```text
██╗   ██╗██████╗
╚██╗ ██╔╝╚════██╗
 ╚████╔╝  █████╔╝
  ╚██╔╝  ██╔═══╝
   ██║   ███████╗
   ╚═╝   ╚══════╝

Y2 INFORMATION DOMINANCE
```

Y2 Information Dominance is an agentic intelligence harness and CLI written in Zig. It is optimized for research, software operations, and embedding in larger systems.

It focuses on minimalism and performance across the board, from system prompt design to its tools, feature set, and 7.8 MiB binary.

For end users, its CLI output style and form factor aim to be closer to a Unix shell than a heavy "IDE in the terminal" TUI.

It's open source (Apache-2.0), model-agnostic, and suitable for both local and cloud inference.

## Install

The repository includes the release installer at `scripts/install.sh`. The
public command will be available after that exact script is served from
`https://y2.dev/harness/install.sh`:

```bash
curl -fsSL https://y2.dev/harness/install.sh | sh
```

For a reproducible install, pass an exact release:

```bash
curl -fsSL https://y2.dev/harness/install.sh | sh -s -- v0.0.6
```

The hosted route is not published yet. Until it is live and release artifacts
are available, build from source:

```bash
git clone https://github.com/tobalo/y2-intel.git
cd y2-intel
zig build -Doptimize=ReleaseSafe
./zig-out/bin/y2
```

## Run the harness

Agent Y2 is the default route. Create a scoped key as described in the [Y2 API authentication guide](https://y2.dev/docs/api/authentication/), then export it:

```bash
export Y2_API_KEY="your-y2-api-key"
y2
```

The default request target is `https://api.y2.dev/api/v1/chat/completions` with model `y2-agent`. This route sends the OpenAI-compatible streaming fields supported by [Agent Y2](https://y2.dev/docs/api/agent-y2/). Agent Y2 owns its internal agent behavior, so local system messages and local function tools are not sent on this route.

To call another OpenAI-compatible endpoint directly, configure its base URL, key, and model:

```bash
export OPENAI_BASE_URL="https://your-provider.example/v1"
export OPENAI_API_KEY="your-provider-api-key"
export Y2_MODEL="your-model-id"
y2
```

`OPENAI_BASE_URL` may include `/chat/completions`; otherwise y2 appends it. `Y2_API_CHAT_URL` overrides the full request URL and also enables direct OpenAI-compatible mode. Direct mode sends standard chat messages and function-tool definitions without routing through an intermediary gateway.

Or use an eligible ChatGPT subscription through OpenAI Codex OAuth:

```bash
y2 login codex
y2
```

Or use an eligible Grok subscription through xAI OAuth:

```bash
y2 login grok
y2
```

`y2 login codex` and `y2 login grok` select that provider and a model from its authenticated catalog. Inside y2, open `/setup` and choose **Model provider** to move between Y2 API, Codex, and Grok. `/model` lists the active provider's models. Subscription model IDs are the raw IDs returned by each authenticated catalog. Use `/logout codex` or `/logout grok` to remove that subscription session without affecting other providers; choosing it again from **Model provider** starts sign-in.

The OpenAI Codex route uses ChatGPT subscription access directly. The session is stored privately at `~/.y2/chatgpt-auth.json` and refreshed when needed. On supported Codex models, `/fast` requests OpenAI's priority service tier and consumes ChatGPT credits at the higher Fast mode rate.

The Grok route uses subscription access directly at xAI. Its session is stored privately at `~/.y2/grok-auth.json`, refreshed when needed, and used only with the authenticated xAI catalog and Responses API.

To store the active API key in the supported local credential backend instead of an environment variable:

```bash
y2 setup
```

Run y2 from a project:

```bash
cd your_project
y2
```

The current directory becomes the primary workspace. Enter a prompt, or run `/help` to browse interactive commands.

The status line hides the workspace path and Git branch by default. Enable the `Status line workspace` option in `/settings`, run `/statusline workspace`, or set it in `~/.y2/settings.json`:

```json
{
  "statusLine": {
    "workspace": true
  }
}
```

List saved sessions with `y2 sessions`. Resume the latest session for the current workspace, or select an exact session ID, through the same command group:

```bash
y2 session resume last
y2 session resume <id>
```

Each interactive session names its terminal tab. The title prefers the session name, falls back to the workspace name, and keeps the active model as secondary context. Renaming or resuming a session updates the tab, and exiting clears the y2-owned title. Noninteractive commands do not emit terminal-title controls.

The `/feedback` command opens this fork's GitHub issue form. It does not create a diagnostic or change the clipboard.

Run `/trace` to create a private Markdown diagnostic with logs, session context, runtime state, permissions, and recent activity. On macOS, y2 copies the `.md` file to the clipboard; on other platforms, it saves the file and prints its path. Review and redact the trace before sharing it.

Use `y2 ask` for a single request:

```bash
y2 ask "explain the changes in this repository"
```

Foreground terminal commands run with an explicit finite deadline. y2 uses durable terminal sessions for services, watchers, GUI applications, and other long-lived work, and keeps captured foreground output available through an opaque bounded-read handle for the active session or `--no-save` process.

y2 starts in `auto` permission mode. Routine understood development actions run directly. Each unresolved action receives one narrow safety review based on the current user request and the exact pending action. A clear result authorizes only that action. A caution or unavailable review holds the action and returns advice to the agent without opening a permission prompt or ending the turn.

JSON and quiet requests stay noninteractive by default. Add `--prompt-permissions` to allow configured approval prompts when stdin is a TTY. Automatic safety review never opens that prompt. Prompt text is written to stderr, so JSON stdout stays parseable and quiet stdout stays empty. Piped or redirected stdin remains noninteractive and fails instead of waiting for approval.

Inside a saved session, `/permissions remember <allow|deny> <tool-name> <arguments-json>` stores an exact confirmed rule without running the action. `/permissions` lists stable rule IDs, and `/permissions revoke <rule-id>` removes a stored rule even when its original workspace or file state has changed.

## Embed y2

y2 builds as a native binary or WebAssembly. Applications embedding y2 can provide network transport, session storage, configuration, permission handling, and terminal I/O.

| Surface | Use |
| --- | --- |
| `y2 acp` | Connect the native agent to editors and other Agent Client Protocol clients. |
| `createY2Agent()` | Embed the agent core in a JavaScript host with `y2-core.wasm`. |
| `createY2Terminal()` | Embed the interactive terminal with `y2-term.wasm`. |

The WebAssembly SDK is experimental. See the [WebAssembly SDK](sdk/README.md).

## Extend y2

Add reusable instructions with skills, connect external tools through MCP, or delegate independent work to subagents. Inside y2, `/mcp add <name> <command> [args...]` saves a local server and `/mcp add --transport http <name> <url>` saves a remote Streamable HTTP server. Project instruction files may link within their scope, and read-only workspace skill directories and their primary `SKILL.md` files may link within their owning workspace or home; managed skills, secondary resources, and escaping links remain no-follow. Skills installed via symlinks that resolve outside home or workspace are loaded when their resolved target is inside a directory listed in the `Y2_SKILL_SYMLINK_AUTHORITIES` environment variable. `y2 status` and `y2 doctor` report an invalid trusted MCP profile without starting its servers.

## Documentation

Read the [Y2 API documentation](https://y2.dev/docs/api/) for Agent Y2,
authentication, and API contracts. Run `y2 help` or `/help` for the native CLI
and interactive command reference.

## Build from source

Building y2 requires [Zig 0.16.0+](https://ziglang.org/download/):

```bash
git clone https://github.com/tobalo/y2-intel.git
cd y2-intel
zig build -Doptimize=ReleaseSafe
./zig-out/bin/y2
```

Run the test suite with `zig build test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines.

## License

[Apache-2.0](LICENSE)

Third-party licenses and attributions are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
