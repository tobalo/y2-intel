const std = @import("std");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");

const Allocator = std.mem.Allocator;
const max_response_bytes: usize = 64 * 1024;

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

pub const oauth_provider: oauth_transport.Provider = if (host_target.is_wasm)
    .{ .execute_fn = executeOAuthRequest }
else
    oauth_transport.unavailable_provider;

fn executeOAuthRequest(
    _: ?*anyopaque,
    alloc: Allocator,
    request: oauth_transport.Request,
) !oauth_transport.Response {
    try checkRequestBounds(request);
    const Header = struct { name: []const u8, value: []const u8 };
    var header_buf: [2]Header = undefined;
    var header_count: usize = 0;
    switch (request.method) {
        .get => {},
        .post_form => {
            header_buf[header_count] = .{ .name = "content-type", .value = "application/x-www-form-urlencoded" };
            header_count += 1;
        },
        .post_json => {
            header_buf[header_count] = .{ .name = "content-type", .value = "application/json" };
            header_count += 1;
        },
    }
    if (request.authorization) |value| {
        header_buf[header_count] = .{ .name = "authorization", .value = value };
        header_count += 1;
    }
    var response = try executeRequest(
        alloc,
        switch (request.method) {
            .get => "GET",
            .post_form, .post_json => "POST",
        },
        request.url,
        header_buf[0..header_count],
        request.payload orelse "",
    );
    errdefer response.deinit(alloc);
    try checkRequestBounds(request);
    return response;
}

pub fn executeBearerGet(
    alloc: Allocator,
    url: []const u8,
    access_token: []const u8,
) !oauth_transport.Response {
    const authorization = try std.fmt.allocPrint(alloc, "Bearer {s}", .{access_token});
    defer secret.zeroAndFree(alloc, authorization);
    return executeRequest(alloc, "GET", url, &.{.{
        .name = "authorization",
        .value = authorization,
    }}, "");
}

fn executeRequest(
    alloc: Allocator,
    method: []const u8,
    url: []const u8,
    headers: anytype,
    body: []const u8,
) !oauth_transport.Response {
    var headers_json: std.Io.Writer.Allocating = .init(alloc);
    defer headers_json.deinit();
    try std.json.Stringify.value(headers, .{}, &headers_json.writer);

    const response_buffer = try alloc.alloc(u8, max_response_bytes);
    defer secret.zeroAndFree(alloc, response_buffer);
    var status: u16 = 0;
    const response_len = y2_http_request(
        method.ptr,
        method.len,
        url.ptr,
        url.len,
        headers_json.written().ptr,
        headers_json.written().len,
        body.ptr,
        body.len,
        &status,
        response_buffer.ptr,
        response_buffer.len,
    );
    if (response_len == -2) return error.OAuthResponseTooLarge;
    if (response_len < 0 or @as(usize, @intCast(response_len)) > response_buffer.len) {
        return error.OAuthRequestFailed;
    }
    return .{
        .disposition = if (status == 200) .accepted else .rejected,
        .body = try alloc.dupe(u8, response_buffer[0..@intCast(response_len)]),
    };
}

fn checkRequestBounds(request: oauth_transport.Request) !void {
    if (request.cancel_flag) |flag| {
        if (flag.load(.seq_cst)) return error.Cancelled;
    }
    if (request.deadline) |deadline| {
        const now = std.Io.Clock.Timestamp.now(io_mod.getIo(), .awake);
        if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline)) return error.Timeout;
    }
}

test "request bounds reject cancellation before touching the JS host" {
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.Cancelled, checkRequestBounds(.{
        .method = .get,
        .url = "https://auth.example.com",
        .cancel_flag = &cancelled,
    }));
}
