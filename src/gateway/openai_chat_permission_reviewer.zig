const std = @import("std");
const permission_auto_classifier = @import("../core/permissions/auto_classifier.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const openai_chat = @import("openai_chat.zig");
const responses_reviewer = @import("responses_permission_reviewer.zig");

const Allocator = std.mem.Allocator;

pub const provider = permission_auto_classifier.Provider{
    .review_fn = reviewOpenAICompatible,
};

fn reviewOpenAICompatible(
    _: ?*anyopaque,
    alloc: Allocator,
    input: permission_auto_classifier.ProviderInput,
    request: permission_auto_classifier.ReviewRequest,
) anyerror!permission_auto_classifier.ParseOutcome {
    if (openai_chat.configuredMode() == .y2_agent) return .invalid;
    return responses_reviewer.review(alloc, input, request, .{
        .source = .api_key,
        .model = request.review_turn.model,
        .validate_fn = validateCredential,
        .build_fn = buildRequest,
        .send_fn = sendPrepared,
    });
}

fn validateCredential(
    _: Allocator,
    input: permission_auto_classifier.ProviderInput,
) !void {
    if (input.credential.len == 0) return error.MissingApiKey;
}

fn buildRequest(alloc: Allocator, request: stream_provider.RequestData) ![]u8 {
    return openai_chat.buildRequest(alloc, request, .openai_compatible);
}

fn sendPrepared(
    alloc: Allocator,
    request: stream_provider.ModelRequest,
    payload: []const u8,
) anyerror!stream_provider.Result {
    const endpoint = try openai_chat.endpointAlloc(alloc);
    defer alloc.free(endpoint);
    if (openai_chat.modeForEndpoint(endpoint) == .y2_agent) return error.UnsupportedY2PermissionReview;
    return openai_chat.streamPrepared(alloc, request, endpoint, payload);
}

test "direct reviewer request uses standard Chat Completions tools" {
    const body = try buildRequest(std.testing.allocator, .{
        .model = "review-model",
        .messages = &.{.{ .role = .user, .content = "Review the action." }},
        .tools = .{ .additional_functions = &.{permission_auto_classifier.function_schema} },
        .tool_choice = .required,
        .provider_options = .{},
    });
    defer std.testing.allocator.free(body);

    try std.testing.expect(std.mem.find(u8, body, "\"messages\":[") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"tool_choice\":\"required\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "providerOptions") == null);
    try std.testing.expect(std.mem.find(u8, body, "retired-gateway") == null);
}
