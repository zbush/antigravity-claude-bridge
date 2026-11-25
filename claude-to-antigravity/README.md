# claude-to-antigravity (`antigravity-local`)

An MCP server that lets the **Claude Code CLI** (or any MCP client) delegate work over local RPC to agents inside a running **Google Antigravity IDE**. You can spawn IDE agents in parallel, collect their results, send follow-ups, and cancel runs while keeping long investigations out of Claude's context.

- No dependencies: `server/index.mjs` plus `server/context.mjs`, `server/spawned-state.mjs`, and `server/workspace-policy.mjs` (Node 18+).
- Works on its own. You don't need the `antigravity-to-claude` half of this repo.
- Optional `AGENT_BRIDGE_*` settings control depth, agent-level cycles, concurrency, and hierarchy when both halves are installed.

## Requirements

- Node.js 18 or newer on `PATH`
- Google Antigravity installed and **running** on the same machine
- Claude Code, or another MCP client that supports stdio servers

## Install (standalone)

Clone the repo anywhere, then register the server with Claude Code at user scope:

```sh
# macOS / Linux (read-only inspection)
claude mcp add --scope user antigravity-local -- node "<path-to-repo>/claude-to-antigravity/server/index.mjs"
```

```powershell
# Windows PowerShell (full delegation for a workspace root)
claude mcp add --scope user antigravity-local `
  -e AGENT_BRIDGE_ALLOW_EDITS=true `
  -e 'AGENT_BRIDGE_WORKSPACE_ROOTS=["C:\\path\\to\\project"]' `
  -- node "<path-to-repo>\claude-to-antigravity\server\index.mjs"
```

Or add it by hand to an MCP config (for example a project `.mcp.json`):

```json
{
  "mcpServers": {
    "antigravity-local": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/claude-to-antigravity/server/index.mjs"],
      "env": {
        "AGENT_BRIDGE_ALLOW_EDITS": "true",
        "AGENT_BRIDGE_WORKSPACE_ROOTS": "[\"/absolute/path/to/project\"]"
      }
    }
  }
}
```

Restart Claude Code and run `/mcp`. You should see `antigravity-local` with 10 tools. Ask Claude to "check the Antigravity bridge status" to confirm it can reach the IDE.

> Keep the server name `antigravity-local`. Claude Code names its tools `mcp__antigravity-local__<tool>`, matching the `*-local` convention across all three bridges. (If upgrading from an older `antigravity` registration, remove it with `claude mcp remove antigravity --scope user`.)

## How it works

Antigravity's language server serves a local Connect/JSON RPC API on `127.0.0.1`. The bridge reads the port and CSRF token from `$HOME/.gemini/antigravity/daemon/hub_<port>.json` and reads them again if Antigravity restarts.

| Bridge action | Antigravity RPC |
|---|---|
| start an agent | `StartCascade` + `SendUserCascadeMessage` |
| status / wait | `GetAllCascadeTrajectories` (polled) |
| read output | `GetCascadeTrajectorySteps`, `ConvertTrajectoryToMarkdown` |
| stop | `CancelCascadeInvocation` / `ForceStopCascadeTree` |
| approve a permission prompt | `HandleCascadeUserInteraction` |
| models | `GetCascadeModelConfigData` |

The IDE sends a full agent config (tools, hooks, terminal policy, model) with every message. The bridge copies that config from your most recent in-workspace Antigravity conversation, so delegated agents inherit your running Antigravity IDE permissions and terminal auto-execution policy. Those IDE permissions operate independently of Claude Code CLI settings and `claude_review` restrictions. When no recent conversation config is available, the bridge falls back to `default-cascade-config.json` and lets the IDE default model apply.

Spawned agents appear in the Antigravity Agent Manager, where you can watch or take over any of them.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `antigravity_spawn` | delegating | Start an agent on a self-contained brief in `cwd` (optionally `model`, `title`, `wait`) |
| `antigravity_send` | delegating | Send a follow-up message to an existing conversation inside `AGENT_BRIDGE_WORKSPACE_ROOTS` |
| `antigravity_cancel` | mutating | Stop an agent inside `AGENT_BRIDGE_WORKSPACE_ROOTS` (`force_tree` also stops its sub-agents) |
| `antigravity_respond` | mutating | Allow or deny a pending generic permission prompt inside `AGENT_BRIDGE_WORKSPACE_ROOTS` (approve built-in terminal, browser, and other non-generic prompts inside the Antigravity IDE) |
| `antigravity_wait` | read-only | Wait for one or more in-workspace agents (`all` / `any`) and return their final responses; aborts promptly on MCP `notifications/cancelled` |
| `antigravity_status` | read-only | Status, pending approvals, and final response for an in-workspace conversation |
| `antigravity_result` | read-only | Final message, compact step log, or full markdown transcript for an in-workspace conversation |
| `antigravity_list` | read-only | Recent conversations (`mine_only` defaults to `true`; `mine_only: false` lists conversations inside `AGENT_BRIDGE_WORKSPACE_ROOTS`) |
| `antigravity_models` | read-only | Available models and remaining quota |
| `antigravity_bridge_status` | read-only | The active `AGENT_BRIDGE_*` policy, workspace roots, which tools it refuses and why, the active spawn count, and the marker the next spawn would carry |

## Delegation labeling

So that Antigravity models don't mistake delegated work for your own requests:

- Each spawned conversation's title starts with `[Claude] ` and the conversation is tagged `claude-mcp`.
- The first message opens with a header like this:

  ```
  [DELEGATED TASK: from Claude Code, not typed by the user]
  [bridge: origin=claude role=<role> depth=<n> max_depth=<n> chain=<hops> ctx=<base64url>]
  ...guidance...
  ---
  ```

  The guidance says the work is delegated by Claude Code and should be attributed to Claude Code, not the user. It also says that unlabeled messages come from the user directly and take precedence. In `subordinate` mode, it tells the agent not to call any `claude_*` tools.
- `antigravity_send` follow-ups open with `[FROM CLAUDE CODE: delegated follow-up, not typed by the user]`.
- Follow-ups to a bridge-created conversation keep its original hop ID and delegation history. A top-level caller or the original delegated caller can continue it. The bridge retains any tighter hop limit or subordinate role applied on a follow-up.
- The `antigravity_result` step log marks each input `[from claude]` or `[from user]` and hides the header.

## Bridge policy: the `AGENT_BRIDGE_*` contract

Both halves of this repo read the same environment variables. Set them in the server's `env` block (or in the environment of the Claude Code process, which passes them on to the MCP servers it starts). With no variables set, the bridge runs in `independent` mode with read-only inspection only (`AGENT_BRIDGE_ALLOW_EDITS=false`).

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `AGENT_BRIDGE_ROLE` | `independent` \| `primary` \| `subordinate` \| `peer` | `independent` | This session's place in the hierarchy |
| `AGENT_BRIDGE_DEPTH` | integer ≥ 0 | `0` | How many delegation hops led to this session |
| `AGENT_BRIDGE_MAX_DEPTH` | integer ≥ 0 | `1` (`0` for `subordinate`) | Deepest allowed delegation |
| `AGENT_BRIDGE_CHAIN` | comma-separated `<agent>:<id>` hops | `""` | Legacy path of hops that led here (superseded by `AGENT_BRIDGE_CONTEXT`) |
| `AGENT_BRIDGE_ALLOW_CYCLES` | `true` \| `false` | `false` | Allow delegating back to an agent already in the hop chain |
| `AGENT_BRIDGE_MAX_CONCURRENT` | integer ≥ 1 | `4` | Maximum active bridge-spawned Antigravity agents (synchronized across processes via lockfile) |
| `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS` | `true` \| `false` | `false` | Leave tools the policy refuses out of `tools/list` |
| `AGENT_BRIDGE_WORKSPACE_ROOTS` | JSON array of absolute directories | `[<server cwd>]` (must be set if that is a volume root) | Limits `antigravity_spawn`, `antigravity_send`, `antigravity_respond`, `antigravity_cancel`, `antigravity_status`, `antigravity_result`, `antigravity_wait`, and `antigravity_list` |
| `AGENT_BRIDGE_ALLOW_EDITS` | `true` \| `false` | `false` | Set to `true` to start or steer IDE agents and respond to their permission prompts |

**Workspace boundary.** The bridge passes a canonical path to the IDE for each spawn and checks every IDE-reported conversation workspace against `AGENT_BRIDGE_WORKSPACE_ROOTS` before reading transcripts, waiting, steering, approving, or cancelling. The IDE enforces its own terminal and edit settings during the turn. Policy and parameter refusals return JSON-RPC error `-32602`; runtime IDE errors return `{ isError: true }`.

### Roles

- **`independent`** (default) runs the connector on its own under the configured workspace, edit, and hop limits. Spawns carry a `[bridge: ... role=independent ...]` marker.
- **`primary`** starts permitted work and gives each delegated Antigravity agent the `subordinate` role.
- **`subordinate`**: this Claude Code session is a delegated worker. `antigravity_spawn`, `antigravity_send`, `antigravity_cancel`, and `antigravity_respond` are refused with a policy error (`-32602`). The read-only tools still work within workspace roots.
- **`peer`**: delegation can go both ways, up to `AGENT_BRIDGE_MAX_DEPTH` hops, with agent-level cycle detection.

### Rules this server enforces

1. **Depth limit:** when the shared remaining budget is zero or `DEPTH >= MAX_DEPTH`, `antigravity_spawn` and `antigravity_send` are refused.
2. **Agent-level cycle detection:** unless `ALLOW_CYCLES=true`, `antigravity_spawn` and `antigravity_send` are refused if the hop history already contains an `antigravity` sender hop. This stops `A → B → A` (and multi-bridge `A → B → C → A`) loops in every role.
3. **Cross-process concurrency cap:** `antigravity_spawn` acquires a lockfile in `ANTIGRAVITY_MCP_STATE_DIR` (with dead-PID stale-lock recovery) and refuses new spawns while `MAX_CONCURRENT` or more bridge-spawned conversations are active. A conversation counts as active while it is running or waiting on an approval, and for 30 s after it starts.
4. **No approvals from delegates:** `antigravity_respond` is always refused when `DEPTH > 0` or the role is `subordinate`, because a delegated worker must never approve its parent's permission prompts.
5. **Fail closed:** if any `AGENT_BRIDGE_*` value is invalid, the four delegating/mutating tools are refused (`-32602`), and `antigravity_bridge_status` reports the error. An unknown role is treated as `subordinate`.

### What a spawn passes downstream

Each `antigravity_spawn` builds the next hop and writes it into the in-band marker:

- `depth` = `AGENT_BRIDGE_DEPTH + 1`
- `chain` = `AGENT_BRIDGE_CHAIN` + `claude:<id>`
- `ctx` = base64url-encoded v1 `AGENT_BRIDGE_CONTEXT`
- `max_depth` = effective remaining limit
- `role`:
  - `independent` if this role is `independent`
  - otherwise `subordinate` if this role is `primary` or the remaining budget is `0`
  - otherwise `peer`

The marker is also stored with the conversation in `spawned.json` (mode `0600`). The marker and its guidance are **instructions to the Antigravity model** and are enforced by `antigravity-to-claude` when present in `bridge_context` or the opening prompt header lines. Hard limits are enforced by the receiving bridge from its own environment variables.

## Other environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTIGRAVITY_DATA_DIR` | `$HOME/.gemini/antigravity` | Where to look for `daemon/hub_<port>.json` |
| `ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN` | — | Skip discovery and connect to this address with this token |
| `ANTIGRAVITY_MCP_STATE_DIR` | `$HOME/.antigravity-mcp` | Where `spawned.json` and its lockfile are stored |

On Windows, `$HOME` means `%USERPROFILE%`.

## Notes and limits

- The Antigravity IDE must be running locally. This connector calls the running IDE over loopback RPC and reports the IDE's own conversation states.
- The bridge uses an internal, undocumented API that Antigravity's own UI and agent CLI also use. An Antigravity update could change it.
- Delegated agents inherit your running Antigravity IDE permissions, including its terminal auto-execution policy, independent of Claude Code CLI permissions or `claude_review` restrictions.
- `antigravity_respond` handles generic permission prompts only. Approve built-in terminal commands, browser actions, and other non-generic prompts inside the Antigravity IDE window.
- Logs go to stderr with the prefix `[claude-to-antigravity]`.
