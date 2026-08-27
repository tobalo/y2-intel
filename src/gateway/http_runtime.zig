const std = @import("std");
const build_options = @import("build_options");
const agent_stream_provider = @import("../core/agent/stream_provider.zig");
const debug_trace = @import("../core/shared/debug_trace.zig");
const io_mod = @import("../core/shared/io.zig");

pub const user_agent = "y2-intel-harness/" ++ build_options.app_version;

pub fn networkFailureEvidence(
    err: anyerror,
    delivery: agent_stream_provider.DeliveryCertainty.State,
) ?agent_stream_provider.NetworkFailureEvidence {
    const cause: agent_stream_provider.NetworkFailureCause = if (err == error.SystemResumed)
        .system_resumed
    else if (isRetryableNetworkError(err))
        .transport_interrupted
    else
        return null;
    return .{ .cause = cause, .delivery = delivery };
}

fn isRetryableNetworkError(err: anyerror) bool {
    return err == error.TlsInitializationFailed or
        err == error.ConnectionSetupTimedOut or
        err == error.UnknownHostName or
        err == error.NameServerFailure or
        err == error.NoAddressReturned or
        err == error.DetectingNetworkConfigurationFailed or
        err == error.AddressUnavailable or
        err == error.ConnectionPending or
        err == error.ConnectionRefused or
        err == error.ConnectionResetByPeer or
        err == error.ConnectionTimedOut or
        err == error.HostUnreachable or
        err == error.NetworkUnreachable or
        err == error.NetworkDown or
        err == error.Timeout or
        err == error.WouldBlock or
        err == error.HttpConnectionClosing or
        err == error.WriteFailed or
        err == error.ReadFailed;
}

pub fn runBoundedHttpOperation(
    comptime Result: type,
    alloc: std.mem.Allocator,
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
    operation: anytype,
) !Result {
    if (cancel_flag.load(.seq_cst)) {
        debug_trace.logf("stream", "bounded termination cause=cancellation phase=admission", .{});
        return error.Cancelled;
    }
    std.debug.assert(deadline.clock == .awake);

    const zio = io_mod.getIo();
    const now = std.Io.Clock.Timestamp.now(zio, .awake);
    if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline)) {
        debug_trace.logf("stream", "bounded termination cause=deadline phase=admission", .{});
        return error.Timeout;
    }

    const Event = union(enum) {
        request: anyerror!Result,
        cancelled: anyerror!void,
        deadline: anyerror!void,
    };
    const Operation = @TypeOf(operation);
    const Runner = struct {
        fn run(value: Operation) anyerror!Result {
            return value.run();
        }
    };
    const Cleanup = struct {
        fn drain(result_alloc: std.mem.Allocator, select: *std.Io.Select(Event)) void {
            while (select.cancel()) |item| switch (item) {
                .request => |request_result| {
                    var late_result = request_result catch continue;
                    late_result.deinit(result_alloc);
                },
                .cancelled, .deadline => {},
            };
        }
    };

    var select_buffer: [3]Event = undefined;
    var select: std.Io.Select(Event) = .init(zio, &select_buffer);
    select.concurrent(.cancelled, waitForCancellation, .{cancel_flag}) catch |err| return err;
    select.concurrent(.deadline, waitForDeadline, .{deadline}) catch |err| {
        select.cancelDiscard();
        return err;
    };
    select.concurrent(.request, Runner.run, .{operation}) catch |err| {
        select.cancelDiscard();
        return err;
    };

    const event = select.await() catch |err| {
        Cleanup.drain(alloc, &select);
        return err;
    };
    switch (event) {
        .request => |request_result| {
            Cleanup.drain(alloc, &select);
            if (cancel_flag.load(.seq_cst)) {
                debug_trace.logf("stream", "bounded termination cause=cancellation phase=request_result", .{});
                var owned_result = request_result catch return error.Cancelled;
                owned_result.deinit(alloc);
                return error.Cancelled;
            }
            return request_result;
        },
        .cancelled => |cancel_result| {
            cancel_result catch |err| {
                Cleanup.drain(alloc, &select);
                return err;
            };
            Cleanup.drain(alloc, &select);
            debug_trace.logf("stream", "bounded termination cause=cancellation phase=control", .{});
            return error.Cancelled;
        },
        .deadline => |deadline_result| {
            deadline_result catch |err| {
                Cleanup.drain(alloc, &select);
                return err;
            };
            Cleanup.drain(alloc, &select);
            if (cancel_flag.load(.seq_cst)) return error.Cancelled;
            debug_trace.logf("stream", "bounded termination cause=deadline phase=control", .{});
            return error.Timeout;
        },
    }
}

fn waitForCancellation(cancel_flag: *std.atomic.Value(bool)) anyerror!void {
    while (!cancel_flag.load(.seq_cst)) {
        try io_mod.getIo().sleep(.fromMilliseconds(5), .awake);
    }
}

fn waitForDeadline(deadline: std.Io.Clock.Timestamp) anyerror!void {
    try deadline.wait(io_mod.getIo());
}

const CancelWatcher = struct {
    fn run(
        done: *std.atomic.Value(bool),
        cancel_flag: *std.atomic.Value(bool),
        deadline: ?std.Io.Clock.Timestamp,
        stream: std.Io.net.Stream,
    ) void {
        while (!done.load(.seq_cst)) {
            if (cancel_flag.load(.seq_cst)) {
                stream.shutdown(io_mod.getIo(), .both) catch {};
                return;
            }
            if (deadline) |limit| {
                const now = std.Io.Clock.Timestamp.now(io_mod.getIo(), .awake);
                if (!std.Io.Clock.Timestamp.compare(now, .lt, limit)) {
                    stream.shutdown(io_mod.getIo(), .both) catch {};
                    return;
                }
            }
            io_mod.sleep(10 * std.time.ns_per_ms);
        }
    }
};

pub fn spawnHttpCancelWatcher(
    done: *std.atomic.Value(bool),
    cancel_flag: *std.atomic.Value(bool),
    stream: std.Io.net.Stream,
) !std.Thread {
    return spawnCancelWatcher(done, cancel_flag, null, stream);
}

pub fn spawnHttpCancelWatcherBounded(
    done: *std.atomic.Value(bool),
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
    stream: std.Io.net.Stream,
) !std.Thread {
    return spawnCancelWatcher(done, cancel_flag, deadline, stream);
}

fn spawnCancelWatcher(
    done: *std.atomic.Value(bool),
    cancel_flag: *std.atomic.Value(bool),
    deadline: ?std.Io.Clock.Timestamp,
    stream: std.Io.net.Stream,
) !std.Thread {
    return std.Thread.spawn(.{}, CancelWatcher.run, .{ done, cancel_flag, deadline, stream });
}

pub fn isLoopbackHttpUrl(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "http") or
        uri.user != null or
        uri.password != null or
        uri.port == null)
    {
        return false;
    }

    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.mem.eql(u8, host, "127.0.0.1") or
        std.ascii.eqlIgnoreCase(host, "localhost") or
        std.mem.eql(u8, host, "[::1]");
}

test "loopback HTTP endpoints require an explicit port" {
    try std.testing.expect(isLoopbackHttpUrl("http://127.0.0.1:43123/v1/chat/completions"));
    try std.testing.expect(isLoopbackHttpUrl("http://localhost:43123/v1/chat/completions"));
    try std.testing.expect(!isLoopbackHttpUrl("http://localhost/v1/chat/completions"));
    try std.testing.expect(!isLoopbackHttpUrl("https://api.y2.dev/api/v1/chat/completions"));
}
