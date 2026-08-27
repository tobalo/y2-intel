const std = @import("std");
const builtin = @import("builtin");
const chatgpt_oauth = @import("chatgpt_oauth.zig");
const grok_oauth = @import("grok_oauth.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const host = @import("../hosts/host.zig");
const io_mod = @import("../shared/io.zig");
const model_provider = @import("../config/model_provider.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");
const types = @import("../shared/types.zig");

pub const Source = types.CredentialSource;

pub const CatalogPublicOnly = union(enum) {
    no_credential,
    credential_refresh_failed: Source,
    authenticated_credential_rejected: Source,
    chatgpt_subscription,
    grok_subscription,

    fn credentialSource(self: CatalogPublicOnly) ?Source {
        return switch (self) {
            .no_credential => null,
            .credential_refresh_failed => |source| source,
            .authenticated_credential_rejected => |source| source,
            .chatgpt_subscription => .chatgpt_subscription,
            .grok_subscription => .grok_subscription,
        };
    }
};

pub const CatalogPublicOnlyReason = std.meta.Tag(CatalogPublicOnly);

pub const CatalogAuthenticatedSource = enum {
    api_key,
    stored_key,
    chatgpt_subscription,
    grok_subscription,

    fn credentialSource(self: CatalogAuthenticatedSource) Source {
        return switch (self) {
            .api_key => .api_key,
            .stored_key => .stored_key,
            .chatgpt_subscription => .chatgpt_subscription,
            .grok_subscription => .grok_subscription,
        };
    }
};

/// A borrowed authorization decision for one model-catalog request. Public-only
/// states cannot carry credential or team bytes; authenticated states carry the
/// only values the request is allowed to send.
pub const CatalogAccess = union(enum) {
    public_only: CatalogPublicOnly,
    authenticated: struct {
        source: CatalogAuthenticatedSource,
        credential: []const u8,
        team_context: ?[]const u8,
        account_id: ?[]const u8 = null,
    },

    pub fn credentialSource(self: CatalogAccess) ?Source {
        return switch (self) {
            .public_only => |access| access.credentialSource(),
            .authenticated => |access| access.source.credentialSource(),
        };
    }

    pub fn publicOnlyReason(self: CatalogAccess) ?CatalogPublicOnlyReason {
        const access = self.publicOnly() orelse return null;
        return std.meta.activeTag(access);
    }

    pub fn publicOnly(self: CatalogAccess) ?CatalogPublicOnly {
        return switch (self) {
            .public_only => |access| access,
            .authenticated => null,
        };
    }

    pub fn publicFallbackAfterRejection(self: CatalogAccess) ?CatalogAccess {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| if (access.source == .chatgpt_subscription or access.source == .grok_subscription)
                null
            else
                .{
                    .public_only = .{
                        .authenticated_credential_rejected = access.source.credentialSource(),
                    },
                },
        };
    }

    pub fn authorizationCredential(self: CatalogAccess) ?[]const u8 {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| access.credential,
        };
    }

    pub fn teamContext(self: CatalogAccess) ?[]const u8 {
        const team = switch (self) {
            .public_only => return null,
            .authenticated => |access| access.team_context orelse return null,
        };
        return if (team.len > 0) team else null;
    }

    pub fn accountId(self: CatalogAccess) ?[]const u8 {
        const account_id = switch (self) {
            .public_only => return null,
            .authenticated => |access| access.account_id orelse return null,
        };
        return if (account_id.len > 0) account_id else null;
    }
};

pub fn catalogAccessAt(credential: ?Credential, now_ms: i64) CatalogAccess {
    _ = now_ms;
    const selected = credential orelse return .{ .public_only = .no_credential };
    return catalogAccessForCredentialAndAccount(
        selected.source,
        selected.token,
        selected.gatewayTeam(),
        selected.accountId(),
    );
}

pub fn catalogAccessAfterRefreshFailure(source: Source) CatalogAccess {
    return .{
        .public_only = .{
            .credential_refresh_failed = source,
        },
    };
}

pub fn catalogAccessForCredential(
    source: ?Source,
    credential: []const u8,
    team_context: ?[]const u8,
) CatalogAccess {
    return catalogAccessForCredentialAndAccount(source, credential, team_context, null);
}

pub fn catalogAccessForCredentialAndAccount(
    source: ?Source,
    credential: []const u8,
    team_context: ?[]const u8,
    account_id: ?[]const u8,
) CatalogAccess {
    const selected_source = source orelse return .{ .public_only = .no_credential };
    const authenticated_source: CatalogAuthenticatedSource = switch (selected_source) {
        .api_key => .api_key,
        .stored_key => .stored_key,
        .chatgpt_subscription => .chatgpt_subscription,
        .grok_subscription => .grok_subscription,
    };
    return .{
        .authenticated = .{
            .source = authenticated_source,
            .credential = credential,
            .team_context = if (authenticated_source == .chatgpt_subscription or authenticated_source == .grok_subscription) null else team_context,
            .account_id = if (authenticated_source == .grok_subscription) account_id else null,
        },
    };
}

/// Current native product copy. Store mechanics and availability come from the
/// injected host port; Core retains the stable user-facing source name.
pub const stored_key_backend_label = if (builtin.os.tag == .macos) "macOS Keychain" else "profile file";

/// Both modes resolve the same source set; the mode selects only whether an expired
/// y2 login session is refreshed first.
pub const LoadMode = enum { stored, refresh_if_needed };

pub const missing_credential_message = "Y2 Information Dominance needs an API key. Run y2 setup or set Y2_API_KEY. For another OpenAI-compatible endpoint, set OPENAI_API_KEY and OPENAI_BASE_URL.";
pub const missing_interactive_credential_message = "Y2 Information Dominance needs an API key. Run /setup or set Y2_API_KEY. For another OpenAI-compatible endpoint, set OPENAI_API_KEY and OPENAI_BASE_URL.";
pub const missing_chatgpt_credential_message = "y2 needs a Codex subscription login for this model. Run y2 login codex.";
pub const missing_chatgpt_interactive_credential_message = "Codex needs a subscription login. Run /login, open Connections, then choose Codex subscription.";
pub const missing_grok_credential_message = "y2 needs a Grok subscription login for this model. Run y2 login grok.";
pub const missing_grok_interactive_credential_message = "Grok needs a subscription login. Run /login, open Connections, then choose Grok subscription.";
pub const unreadable_store_message = "Y2 Information Dominance could not read the stored API key from " ++ stored_key_backend_label ++ ". A key may be saved but unreadable. Set Y2_TRACE_LOG for the failing step, or set Y2_API_KEY.";

pub const Credential = struct {
    token: []u8,
    source: Source,
    account_id: ?[]u8 = null,
    team_id: ?[]u8 = null,
    team_slug: ?[]u8 = null,
    refresh_after_ms: ?i64 = null,

    pub fn deinit(self: *Credential, alloc: std.mem.Allocator) void {
        secret.zeroAndFree(alloc, self.token);
        if (self.account_id) |account_id| alloc.free(account_id);
        if (self.team_id) |team| alloc.free(team);
        if (self.team_slug) |team| alloc.free(team);
        self.* = undefined;
    }

    pub fn gatewayTeam(self: Credential) ?[]const u8 {
        if (self.team_id) |team| return team;
        return self.team_slug;
    }

    pub fn accountId(self: Credential) ?[]const u8 {
        return self.account_id;
    }

    pub fn needsRefreshAt(self: Credential, now_ms: i64) bool {
        const refresh_after_ms = self.refresh_after_ms orelse return false;
        return refresh_after_ms <= now_ms;
    }
};

pub const StoredKeyReadStatus = enum {
    not_attempted,
    not_found,
    unavailable,
};

/// Why the y2 login produced no credential. Only meaningful once resolution has
/// reached the y2-login step and it stayed silent. `unavailable` means the
/// session could not be loaded or its refresh failed, which is different from
/// having no session at all: the login exists and may still be repairable.
pub const Resolution = struct {
    credential: ?Credential = null,
    stored_key_status: StoredKeyReadStatus = .not_attempted,
};

/// The single credential resolution method. Walks source precedence, then falls back to
/// the stored key, reporting why that store was silent when it produced nothing.
pub fn resolve(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
) !Resolution {
    return resolvePreferring(alloc, transport, secret_store, mode, null);
}

pub fn resolveForProvider(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    provider: model_provider.ProviderId,
    preferred: ?Source,
) !Resolution {
    switch (provider) {
        .codex => {
            const credential = switch (mode) {
                .stored => try loadStoredChatGptCredential(alloc),
                .refresh_if_needed => try loadChatGptCredential(alloc, transport, .if_needed),
            };
            return .{ .credential = credential };
        },
        .grok => {
            const credential = switch (mode) {
                .stored => try loadStoredGrokCredential(alloc),
                .refresh_if_needed => try loadGrokCredential(alloc, transport, .if_needed),
            };
            return .{ .credential = credential };
        },
        .gateway => {},
    }
    return resolvePreferring(
        alloc,
        transport,
        secret_store,
        mode,
        if (preferred == .chatgpt_subscription or preferred == .grok_subscription) null else preferred,
    );
}

/// `preferred` is the source the user last chose in the hub. It wins over the
/// precedence order below, including over the environment, because it is an
/// explicit choice rather than a default. A preferred source that no longer
/// resolves falls through to precedence instead of failing.
pub fn resolvePreferring(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    preferred: ?Source,
) !Resolution {
    if (preferred) |source| {
        if (source != .stored_key or !secret_store.isDisabled()) {
            const chosen = loadPreferredSource(alloc, transport, secret_store, mode, source) catch |err| blk: {
                if (err == error.OutOfMemory) return err;
                debug_trace.logf("auth", "preferred source load failed source={t} err={s}", .{ source, @errorName(err) });
                break :blk null;
            };
            if (chosen) |credential| return .{ .credential = credential };
            debug_trace.logf("auth", "preferred source unavailable source={t}; using precedence", .{source});
        }
    }

    if (try loadSource(alloc, transport, secret_store, .api_key)) |credential| return .{ .credential = credential };

    if (secret_store.isDisabled()) return .{};

    var status: StoredKeyReadStatus = .not_found;
    const stored = loadSource(alloc, transport, secret_store, .stored_key) catch |err| blk: {
        if (err == error.OutOfMemory) return err;
        status = .unavailable;
        debug_trace.logf("auth", "stored key load failed err={s} status={t}", .{ @errorName(err), status });
        break :blk null;
    };
    if (stored) |credential| return .{ .credential = credential };
    return .{ .stored_key_status = status };
}

/// `loadSource` always refreshes an expired y2 login, which `.stored` mode
/// forbids: a diagnostic must not rewrite the session file or make an OAuth
/// request. Honour the mode for the preferred source too.
fn loadPreferredSource(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    mode: LoadMode,
    source: Source,
) !?Credential {
    return switch (source) {
        .chatgpt_subscription => switch (mode) {
            .stored => loadStoredChatGptCredential(alloc),
            .refresh_if_needed => loadChatGptCredential(alloc, transport, .if_needed),
        },
        .grok_subscription => switch (mode) {
            .stored => loadStoredGrokCredential(alloc),
            .refresh_if_needed => loadGrokCredential(alloc, transport, .if_needed),
        },
        else => loadSource(alloc, transport, secret_store, source),
    };
}

pub fn loadSource(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    secret_store: host.SecretStore,
    source: Source,
) !?Credential {
    return switch (source) {
        .api_key => loadApiKeyEnvCredential(alloc),
        .stored_key => loadStoredKeyCredential(alloc, secret_store),
        .chatgpt_subscription => loadChatGptCredential(alloc, transport, .if_needed),
        .grok_subscription => loadGrokCredential(alloc, transport, .if_needed),
    };
}

pub fn sourceExists(
    alloc: std.mem.Allocator,
    secret_store: host.SecretStore,
    source: Source,
) !bool {
    return switch (source) {
        .api_key => if (usesDirectOpenAiEndpoint())
            nonEmptyEnvValue("OPENAI_API_KEY") != null
        else
            nonEmptyEnvValue("Y2_API_KEY") != null,
        .chatgpt_subscription => chatgpt_oauth.sourceExists(alloc),
        .grok_subscription => grok_oauth.sourceExists(alloc),
        .stored_key => blk: {
            // The profile/keychain slot is populated by the Y2 setup flow. A
            // direct endpoint must use OPENAI_API_KEY so changing endpoints can
            // never send a stored Y2 credential to another host.
            if (usesDirectOpenAiEndpoint()) break :blk false;
            if (secret_store.isDisabled()) break :blk false;
            const stored = secret_store.load(alloc) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => {
                    debug_trace.logf("auth", "source probe failed source=stored_key err={s}", .{@errorName(err)});
                    break :blk false;
                },
            };
            const value = stored orelse break :blk false;
            secret.zeroAndFree(alloc, value);
            break :blk true;
        },
    };
}

fn loadEnvCredential(
    alloc: std.mem.Allocator,
    name: []const u8,
    source: Source,
) !?Credential {
    const value = nonEmptyEnvValue(name) orelse return null;
    return .{
        .token = try alloc.dupe(u8, value),
        .source = source,
    };
}

fn loadApiKeyEnvCredential(alloc: std.mem.Allocator) !?Credential {
    return loadEnvCredential(
        alloc,
        if (usesDirectOpenAiEndpoint()) "OPENAI_API_KEY" else "Y2_API_KEY",
        .api_key,
    );
}

fn usesDirectOpenAiEndpoint() bool {
    if (nonEmptyEnvValue("Y2_API_CHAT_URL")) |endpoint| return !isY2AgentEndpoint(endpoint);
    if (nonEmptyEnvValue("OPENAI_BASE_URL")) |base_url| return !isY2AgentBaseUrl(base_url);
    return false;
}

fn isY2AgentEndpoint(endpoint: []const u8) bool {
    return std.mem.eql(
        u8,
        std.mem.trimEnd(u8, endpoint, "/"),
        "https://api.y2.dev/api/v1/chat/completions",
    );
}

fn isY2AgentBaseUrl(base_url: []const u8) bool {
    const trimmed = std.mem.trimEnd(u8, base_url, "/");
    return std.mem.eql(u8, trimmed, "https://api.y2.dev/api/v1") or
        std.mem.eql(u8, trimmed, "https://api.y2.dev/api/v1/chat/completions");
}

fn loadStoredKeyCredential(
    alloc: std.mem.Allocator,
    secret_store: host.SecretStore,
) !?Credential {
    if (usesDirectOpenAiEndpoint()) return null;
    if (secret_store.isDisabled()) return null;
    const value = (try secret_store.load(alloc)) orelse return null;
    return .{ .token = value, .source = .stored_key };
}

fn loadChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: chatgpt_oauth.RefreshMode,
) !?Credential {
    var access = (try chatgpt_oauth.loadAccess(alloc, transport, mode)) orelse return null;
    defer access.deinit(alloc);
    const token = access.access_token;
    access.access_token = &.{};
    const account_id = access.account_id;
    access.account_id = &.{};
    return .{
        .token = token,
        .source = .chatgpt_subscription,
        .account_id = account_id,
        .refresh_after_ms = access.refresh_after_ms,
    };
}

fn loadStoredChatGptCredential(alloc: std.mem.Allocator) !?Credential {
    return loadChatGptCredential(alloc, oauth_transport.unavailable_provider, .stored);
}

fn loadGrokCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: grok_oauth.RefreshMode,
) !?Credential {
    var access = (try grok_oauth.loadAccess(alloc, transport, mode)) orelse return null;
    defer access.deinit(alloc);
    const token = access.access_token;
    access.access_token = &.{};
    const account_id = access.account_id;
    access.account_id = &.{};
    return .{
        .token = token,
        .source = .grok_subscription,
        .account_id = account_id,
        .refresh_after_ms = access.refresh_after_ms,
    };
}

fn loadStoredGrokCredential(alloc: std.mem.Allocator) !?Credential {
    return loadGrokCredential(alloc, oauth_transport.unavailable_provider, .stored);
}

fn nonEmptyEnvValue(name: []const u8) ?[]const u8 {
    return nonEmptyValue(io_mod.getenv(name));
}

fn nonEmptyValue(value: ?[]const u8) ?[]const u8 {
    const raw = value orelse return null;
    if (std.mem.trim(u8, raw, " \t\r\n").len == 0) return null;
    return raw;
}

pub fn refreshChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
) !?Credential {
    return loadChatGptCredential(alloc, transport, .force);
}

pub fn refreshGrokCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
) !?Credential {
    return loadGrokCredential(alloc, transport, .force);
}

pub fn sourceLabel(source: Source) []const u8 {
    return switch (source) {
        .api_key => "API key",
        .stored_key => "stored API key (" ++ stored_key_backend_label ++ ")",
        .chatgpt_subscription => "Codex subscription",
        .grok_subscription => "Grok subscription",
    };
}

pub fn sourceRefreshable(source: Source) bool {
    return source == .chatgpt_subscription or source == .grok_subscription;
}

test "stored key label discloses the backend that answered" {
    try std.testing.expect(std.mem.find(u8, sourceLabel(.stored_key), stored_key_backend_label) != null);
    try std.testing.expect(std.mem.find(u8, unreadable_store_message, stored_key_backend_label) != null);
    for ([_]Source{.api_key}) |source| {
        try std.testing.expect(!std.mem.eql(u8, sourceLabel(source), sourceLabel(.stored_key)));
    }
}

test "missing credential messages use surface commands in preferred order" {
    const cli_setup = std.mem.find(u8, missing_credential_message, "y2 setup").?;
    const cli_env = std.mem.find(u8, missing_credential_message, "Y2_API_KEY").?;

    try std.testing.expect(cli_setup < cli_env);

    const tui_setup = std.mem.find(u8, missing_interactive_credential_message, "/setup").?;
    const tui_env = std.mem.find(u8, missing_interactive_credential_message, "Y2_API_KEY").?;

    try std.testing.expect(tui_setup < tui_env);
}

test "catalog access isolates public and authenticated provider credentials" {
    const missing = catalogAccessAt(null, 0);
    try std.testing.expectEqual(CatalogPublicOnlyReason.no_credential, missing.publicOnlyReason().?);
    try std.testing.expect(missing.credentialSource() == null);
    try std.testing.expect(missing.authorizationCredential() == null);
    try std.testing.expect(missing.teamContext() == null);

    const refresh_failed = catalogAccessAfterRefreshFailure(.stored_key);
    try std.testing.expectEqual(CatalogPublicOnlyReason.credential_refresh_failed, refresh_failed.publicOnlyReason().?);
    try std.testing.expectEqual(Source.stored_key, refresh_failed.credentialSource().?);

    const chatgpt = catalogAccessForCredential(
        .chatgpt_subscription,
        "chatgpt-secret",
        "chatgpt-account",
    );
    try std.testing.expectEqual(Source.chatgpt_subscription, chatgpt.credentialSource().?);
    try std.testing.expectEqualStrings("chatgpt-secret", chatgpt.authorizationCredential().?);
    try std.testing.expect(chatgpt.teamContext() == null);
    try std.testing.expect(chatgpt.publicFallbackAfterRejection() == null);

    var grok_credential = Credential{
        .token = try std.testing.allocator.dupe(u8, "grok-secret"),
        .source = .grok_subscription,
        .account_id = try std.testing.allocator.dupe(u8, "acct_grok"),
    };
    defer grok_credential.deinit(std.testing.allocator);
    const grok = catalogAccessAt(grok_credential, 0);
    try std.testing.expectEqualStrings("acct_grok", grok.accountId().?);
    try std.testing.expect(grok.teamContext() == null);

    const rejected: CatalogAccess = .{ .public_only = .{ .authenticated_credential_rejected = .stored_key } };
    try std.testing.expectEqual(CatalogPublicOnlyReason.authenticated_credential_rejected, rejected.publicOnlyReason().?);
    try std.testing.expectEqual(Source.stored_key, rejected.credentialSource().?);
    try std.testing.expect(rejected.authorizationCredential() == null);
    try std.testing.expect(rejected.teamContext() == null);
}

test "authenticated catalog access carries source and permitted request context" {
    for ([_]Source{ .api_key, .stored_key }) |source| {
        var credential = Credential{
            .token = try std.testing.allocator.dupe(u8, "token"),
            .source = source,
            .team_slug = try std.testing.allocator.dupe(u8, "example-org"),
        };
        defer credential.deinit(std.testing.allocator);

        const authenticated = catalogAccessAt(credential, 0);
        try std.testing.expect(authenticated.publicOnlyReason() == null);
        try std.testing.expectEqual(source, authenticated.credentialSource().?);
        try std.testing.expectEqualStrings("token", authenticated.authorizationCredential().?);
        try std.testing.expectEqualStrings("example-org", authenticated.teamContext().?);

        const fallback = authenticated.publicFallbackAfterRejection().?;
        try std.testing.expectEqual(CatalogPublicOnlyReason.authenticated_credential_rejected, fallback.publicOnlyReason().?);
        try std.testing.expectEqual(source, fallback.credentialSource().?);
        try std.testing.expect(fallback.authorizationCredential() == null);
        try std.testing.expect(fallback.teamContext() == null);
        try std.testing.expect(fallback.publicFallbackAfterRejection() == null);
    }
}

var stable_credential_test_environ: ?*std.process.Environ.Map = null;

fn stableCredentialTestEnviron() !*const std.process.Environ.Map {
    if (stable_credential_test_environ) |map| return map;

    const alloc = std.heap.page_allocator;
    const map = try alloc.create(std.process.Environ.Map);
    map.* = std.process.Environ.Map.init(alloc);
    stable_credential_test_environ = map;
    return map;
}

const CredentialTestEnv = struct {
    alloc: std.mem.Allocator,
    map: std.process.Environ.Map,

    /// Installs exactly `entries`, so anything the resolver reads from the real
    /// environment, `HOME` included, is absent for the duration of the test.
    fn install(alloc: std.mem.Allocator, entries: []const [2][]const u8) !*CredentialTestEnv {
        _ = try stableCredentialTestEnviron();

        const self = try alloc.create(CredentialTestEnv);
        errdefer alloc.destroy(self);
        self.* = .{
            .alloc = alloc,
            .map = std.process.Environ.Map.init(alloc),
        };
        errdefer self.map.deinit();

        for (entries) |entry| try self.map.put(entry[0], entry[1]);
        io_mod.setEnvironMap(&self.map);
        return self;
    }

    fn deinit(self: *CredentialTestEnv) void {
        if (stable_credential_test_environ) |map| io_mod.setEnvironMap(map);
        self.map.deinit();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

const SecretStoreFixture = struct {
    value: ?[]const u8 = null,
    disabled: bool = false,
    unreadable: bool = false,
    load_calls: usize = 0,

    fn provider(self: *@This()) host.SecretStore {
        return .{
            .context = self,
            .backend_label = "test credential store",
            .is_disabled_fn = isDisabled,
            .load_fn = load,
            .store_fn = store,
            .store_interactive_fn = storeInteractive,
        };
    }

    fn isDisabled(raw_context: ?*anyopaque) bool {
        const self: *@This() = @ptrCast(@alignCast(raw_context.?));
        return self.disabled;
    }

    fn load(
        raw_context: ?*anyopaque,
        alloc: std.mem.Allocator,
    ) host.SecretStoreLoadError!?[]u8 {
        const self: *@This() = @ptrCast(@alignCast(raw_context.?));
        self.load_calls += 1;
        if (self.unreadable) return error.StoredKeyUnreadable;
        const value = self.value orelse return null;
        return try alloc.dupe(u8, value);
    }

    fn store(
        _: ?*anyopaque,
        _: std.mem.Allocator,
        _: []const u8,
    ) host.SecretStoreWriteError!void {
        return error.StoredKeyWriteFailed;
    }

    fn storeInteractive(
        _: ?*anyopaque,
    ) host.SecretStoreWriteError!bool {
        return false;
    }
};

test "API credential resolution prefers the Y2 API key" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ "Y2_API_KEY", "api-key" },
    });
    defer env.deinit();

    const resolution = try resolve(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .refresh_if_needed);
    var startup = resolution.credential orelse return error.TestExpectedCredential;
    defer startup.deinit(alloc);
    try std.testing.expectEqualStrings("api-key", startup.token);
    try std.testing.expectEqual(Source.api_key, startup.source);

    var api_key = (try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)).?;
    defer api_key.deinit(alloc);
    try std.testing.expectEqualStrings("api-key", api_key.token);
    try std.testing.expectEqual(Source.api_key, api_key.source);

    try std.testing.expect(try sourceExists(alloc, host.unavailable_secret_store, .api_key));
    try std.testing.expect(!(try sourceExists(alloc, host.unavailable_secret_store, .stored_key)));
}

test "direct endpoint prefers OPENAI_API_KEY while Agent Y2 prefers Y2_API_KEY" {
    const alloc = std.testing.allocator;
    {
        const env = try CredentialTestEnv.install(alloc, &.{
            .{ "Y2_API_KEY", "y2-key" },
            .{ "OPENAI_API_KEY", "openai-key" },
            .{ "OPENAI_BASE_URL", "https://models.example/v1" },
        });
        defer env.deinit();
        var credential = (try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)).?;
        defer credential.deinit(alloc);
        try std.testing.expectEqualStrings("openai-key", credential.token);
    }
    {
        const env = try CredentialTestEnv.install(alloc, &.{
            .{ "Y2_API_KEY", "y2-key" },
            .{ "OPENAI_BASE_URL", "https://models.example/v1" },
        });
        defer env.deinit();
        try std.testing.expect((try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)) == null);
    }
    {
        const env = try CredentialTestEnv.install(alloc, &.{
            .{ "Y2_API_KEY", "y2-key" },
            .{ "OPENAI_API_KEY", "openai-key" },
            .{ "Y2_API_CHAT_URL", "https://api.y2.dev/api/v1/chat/completions/" },
        });
        defer env.deinit();
        var credential = (try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)).?;
        defer credential.deinit(alloc);
        try std.testing.expectEqualStrings("y2-key", credential.token);
    }
    {
        const env = try CredentialTestEnv.install(alloc, &.{
            .{ "OPENAI_API_KEY", "openai-key" },
            .{ "Y2_API_CHAT_URL", "https://api.y2.dev/api/v1/chat/completions" },
        });
        defer env.deinit();
        try std.testing.expect((try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)) == null);
    }
    {
        const env = try CredentialTestEnv.install(alloc, &.{
            .{ "Y2_API_KEY", "y2-key" },
            .{ "OPENAI_API_KEY", "openai-key" },
            .{ "OPENAI_BASE_URL", "https://api.y2.dev/api/v1" },
        });
        defer env.deinit();
        var credential = (try loadSource(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .api_key)).?;
        defer credential.deinit(alloc);
        try std.testing.expectEqualStrings("y2-key", credential.token);
    }
}

test "stored Y2 key is unavailable for direct OpenAI-compatible endpoints" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ "OPENAI_BASE_URL", "https://models.example/v1" },
    });
    defer env.deinit();
    var store_fixture = SecretStoreFixture{ .value = "stored-y2-key" };

    const stored = try loadSource(alloc, oauth_transport.unavailable_provider, store_fixture.provider(), .stored_key);
    try std.testing.expect(stored == null);
    try std.testing.expectEqual(@as(usize, 0), store_fixture.load_calls);
    try std.testing.expect(!(try sourceExists(alloc, store_fixture.provider(), .stored_key)));
}

test "a remembered choice outranks the environment" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ "Y2_API_KEY", "api-key" },
    });
    defer env.deinit();

    const resolution = try resolvePreferring(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .refresh_if_needed, .api_key);
    var credential = resolution.credential orelse return error.TestExpectedCredential;
    defer credential.deinit(alloc);
    try std.testing.expectEqual(Source.api_key, credential.source);
    try std.testing.expectEqualStrings("api-key", credential.token);
}

test "a remembered choice that no longer resolves falls back to precedence" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ "Y2_API_KEY", "api-key" },
    });
    defer env.deinit();

    const resolution = try resolvePreferring(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .refresh_if_needed, .stored_key);
    var credential = resolution.credential orelse return error.TestExpectedCredential;
    defer credential.deinit(alloc);
    try std.testing.expectEqual(Source.api_key, credential.source);
}

test "no remembered choice resolves exactly as plain precedence" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{
        .{ "Y2_API_KEY", "api-key" },
    });
    defer env.deinit();

    var preferred = try resolvePreferring(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .refresh_if_needed, null);
    defer if (preferred.credential) |*credential| credential.deinit(alloc);
    var plain = try resolve(alloc, oauth_transport.unavailable_provider, host.unavailable_secret_store, .refresh_if_needed);
    defer if (plain.credential) |*credential| credential.deinit(alloc);

    try std.testing.expectEqual(plain.credential.?.source, preferred.credential.?.source);
    try std.testing.expectEqualStrings(plain.credential.?.token, preferred.credential.?.token);
}

test "a disabled stored key is reported as never attempted, not as absent" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{});
    defer env.deinit();
    var store_fixture = SecretStoreFixture{ .disabled = true };

    for ([_]LoadMode{ .stored, .refresh_if_needed }) |mode| {
        var resolution = try resolve(alloc, oauth_transport.unavailable_provider, store_fixture.provider(), mode);
        defer if (resolution.credential) |*credential| credential.deinit(alloc);
        try std.testing.expect(resolution.credential == null);
        try std.testing.expectEqual(StoredKeyReadStatus.not_attempted, resolution.stored_key_status);
    }
    try std.testing.expectEqual(@as(usize, 0), store_fixture.load_calls);
}

test "credential resolution loads a stored key only through the injected host port" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{});
    defer env.deinit();
    var store_fixture = SecretStoreFixture{ .value = "injected-test-value" };

    var resolution = try resolve(
        alloc,
        oauth_transport.unavailable_provider,
        store_fixture.provider(),
        .stored,
    );
    defer if (resolution.credential) |*credential| credential.deinit(alloc);

    try std.testing.expectEqual(@as(usize, 1), store_fixture.load_calls);
    try std.testing.expectEqual(StoredKeyReadStatus.not_attempted, resolution.stored_key_status);
    try std.testing.expectEqual(Source.stored_key, resolution.credential.?.source);
    try std.testing.expectEqualStrings("injected-test-value", resolution.credential.?.token);
}

test "credential resolution preserves unreadable store classification" {
    const alloc = std.testing.allocator;
    const env = try CredentialTestEnv.install(alloc, &.{});
    defer env.deinit();
    var store_fixture = SecretStoreFixture{ .unreadable = true };

    const resolution = try resolve(
        alloc,
        oauth_transport.unavailable_provider,
        store_fixture.provider(),
        .stored,
    );

    try std.testing.expectEqual(@as(usize, 1), store_fixture.load_calls);
    try std.testing.expect(resolution.credential == null);
    try std.testing.expectEqual(StoredKeyReadStatus.unavailable, resolution.stored_key_status);
}
