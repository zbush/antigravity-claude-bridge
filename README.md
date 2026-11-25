# Antigravity ↔ Claude Code Bridge

Two zero-dependency Node.js Model Context Protocol (MCP) connectors that let **Google Antigravity** and **Anthropic Claude Code** delegate work to each other locally — independently, in a strict **primary/subordinate hierarchy**, or in guarded **bidirectional peer mode**.

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

#### Independent / Default
```bash
claude mcp add --scope user antigravity -- node /path/to/antigravity-claude-bridge/claude-to-antigravity/server/index.mjs
```

#### With Explicit Bridge Role / Environment Variables
```bash
claude mcp add --scope user antigravity \
  -e AGENT_BRIDGE_ROLE=peer \
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
- **In-band RPC propagation:** Because Claude → Antigravity calls run over Antigravity's local RPC server (where child env vars cannot cross), `claude-to-antigravity` embeds `[bridge: origin=claude role=... depth=... max_depth=... chain=...]` into the delegation header.
- **No self-approval:** `antigravity_respond` is automatically disabled whenever `AGENT_BRIDGE_DEPTH > 0` or `AGENT_BRIDGE_ROLE=subordinate`, so a delegated worker can never approve its own parent's prompts.

---

## Configuration Reference

### Shared Bridge Environment Variables (Both Connectors)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_ROLE` | `independent` | `independent`, `primary`, `subordinate`, or `peer`. |
| `AGENT_BRIDGE_DEPTH` | `0` | Current hop depth (propagated automatically on child launches). |
| `AGENT_BRIDGE_MAX_DEPTH` | `1` (`0` if `subordinate`) | Maximum allowed delegation hop depth (applies when role is `primary` or `peer`). |
| `AGENT_BRIDGE_CHAIN` | `""` | Comma-separated delegation history (e.g. `antigravity:a1b2c3d4,claude:e5f6a7b8`). |
| `AGENT_BRIDGE_ALLOW_CYCLES` | `false` | Set to `true` only if you intentionally allow `A → B → A` callbacks within `MAX_DEPTH`. |
| `AGENT_BRIDGE_MAX_CONCURRENT` | `4` | Maximum concurrent active delegated runs/jobs per connector. |
| `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS` | `false` | When `true` in `subordinate` mode, omits restricted delegating tools from `tools/list` in addition to refusing them in `tools/call`. |

### Connector-Specific Environment Variables

| Variable | Connector | Default | Description |
| :--- | :--- | :--- | :--- |
| `CLAUDE_CLI_BIN` | `antigravity-to-claude` | *(auto-discovered)* | Explicit path to `claude` / `claude.exe`. Leave unset to auto-pick the newest version. |
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
| `claude_run` | Runs a scoped local Claude Code task synchronously (`permission_mode`, `model`, `effort`, `worktree`, `allowed_tools`, `ide`, `max_budget_usd`, `ephemeral`). |
| `claude_resume` | Continues an earlier Claude Code thread by `session_id` or `last: true` (`--continue`). |
| `claude_fork` | Branches an existing Claude Code session into a new independent thread (`--fork-session`). |
| `claude_review` | Non-interactive, strictly read-only (`plan` mode) code review of uncommitted changes, a `base` branch diff, or a `commit`. |
| `claude_spawn` | Launches a Claude Code agent asynchronously in the background for parallel fan-out. |
| `claude_job_status` | Polls a background job by `job_id` or lists all tracked jobs. |
| `claude_job_cancel` | Cancels a running background job. |

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
| `antigravity_respond` | Responds to a pending generic permission prompt (automatically disabled at `depth > 0` or in `subordinate` mode). |
| `antigravity_models` | Lists models currently configured in Antigravity. |
| `antigravity_bridge_status` | Reports active `AGENT_BRIDGE_*` policy, refused tools, active spawn count, and next-hop `[bridge: ...]` marker. |

See [`antigravity-to-claude/README.md`](antigravity-to-claude/README.md) and [`claude-to-antigravity/README.md`](claude-to-antigravity/README.md) for connector-specific details.

---

## Verifying Both Servers Locally

Run the MCP stdio handshake against either server:

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
