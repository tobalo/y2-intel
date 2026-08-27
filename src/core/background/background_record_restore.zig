const std = @import("std");
const io_mod = @import("../shared/io.zig");
const background_record_liveness = @import("background_record_liveness.zig");
const background_store = @import("background_store.zig");
const background_process_provider = @import(
    "../execution/background_process_provider.zig",
);
const process_supervisor = @import("process_supervisor.zig");
const server_detection = @import("server_detection.zig");
const session_child_store = @import("../session/session_child_store.zig");

const Allocator = std.mem.Allocator;

pub const Input = struct {
    process_provider: background_process_provider.Provider =
        background_process_provider.unavailable_provider,
    store: background_store.Store,
    record: *background_store.Record,
    source_session_id: ?[]const u8,
    authority: ?process_supervisor.RecordAuthority,
};

pub const Result = union(enum) {
    not_attachable,
    skipped,
    task: process_supervisor.TaskSnapshot,
};

pub fn prepare(alloc: Allocator, input: Input) Result {
    if (!recordCanAttach(
        alloc,
        input.process_provider,
        input.store,
        input.record.*,
    )) {
        return .not_attachable;
    }
    const source_session_id = input.source_session_id orelse return .skipped;
    const authority = input.authority orelse return .skipped;
    switch (authority) {
        .none => return .skipped,
        .read_only, .writable => {},
    }
    if (input.record.server_url == null) {
        input.record.server_url = detectServerUrl(
            alloc,
            authority,
            input.record.*,
        ) catch null;
        if (input.record.server_url != null) {
            input.record.expect_url = false;
        }
    }
    const task = taskSnapshot(
        alloc,
        input.record.*,
        source_session_id,
        authority,
    ) catch return .skipped;
    return .{ .task = task };
}

fn recordCanAttach(
    alloc: Allocator,
    process_provider: background_process_provider.Provider,
    store: background_store.Store,
    record: background_store.Record,
) bool {
    if (record.state != .running) return false;
    const stable_id = record.background_record_id orelse return false;
    const token_text = record.process_token orelse return false;
    const log_storage = record.log_storage orelse return false;
    switch (log_storage) {
        .external => |value| {
            if (!background_record_liveness.absoluteFileExists(value.path)) {
                return false;
            }
        },
        .managed_session => |value| {
            var log_file = store.capability.openFileReadOnly(
                alloc,
                .background_logs,
                value.managed_log_name,
            ) catch return false;
            log_file.deinit();
        },
    }
    var exact = store.loadByStableId(alloc, stable_id) catch return false;
    defer exact.deinit(alloc);
    const token = process_supervisor.ProcessInstanceToken.parse(
        token_text,
    ) catch return false;
    return process_provider.matchToken(
        alloc,
        record.pid,
        token,
    ) == .matched;
}

fn detectServerUrl(
    alloc: Allocator,
    authority: process_supervisor.RecordAuthority,
    record: background_store.Record,
) !?[]u8 {
    const storage = record.log_storage orelse return null;
    return switch (storage) {
        .external => |value| server_detection.detectServerUrl(
            alloc,
            value.path,
        ),
        .managed_session => |value| blk: {
            const capability = switch (authority) {
                .none => return null,
                .read_only, .writable => |item| item,
            };
            var file = try capability.openFileReadOnly(
                alloc,
                .background_logs,
                value.managed_log_name,
            );
            defer file.deinit();
            const stat = try file.stat();
            if (stat.size > 64 * 1024) return error.StreamTooLong;
            const content = try file.readRange(
                alloc,
                0,
                @intCast(stat.size),
            );
            defer alloc.free(content);
            break :blk try server_detection.detectServerUrlFromContent(
                alloc,
                content,
            );
        },
    };
}

fn taskSnapshot(
    alloc: Allocator,
    record: background_store.Record,
    source_session_id: []const u8,
    authority: process_supervisor.RecordAuthority,
) !process_supervisor.TaskSnapshot {
    const pid = try alloc.dupe(u8, record.pid);
    errdefer alloc.free(pid);
    const command = try alloc.dupe(u8, record.command);
    errdefer alloc.free(command);
    const cwd = try alloc.dupe(u8, record.cwd);
    errdefer alloc.free(cwd);
    const log_path = try alloc.dupe(u8, record.log_path);
    errdefer alloc.free(log_path);

    var server_url: ?[]u8 = null;
    errdefer if (server_url) |url| alloc.free(url);
    if (record.server_url) |url| {
        server_url = try alloc.dupe(u8, url);
    }
    var managed_log_name: ?[]u8 = null;
    errdefer if (managed_log_name) |name| alloc.free(name);
    if (record.log_storage) |storage| {
        switch (storage) {
            .managed_session => |value| {
                managed_log_name = try alloc.dupe(
                    u8,
                    value.managed_log_name,
                );
            },
            .external => {},
        }
    }

    return .{
        .id = record.id,
        .pid = pid,
        .process_token = if (record.process_token) |token|
            try process_supervisor.ProcessInstanceToken.parse(token)
        else
            null,
        .policy = .durable_long_lived,
        .source_session_id = try alloc.dupe(u8, source_session_id),
        .background_record_id = record.background_record_id,
        .durable_record_id = record.id,
        .record_authority = authority,
        .record_persistence = .confirmed,
        .managed_log_name = managed_log_name,
        .command = command,
        .cwd = cwd,
        .log_path = log_path,
        .expect_url = record.expect_url,
        .server_url = server_url,
        .started_at_ms = record.started_at_ms,
        .exit_code = record.exit_code,
        .state = record.state,
    };
}

const TestStore = struct {
    alloc: Allocator,
    background_dir: []u8,
    capability: *session_child_store.SessionChildCapability,
    store: background_store.Store,

    fn init(alloc: Allocator, tmp: std.testing.TmpDir) !TestStore {
        try tmp.dir.createDirPath(io_mod.getIo(), "background");
        const background_dir = try io_mod.dirRealpathAlloc(
            alloc,
            tmp.dir,
            "background",
        );
        errdefer alloc.free(background_dir);
        const capability = try alloc.create(
            session_child_store.SessionChildCapability,
        );
        errdefer alloc.destroy(capability);
        capability.* = try session_child_store.SessionChildCapability.initLegacyBackgroundRoutes(
            alloc,
            background_dir,
            .writable,
        );
        errdefer capability.deinit();
        return .{
            .alloc = alloc,
            .background_dir = background_dir,
            .capability = capability,
            .store = background_store.Store.initManaged(capability),
        };
    }

    fn deinit(self: *TestStore) void {
        self.capability.deinit();
        self.alloc.destroy(self.capability);
        self.alloc.free(self.background_dir);
        self.* = undefined;
    }
};

fn writeAbsoluteFile(path: []const u8, text: []const u8) !void {
    var file = try std.Io.Dir.createFileAbsolute(
        io_mod.getIo(),
        path,
        .{ .truncate = true },
    );
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), text);
}

fn tempPath(
    alloc: Allocator,
    tmp: std.testing.TmpDir,
    name: []const u8,
) ![]u8 {
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, name });
}

fn testRecord(
    alloc: Allocator,
    id: u64,
    log_path: []const u8,
) !background_store.Record {
    const pid = try alloc.dupe(u8, "12345");
    errdefer alloc.free(pid);
    const process_token = try alloc.dupe(
        u8,
        "linux:00112233445566778899aabbccddeeff:12345",
    );
    errdefer alloc.free(process_token);
    const command = try alloc.dupe(u8, "npm run dev");
    errdefer alloc.free(command);
    const cwd = try alloc.dupe(u8, "/tmp/y2");
    errdefer alloc.free(cwd);
    const owned_log_path = try alloc.dupe(u8, log_path);
    errdefer alloc.free(owned_log_path);
    const external_path = try alloc.dupe(u8, log_path);
    errdefer alloc.free(external_path);

    return .{
        .id = id,
        .background_record_id = [_]u8{@intCast(id)} ** 16,
        .process_token = process_token,
        .pid = pid,
        .command = command,
        .cwd = cwd,
        .log_path = owned_log_path,
        .log_storage = .{ .external = .{ .path = external_path } },
        .expect_url = true,
        .started_at_ms = 1,
        .updated_at_ms = 2,
        .state = .running,
    };
}

test "background record restore prepares external snapshots with writable authority" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var test_store = try TestStore.init(alloc, tmp);
    defer test_store.deinit();

    const log_path = try tempPath(alloc, tmp, "external.log");
    defer alloc.free(log_path);
    try writeAbsoluteFile(
        log_path,
        "ready - started server on 0.0.0.0:3000, url: http://localhost:3000\n",
    );
    var record = try testRecord(alloc, 1, log_path);
    defer record.deinit(alloc);
    try test_store.store.saveRecord(alloc, record);

    const Stub = struct {
        fn match(
            _: []const u8,
            _: process_supervisor.ProcessInstanceToken,
        ) process_supervisor.TokenMatch {
            return .matched;
        }
    };
    process_supervisor.process_token_match_for_test = Stub.match;
    defer process_supervisor.process_token_match_for_test = null;

    const result = prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &record,
        .source_session_id = "current-session",
        .authority = .{ .writable = test_store.capability },
    });
    switch (result) {
        .task => |task| {
            var snapshot = task;
            defer snapshot.deinit(alloc);
            try std.testing.expectEqualStrings("http://localhost:3000", record.server_url.?);
            try std.testing.expect(!record.expect_url);
            try std.testing.expect(snapshot.pid.ptr != record.pid.ptr);
            snapshot.pid[0] = '9';
            try std.testing.expectEqualStrings("12345", record.pid);
            switch (snapshot.record_authority) {
                .writable => |capability| try std.testing.expect(capability == test_store.capability),
                .none, .read_only => return error.TestExpectedEqual,
            }
        },
        .not_attachable, .skipped => return error.TestExpectedEqual,
    }

    var persisted = try test_store.store.loadByStableId(
        alloc,
        record.background_record_id.?,
    );
    defer persisted.deinit(alloc);
    try std.testing.expect(persisted.server_url == null);
}

test "background record restore prepares managed snapshots with read only authority" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var test_store = try TestStore.init(alloc, tmp);
    defer test_store.deinit();

    var log_entry = try test_store.capability.atomicReplace(
        alloc,
        .background_logs,
        "managed.log",
        "Local: http://localhost:4173\n",
    );
    defer log_entry.deinit(alloc);
    var record = try testRecord(alloc, 2, "/tmp/managed.log");
    defer record.deinit(alloc);
    if (record.log_storage) |*storage| storage.deinit(alloc);
    record.log_storage = .{ .managed_session = .{
        .managed_log_name = try alloc.dupe(u8, "managed.log"),
    } };
    try test_store.store.saveRecord(alloc, record);

    const Stub = struct {
        fn match(
            _: []const u8,
            _: process_supervisor.ProcessInstanceToken,
        ) process_supervisor.TokenMatch {
            return .matched;
        }
    };
    process_supervisor.process_token_match_for_test = Stub.match;
    defer process_supervisor.process_token_match_for_test = null;

    const result = prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &record,
        .source_session_id = "other-session",
        .authority = .{ .read_only = test_store.capability },
    });
    switch (result) {
        .task => |task| {
            var snapshot = task;
            defer snapshot.deinit(alloc);
            try std.testing.expectEqualStrings("managed.log", snapshot.managed_log_name.?);
            try std.testing.expect(snapshot.managed_log_name.?.ptr != record.log_storage.?.managed_session.managed_log_name.ptr);
            switch (snapshot.record_authority) {
                .read_only => |capability| try std.testing.expect(capability == test_store.capability),
                .none, .writable => return error.TestExpectedEqual,
            }
        },
        .not_attachable, .skipped => return error.TestExpectedEqual,
    }
}

test "background record restore treats missing logs malformed tokens and mismatched identity as non attachable" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var test_store = try TestStore.init(alloc, tmp);
    defer test_store.deinit();

    const missing_log_path = try tempPath(alloc, tmp, "missing.log");
    defer alloc.free(missing_log_path);
    var missing_log = try testRecord(alloc, 3, missing_log_path);
    defer missing_log.deinit(alloc);
    try test_store.store.saveRecord(alloc, missing_log);
    try std.testing.expect(prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &missing_log,
        .source_session_id = "source",
        .authority = .{ .writable = test_store.capability },
    }) == .not_attachable);

    const log_path = try tempPath(alloc, tmp, "live.log");
    defer alloc.free(log_path);
    try writeAbsoluteFile(log_path, "stdout\n");
    var malformed_token = try testRecord(alloc, 4, log_path);
    defer malformed_token.deinit(alloc);
    try test_store.store.saveRecord(alloc, malformed_token);
    alloc.free(malformed_token.process_token.?);
    malformed_token.process_token = try alloc.dupe(u8, "not-a-token");
    try std.testing.expect(prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &malformed_token,
        .source_session_id = "source",
        .authority = .{ .writable = test_store.capability },
    }) == .not_attachable);

    var mismatched_identity = try testRecord(alloc, 5, log_path);
    defer mismatched_identity.deinit(alloc);
    try test_store.store.saveRecord(alloc, mismatched_identity);
    const Stub = struct {
        fn match(
            _: []const u8,
            _: process_supervisor.ProcessInstanceToken,
        ) process_supervisor.TokenMatch {
            return .mismatched;
        }
    };
    process_supervisor.process_token_match_for_test = Stub.match;
    defer process_supervisor.process_token_match_for_test = null;
    try std.testing.expect(prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &mismatched_identity,
        .source_session_id = "source",
        .authority = .{ .writable = test_store.capability },
    }) == .not_attachable);
}

test "background record restore validates before skipping unavailable source or authority" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var test_store = try TestStore.init(alloc, tmp);
    defer test_store.deinit();

    const log_path = try tempPath(alloc, tmp, "live.log");
    defer alloc.free(log_path);
    try writeAbsoluteFile(
        log_path,
        "Local: http://localhost:3000\n",
    );
    var record = try testRecord(alloc, 6, log_path);
    defer record.deinit(alloc);
    try test_store.store.saveRecord(alloc, record);

    const Stub = struct {
        var calls: usize = 0;

        fn match(
            _: []const u8,
            _: process_supervisor.ProcessInstanceToken,
        ) process_supervisor.TokenMatch {
            calls += 1;
            return .matched;
        }
    };
    Stub.calls = 0;
    process_supervisor.process_token_match_for_test = Stub.match;
    defer process_supervisor.process_token_match_for_test = null;

    try std.testing.expect(prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &record,
        .source_session_id = null,
        .authority = .{ .writable = test_store.capability },
    }) == .skipped);
    try std.testing.expectEqual(@as(usize, 1), Stub.calls);
    try std.testing.expect(record.server_url == null);
    try std.testing.expect(record.expect_url);

    try std.testing.expect(prepare(alloc, .{
        .process_provider = background_process_provider.process_supervisor_test_provider,
        .store = test_store.store,
        .record = &record,
        .source_session_id = "source",
        .authority = null,
    }) == .skipped);
    try std.testing.expectEqual(@as(usize, 2), Stub.calls);
    try std.testing.expect(record.server_url == null);
    try std.testing.expect(record.expect_url);
}
