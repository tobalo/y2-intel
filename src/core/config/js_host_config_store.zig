const std = @import("std");

const Allocator = std.mem.Allocator;

pub const LoadError = error{
    ValueTooLarge,
    HostFailure,
    OutOfMemory,
};

pub const SaveError = error{HostFailure};

const initial_capacity = 256;
const max_value_bytes = 16 * 1024;

extern "y2" fn y2_config_get(
    id_ptr: [*]const u8,
    id_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) i32;

extern "y2" fn y2_config_set(
    id_ptr: [*]const u8,
    id_len: usize,
    value_ptr: [*]const u8,
    value_len: usize,
) i32;

/// Loads a host-owned configuration value. The caller owns the returned bytes.
pub fn load(alloc: Allocator, id: []const u8) LoadError!?[]u8 {
    var capacity: usize = initial_capacity;
    while (capacity <= max_value_bytes) : (capacity *= 2) {
        const value = alloc.alloc(u8, capacity) catch return error.OutOfMemory;
        const result = y2_config_get(id.ptr, id.len, value.ptr, value.len);
        if (result >= 0) {
            const length: usize = @intCast(result);
            if (length > value.len) {
                alloc.free(value);
                return error.HostFailure;
            }
            return alloc.realloc(value, length) catch {
                alloc.free(value);
                return error.OutOfMemory;
            };
        }
        alloc.free(value);
        switch (result) {
            -2 => return null,
            -3 => continue,
            else => return error.HostFailure,
        }
    }
    return error.ValueTooLarge;
}

/// Persists a value only after y2 has accepted and applied it.
pub fn setAccepted(id: []const u8, value: []const u8) SaveError!void {
    if (y2_config_set(id.ptr, id.len, value.ptr, value.len) != 0) {
        return error.HostFailure;
    }
}
