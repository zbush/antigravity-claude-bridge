# Antigravity → Claude Code Plugin (`claude-local`)

An Antigravity plugin that lets **Google Antigravity** spawn and orchestrate your locally installed **Anthropic Claude Code CLI** (`claude`) over a zero-dependency Node.js MCP stdio server. This connector launches local Claude CLI child processes from Antigravity, while the companion `claude-to-antigravity` connector delegates into a running Antigravity IDE over local RPC.

## Binary Auto-Discovery

`server/index.mjs` resolves the local `claude` binary automatically in this order:

1. `CLAUDE_CLI_BIN` environment variable (optional explicit override)
2. Standalone install (`~/.local/bin/claude`, `~/.claude/local/claude`, or `PATH`)
3. Claude Desktop's bundled auto-updating Claude Code binary (highest semver in `%APPDATA%\Claude\claude-code\`, MSIX `LocalCache\Roaming\Claude\claude-code\`, macOS `~/Library/Application Support/Claude/claude-code/`, or Linux `~/.config/Claude/claude-code/`)
4. VS Code / Cursor Claude Code extension native binary (`anthropic.claude-code-*`)

If discovery selects Claude Desktop, the bridge picks up the newest version in its bundle as Desktop updates.

On Windows, `CLAUDE_CLI_BIN` supports an absolute path to a native `.exe` executable or a JavaScript CLI entry point. Auto-discovery also checks the npm package entry point on `PATH`, and an invalid explicit override stops the launch.

## Restricted Review (`claude_review`)

The `claude_review` tool requires Claude Code CLI `2.1.248` or newer. It runs in restricted mode with managed settings limited to the `Read`, `Glob`, and `Grep` built-in tools. You can pass an optional `allowed_tools` array containing a subset of those three tools, or pass `[]` for a diff-only review with no workspace inspection tools.

By default, the bridge collects a Git diff from `uncommitted`, `base`, or `commit` before starting the reviewer. A string `review_diff` uses the supplied diff and skips bridge-side Git execution. You cannot combine `review_diff` with `commit`, `base`, or `uncommitted`. On an untrusted checkout, prepare a trusted diff yourself and pass `review_diff` with `allowed_tools` set to `[]` because local Git config or filters can execute during bridge-side diff collection.

```json
{
  "cwd": "/absolute/path/to/workspace",
  "review_diff": "<trusted unified diff>",
  "allowed_tools": []
}
```

Diff-only reviews reject inputs over 120,000 characters. Split larger inputs into smaller patches.

## Workspace and Tool Ceiling (`claude_run`, `claude_resume`, `claude_fork`, `claude_spawn`)

The host operator sets the ceiling in the server's `env` block. Tool calls can narrow it but never widen it.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_WORKSPACE_ROOTS` | `[<server cwd>]` | JSON array of absolute, existing directories. If the server's cwd is a volume root (`C:\`, `/`), you must set this explicitly. |
| `AGENT_BRIDGE_ALLOW_EDITS` | `false` | Exactly `true` or `false`. `true` adds `Edit` and `Write` to the tool ceiling. |

- **Paths:** Before launch, the bridge resolves `cwd` and every `add_dirs` entry with `realpath`, so symlinks and junctions are followed. Each must land inside a root. Claude then gets the canonical paths. Reviews follow the same `cwd` rule.
- **Launch flags:** Every launch passes `--restricted --strict-mcp-config --tools <set>`. The default set is `Read,Glob,Grep`, plus `Edit,Write` when edits are allowed. `allowed_tools` can choose a subset of that set. Shell tools, `bypassPermissions`/`auto` permission modes, `agent`, `worktree`/`worktree_name`, and `ide` are always rejected. User and project MCP servers never load.
- **Resume and fork.** Pass the ID of a completed, persistent session that this server launched in the same canonical workspace. Its previous tools and additional directories must fit the current request. After a server restart, start a fresh session.
- **Invalid configuration:** If either variable is invalid, the bridge refuses every launch, including reviews. `claude_status`, `claude_job_status`, and `claude_job_cancel` keep working, and `claude_status` reports the active `workspace` policy.
- **Antigravity callback.** A peer with a hop left can load the companion `claude-to-antigravity/server/index.mjs` from the same installation. Its registration receives the selected workspace and additional directories. Starting IDE work also requires edit permission for the delegated Claude session. Copying only the Antigravity-to-Claude plugin installs a standalone Claude worker.

## Process Lifecycle, Timeouts, and Cancellation

When a Claude CLI job times out or you call `claude_job_cancel`, the bridge signals the spawned process tree. The cancel tool acknowledges the request immediately. If the bridge cannot confirm exit within five seconds, a waiting run returns `termination_unconfirmed`. Poll `claude_job_status` with the same `job_id` to follow the job.

The bridge holds the job's concurrency slot until it observes the Claude process exit. On Windows, descendants that outlive their parent may continue running. A zero exit without a terminal result marks the run as failed because its output may be partial.

## Included Components

- **MCP Server (`claude-local`)**: Exposes `claude_run`, `claude_resume`, `claude_fork`, `claude_review`, `claude_spawn`, `claude_job_status`, `claude_job_cancel`, and `claude_status`.
- **Skill (`claude-orchestration`)**: Guides Antigravity on the tool ceiling, `allowed_tools`, session reuse, and `[bridge: ...]` recursion guardrails.

## Installation

Copy or symlink this directory (`antigravity-to-claude/`) to `~/.gemini/config/plugins/claude`:

### macOS / Linux
```bash
mkdir -p ~/.gemini/config/plugins
ln -s /path/to/antigravity-claude-bridge/antigravity-to-claude ~/.gemini/config/plugins/claude
```

### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
Copy-Item -Recurse -Force "<path-to-repo>\antigravity-to-claude" "$env:USERPROFILE\.gemini\config\plugins\claude"
```

## Tests

Run the Claude runner test suite from the repository root.

```bash
node --test tests/claude-runner.test.mjs tests/workspace-policy.test.mjs
```

See the [root README](../README.md) for topology presets (independent, strict hierarchy, or bidirectional peer mode), `AGENT_BRIDGE_*` environment variables, and non-PATH Node.js configuration.
