const std = @import("std");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const io_mod = @import("../core/shared/io.zig");
const secret = @import("../core/auth/secret.zig");
const sort_utils = @import("../core/shared/sort_utils.zig");
const http_runtime = @import("http_runtime.zig");
const openai_chat = @import("openai_chat.zig");

const Allocator = std.mem.Allocator;
const max_catalog_bytes: usize = 4 * 1024 * 1024;
const max_catalog_models: usize = 4096;
const fetch_timeout_ms: i64 = 30_000;

pub const provider = model_catalog.Provider{
    .fetch_fn = fetchCatalog,
};

pub const cli_provider = gateway_provider.CliModelCatalogProvider{
    .fetch_fn = fetchCliCatalog,
};

fn fetchCliCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: gateway_provider.CliModelCatalogInput,
) gateway_provider.CliModelCatalogResult {
    return switch (model_catalog.fetchWithPublicFallback(provider, alloc, .{
        .access = input.access,
        .endpoint = input.endpoint,
        .cancel_flag = input.cancel_flag,
        .view = .full,
    })) {
        .loaded => |loaded| blk: {
            var catalog = loaded.catalog;
            defer model_catalog.freeModelCatalog(alloc, &catalog);
            const ids = model_catalog.projectModelIds(alloc, catalog.items) catch return .{ .failure = .{
                .access = loaded.provenance.access,
                .anonymous_fallback_used = false,
                .failure = .{ .category = .resource_exhausted },
            } };
            break :blk .{ .loaded = .{
                .ids = ids,
                .provenance = loaded.provenance,
            } };
        },
        .failed => |failure| .{ .failure = failure },
    };
}

fn fetchCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    const base_url = io_mod.getenv(openai_chat.openai_base_url_env) orelse
        io_mod.getenv(openai_chat.chat_url_env) orelse return .{
        .failure = .{ .category = .runtime },
    };
    const request_url = catalogUrlAlloc(alloc, base_url) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = .{ .category = .runtime } };
    };
    defer alloc.free(request_url);

    var fallback_cancel = std.atomic.Value(bool).init(false);
    const cancel_flag = input.cancel_flag orelse &fallback_cancel;
    var operation = FetchOperation{
        .alloc = alloc,
        .url = request_url,
        .credential = input.access.authorizationCredential(),
    };
    var response = http_runtime.runBoundedHttpOperation(
        FetchResponse,
        alloc,
        cancel_flag,
        std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
            .clock = .awake,
            .raw = .fromMilliseconds(fetch_timeout_ms),
        }),
        &operation,
    ) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = .{
            .category = if (err == error.Cancelled)
                .cancellation
            else if (err == error.OpenAiModelCatalogTooLarge)
                .malformed_response
            else
                .transport,
            .retryable = err != error.Cancelled and err != error.OpenAiModelCatalogTooLarge,
        } };
    };
    defer response.deinit(alloc);
    if (response.status != .ok) {
        return .{ .failure = model_catalog.failureForHttpStatus(response.status) };
    }
    const catalog = parseCatalogForView(alloc, response.body, input.view) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = .{ .category = .malformed_response, .http_status = .ok } };
    };
    return .{ .catalog = catalog };
}

const FetchResponse = struct {
    status: std.http.Status,
    body: []u8,

    pub fn deinit(self: *FetchResponse, alloc: Allocator) void {
        secret.zeroAndFree(alloc, self.body);
        self.* = undefined;
    }
};

const FetchOperation = struct {
    alloc: Allocator,
    url: []const u8,
    credential: ?[]const u8,

    pub fn run(self: *FetchOperation) !FetchResponse {
        var client: std.http.Client = .{ .allocator = self.alloc, .io = io_mod.getIo() };
        defer client.deinit();

        var authorization: ?[]u8 = null;
        defer if (authorization) |value| secret.zeroAndFree(self.alloc, value);
        var extra_headers: [2]std.http.Header = undefined;
        extra_headers[0] = .{ .name = "accept", .value = "application/json" };
        var extra_header_count: usize = 1;
        if (self.credential) |credential| {
            authorization = try std.fmt.allocPrint(self.alloc, "Bearer {s}", .{credential});
            extra_headers[extra_header_count] = .{ .name = "authorization", .value = authorization.? };
            extra_header_count += 1;
        }

        const body_buffer = try self.alloc.alloc(u8, max_catalog_bytes + 1);
        defer secret.zeroAndFree(self.alloc, body_buffer);
        var response_writer = std.Io.Writer.fixed(body_buffer);
        const result = client.fetch(.{
            .location = .{ .url = self.url },
            .method = .GET,
            .headers = .{
                .user_agent = .{ .override = http_runtime.user_agent },
                .accept_encoding = .omit,
            },
            .extra_headers = extra_headers[0..extra_header_count],
            .response_writer = &response_writer,
            .redirect_behavior = .unhandled,
        }) catch |err| switch (err) {
            error.WriteFailed => return error.OpenAiModelCatalogTooLarge,
            else => return err,
        };
        const body = response_writer.buffered();
        if (body.len > max_catalog_bytes) return error.OpenAiModelCatalogTooLarge;
        return .{
            .status = result.status,
            .body = try self.alloc.dupe(u8, body),
        };
    }
};

fn catalogUrlAlloc(alloc: Allocator, base_url: []const u8) ![]u8 {
    const uri = std.Uri.parse(base_url) catch return error.InvalidOpenAiBaseUrl;
    if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null) {
        return error.InvalidOpenAiBaseUrl;
    }
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "https") and !http_runtime.isLoopbackHttpUrl(base_url)) {
        return error.InvalidOpenAiBaseUrl;
    }
    const trimmed = std.mem.trimEnd(u8, base_url, "/");
    if (std.mem.endsWith(u8, trimmed, "/models")) return alloc.dupe(u8, trimmed);
    const chat_suffix = "/chat/completions";
    const catalog_base = if (std.mem.endsWith(u8, trimmed, chat_suffix))
        trimmed[0 .. trimmed.len - chat_suffix.len]
    else
        trimmed;
    return std.fmt.allocPrint(alloc, "{s}/models", .{catalog_base});
}

fn parseCatalogForView(
    alloc: Allocator,
    json_text: []const u8,
    view: model_catalog.View,
) !std.ArrayList(model_catalog.ModelCatalogEntry) {
    var catalog = try parseCatalog(alloc, json_text);
    if (view == .full) return catalog;
    defer model_catalog.freeModelCatalog(alloc, &catalog);
    return model_catalog.projectPickerModelCatalog(alloc, catalog.items);
}

fn parseCatalog(alloc: Allocator, json_text: []const u8) !std.ArrayList(model_catalog.ModelCatalogEntry) {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, json_text, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidOpenAiModelCatalog;
    const data = parsed.value.object.get("data") orelse return error.InvalidOpenAiModelCatalog;
    if (data != .array or data.array.items.len > max_catalog_models) return error.InvalidOpenAiModelCatalog;

    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);
    for (data.array.items) |value| {
        const entry = (try parseEntry(alloc, value)) orelse continue;
        catalog.append(alloc, entry) catch |err| {
            model_catalog.freeModelCatalogEntry(alloc, entry);
            return err;
        };
    }
    sort_utils.sort(
        model_catalog.ModelCatalogEntry,
        catalog.items,
        {},
        model_catalog.compareModelCatalogEntries,
    );
    return catalog;
}

fn parseEntry(alloc: Allocator, value: std.json.Value) !?model_catalog.ModelCatalogEntry {
    if (value != .object) return null;
    const id_value = value.object.get("id") orelse return null;
    if (id_value != .string or !validModelId(id_value.string)) return null;
    const id = try alloc.dupe(u8, id_value.string);
    errdefer alloc.free(id);
    const owned_model_type = try alloc.dupe(u8, "language");
    errdefer alloc.free(owned_model_type);

    return .{
        .id = id,
        .model_type = owned_model_type,
        .released = optionalCreatedTimestamp(value.object),
        // The standard models response has no capability metadata. Direct
        // Chat Completions mode exposes protocol-level function tools and image
        // content, leaving model-specific acceptance to the configured endpoint.
        .has_tool_use = true,
        .has_vision = true,
        .has_file_input = true,
    };
}

fn optionalCreatedTimestamp(object: std.json.ObjectMap) i64 {
    const value = object.get("created") orelse return 0;
    return if (value == .integer and value.integer >= 0) value.integer else 0;
}

fn validModelId(id: []const u8) bool {
    if (id.len == 0 or id.len > 1024) return false;
    for (id) |byte| if (byte <= 0x20 or byte == 0x7f) return false;
    return true;
}

test "OpenAI-compatible catalog URL preserves the base path" {
    const url = try catalogUrlAlloc(std.testing.allocator, "https://models.example/v1/");
    defer std.testing.allocator.free(url);
    try std.testing.expectEqualStrings("https://models.example/v1/models", url);
}

test "OpenAI-compatible catalog URL is the sibling of chat completions" {
    const url = try catalogUrlAlloc(std.testing.allocator, "https://models.example/v1/chat/completions");
    defer std.testing.allocator.free(url);
    try std.testing.expectEqualStrings("https://models.example/v1/models", url);
}

test "OpenAI-compatible catalog parses the standard model list" {
    const json =
        \\{"object":"list","data":[
        \\  {"id":"provider/beta","object":"model","created":1,"owned_by":"provider"},
        \\  {"id":"provider/alpha","object":"model","created":2,"owned_by":"provider"}
        \\]}
    ;
    var catalog = try parseCatalog(std.testing.allocator, json);
    defer model_catalog.freeModelCatalog(std.testing.allocator, &catalog);
    try std.testing.expectEqual(@as(usize, 2), catalog.items.len);
    const entry = catalog.items[0];
    try std.testing.expectEqualStrings("provider/alpha", entry.id);
    try std.testing.expectEqual(@as(i64, 2), entry.released);
    try std.testing.expectEqualStrings("language", entry.model_type);
    try std.testing.expect(entry.has_tool_use);
    try std.testing.expect(entry.has_vision);
    try std.testing.expect(entry.has_file_input);
}
