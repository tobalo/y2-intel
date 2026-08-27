const std = @import("std");

pub const permission_reviewer = @import("../gateway/openai_chat_permission_reviewer.zig");

const api_key_validator_contract = @import("../core/auth/api_key_validator.zig");
const agent_stream_provider_contract = @import("../core/agent/stream_provider.zig");
const oauth_transport = @import("../core/auth/oauth_transport.zig");
const secret = @import("../core/auth/secret.zig");
const io_mod = @import("../core/shared/io.zig");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const provider_set = @import("../core/gateway/provider_set.zig");
const provider_catalog = @import("../core/auth/provider_catalog.zig");
const model_capabilities = @import("../core/config/model_capabilities.zig");
const web_search_contract = @import("../core/tooling/web_search_contract.zig");
const web_search_policy = @import("../core/tooling/web_search_policy.zig");
const web_search_provider = @import("../core/tooling/web_search_provider.zig");
const http_runtime = @import("../gateway/http_runtime.zig");
const openai_chat = @import("../gateway/openai_chat.zig");

const Allocator = std.mem.Allocator;
const oauth_request_timeout_ms: i64 = 15_000;
const oauth_response_max_bytes: usize = 64 * 1024;

pub const default_model = openai_chat.default_model;
pub const default_chat_url = openai_chat.default_y2_chat_url;
pub const models_path = "/models";
pub const retry_count: usize = 3;
pub const chat_url_env = openai_chat.chat_url_env;

pub const chat_url_provider = gateway_provider.ChatUrlProvider{
    .resolve_fn = resolveChatUrlForProvider,
};

pub fn agentChatUrl() []const u8 {
    return chatUrl(default_chat_url);
}

pub const cli_model_catalog_provider = gateway_provider.CliModelCatalogProvider{
    .fetch_fn = fetchStaticCliModelCatalog,
};

pub const model_catalog_provider = model_catalog.Provider{
    .fetch_fn = fetchStaticModelCatalog,
};

pub const api_key_validator = api_key_validator_contract.Provider{
    .validate_fn = validateApiKey,
};

pub const oauth_transport_provider = oauth_transport.Provider{
    .execute_fn = executeOAuthRequest,
};

pub const agent_stream_provider = openai_chat.agent_stream_provider;

pub const provider_bundle = provider_set.Bundle{
    .capabilities = .{},
    .presentation = provider_catalog.find(.gateway),
    .auth_strategy = .api_key,
    .fallback_model_capabilities_fn = fallbackModelCapabilities,
    .agent_stream = agent_stream_provider,
    .cli_model_catalog = cli_model_catalog_provider,
    .model_catalog = model_catalog_provider,
    .permission_reviewer = permission_reviewer.provider,
};

pub const provider = gateway_provider.Provider{
    .oauth_transport = oauth_transport_provider,
    .chat_url = chat_url_provider,
};

pub fn buildAgentRequest(
    alloc: Allocator,
    request: agent_stream_provider_contract.RequestData,
) anyerror![]u8 {
    return openai_chat.buildRequest(alloc, request, .openai_compatible);
}

fn fallbackModelCapabilities(model: []const u8) model_capabilities.Capabilities {
    const native_images = std.mem.startsWith(u8, model, "google/gemini") or
        std.mem.startsWith(u8, model, "gemini");
    return .{
        .supports_tool_use = true,
        .supports_vision = native_images,
        .supports_file_input = native_images,
    };
}

pub fn usesDirectOpenAiEndpoint() bool {
    return openai_chat.configuredMode() == .openai_compatible;
}

pub fn chatUrl(fallback: []const u8) []const u8 {
    return resolveChatUrl(fallback, io_mod.getenv(chat_url_env));
}

pub fn defaultChatUrl() []const u8 {
    return chatUrl(default_chat_url);
}

fn resolveChatUrlForProvider(_: ?*anyopaque, fallback: []const u8) []const u8 {
    return chatUrl(fallback);
}

pub fn resolveChatUrl(fallback: []const u8, override: ?[]const u8) []const u8 {
    const candidate = override orelse return fallback;
    const uri = std.Uri.parse(candidate) catch return fallback;
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null) return fallback;
    if (std.ascii.eqlIgnoreCase(uri.scheme, "https") or http_runtime.isLoopbackHttpUrl(candidate)) return candidate;
    return fallback;
}

fn validateApiKey(
    _: ?*anyopaque,
    _: Allocator,
    api_key: []const u8,
) api_key_validator_contract.Result {
    const trimmed = std.mem.trim(u8, api_key, " \t\r\n");
    if (trimmed.len == 0 or trimmed.len != api_key.len or trimmed.len > 4096) return .refused;
    return .accepted;
}

fn fetchStaticCliModelCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: gateway_provider.CliModelCatalogInput,
) gateway_provider.CliModelCatalogResult {
    if (input.cancel_flag) |flag| if (flag.load(.seq_cst)) return .{ .failure = .{
        .access = .init(input.access),
        .anonymous_fallback_used = false,
        .failure = .{ .category = .cancellation },
    } };
    var ids: std.ArrayList([]u8) = .empty;
    const id = alloc.dupe(u8, default_model) catch return .{ .failure = .{
        .access = .init(input.access),
        .anonymous_fallback_used = false,
        .failure = .{ .category = .resource_exhausted },
    } };
    ids.append(alloc, id) catch {
        alloc.free(id);
        return .{ .failure = .{
            .access = .init(input.access),
            .anonymous_fallback_used = false,
            .failure = .{ .category = .resource_exhausted },
        } };
    };
    return .{ .loaded = .{
        .ids = ids,
        .provenance = .{ .access = .init(input.access) },
    } };
}

fn fetchStaticModelCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    if (input.cancel_flag) |flag| if (flag.load(.seq_cst)) return .{
        .failure = .{ .category = .cancellation },
    };
    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);
    const id = try alloc.dupe(u8, default_model);
    errdefer alloc.free(id);
    const model_type = try alloc.dupe(u8, "language");
    errdefer alloc.free(model_type);
    try catalog.append(alloc, .{ .id = id, .model_type = model_type });
    return .{ .catalog = catalog };
}

fn executeOAuthRequest(
    _: ?*anyopaque,
    alloc: Allocator,
    request: oauth_transport.Request,
) !oauth_transport.Response {
    var local_cancel = std.atomic.Value(bool).init(false);
    const cancel_flag = request.cancel_flag orelse &local_cancel;
    const deadline = request.deadline orelse std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(oauth_request_timeout_ms),
    });
    var operation = OAuthHttpOperation{ .alloc = alloc, .request = request };
    return http_runtime.runBoundedHttpOperation(
        oauth_transport.Response,
        alloc,
        cancel_flag,
        deadline,
        &operation,
    );
}

const OAuthHttpOperation = struct {
    alloc: Allocator,
    request: oauth_transport.Request,

    pub fn run(self: *@This()) !oauth_transport.Response {
        var client: std.http.Client = .{ .allocator = self.alloc, .io = io_mod.getIo() };
        defer client.deinit();

        const response_buffer = try self.alloc.alloc(u8, oauth_response_max_bytes + 1);
        defer secret.zeroAndFree(self.alloc, response_buffer);
        var response_writer = std.Io.Writer.fixed(response_buffer);

        const result = client.fetch(.{
            .location = .{ .url = self.request.url },
            .method = switch (self.request.method) {
                .get => .GET,
                .post_form, .post_json => .POST,
            },
            .payload = self.request.payload,
            .headers = .{
                .content_type = switch (self.request.method) {
                    .get => .default,
                    .post_form => .{ .override = "application/x-www-form-urlencoded" },
                    .post_json => .{ .override = "application/json" },
                },
                .user_agent = .{ .override = http_runtime.user_agent },
                .accept_encoding = .omit,
                .authorization = if (self.request.authorization) |value|
                    .{ .override = value }
                else
                    .default,
            },
            .redirect_behavior = .unhandled,
            .response_writer = &response_writer,
        }) catch |err| switch (err) {
            error.WriteFailed => return error.OAuthResponseTooLarge,
            else => return err,
        };
        const body = response_writer.buffered();
        if (body.len > oauth_response_max_bytes) return error.OAuthResponseTooLarge;

        return .{
            .disposition = if (result.status == .ok) .accepted else .rejected,
            .body = try self.alloc.dupe(u8, body),
        };
    }
};

pub const default_web_search_policy = web_search_policy.WebSearchPolicy{};

pub const default_web_search_provider = web_search_provider.Provider{
    .policy = default_web_search_policy,
    .preferred_backends_fn = noWebSearchBackends,
    .execute_fn = unavailableWebSearch,
};

fn noWebSearchBackends(_: ?*anyopaque) !?[]const web_search_contract.SearchBackendId {
    return null;
}

fn unavailableWebSearch(
    _: ?*anyopaque,
    _: Allocator,
    _: web_search_provider.Inputs,
    _: web_search_contract.ProviderRequest,
    _: ?web_search_contract.ProgressFn,
    _: ?*anyopaque,
) !web_search_contract.ProviderResponse {
    return error.WebSearchProviderUnavailable;
}

test "Y2 provider uses direct API transport and a static model catalog" {
    try std.testing.expectEqualStrings("y2-agent", default_model);
    try std.testing.expectEqualStrings(
        "https://api.y2.dev/api/v1/chat/completions",
        default_chat_url,
    );
    try std.testing.expectEqual(provider_set.Bundle.AuthStrategy.api_key, provider_bundle.auth_strategy.?);
    try std.testing.expect(!provider_bundle.capabilities.y2_search);
    try std.testing.expect(provider_bundle.deferred_usage == null);
    try std.testing.expect(provider_bundle.credits == null);
}

test "direct model fallback preserves Gemini native image capability" {
    const gemini = fallbackModelCapabilities("google/gemini-2.5-flash");
    try std.testing.expect(gemini.supports_tool_use);
    try std.testing.expect(gemini.supports_vision);
    try std.testing.expect(gemini.supports_file_input);

    const unknown = fallbackModelCapabilities("provider/text-only");
    try std.testing.expect(unknown.supports_tool_use);
    try std.testing.expect(!unknown.supports_vision);
    try std.testing.expect(!unknown.supports_file_input);
}
