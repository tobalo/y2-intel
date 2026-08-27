const std = @import("std");
const search_args = @import("search_args.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const tool_result_errors = @import("../../core/tooling/tool_result_errors.zig");

pub const decode = search_args.decode;
pub const validate = search_args.validate;
pub const readsOnly = search_args.readsOnly;
pub const isIrreversible = search_args.isIrreversible;

pub fn call(ctx: tool_dispatch.DispatchContext, erased: tool_dispatch.ToolInput) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const backend = ctx.web_search_backend orelse {
        return .{ .failure = try ctx.allocator.dupe(u8, tool_dispatch.web_search_unavailable_message) };
    };
    const input = erased.as(search_args.Input);
    var execution = backend.execute(ctx, .{
        .query = input.query,
        .allowed_domains = optionalConstStrings(input.allowed_domains),
        .blocked_domains = optionalConstStrings(input.blocked_domains),
    }) catch |err| {
        const details = [_]tool_result_errors.Detail{
            .{ .name = "error", .value = .{ .string = @errorName(err) } },
        };
        return .{ .failure = try tool_result_errors.toolExecutionFailureJson(ctx.allocator, .{
            .tool_name = "web_search",
            .message = "web_search failed",
            .details = &details,
        }) };
    };
    defer execution.deinit(ctx.allocator);

    tool_dispatch.reportWebSearchCompletion(ctx, .{
        .searches = execution.output.web_search_requests,
        .duration_ms = execution.output.duration_ms,
    });
    if (execution.inner_usage) |usage| tool_dispatch.reportInnerUsage(ctx, usage);
    return .{ .success = try std.fmt.allocPrint(
        ctx.allocator,
        "Web search results for query: {s}",
        .{execution.output.query},
    ) };
}

fn optionalConstStrings(maybe_strings: ?[][]u8) ?[]const []const u8 {
    const strings = maybe_strings orelse return null;
    return strings;
}
