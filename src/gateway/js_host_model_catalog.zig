const std = @import("std");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const builtin_gateway = @import("../builtins/gateway.zig");

const Allocator = std.mem.Allocator;

pub const provider = model_catalog.Provider{ .fetch_fn = fetch };

fn fetch(
    _: ?*anyopaque,
    alloc: Allocator,
    input: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    if (input.cancel_flag) |flag| if (flag.load(.seq_cst)) return .{
        .failure = .{ .category = .cancellation },
    };

    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);
    const id = try alloc.dupe(u8, builtin_gateway.default_model);
    errdefer alloc.free(id);
    const model_type = try alloc.dupe(u8, "language");
    errdefer alloc.free(model_type);
    try catalog.append(alloc, .{
        .id = id,
        .model_type = model_type,
    });
    return .{ .catalog = catalog };
}

test "JS host catalog is the static Agent Y2 model" {
    const result = try provider.fetch(std.testing.allocator, .{
        .endpoint = "/models",
    });
    switch (result) {
        .catalog => |owned| {
            var catalog = owned;
            defer model_catalog.freeModelCatalog(std.testing.allocator, &catalog);
            try std.testing.expectEqual(@as(usize, 1), catalog.items.len);
            try std.testing.expectEqualStrings("y2-agent", catalog.items[0].id);
        },
        .failure => return error.TestExpectedCatalog,
    }
}
