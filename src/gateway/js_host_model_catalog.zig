const std = @import("std");
const builtin_gateway = @import("../builtins/gateway.zig");
const credentials = @import("../core/auth/credentials.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const host_target = @import("../core/hosts/target.zig");
const io_mod = @import("../core/shared/io.zig");
const secret = @import("../core/auth/secret.zig");
const http_runtime = @import("http_runtime.zig");
const openai_chat = @import("openai_chat.zig");

const Allocator = std.mem.Allocator;
const max_catalog_bytes: usize = 4 * 1024 * 1024;
const max_catalog_models: usize = 4096;

extern "y2" fn y2_http_request(
    method_ptr: [*]const u8,
    method_len: usize,
    url_ptr: [*]const u8,
    url_len: usize,
    headers_ptr: [*]const u8,
    headers_len: usize,
    body_ptr: [*]const u8,
    body_len: usize,
    status_out: *u16,
    response_ptr: [*]u8,
    response_cap: usize,
) i32;

pub const provider = model_catalog.Provider{ .fetch_fn = fetch };

fn fetch(
    _: ?*anyopaque,
    alloc: Allocator,
    input: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    if (input.cancel_flag) |flag| if (flag.load(.seq_cst)) return .{
        .failure = .{ .category = .cancellation },
    };

    if (comptime host_target.is_wasm) {
        if (io_mod.getenv(openai_chat.openai_base_url_env)) |base_url| {
            return fetchOpenAiCatalog(alloc, input.access, base_url);
        }
    }
    return staticY2Catalog(alloc);
}

fn staticY2Catalog(alloc: Allocator) Allocator.Error!model_catalog.ProviderResult {
    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);
    const id = try alloc.dupe(u8, builtin_gateway.default_model);
    errdefer alloc.free(id);
    const model_type = try alloc.dupe(u8, "language");
    errdefer alloc.free(model_type);
    try catalog.append(alloc, .{
        .id = id,
        .model_type = model_type,
        .has_tool_use = true,
    });
    return .{ .catalog = catalog };
}

fn fetchOpenAiCatalog(
    alloc: Allocator,
    access: credentials.CatalogAccess,
    base_url: []const u8,
) Allocator.Error!model_catalog.ProviderResult {
    const endpoint = modelCatalogUrlAlloc(alloc, base_url) catch return .{
        .failure = .{ .category = .runtime },
    };
    defer alloc.free(endpoint);

    const Header = struct { name: []const u8, value: []const u8 };
    var headers: std.ArrayList(Header) = .empty;
    defer headers.deinit(alloc);
    try headers.append(alloc, .{ .name = "accept", .value = "application/json" });

    var authorization: ?[]u8 = null;
    defer if (authorization) |value| secret.zeroAndFree(alloc, value);
    if (access.authorizationCredential()) |credential| {
        authorization = try std.fmt.allocPrint(alloc, "Bearer {s}", .{credential});
        try headers.append(alloc, .{ .name = "authorization", .value = authorization.? });
    }

    var headers_json: std.Io.Writer.Allocating = .init(alloc);
    defer headers_json.deinit();
    std.json.Stringify.value(headers.items, .{}, &headers_json.writer) catch return error.OutOfMemory;

    const response_buffer = try alloc.alloc(u8, max_catalog_bytes);
    defer alloc.free(response_buffer);
    var status_code: u16 = 0;
    const response_len = y2_http_request(
        "GET".ptr,
        "GET".len,
        endpoint.ptr,
        endpoint.len,
        headers_json.written().ptr,
        headers_json.written().len,
        "".ptr,
        0,
        &status_code,
        response_buffer.ptr,
        response_buffer.len,
    );
    if (response_len < 0 or @as(usize, @intCast(response_len)) > response_buffer.len) return .{
        .failure = .{ .category = .transport, .retryable = true },
    };

    const status: std.http.Status = @enumFromInt(status_code);
    if (status != .ok) return .{ .failure = model_catalog.failureForHttpStatus(status) };

    const catalog = parseCatalog(alloc, response_buffer[0..@intCast(response_len)]) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return .{ .failure = .{ .category = .malformed_response } },
    };
    return .{ .catalog = catalog };
}

fn modelCatalogUrlAlloc(alloc: Allocator, base_url: []const u8) ![]u8 {
    const uri = std.Uri.parse(base_url) catch return error.InvalidOpenAiBaseUrl;
    if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null) {
        return error.InvalidOpenAiBaseUrl;
    }
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "https") and !http_runtime.isLoopbackHttpUrl(base_url)) {
        return error.InvalidOpenAiBaseUrl;
    }
    const trimmed = std.mem.trimEnd(u8, base_url, "/");
    if (std.mem.endsWith(u8, trimmed, "/models")) return alloc.dupe(u8, trimmed);
    return std.fmt.allocPrint(alloc, "{s}/models", .{trimmed});
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
        if (value != .object) return error.InvalidOpenAiModelCatalog;
        const id_value = value.object.get("id") orelse return error.InvalidOpenAiModelCatalog;
        if (id_value != .string or !validModelId(id_value.string)) return error.InvalidOpenAiModelCatalog;

        const id = try alloc.dupe(u8, id_value.string);
        errdefer alloc.free(id);
        const model_type = try alloc.dupe(u8, optionalString(value.object, "type") orelse "language");
        errdefer alloc.free(model_type);
        try catalog.append(alloc, .{
            .id = id,
            .model_type = model_type,
            .released = try optionalTimestamp(value.object),
            .has_tool_use = try stringArrayContains(value.object, "tags", "tool-use"),
            .has_reasoning = try stringArrayContains(value.object, "tags", "reasoning"),
        });
    }
    return catalog;
}

fn optionalString(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return if (value == .string and value.string.len > 0) value.string else null;
}

fn optionalTimestamp(object: std.json.ObjectMap) !i64 {
    const value = object.get("released") orelse object.get("created") orelse return 0;
    if (value != .integer or value.integer < 0) return error.InvalidOpenAiModelCatalog;
    return value.integer;
}

fn stringArrayContains(object: std.json.ObjectMap, key: []const u8, expected: []const u8) !bool {
    const value = object.get(key) orelse return false;
    if (value != .array or value.array.items.len > 64) return error.InvalidOpenAiModelCatalog;
    for (value.array.items) |entry| {
        if (entry != .string) return error.InvalidOpenAiModelCatalog;
        if (std.mem.eql(u8, entry.string, expected)) return true;
    }
    return false;
}

fn validModelId(id: []const u8) bool {
    if (id.len == 0 or id.len > 1024) return false;
    for (id) |byte| if (byte <= 0x20 or byte == 0x7f) return false;
    return true;
}

test "JS host catalog is the static Agent Y2 model outside WASM" {
    const result = try provider.fetch(std.testing.allocator, .{
        .endpoint = "/models",
    });
    switch (result) {
        .catalog => |owned| {
            var catalog = owned;
            defer model_catalog.freeModelCatalog(std.testing.allocator, &catalog);
            try std.testing.expectEqual(@as(usize, 1), catalog.items.len);
            try std.testing.expectEqualStrings("y2-agent", catalog.items[0].id);
            try std.testing.expect(catalog.items[0].has_tool_use);
        },
        .failure => return error.TestExpectedCatalog,
    }
}

test "OpenAI-compatible catalog URL preserves the base path" {
    const url = try modelCatalogUrlAlloc(std.testing.allocator, "https://models.example/v1/");
    defer std.testing.allocator.free(url);
    try std.testing.expectEqualStrings("https://models.example/v1/models", url);
}

test "OpenAI-compatible model catalog parses standard and optional fields" {
    const json =
        \\{"object":"list","data":[
        \\  {"id":"sdk/catalog-alpha","type":"language","released":2,"tags":["tool-use"]},
        \\  {"id":"sdk/catalog-beta","created":1,"tags":["reasoning"]}
        \\]}
    ;
    var catalog = try parseCatalog(std.testing.allocator, json);
    defer model_catalog.freeModelCatalog(std.testing.allocator, &catalog);
    try std.testing.expectEqual(@as(usize, 2), catalog.items.len);
    try std.testing.expectEqualStrings("sdk/catalog-alpha", catalog.items[0].id);
    try std.testing.expectEqual(@as(i64, 2), catalog.items[0].released);
    try std.testing.expect(catalog.items[0].has_tool_use);
    try std.testing.expect(catalog.items[1].has_reasoning);
}
