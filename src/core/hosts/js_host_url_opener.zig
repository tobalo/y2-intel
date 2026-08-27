const std = @import("std");
const host = @import("host.zig");

extern "y2" fn y2_open_url(url_ptr: [*]const u8, url_len: usize) i32;

pub const opener: host.UrlOpener = .{ .open_fn = open };

fn open(
    _: ?*anyopaque,
    _: std.mem.Allocator,
    url: []const u8,
) host.UrlOpenError!bool {
    return openWith(y2_open_url, url);
}

fn openWith(call: anytype, url: []const u8) bool {
    return call(url.ptr, url.len) == 1;
}

test "JS host URL opener keeps the manual fallback without a handler" {
    const NoHandler = struct {
        fn call(_: [*]const u8, _: usize) i32 {
            return 0;
        }
    };
    try std.testing.expect(!openWith(NoHandler.call, "https://auth.example.com/login"));
}
