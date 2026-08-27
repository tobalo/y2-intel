const std = @import("std");
const build_options = @import("build_options");
const y2 = @import("main.zig");

comptime {
    if (build_options.wasm_surface != .term) {
        @compileError("y2-term requires -Dwasm-surface=term");
    }
}

pub const panic = @import("core/hosts/wasm_panic.zig").panic;

pub fn main(init: std.process.Init) !void {
    try y2.runWasmTerminal(init);
}
