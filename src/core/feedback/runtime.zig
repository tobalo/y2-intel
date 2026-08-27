const std = @import("std");

pub const url = "https://github.com/tobalo/y2-intel/issues/new";

test "feedback URL stays on the Y2 harness repository" {
    try std.testing.expectEqualStrings("https://github.com/tobalo/y2-intel/issues/new", url);
}
