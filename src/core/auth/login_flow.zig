const std = @import("std");
const chatgpt_session = @import("chatgpt_session.zig");
const grok_session = @import("grok_session.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const host = @import("../hosts/host.zig");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");
const oauth = @import("oauth.zig");
const oauth_transport = @import("oauth_transport.zig");

const Allocator = std.mem.Allocator;
const poll_wait_slice_ms: u64 = 100;
pub const poll_request_timeout_ms: i64 = 15_000;
const max_poll_interval_ms = std.math.maxInt(u64) / std.time.ns_per_ms;

pub const LoginError = error{LoginTimedOut};

pub const SignInState = enum {
    idle,
    polling,
    succeeded,
    failed,
    cancelled,
};

pub const SignInSnapshot = struct {
    state: SignInState = .idle,
    verification_uri: []const u8 = "",
    verification_uri_complete: ?[]const u8 = null,
    user_code: []const u8 = "",
    accepts_manual_code: bool = false,
};

pub const max_manual_code_bytes: usize = 4096;

pub const SignInCompletion = union(enum) {
    chatgpt: chatgpt_session.Session,
    grok: grok_session.Session,

    pub fn deinit(self: *SignInCompletion, alloc: Allocator) void {
        switch (self.*) {
            .chatgpt => |*session| session.deinit(alloc),
            .grok => |*session| session.deinit(alloc),
        }
        self.* = undefined;
    }
};

pub const SignInTransition = union(enum) {
    none,
    succeeded: SignInCompletion,
    failed: anyerror,
    cancelled,
};

pub const PreparedLogin = struct {
    metadata: oauth.Metadata,
    device: oauth.DeviceAuthorization,
    client_id: []u8,

    pub fn deinit(self: *PreparedLogin, alloc: Allocator) void {
        self.metadata.deinit(alloc);
        self.device.deinit(alloc);
        alloc.free(self.client_id);
        self.* = undefined;
    }
};

pub const CompleteSignInFn = *const fn (
    ?*anyopaque,
    Allocator,
    []const u8,
    []const u8,
    *oauth.TokenSet,
) anyerror!SignInCompletion;
pub const SaveSignInFn = *const fn (?*anyopaque, Allocator, SignInCompletion) anyerror!void;
pub const DeinitSignInContextFn = *const fn (?*anyopaque, Allocator) void;
pub const SubmitManualCodeFn = *const fn (?*anyopaque, Allocator, []const u8) anyerror!void;

fn unavailableCompleteSignIn(
    _: ?*anyopaque,
    _: Allocator,
    _: []const u8,
    _: []const u8,
    _: *oauth.TokenSet,
) !SignInCompletion {
    return error.SignInCompletionUnavailable;
}

fn unavailableSaveSignIn(_: ?*anyopaque, _: Allocator, _: SignInCompletion) !void {
    return error.SignInPersistenceUnavailable;
}

pub const SignInRuntimeDeps = struct {
    ctx: ?*anyopaque = null,
    deinit_ctx: ?DeinitSignInContextFn = null,
    oauth_transport: oauth_transport.Provider = oauth_transport.unavailable_provider,
    poll: LoginPollDeps = .{},
    complete: CompleteSignInFn = unavailableCompleteSignIn,
    save: SaveSignInFn = unavailableSaveSignIn,
    submit_manual_code: ?SubmitManualCodeFn = null,
};

pub const SignInRuntime = struct {
    const Self = @This();

    mutex: std.Io.Mutex = .init,
    thread: ?std.Thread = null,
    cancel_requested: std.atomic.Value(bool) = .init(false),
    state: SignInState = .idle,
    flow: ?PreparedLogin = null,
    completion: ?SignInCompletion = null,
    failure: ?anyerror = null,
    poll_state: ?LoginPollState = null,
    deps: SignInRuntimeDeps = .{},

    pub fn startPrepared(
        self: *Self,
        alloc: Allocator,
        prepared: PreparedLogin,
        deps: SignInRuntimeDeps,
    ) !bool {
        return self.startPreparedWithMode(alloc, prepared, deps, host_target.is_wasm);
    }

    fn startPreparedCooperative(
        self: *Self,
        alloc: Allocator,
        prepared: PreparedLogin,
        deps: SignInRuntimeDeps,
    ) !bool {
        return self.startPreparedWithMode(alloc, prepared, deps, true);
    }

    fn startPreparedWithMode(
        self: *Self,
        alloc: Allocator,
        prepared: PreparedLogin,
        deps: SignInRuntimeDeps,
        comptime cooperative: bool,
    ) !bool {
        const poll_state = if (cooperative)
            LoginPollState.init(deps.poll, prepared.device) catch |err| {
                var rejected = prepared;
                rejected.deinit(alloc);
                if (deps.deinit_ctx) |deinit_ctx| deinit_ctx(deps.ctx, alloc);
                return err;
            }
        else
            null;
        self.mutex.lockUncancelable(io_mod.getIo());
        if (self.thread != null or self.state == .polling or self.completion != null) {
            self.mutex.unlock(io_mod.getIo());
            var rejected = prepared;
            rejected.deinit(alloc);
            if (deps.deinit_ctx) |deinit_ctx| deinit_ctx(deps.ctx, alloc);
            return false;
        }
        self.state = .polling;
        self.failure = null;
        self.flow = prepared;
        self.poll_state = poll_state;
        self.deps = deps;
        self.deps.poll.cancel_flag = &self.cancel_requested;
        self.cancel_requested.store(false, .seq_cst);
        self.mutex.unlock(io_mod.getIo());

        if (cooperative) return true;
        self.thread = std.Thread.spawn(.{}, workerMain, .{ self, alloc }) catch |err| {
            self.mutex.lockUncancelable(io_mod.getIo());
            self.state = .idle;
            self.mutex.unlock(io_mod.getIo());
            self.clearFlow(alloc);
            return err;
        };
        return true;
    }

    pub fn cancel(self: *Self, alloc: Allocator) bool {
        self.cancel_requested.store(true, .seq_cst);
        self.mutex.lockUncancelable(io_mod.getIo());
        const cancelled = self.state == .polling;
        if (cancelled) self.state = .cancelled;
        const thread = self.thread;
        self.thread = null;
        self.mutex.unlock(io_mod.getIo());

        if (comptime !host_target.is_wasm) {
            if (thread) |handle| handle.join();
        }
        self.clearFlow(alloc);
        return cancelled;
    }

    pub fn deinit(self: *Self, alloc: Allocator) void {
        _ = self.cancel(alloc);
        if (self.completion) |*selection| selection.deinit(alloc);
        self.completion = null;
        self.failure = null;
        self.state = .idle;
    }

    pub fn snapshot(self: *const Self) SignInSnapshot {
        const mutable = @constCast(self);
        mutable.mutex.lockUncancelable(io_mod.getIo());
        defer mutable.mutex.unlock(io_mod.getIo());
        const flow = self.flow orelse return .{ .state = self.state };
        return .{
            .state = self.state,
            .verification_uri = flow.device.verification_uri,
            .verification_uri_complete = flow.device.verification_uri_complete,
            .user_code = flow.device.user_code,
            .accepts_manual_code = self.deps.submit_manual_code != null,
        };
    }

    pub fn submitManualCode(self: *Self, alloc: Allocator, code: []const u8) !bool {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (self.state != .polling) return false;
        const submit = self.deps.submit_manual_code orelse return false;
        try submit(self.deps.ctx, alloc, code);
        return true;
    }

    pub fn browserUrlAlloc(self: *Self, alloc: Allocator) !?[]u8 {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        const flow = self.flow orelse return null;
        const url = flow.device.verification_uri_complete orelse flow.device.verification_uri;
        return try alloc.dupe(u8, url);
    }

    pub fn pollTransition(self: *Self, alloc: Allocator) SignInTransition {
        self.mutex.lockUncancelable(io_mod.getIo());
        const terminal = switch (self.state) {
            .succeeded, .failed, .cancelled => true,
            .idle, .polling => false,
        };
        const thread = if (terminal) self.thread else null;
        if (terminal) self.thread = null;
        self.mutex.unlock(io_mod.getIo());
        if (!terminal) return .none;

        if (comptime !host_target.is_wasm) {
            if (thread) |handle| handle.join();
        }
        self.clearFlow(alloc);

        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        const state = self.state;
        self.state = .idle;
        return switch (state) {
            .succeeded => blk: {
                const completion = self.completion orelse break :blk .{ .failed = error.LoginCompletionMissing };
                self.completion = null;
                break :blk .{ .succeeded = completion };
            },
            .failed => blk: {
                const failure = self.failure orelse error.OAuthRequestFailed;
                self.failure = null;
                break :blk .{ .failed = failure };
            },
            .cancelled => .cancelled,
            .idle, .polling => .none,
        };
    }

    fn workerMain(self: *Self, alloc: Allocator) void {
        const flow = if (self.flow) |*prepared| prepared else return;
        var prompt = BrowserOpenPrompt{ .url = flow.device.verification_uri };
        var token = pollForTokenWithDeps(
            alloc,
            self.deps.oauth_transport,
            flow.metadata,
            flow.client_id,
            flow.device,
            &prompt,
            self.deps.poll,
        ) catch |err| {
            self.publishFailure(err);
            return;
        };
        defer token.deinit(alloc);

        self.completeToken(alloc, &token);
    }

    pub fn pulse(self: *Self, alloc: Allocator) void {
        if (comptime !host_target.is_wasm) return;
        self.pulseCooperative(alloc);
    }

    fn pulseCooperative(self: *Self, alloc: Allocator) void {
        if (self.state != .polling) return;
        const flow = if (self.flow) |*prepared| prepared else return;
        const poll_state = if (self.poll_state) |*state| state else {
            self.publishFailure(error.LoginPollStateMissing);
            return;
        };
        const step = pollTokenStep(
            alloc,
            self.deps.oauth_transport,
            flow.metadata,
            flow.client_id,
            flow.device,
            self.deps.poll,
            poll_state,
        ) catch |err| {
            self.publishFailure(err);
            return;
        };
        switch (step) {
            .waiting => {},
            .succeeded => |token| {
                var owned = token;
                defer owned.deinit(alloc);
                self.completeToken(alloc, &owned);
            },
        }
    }

    fn completeToken(self: *Self, alloc: Allocator, token: *oauth.TokenSet) void {
        const flow = if (self.flow) |*prepared| prepared else {
            self.publishFailure(error.LoginFlowMissing);
            return;
        };
        if (self.cancel_requested.load(.seq_cst)) {
            debug_trace.logf("auth", "sign-in discarded token after cancel", .{});
            return;
        }
        var completion = self.deps.complete(
            self.deps.ctx,
            alloc,
            flow.metadata.issuer,
            flow.client_id,
            token,
        ) catch |err| {
            self.publishFailure(err);
            return;
        };
        var completion_owned = true;
        defer if (completion_owned) completion.deinit(alloc);

        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (self.state != .polling or self.cancel_requested.load(.seq_cst)) {
            debug_trace.logf("auth", "sign-in discarded session after cancel state={t}", .{self.state});
            return;
        }
        self.deps.save(self.deps.ctx, alloc, completion) catch |err| {
            debug_trace.logf("auth", "sign-in session save failed err={s}", .{@errorName(err)});
            self.failure = err;
            self.state = .failed;
            return;
        };
        self.completion = completion;
        completion_owned = false;
        self.state = .succeeded;
    }

    fn publishFailure(self: *Self, err: anyerror) void {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        if (self.state != .polling or self.cancel_requested.load(.seq_cst)) {
            debug_trace.logf(
                "auth",
                "sign-in suppressed post-cancel failure err={s} state={t}",
                .{ @errorName(err), self.state },
            );
            return;
        }
        if (err == error.Cancelled) {
            self.state = .cancelled;
            return;
        }
        self.failure = err;
        self.state = .failed;
    }

    fn clearFlow(self: *Self, alloc: Allocator) void {
        self.mutex.lockUncancelable(io_mod.getIo());
        var flow = self.flow;
        const deps = self.deps;
        self.flow = null;
        self.poll_state = null;
        self.deps = .{};
        self.mutex.unlock(io_mod.getIo());
        if (flow) |*prepared| prepared.deinit(alloc);
        if (deps.deinit_ctx) |deinit_ctx| deinit_ctx(deps.ctx, alloc);
    }
};

pub const LoginPollDeps = struct {
    ctx: ?*anyopaque = null,
    now_ms: *const fn (?*anyopaque) i64 = realNowMs,
    poll_device_token: *const fn (
        ?*anyopaque,
        Allocator,
        oauth_transport.Provider,
        oauth.Metadata,
        []const u8,
        []const u8,
        *std.atomic.Value(bool),
        std.Io.Clock.Timestamp,
    ) anyerror!oauth.PollResult = realPollDeviceToken,
    sleep_ms: *const fn (?*anyopaque, u64) void = realSleepMs,
    wait_for_enter: *const fn (?*anyopaque, u64) bool = if (host_target.is_wasm)
        unavailableWaitForEnter
    else
        realWaitForEnter,
    url_opener: host.UrlOpener = host.unavailable_url_opener,
    is_cancelled: *const fn (?*anyopaque) bool = neverCancelled,
    cancel_flag: ?*std.atomic.Value(bool) = null,
    request_timeout_ms: i64 = poll_request_timeout_ms,
};

const LoginPollState = struct {
    expires_at_ms: i64,
    interval_ms: u64,
    next_poll_at_ms: i64,

    fn init(deps: LoginPollDeps, device: oauth.DeviceAuthorization) !LoginPollState {
        const now_ms = deps.now_ms(deps.ctx);
        return .{
            .expires_at_ms = try oauth.expiry_timestamp_ms(now_ms, device.expires_in),
            .interval_ms = try poll_interval_ms(device.interval),
            .next_poll_at_ms = now_ms,
        };
    }

    fn scheduleNext(self: *LoginPollState, now_ms: i64) !void {
        const interval_ms = std.math.cast(i64, self.interval_ms) orelse
            return oauth.OAuthError.InvalidOAuthResponse;
        self.next_poll_at_ms = std.math.add(i64, now_ms, interval_ms) catch
            return oauth.OAuthError.InvalidOAuthResponse;
    }

    fn waitMs(self: LoginPollState, now_ms: i64) u64 {
        if (now_ms >= self.next_poll_at_ms) return 0;
        return @intCast(self.next_poll_at_ms - now_ms);
    }
};

const LoginPollStep = union(enum) {
    waiting,
    succeeded: oauth.TokenSet,
};

fn pollForTokenWithDeps(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    metadata: oauth.Metadata,
    client_id: []const u8,
    device: oauth.DeviceAuthorization,
    prompt: *BrowserOpenPrompt,
    deps: LoginPollDeps,
) !oauth.TokenSet {
    var state = try LoginPollState.init(deps, device);
    while (true) {
        switch (try pollTokenStep(alloc, transport, metadata, client_id, device, deps, &state)) {
            .succeeded => |token| return token,
            .waiting => {
                const wait_ms = state.waitMs(deps.now_ms(deps.ctx));
                if (wait_ms > 0) try waitBetweenPolls(alloc, prompt, deps, wait_ms);
            },
        }
    }
}

fn pollTokenStep(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    metadata: oauth.Metadata,
    client_id: []const u8,
    device: oauth.DeviceAuthorization,
    deps: LoginPollDeps,
    state: *LoginPollState,
) !LoginPollStep {
    const now_ms = deps.now_ms(deps.ctx);
    if (now_ms >= state.expires_at_ms) return LoginError.LoginTimedOut;
    if (pollCancelled(deps)) return error.Cancelled;
    if (now_ms < state.next_poll_at_ms) return .waiting;

    var local_cancel_flag = std.atomic.Value(bool).init(false);
    const cancel_flag = deps.cancel_flag orelse &local_cancel_flag;
    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(deps.request_timeout_ms),
    });
    switch (try deps.poll_device_token(
        deps.ctx,
        alloc,
        transport,
        metadata,
        client_id,
        device.device_code,
        cancel_flag,
        deadline,
    )) {
        .success => |token| {
            if (pollCancelled(deps)) {
                var owned = token;
                owned.deinit(alloc);
                debug_trace.logf("auth", "sign-in poll discarded granted token after cancel", .{});
                return error.Cancelled;
            }
            return .{ .succeeded = token };
        },
        .pending => {},
        .slow_down => {
            state.interval_ms = std.math.add(u64, state.interval_ms, 5 * std.time.ms_per_s) catch
                return oauth.OAuthError.InvalidOAuthResponse;
            if (state.interval_ms > max_poll_interval_ms) return oauth.OAuthError.InvalidOAuthResponse;
        },
    }
    try state.scheduleNext(deps.now_ms(deps.ctx));
    return .waiting;
}

fn poll_interval_ms(interval_seconds: i64) oauth.OAuthError!u64 {
    const seconds = @max(interval_seconds, 1);
    const signed_interval_ms = std.math.mul(i64, seconds, std.time.ms_per_s) catch
        return oauth.OAuthError.InvalidOAuthResponse;
    const interval_ms = std.math.cast(u64, signed_interval_ms) orelse
        return oauth.OAuthError.InvalidOAuthResponse;
    if (interval_ms > max_poll_interval_ms) return oauth.OAuthError.InvalidOAuthResponse;
    return interval_ms;
}

fn waitBetweenPolls(
    alloc: Allocator,
    prompt: *BrowserOpenPrompt,
    deps: LoginPollDeps,
    interval_ms: u64,
) error{Cancelled}!void {
    var remaining_ms = interval_ms;
    while (remaining_ms > 0) {
        if (pollCancelled(deps)) return error.Cancelled;
        const slice_ms = @min(remaining_ms, poll_wait_slice_ms);
        if (prompt.enabled and !prompt.opened) {
            if (deps.wait_for_enter(deps.ctx, slice_ms)) {
                prompt.opened = true;
                _ = deps.url_opener.open(alloc, prompt.url) catch false;
            }
        } else {
            deps.sleep_ms(deps.ctx, slice_ms);
        }
        remaining_ms -= slice_ms;
    }
    if (pollCancelled(deps)) return error.Cancelled;
}

fn pollCancelled(deps: LoginPollDeps) bool {
    if (deps.is_cancelled(deps.ctx)) return true;
    const flag = deps.cancel_flag orelse return false;
    return flag.load(.seq_cst);
}

const BrowserOpenPrompt = struct {
    url: []const u8,
    enabled: bool = false,
    opened: bool = false,
};

fn realNowMs(_: ?*anyopaque) i64 {
    return io_mod.milliTimestamp();
}

fn realPollDeviceToken(
    _: ?*anyopaque,
    alloc: Allocator,
    transport: oauth_transport.Provider,
    metadata: oauth.Metadata,
    client_id: []const u8,
    device_code: []const u8,
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
) !oauth.PollResult {
    return oauth.pollDeviceTokenBounded(
        alloc,
        transport,
        metadata,
        client_id,
        device_code,
        cancel_flag,
        deadline,
    );
}

fn neverCancelled(_: ?*anyopaque) bool {
    return false;
}

fn realSleepMs(_: ?*anyopaque, ms: u64) void {
    io_mod.sleep(ms *| std.time.ns_per_ms);
}

fn unavailableWaitForEnter(_: ?*anyopaque, _: u64) bool {
    return false;
}

fn realWaitForEnter(_: ?*anyopaque, timeout_ms: u64) bool {
    var fds = [_]std.posix.pollfd{.{
        .fd = std.posix.STDIN_FILENO,
        .events = std.posix.POLL.IN,
        .revents = 0,
    }};
    const timeout: i32 = @intCast(@min(timeout_ms, @as(u64, @intCast(std.math.maxInt(i32)))));
    const ready = std.posix.poll(&fds, timeout) catch return false;
    if (ready == 0 or (fds[0].revents & std.posix.POLL.IN) == 0) return false;
    discardStdinLine();
    return true;
}

fn discardStdinLine() void {
    var buf: [256]u8 = undefined;
    while (true) {
        const n = std.posix.read(std.posix.STDIN_FILENO, &buf) catch return;
        if (n == 0) return;
        if (std.mem.findScalar(u8, buf[0..n], '\n') != null) return;
    }
}
