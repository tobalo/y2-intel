const std = @import("std");
const io_mod = @import("../shared/io.zig");
const types = @import("../shared/types.zig");
const process_supervisor = @import("../background/process_supervisor.zig");
const command_contract = @import("../execution/command_contract.zig");
const session_child_store = @import("../session/session_child_store.zig");
const session_runtime = @import("../session/session.zig");

const Allocator = std.mem.Allocator;

pub const StopSelection = process_supervisor.StopSelection;
pub const TaskState = process_supervisor.TaskState;
pub const TaskCompletion = process_supervisor.TaskCompletion;
pub const ConversationLanguage = session_runtime.ConversationLanguage;

pub fn taskStateLabel(state: TaskState) []const u8 {
    return switch (state) {
        .running => "running",
        .exited => "exited",
        .failed => "failed",
        .stopped => "stopped",
        .dead => "dead",
        .stale => "stale",
    };
}

pub fn parseTaskSelection(target: []const u8) !StopSelection {
    const trimmed = std.mem.trim(u8, target, " \t");
    if (trimmed.len == 0 or std.mem.eql(u8, trimmed, "last")) return .last;
    return .{ .id = try std.fmt.parseInt(u64, trimmed, 10) };
}

pub fn readExternalTaskLogTail(alloc: Allocator, log_path: []const u8, max_bytes: usize, max_lines: usize) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), log_path, .{});
    defer file.close(io_mod.getIo());

    const stat = try file.stat(io_mod.getIo());
    const size: usize = @intCast(stat.size);
    const tail_size = @min(size, max_bytes);
    const start = size - tail_size;

    var read_buf: [8192]u8 = undefined;
    var reader = file.reader(io_mod.getIo(), &read_buf);
    if (start > 0) try reader.seekTo(start);
    const read_limit = std.math.add(usize, tail_size, 1) catch tail_size;
    const content = try reader.interface.allocRemaining(alloc, std.Io.Limit.limited(read_limit));
    defer alloc.free(content);

    const tail = tailLogSlice(content, start, max_lines);
    return std.fmt.allocPrint(alloc, "[logs] {s}\n{s}", .{ log_path, tail });
}

pub fn readExternalTaskLogSummary(alloc: Allocator, log_path: []const u8, max_head_bytes: usize, max_tail_bytes: usize, max_lines: usize) ![]u8 {
    return readExternalTaskLogSummaryWithTopic(alloc, log_path, max_head_bytes, max_tail_bytes, max_lines, true);
}

pub fn readExternalTaskLogSummaryBody(alloc: Allocator, log_path: []const u8, max_head_bytes: usize, max_tail_bytes: usize, max_lines: usize) ![]u8 {
    return readExternalTaskLogSummaryWithTopic(alloc, log_path, max_head_bytes, max_tail_bytes, max_lines, false);
}

fn readExternalTaskLogSummaryWithTopic(alloc: Allocator, log_path: []const u8, max_head_bytes: usize, max_tail_bytes: usize, max_lines: usize, include_topic: bool) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), log_path, .{});
    defer file.close(io_mod.getIo());

    const stat = try file.stat(io_mod.getIo());
    const size: usize = @intCast(stat.size);

    const head = try readLogRange(alloc, &file, 0, @min(size, max_head_bytes));
    defer alloc.free(head);

    const tail_size = @min(size, max_tail_bytes);
    const tail_start = size - tail_size;
    const tail_raw = try readLogRange(alloc, &file, tail_start, tail_size);
    defer alloc.free(tail_raw);

    const head_slice = head[0..firstLinesEnd(head, max_lines)];
    const tail_slice = tailLogSlice(tail_raw, tail_start, max_lines);

    return formatTaskLogSummary(alloc, log_path, size, head_slice, tail_slice, include_topic);
}

pub fn readManagedTaskLogTail(
    alloc: Allocator,
    file: *session_child_store.ManagedFile,
    display_path: []const u8,
    max_bytes: usize,
    max_lines: usize,
) ![]u8 {
    const stat = try file.stat();
    const size: usize = @intCast(stat.size);
    const tail_size = @min(size, max_bytes);
    const start = size - tail_size;
    const content = try file.readRange(alloc, start, tail_size);
    defer alloc.free(content);

    const tail = tailLogSlice(content, start, max_lines);
    return std.fmt.allocPrint(
        alloc,
        "[logs] {s}\n{s}",
        .{ display_path, tail },
    );
}

pub fn readManagedTaskLogSummary(
    alloc: Allocator,
    file: *session_child_store.ManagedFile,
    display_path: []const u8,
    max_head_bytes: usize,
    max_tail_bytes: usize,
    max_lines: usize,
) ![]u8 {
    return readManagedTaskLogSummaryWithTopic(alloc, file, display_path, max_head_bytes, max_tail_bytes, max_lines, true);
}

pub fn readManagedTaskLogSummaryBody(
    alloc: Allocator,
    file: *session_child_store.ManagedFile,
    display_path: []const u8,
    max_head_bytes: usize,
    max_tail_bytes: usize,
    max_lines: usize,
) ![]u8 {
    return readManagedTaskLogSummaryWithTopic(alloc, file, display_path, max_head_bytes, max_tail_bytes, max_lines, false);
}

fn readManagedTaskLogSummaryWithTopic(
    alloc: Allocator,
    file: *session_child_store.ManagedFile,
    display_path: []const u8,
    max_head_bytes: usize,
    max_tail_bytes: usize,
    max_lines: usize,
    include_topic: bool,
) ![]u8 {
    const stat = try file.stat();
    const size: usize = @intCast(stat.size);
    const head = try file.readRange(alloc, 0, @min(size, max_head_bytes));
    defer alloc.free(head);

    const tail_size = @min(size, max_tail_bytes);
    const tail_start = size - tail_size;
    const tail_raw = try file.readRange(alloc, tail_start, tail_size);
    defer alloc.free(tail_raw);

    const head_slice = head[0..firstLinesEnd(head, max_lines)];
    const tail_slice = tailLogSlice(tail_raw, tail_start, max_lines);

    return formatTaskLogSummary(alloc, display_path, size, head_slice, tail_slice, include_topic);
}

fn formatTaskLogSummary(
    alloc: Allocator,
    display_path: []const u8,
    size: usize,
    head: []const u8,
    tail: []const u8,
    include_topic: bool,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    if (include_topic) try out.writer.writeAll("[logs] ");
    try out.writer.print("{s}\nbytes={d}\n<head>\n{s}</head>\n<tail>\n{s}</tail>\n", .{
        display_path,
        size,
        head,
        tail,
    });
    return try out.toOwnedSlice();
}

pub fn formatBackgroundCommandNotice(alloc: Allocator, task_id: u64, background: command_contract.BackgroundCommand, language: ConversationLanguage) ![]u8 {
    _ = language;
    if (background.url) |url| {
        return std.fmt.allocPrint(alloc, "Background #{d}: server running at {s}. Log: {s}", .{ task_id, url, background.log_path });
    }

    if (background.expect_url) {
        return std.fmt.allocPrint(alloc, "Background #{d}: server started. Waiting for local URL. Log: {s}", .{ task_id, background.log_path });
    }

    return std.fmt.allocPrint(alloc, "Background #{d}: command started. Log: {s}", .{ task_id, background.log_path });
}

/// Returns a semantic notice whose body is owned by the caller.
pub fn backgroundLaunchNotice(alloc: Allocator, task_id: u64, background: command_contract.BackgroundCommand, language: ConversationLanguage) !types.SemanticNotice {
    _ = language;
    const body = if (background.url) |url|
        try std.fmt.allocPrint(alloc, "Command #{d} started. Server: {s}. Log: {s}", .{ task_id, url, background.log_path })
    else if (background.expect_url)
        try std.fmt.allocPrint(alloc, "Command #{d} started. Waiting for local URL. Log: {s}", .{ task_id, background.log_path })
    else
        try std.fmt.allocPrint(alloc, "Command #{d} started. Log: {s}", .{ task_id, background.log_path });
    return .{
        .topic = "background",
        .tone = .neutral,
        .body = body,
    };
}

/// Returns a semantic notice whose body is owned by the caller.
pub fn backgroundServerReadyNotice(alloc: Allocator, task_id: u64, url: []const u8, language: ConversationLanguage) !types.SemanticNotice {
    _ = language;
    return .{
        .topic = "background",
        .tone = .neutral,
        .body = try std.fmt.allocPrint(alloc, "Command #{d} server ready at {s}.", .{ task_id, url }),
    };
}

/// Returns a semantic notice whose body is owned by the caller.
pub fn backgroundCompletionNotice(alloc: Allocator, completion: TaskCompletion, language: ConversationLanguage) !types.SemanticNotice {
    _ = language;
    const tone: types.NoticeTone = switch (completion.state) {
        .exited, .running => .neutral,
        .failed, .dead, .stale => .@"error",
        .stopped => .cancelled,
    };
    const body = switch (completion.state) {
        .exited => try std.fmt.allocPrint(alloc, "Command #{d} completed successfully.", .{completion.id}),
        .failed => if (completion.exit_code) |code|
            try std.fmt.allocPrint(alloc, "Command #{d} failed (exit {d}).", .{ completion.id, code })
        else
            try std.fmt.allocPrint(alloc, "Command #{d} failed.", .{completion.id}),
        .stopped => try std.fmt.allocPrint(alloc, "Command #{d} stopped.", .{completion.id}),
        .dead => try std.fmt.allocPrint(alloc, "Command #{d} is no longer running.", .{completion.id}),
        .stale => try std.fmt.allocPrint(alloc, "Command #{d} is stale.", .{completion.id}),
        .running => try std.fmt.allocPrint(alloc, "Command #{d} is running.", .{completion.id}),
    };
    return .{
        .topic = "background",
        .tone = tone,
        .body = body,
    };
}

fn tailLogSlice(content: []const u8, window_start: usize, max_lines: usize) []const u8 {
    var slice = content;
    if (window_start > 0) {
        slice = if (std.mem.findScalar(u8, slice, '\n')) |newline_index|
            slice[newline_index + 1 ..]
        else
            slice[slice.len..];
    }
    return slice[finalLinesStart(slice, max_lines)..];
}

fn readLogRange(alloc: Allocator, file: *std.Io.File, start: usize, len: usize) ![]u8 {
    if (len == 0) return alloc.dupe(u8, "");
    var read_buf: [8192]u8 = undefined;
    var reader = file.reader(io_mod.getIo(), &read_buf);
    try reader.seekTo(start);
    const out = try alloc.alloc(u8, len);
    errdefer alloc.free(out);
    const read_len = try reader.interface.readSliceShort(out);
    if (read_len == out.len) return out;
    const resized = try alloc.realloc(out, read_len);
    return resized;
}

fn firstLinesEnd(text: []const u8, max_lines: usize) usize {
    if (max_lines == 0) return 0;

    var separator_count: usize = 0;
    for (text, 0..) |byte, i| {
        if (byte != '\n') continue;
        separator_count += 1;
        if (separator_count == max_lines) return i + 1;
    }

    return text.len;
}

fn finalLinesStart(text: []const u8, max_lines: usize) usize {
    if (max_lines == 0) return text.len;

    var separator_count: usize = 0;
    var i = text.len;
    while (i > 0) {
        i -= 1;
        if (text[i] != '\n') continue;
        if (i == text.len - 1) continue;

        separator_count += 1;
        if (separator_count == max_lines) return i + 1;
    }

    return 0;
}

fn writeAbsoluteFile(path: []const u8, text: []const u8) !void {
    var file = try std.Io.Dir.createFileAbsolute(io_mod.getIo(), path, .{ .truncate = true });
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), text);
}

fn tmpPath(alloc: Allocator, tmp: std.testing.TmpDir, name: []const u8) ![]u8 {
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, name });
}

test "parseTaskSelection accepts defaults and numeric ids and rejects malformed ids" {
    try std.testing.expectEqual(StopSelection.last, try parseTaskSelection(""));
    try std.testing.expectEqual(StopSelection.last, try parseTaskSelection(" \t "));
    try std.testing.expectEqual(StopSelection.last, try parseTaskSelection("last"));
    try std.testing.expectEqual(StopSelection{ .id = 42 }, try parseTaskSelection("42"));

    try std.testing.expectError(error.InvalidCharacter, parseTaskSelection("abc"));
    try std.testing.expectError(error.InvalidCharacter, parseTaskSelection("12abc"));
}

test "taskStateLabel covers every task state" {
    try std.testing.expectEqualStrings("running", taskStateLabel(.running));
    try std.testing.expectEqualStrings("exited", taskStateLabel(.exited));
    try std.testing.expectEqualStrings("failed", taskStateLabel(.failed));
    try std.testing.expectEqualStrings("stopped", taskStateLabel(.stopped));
    try std.testing.expectEqualStrings("dead", taskStateLabel(.dead));
    try std.testing.expectEqualStrings("stale", taskStateLabel(.stale));
}

test "managed task log tail and summary read already open file" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "logs");
    const logs_dir = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "logs");
    defer alloc.free(logs_dir);
    var capability = try session_child_store.SessionChildCapability.initLegacyRoute(
        alloc,
        logs_dir,
        .background_logs,
        .writable,
    );
    defer capability.deinit();
    var file = try capability.createExclusiveFile(
        alloc,
        .background_logs,
        "managed.log",
    );
    defer file.deinit();
    try file.writeAll("one\ntwo\nthree\nfour\n");
    try file.sync();

    const tail = try readManagedTaskLogTail(
        alloc,
        &file,
        "managed.log",
        64,
        2,
    );
    defer alloc.free(tail);
    try std.testing.expectEqualStrings("[logs] managed.log\nthree\nfour\n", tail);

    const summary = try readManagedTaskLogSummary(
        alloc,
        &file,
        "managed.log",
        8,
        12,
        2,
    );
    defer alloc.free(summary);
    try std.testing.expectEqualStrings(
        "[logs] managed.log\nbytes=19\n<head>\none\ntwo\n</head>\n<tail>\nthree\nfour\n</tail>\n",
        summary,
    );
}

test "background headless and interactive launch notices preserve distinct contracts" {
    const alloc = std.testing.allocator;
    const language = ConversationLanguage.default();

    const with_url = try formatBackgroundCommandNotice(alloc, 7, .{
        .pid = "100",
        .command = "npm run dev",
        .cwd = "/tmp/app",
        .log_path = "/tmp/y2-cmd.log",
        .url = "http://localhost:3000",
        .expect_url = true,
    }, language);
    defer alloc.free(with_url);
    try std.testing.expectEqualStrings("Background #7: server running at http://localhost:3000. Log: /tmp/y2-cmd.log", with_url);

    const waiting = try formatBackgroundCommandNotice(alloc, 8, .{
        .pid = "101",
        .command = "npm run dev",
        .cwd = "/tmp/app",
        .log_path = "/tmp/y2-cmd.log",
        .expect_url = true,
    }, language);
    defer alloc.free(waiting);
    try std.testing.expectEqualStrings("Background #8: server started. Waiting for local URL. Log: /tmp/y2-cmd.log", waiting);

    const command = try formatBackgroundCommandNotice(alloc, 9, .{
        .pid = "102",
        .command = "zig build test",
        .cwd = "/tmp/app",
        .log_path = "/tmp/y2-cmd.log",
    }, language);
    defer alloc.free(command);
    try std.testing.expectEqualStrings("Background #9: command started. Log: /tmp/y2-cmd.log", command);

    const interactive = try backgroundLaunchNotice(alloc, 9, .{
        .pid = "102",
        .command = "zig build test",
        .cwd = "/tmp/app",
        .log_path = "/tmp/y2-cmd.log",
    }, language);
    defer alloc.free(interactive.body);
    try std.testing.expectEqualStrings("background", interactive.topic);
    try std.testing.expectEqual(types.NoticeTone.neutral, interactive.tone);
    try std.testing.expectEqualStrings("Command #9 started. Log: /tmp/y2-cmd.log", interactive.body);
    try std.testing.expect(std.mem.find(u8, interactive.body, "Background") == null);
}

test "background ready and completion notices own one semantic topic and outcome tone" {
    const alloc = std.testing.allocator;
    const language = ConversationLanguage.default();

    const ready = try backgroundServerReadyNotice(alloc, 7, "http://localhost:3000", language);
    defer alloc.free(ready.body);
    try std.testing.expectEqualStrings("background", ready.topic);
    try std.testing.expectEqual(types.NoticeTone.neutral, ready.tone);
    try std.testing.expectEqualStrings("Command #7 server ready at http://localhost:3000.", ready.body);

    const exited = try backgroundCompletionNotice(alloc, .{ .id = 7, .state = .exited, .exit_code = 0 }, language);
    defer alloc.free(exited.body);
    try std.testing.expectEqual(types.NoticeTone.neutral, exited.tone);
    try std.testing.expectEqualStrings("Command #7 completed successfully.", exited.body);

    const failed_code = try backgroundCompletionNotice(alloc, .{ .id = 8, .state = .failed, .exit_code = 2 }, language);
    defer alloc.free(failed_code.body);
    try std.testing.expectEqual(types.NoticeTone.@"error", failed_code.tone);
    try std.testing.expectEqualStrings("Command #8 failed (exit 2).", failed_code.body);

    const failed = try backgroundCompletionNotice(alloc, .{ .id = 9, .state = .failed, .exit_code = null }, language);
    defer alloc.free(failed.body);
    try std.testing.expectEqual(types.NoticeTone.@"error", failed.tone);
    try std.testing.expectEqualStrings("Command #9 failed.", failed.body);

    const stopped = try backgroundCompletionNotice(alloc, .{ .id = 10, .state = .stopped, .exit_code = null }, language);
    defer alloc.free(stopped.body);
    try std.testing.expectEqual(types.NoticeTone.cancelled, stopped.tone);
    try std.testing.expectEqualStrings("Command #10 stopped.", stopped.body);

    const dead = try backgroundCompletionNotice(alloc, .{ .id = 11, .state = .dead, .exit_code = null }, language);
    defer alloc.free(dead.body);
    try std.testing.expectEqual(types.NoticeTone.@"error", dead.tone);
    try std.testing.expectEqualStrings("Command #11 is no longer running.", dead.body);

    const stale = try backgroundCompletionNotice(alloc, .{ .id = 12, .state = .stale, .exit_code = null }, language);
    defer alloc.free(stale.body);
    try std.testing.expectEqual(types.NoticeTone.@"error", stale.tone);
    try std.testing.expectEqualStrings("Command #12 is stale.", stale.body);

    const running = try backgroundCompletionNotice(alloc, .{ .id = 13, .state = .running, .exit_code = null }, language);
    defer alloc.free(running.body);
    try std.testing.expectEqual(types.NoticeTone.neutral, running.tone);
    try std.testing.expectEqualStrings("Command #13 is running.", running.body);

    inline for (.{ ready, exited, failed_code, failed, stopped, dead, stale, running }) |notice| {
        try std.testing.expectEqualStrings("background", notice.topic);
        try std.testing.expect(std.mem.find(u8, notice.body, "Background") == null);
    }
}

test "readExternalTaskLogTail respects max_bytes and omits earlier content" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const path = try tmpPath(alloc, tmp, "large.log");
    defer alloc.free(path);
    try writeAbsoluteFile(path, "early-content\nmiddle-content\nlate-one\nlate-two\n");

    const text = try readExternalTaskLogTail(alloc, path, 18, 10);
    defer alloc.free(text);

    try std.testing.expect(std.mem.find(u8, text, "early-content") == null);
    try std.testing.expect(std.mem.find(u8, text, "middle-content") == null);
    try std.testing.expect(std.mem.find(u8, text, "late-two") != null);
}

test "readExternalTaskLogTail respects max_lines and drops partial first line" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const path = try tmpPath(alloc, tmp, "lines.log");
    defer alloc.free(path);
    try writeAbsoluteFile(path, "alpha-should-drop\nbeta\ncharlie\ndelta\necho\n");

    const text = try readExternalTaskLogTail(alloc, path, 21, 2);
    defer alloc.free(text);

    const expected = try std.fmt.allocPrint(alloc, "[logs] {s}\ndelta\necho\n", .{path});
    defer alloc.free(expected);
    try std.testing.expectEqualStrings(expected, text);
}

test "readExternalTaskLogTail returns useful error for missing log file" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const path = try tmpPath(alloc, tmp, "missing.log");
    defer alloc.free(path);
    try std.testing.expectError(
        error.FileNotFound,
        readExternalTaskLogTail(alloc, path, 1024, 40),
    );
}

test "readExternalTaskLogSummary includes head tail bytes and path" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const path = try tmpPath(alloc, tmp, "long.log");
    defer alloc.free(path);
    try writeAbsoluteFile(path, "head-one\nhead-two\nmiddle-one\nmiddle-two\ntail-one\ntail-two\n");

    const text = try readExternalTaskLogSummary(alloc, path, 18, 18, 2);
    defer alloc.free(text);

    try std.testing.expect(std.mem.find(u8, text, "[logs] ") != null);
    try std.testing.expect(std.mem.find(u8, text, "bytes=") != null);
    try std.testing.expect(std.mem.find(u8, text, "<head>") != null);
    try std.testing.expect(std.mem.find(u8, text, "head-one") != null);
    try std.testing.expect(std.mem.find(u8, text, "<tail>") != null);
    try std.testing.expect(std.mem.find(u8, text, "tail-two") != null);
}
