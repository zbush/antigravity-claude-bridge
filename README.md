# Antigravity ↔ Claude Code Bridge

Two zero-dependency Node.js Model Context Protocol (MCP) connectors link a locally running **Google Antigravity IDE** and your locally installed **Anthropic Claude Code CLI**. The `antigravity-to-claude` plugin spawns local Claude CLI processes from Antigravity, while `claude-to-antigravity` sends local RPC calls from Claude Code into the running Antigravity IDE. You can install one connector on its own, enforce a **primary/subordinate hierarchy**, or run guarded **bidirectional peer mode**.

```text
┌─────────────────────────────┐         antigravity-to-claude         ┌─────────────────────────────┐
│                             │ ────── (claude -p stream-json) ─────► │                             │
│     Google Antigravity      │                                       │    Anthropic Claude Code    │
│   (App / IDE / CLI)         │ ◄─── (local Language Server RPC) ──── │   (CLI / Desktop / IDE)     │
└─────────────────────────────┘         claude-to-antigravity         └─────────────────────────────┘
```

## Highlights

- **Zero dependencies** — pure Node.js 18+ ESM on both sides; no `npm install` or build step required.
- **No personal data or hardcoded paths** — portable defaults with automatic binary/daemon discovery on Windows, macOS, and Linux.
- **Independent or combined** — install only one connector, or install both with explicit topology controls.
- **Built-in recursion & hierarchy guardrails** — shared `AGENT_BRIDGE_*` environment contract enforces role permissions, max delegation depth, cycle detection, concurrency caps, and callback tool blocking.

## Repository Structure

```text
antigravity-claude-bridge/
├── README.md                                  # This guide
├── LICENSE                                    # MIT
├── antigravity-to-claude/                     # Antigravity plugin (Antigravity → Claude Code)
│   ├── plugin.json
│   ├── mcp_config.json
│   ├── assets/logo.svg
│   ├── server/index.mjs
│   └── skills/claude-orchestration/SKILL.md
├── claude-to-antigravity/                     # Claude Code MCP server (Claude Code → Antigravity)
│   ├── README.md
│   ├── default-cascade-config.json
│   └── server/index.mjs
└── presets/                                   # Copy-paste config presets for every topology
    ├── independent-antigravity-only.mcp_config.json
    ├── independent-claude-only.claude-mcp.json
    ├── hierarchy-antigravity-primary.mcp_config.json
    ├── hierarchy-claude-subordinate.claude-mcp.json
    ├── hierarchy-claude-primary.claude-mcp.json
    ├── hierarchy-antigravity-subordinate.mcp_config.json
    ├── bidirectional-antigravity.mcp_config.json
    └── bidirectional-claude.claude-mcp.json
```

---

## Prerequisites

1. **Node.js 18+** (`node --version`)
2. **Google Antigravity** (running locally when using `claude-to-antigravity`)
3. **Anthropic Claude Code** installed and authenticated locally (standalone CLI, Claude Desktop's bundled `claude-code`, or VS Code / Cursor extension)

Clone this repository anywhere on your machine:

```bash
git clone https://github.com/<OWNER>/antigravity-claude-bridge.git
```

---

## Choose Your Topology

| Topology | What to Install | `AGENT_BRIDGE_ROLE` | Best For |
| :--- | :--- | :--- | :--- |
| **1. Independent (Antigravity → Claude only)** | `antigravity-to-claude/` only | `independent` | Using Antigravity as your main IDE and delegating tasks/reviews to Claude Code. |
| **2. Independent (Claude → Antigravity only)** | `claude-to-antigravity/` only | `independent` | Using Claude Code as your main agent and delegating tasks to Antigravity. |
| **3. Strict Hierarchy (Antigravity Primary → Claude Subordinate)** | `antigravity-to-claude/` (required) + optional `claude-to-antigravity/` in subordinate mode | AGY: `primary`<br>Claude: `subordinate` | One-way hierarchical control where Antigravity orchestrates Claude workers and Claude cannot call back into Antigravity. |
| **4. Strict Hierarchy (Claude Primary → Antigravity Subordinate)** | `claude-to-antigravity/` (required) + optional `antigravity-to-claude/` in subordinate mode | Claude: `primary`<br>AGY: `subordinate` | One-way hierarchical control where Claude orchestrates Antigravity workers and Antigravity cannot call back into Claude. |
| **5. Bidirectional Peer Delegation** | Both connectors | Both: `peer` (`MAX_DEPTH=1`, `ALLOW_CYCLES=false`) | Initiating delegation from whichever tool you happen to be in, with hard depth and cycle guards preventing ping-pong loops. |

---

## Setup Instructions

### Part A: Install Antigravity → Claude Code (`antigravity-to-claude`)

Install the plugin into Antigravity's global plugins directory (`~/.gemini/config/plugins/claude`):

#### macOS / Linux (symlink recommended)
```bash
mkdir -p ~/.gemini/config/plugins
ln -s /path/to/antigravity-claude-bridge/antigravity-to-claude ~/.gemini/config/plugins/claude
```

#### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
Copy-Item -Recurse -Force "<path-to-repo>\antigravity-to-claude" "$env:USERPROFILE\.gemini\config\plugins\claude"
```

Antigravity automatically discovers plugins under `~/.gemini/config/plugins/`. Verify **Local Claude Code Orchestrator** under **Customizations → Plugins** and `claude_claude-local` under **MCP Servers**.

### Part B: Install Claude Code → Antigravity (`claude-to-antigravity`)

Register the MCP server with Claude Code:

The default registration supports inspection. To launch IDE work, use the explicit registration example below and replace the workspace path with your own.

#### Independent / Default
```bash
claude mcp add --scope user antigravity -- node /path/to/antigravity-claude-bridge/claude-to-antigravity/server/index.mjs
```

#### With Explicit Bridge Role / Environment Variables
```bash
claude mcp add --scope user antigravity \
  -e AGENT_BRIDGE_ROLE=peer \
  -e AGENT_BRIDGE_ALLOW_EDITS=true \
  -e 'AGENT_BRIDGE_WORKSPACE_ROOTS=["/absolute/path/to/project"]' \
  -e AGENT_BRIDGE_MAX_DEPTH=1 \
  -e AGENT_BRIDGE_ALLOW_CYCLES=false \
  -e AGENT_BRIDGE_MAX_CONCURRENT=4 \
  -- node /path/to/antigravity-claude-bridge/claude-to-antigravity/server/index.mjs
```

> Keep the server name `antigravity` so Claude Code exposes its tools as `mcp__antigravity__*`, which the hierarchy presets target with `AGENT_BRIDGE_CALLBACK_DISALLOWED_TOOLS="mcp__antigravity__*"`. Or edit your Claude Code MCP config (`~/.claude.json` under `mcpServers.antigravity`) using one of the JSON templates in [`presets/`](presets/).

---

## Applying Topology Presets

### 1. Independent Setup (One Direction Only)

- **Antigravity → Claude only:** Follow **Part A** only. Default `antigravity-to-claude/mcp_config.json` already runs in `independent` mode (see [`presets/independent-antigravity-only.mcp_config.json`](presets/independent-antigravity-only.mcp_config.json)).
- **Claude → Antigravity only:** Follow **Part B** only (see [`presets/independent-claude-only.claude-mcp.json`](presets/independent-claude-only.claude-mcp.json)).

> **Note when both are installed in `independent` mode:** When Antigravity launches Claude Code, it still propagates `AGENT_BRIDGE_DEPTH=1` and `AGENT_BRIDGE_CHAIN=antigravity:<job_id>` to the child process as a safety rail, so `claude-to-antigravity` will still block `antigravity_respond` and loop-back `antigravity_spawn` unless `AGENT_BRIDGE_ALLOW_CYCLES=true`. Use the explicit `peer` or `primary`/`subordinate` presets below when running both sides together.

### 2. Strict Primary / Subordinate Hierarchy

#### Antigravity as Primary, Claude Code as Subordinate
1. Copy [`presets/hierarchy-antigravity-primary.mcp_config.json`](presets/hierarchy-antigravity-primary.mcp_config.json) over `~/.gemini/config/plugins/claude/mcp_config.json`:
   ```json
   {
     "mcpServers": {
       "claude-local": {
         "command": "node",
         "args": ["server/index.mjs"],
         "env": {
           "AGENT_BRIDGE_ROLE": "primary",
           "AGENT_BRIDGE_MAX_DEPTH": "1",
           "AGENT_BRIDGE_ALLOW_CYCLES": "false",
           "AGENT_BRIDGE_MAX_CONCURRENT": "4",
           "AGENT_BRIDGE_CALLBACK_DISALLOWED_TOOLS": "mcp__antigravity__*"
         }
       }
     }
   }
   ```
2. **Hard enforcement:** Whenever Antigravity spawns Claude Code in `primary` mode, `claude-local` automatically:
   - Injects `AGENT_BRIDGE_ROLE=subordinate`, `AGENT_BRIDGE_DEPTH=1`, and `AGENT_BRIDGE_CHAIN=antigravity:<job_id>` into Claude's child environment.
   - Appends `--disallowedTools mcp__antigravity__*` so Claude Code cannot invoke the Antigravity MCP server back, even if it is installed globally.
3. *(Optional)* If you also keep `claude-to-antigravity` registered in Claude Code for read-only inspection, configure it with [`presets/hierarchy-claude-subordinate.claude-mcp.json`](presets/hierarchy-claude-subordinate.claude-mcp.json) (`AGENT_BRIDGE_ROLE=subordinate`, `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS=true`).

#### Claude Code as Primary, Antigravity as Subordinate
1. Register `claude-to-antigravity` using [`presets/hierarchy-claude-primary.claude-mcp.json`](presets/hierarchy-claude-primary.claude-mcp.json) (`AGENT_BRIDGE_ROLE=primary`, `AGENT_BRIDGE_MAX_DEPTH=1`).
2. *(Optional)* If `antigravity-to-claude` is also installed in Antigravity, replace `~/.gemini/config/plugins/claude/mcp_config.json` with [`presets/hierarchy-antigravity-subordinate.mcp_config.json`](presets/hierarchy-antigravity-subordinate.mcp_config.json) (`AGENT_BRIDGE_ROLE=subordinate`, `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS=true`) so Antigravity can never delegate back to Claude Code.
3. Even if `antigravity-to-claude` is not set to `subordinate`, `claude-to-antigravity` stamps every delegated task with `[bridge: origin=claude role=subordinate depth=1 max_depth=1 chain=claude:<id>]`. Note that because `antigravity-to-claude` cannot inspect which Antigravity conversation called it, the in-band marker is advisory via `claude-orchestration/SKILL.md` and enforced by `antigravity-to-claude/server/index.mjs` when passed in `bridge_context` (or on a leading `[bridge: origin=claude ...]` line in `prompt`). For hard enforcement on the Antigravity side, set `AGENT_BRIDGE_ROLE=subordinate` in `mcp_config.json` (step 2).

### 3. Bidirectional Peer Delegation

Use this when you want to start from **either** Antigravity or Claude Code and delegate to the other without infinite loops:

1. Apply [`presets/bidirectional-antigravity.mcp_config.json`](presets/bidirectional-antigravity.mcp_config.json) to `~/.gemini/config/plugins/claude/mcp_config.json`.
2. Apply [`presets/bidirectional-claude.claude-mcp.json`](presets/bidirectional-claude.claude-mcp.json) to Claude Code's `mcpServers.antigravity` entry (replacing `<path-to-repo>` with your clone path).

**How loops are prevented in `peer` mode:**
- **Depth cap (`AGENT_BRIDGE_MAX_DEPTH=1`):** A top-level session (`depth=0`) can delegate one hop (`depth=1`), and the delegated worker cannot delegate further unless you explicitly raise `AGENT_BRIDGE_MAX_DEPTH`. Note: back-and-forth chains (`A → B → A`) require **both** `AGENT_BRIDGE_MAX_DEPTH > 1` **and** `AGENT_BRIDGE_ALLOW_CYCLES=true`.
- **Cycle guard (`AGENT_BRIDGE_ALLOW_CYCLES=false`):** Every hop appends `<agent>:<id>` to `AGENT_BRIDGE_CHAIN`. Neither side will delegate back to an agent already present in the chain.
- **Concurrency cap (`AGENT_BRIDGE_MAX_CONCURRENT=4`):** Prevents fan-out snowballs (tracked per process in `antigravity-to-claude` and per machine via `ANTIGRAVITY_MCP_STATE_DIR/spawned.json` in `claude-to-antigravity`).
- **Callback stripping at max depth:** When Antigravity launches Claude at `depth + 1 >= max_depth`, it automatically adds `--disallowedTools mcp__antigravity__*`.
- **Callback registration:** Claude launches use `--strict-mcp-config`, so they never load a globally registered `antigravity` server. In `peer` mode below max depth, `claude-local` registers the callback itself, but only from `claude-to-antigravity/server/index.mjs` in the same installation (a checkout or a symlinked plugin). A copied plugin directory has no callback. With the default `MAX_DEPTH=1`, no callback is registered.
- **In-band RPC propagation:** Because Claude → Antigravity calls run over Antigravity's local RPC server (where child env vars cannot cross), `claude-to-antigravity` embeds `[bridge: origin=claude role=... depth=... max_depth=... chain=...]` into the delegation header.
- **No self-approval:** `antigravity_respond` is automatically disabled whenever `AGENT_BRIDGE_DEPTH > 0` or `AGENT_BRIDGE_ROLE=subordinate`, so a delegated worker can never approve its own parent's prompts.

---

## Configuration Reference

### Shared Bridge Environment Variables (Both Connectors)

Both connectors accept `AGENT_BRIDGE_CONTEXT` from their host registration as a version 1 JSON envelope containing an ordered `hops` array of `{from, to, id}` objects and a nonnegative `remaining_hops` count. Each child handoff spends one hop and applies the tighter of the incoming and local limits. Older registrations using depth and a comma-separated sender history are translated when that history is complete. The IDE carries this context in its existing prompt marker. Its registration sets the local limit even when the caller omits that marker.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_ROLE` | `independent` | `independent`, `primary`, `subordinate`, or `peer`. |
| `AGENT_BRIDGE_DEPTH` | `0` | Current hop depth (propagated automatically on child launches). |
| `AGENT_BRIDGE_MAX_DEPTH` | `1` (`0` if `subordinate`) | Maximum allowed delegation hop depth (applies when role is `primary` or `peer`). |
| `AGENT_BRIDGE_CHAIN` | `""` | Comma-separated delegation history (e.g. `antigravity:a1b2c3d4,claude:e5f6a7b8`). |
| `AGENT_BRIDGE_ALLOW_CYCLES` | `false` | Set to `true` only if you intentionally allow `A → B → A` callbacks within `MAX_DEPTH`. |
| `AGENT_BRIDGE_MAX_CONCURRENT` | `4` | Maximum concurrent active delegated runs/jobs per connector. |
| `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS` | `false` | When `true` in `subordinate` mode, omits restricted delegating tools from `tools/list` in addition to refusing them in `tools/call`. |
| `AGENT_BRIDGE_WORKSPACE_ROOTS` | `[<server cwd>]` | JSON array of absolute existing directories. Launch directories (`cwd`, `add_dirs`, `antigravity_spawn` `cwd`) must resolve inside one after following symlinks. If the server cwd is a volume root, you must set this explicitly. |
| `AGENT_BRIDGE_ALLOW_EDITS` | `false` | Exactly `true` or `false`. Permits `Edit` and `Write` in Claude CLI. Set it to `true` to launch or steer an Antigravity IDE agent using the IDE's permissions. |

An invalid value for either of the last two refuses launches (`claude_*` runs, `antigravity_spawn`). Status, wait, and cancel tools keep working. Each connector ships its own copy of `server/workspace-policy.mjs`, so you can install either half alone.

### Connector-Specific Environment Variables

| Variable | Connector | Default | Description |
| :--- | :--- | :--- | :--- |
| `CLAUDE_CLI_BIN` | `antigravity-to-claude` | *(auto-discovered)* | Absolute path to the Claude CLI. On Windows, use a native `.exe` or JavaScript entry point. When unset, the bridge checks standalone installs and PATH before bundled copies. |
| `AGENT_BRIDGE_CALLBACK_DISALLOWED_TOOLS` | `antigravity-to-claude` | `mcp__antigravity__*` | Comma-separated Claude tool patterns passed to `--disallowedTools` when blocking callbacks. |
| `ANTIGRAVITY_LS_ADDRESS` | `claude-to-antigravity` | *(auto-discovered)* | Manual `host:port` override for Antigravity's local language server. |
| `ANTIGRAVITY_CSRF_TOKEN` | `claude-to-antigravity` | *(auto-discovered)* | Manual CSRF token override (pair with `ANTIGRAVITY_LS_ADDRESS`). |
| `ANTIGRAVITY_DATA_DIR` | `claude-to-antigravity` | `~/.gemini/antigravity` | Override Antigravity data directory where `daemon/hub_*.json` lives. |
| `ANTIGRAVITY_MCP_STATE_DIR` | `claude-to-antigravity` | `~/.antigravity-mcp` | Override directory where bridge-spawned conversation state is stored. |

### Non-PATH Node.js Setups (nvm, nvm-windows, fnm, volta, Homebrew)

If a desktop GUI app does not inherit your shell's `PATH`, pin the full `node` binary path in your local MCP config (do not commit personal paths):

<details>
<summary><strong>Windows example (nvm-windows)</strong></summary>

```json
{
  "mcpServers": {
    "claude-local": {
      "command": "C:\\path\\to\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\<YOUR_USER>\\.gemini\\config\\plugins\\claude\\server\\index.mjs"
      ],
      "env": {
        "AGENT_BRIDGE_ROLE": "peer",
        "AGENT_BRIDGE_MAX_DEPTH": "1"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>macOS / Linux example (nvm / Homebrew)</strong></summary>

```json
{
  "mcpServers": {
    "claude-local": {
      "command": "/Users/<YOUR_USER>/.nvm/versions/node/v22.x.x/bin/node",
      "args": [
        "/Users/<YOUR_USER>/.gemini/config/plugins/claude/server/index.mjs"
      ],
      "env": {
        "AGENT_BRIDGE_ROLE": "peer",
        "AGENT_BRIDGE_MAX_DEPTH": "1"
      }
    }
  }
}
```
</details>

---

## MCP Tools Overview

### Antigravity → Claude Code (`claude-local`)

| Tool | Description |
| :--- | :--- |
| `claude_status` | Reports resolved binary, version, `claude auth status`, and active `AGENT_BRIDGE_*` policy. |
| `claude_run` | Runs a restricted local Claude Code task synchronously. Tools are capped at `Read`, `Glob`, and `Grep`, plus `Edit`/`Write` when the host allows edits. Accepts `permission_mode` (`plan`, `acceptEdits`, `dontAsk`), `model`, `effort`, `add_dirs`, an `allowed_tools` subset, `max_budget_usd`, and `ephemeral`. |
| `claude_resume` | Continues a finished session that this server launched in the same `cwd`, under the same ceiling. |
| `claude_fork` | Branches a session that this server launched in the same `cwd` (`--fork-session`), under the same ceiling. |
| `claude_review` | Runs a restricted read-only review (requires Claude Code CLI `>=2.1.248`) limited to `Read`, `Glob`, and `Grep`, or an `allowed_tools` subset (`[]` for diff-only). Accepts `uncommitted`, `base`, `commit`, or a caller-supplied string `review_diff`. |
| `claude_spawn` | Launches a Claude Code agent asynchronously in the background for parallel fan-out. |
| `claude_job_status` | Polls a Claude CLI job by `job_id` (including exit checks after `termination_unconfirmed`) or lists all tracked jobs. |
| `claude_job_cancel` | Requests cancellation and returns the job ID and current status. Poll `claude_job_status` to see when the process exits. |

### Claude Code → Antigravity (`antigravity`)

| Tool | Description |
| :--- | :--- |
| `antigravity_spawn` | Starts a new Antigravity conversation in a target workspace (`cwd`), optionally waiting until completion. |
| `antigravity_send` | Sends a follow-up message to an existing Antigravity conversation. |
| `antigravity_wait` | Waits for one or more Antigravity conversations (`all` or `any`) to become idle. |
| `antigravity_status` | Checks the live status of an Antigravity conversation (running/idle, step count, pending approvals, and final response). |
| `antigravity_result` | Fetches the final response, step summary, or full Markdown transcript of a conversation. |
| `antigravity_list` | Lists Antigravity conversations (optionally filtered to bridge-spawned runs). |
| `antigravity_cancel` | Cancels an active Antigravity conversation (or entire subagent tree with `force_tree`). |
| `antigravity_respond` | Responds to a pending generic permission prompt in the IDE (automatically disabled at `depth > 0` or in `subordinate` mode). Approve built-in terminal, browser, and other non-generic prompts inside the Antigravity IDE. |
| `antigravity_models` | Lists models currently configured in Antigravity. |
| `antigravity_bridge_status` | Reports active `AGENT_BRIDGE_*` policy, refused tools, active spawn count, and next-hop `[bridge: ...]` marker. |

Ordinary `claude_run`, `claude_resume`, `claude_fork`, and `claude_spawn` launches use the workspace and tool ceiling described in [`antigravity-to-claude/README.md`](antigravity-to-claude/README.md#workspace-and-tool-ceiling-claude_run-claude_resume-claude_fork-claude_spawn). For an untrusted checkout, pass a prepared `review_diff` from a trusted source and set `allowed_tools` to `[]`. This skips local Git configuration and filters during diff collection and gives the reviewer only the supplied text.

If the bridge cannot confirm exit within five seconds of a cancellation or timeout, a waiting Claude call returns `termination_unconfirmed`. Use its `job_id` to check progress. The bridge releases the concurrency slot automatically when it observes the process exit.

Delegated `claude-to-antigravity` runs execute inside the running Antigravity IDE and inherit your IDE permissions, including terminal execution. The Claude CLI tool ceiling does not apply to them. The bridge checks `cwd` before a spawn and verifies all workspace directories reported by the IDE before a follow-up or approval. Once a turn starts, file and terminal access follow the IDE's settings. See [`antigravity-to-claude/README.md`](antigravity-to-claude/README.md) and [`claude-to-antigravity/README.md`](claude-to-antigravity/README.md) for connector-specific details.

---

## Verifying Both Servers Locally

Run the test suites from the repository root.

```bash
node --test tests/claude-runner.test.mjs tests/workspace-policy.test.mjs
```

You can also run the MCP stdio handshake against either server.

```bash
# Test Antigravity → Claude Code server
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node antigravity-to-claude/server/index.mjs

# Test Claude Code → Antigravity server
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node claude-to-antigravity/server/index.mjs
```

Verify subordinate mode blocks delegation:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | AGENT_BRIDGE_ROLE=subordinate AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS=true \
    node antigravity-to-claude/server/index.mjs
```

## License

[MIT](LICENSE)
