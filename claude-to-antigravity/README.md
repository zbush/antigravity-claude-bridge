# claude-to-antigravity

An MCP server that lets **Claude Code** (or any MCP client) hand work to agents in a locally running **Google Antigravity** IDE. You can spawn agents in parallel, collect their results, steer them, and stop them, without spending Claude's context on long investigations.

- One file, no dependencies: `server/index.mjs` (Node 18+).
- Works on its own. You don't need the `antigravity-to-claude` half of this repo.
- Optional `AGENT_BRIDGE_*` settings control depth and hierarchy when both halves are installed.

## Requirements

- Node.js 18 or newer on `PATH`
- Google Antigravity installed and **running** on the same machine
- Claude Code, or another MCP client that supports stdio servers

## Install (standalone)

Clone the repo anywhere, then register the server with Claude Code at user scope:

```sh
# macOS / Linux
claude mcp add --scope user antigravity -- node "<path-to-repo>/claude-to-antigravity/server/index.mjs"
```

```powershell
# Windows (PowerShell)
claude mcp add --scope user antigravity -- node "<path-to-repo>\claude-to-antigravity\server\index.mjs"
```

Or add it by hand to an MCP config (for example a project `.mcp.json`):

```json
{
  "mcpServers": {
    "antigravity": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/claude-to-antigravity/server/index.mjs"],
      "env": {}
    }
  }
}
```

Restart Claude Code and run `/mcp`. You should see `antigravity` with 10 tools. Ask Claude to "check the Antigravity bridge status" to confirm it can reach the IDE.

> Keep the server name `antigravity`. Claude Code names its tools `mcp__antigravity__<tool>`, and the hierarchy recipes below rely on that name, for example `--disallowedTools "mcp__antigravity__*"`.

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

The IDE sends a full agent config (tools, hooks, terminal policy, model) with every message. The bridge copies that config from your most recent Antigravity conversation, so spawned agents behave like ones you start yourself. If it can't read one, it falls back to `default-cascade-config.json`. That file has no pinned model, so the IDE default model applies.

Spawned agents appear in the Antigravity Agent Manager, where you can watch or take over any of them.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `antigravity_spawn` | delegating | Start an agent on a self-contained brief in `cwd` (optionally `model`, `title`, `wait`) |
| `antigravity_send` | delegating | Send a follow-up message to an existing conversation |
| `antigravity_cancel` | mutating | Stop an agent (`force_tree` also stops its sub-agents) |
| `antigravity_respond` | mutating | Allow or deny a pending generic permission prompt |
| `antigravity_wait` | read-only | Wait for one or more agents (`all` / `any`) and return their final responses |
| `antigravity_status` | read-only | Status, pending approvals and final response |
| `antigravity_result` | read-only | Final message, compact step log, or full markdown transcript |
| `antigravity_list` | read-only | Recent conversations (`mine_only` for bridge-spawned ones) |
| `antigravity_models` | read-only | Available models and remaining quota |
| `antigravity_bridge_status` | read-only | The active `AGENT_BRIDGE_*` policy, which tools it refuses and why, the active spawn count, and the marker the next spawn would carry |

## Delegation labeling

So that Antigravity models don't mistake delegated work for your own requests:

- Each spawned conversation's title starts with `[Claude] ` and the conversation is tagged `claude-mcp`.
- The first message opens with a header like this:

  ```
  [DELEGATED TASK: from Claude Code, not typed by the user]
  [bridge: origin=claude role=<role> depth=<n> max_depth=<n> chain=<hops>]
  ...guidance...
  ---
  ```

  The guidance says the work is delegated by Claude Code and should be attributed to Claude Code, not the user. It also says that unlabeled messages come from the user directly and take precedence. In `subordinate` mode, it tells the agent not to call any `claude_*` tools.
- `antigravity_send` follow-ups open with `[FROM CLAUDE CODE: delegated follow-up, not typed by the user]`.
- The `antigravity_result` step log marks each input `[from claude]` or `[from user]` and hides the header.

## Bridge policy: the `AGENT_BRIDGE_*` contract

Both halves of this repo read the same environment variables. Set them in the server's `env` block (or in the environment of the Claude Code process, which passes them on to the MCP servers it starts). With no variables set, the bridge runs in `independent` mode and behaves like a plain standalone connector.

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `AGENT_BRIDGE_ROLE` | `independent` \| `primary` \| `subordinate` \| `peer` | `independent` | This session's place in the hierarchy |
| `AGENT_BRIDGE_DEPTH` | integer ≥ 0 | `0` | How many delegation hops led to this session |
| `AGENT_BRIDGE_MAX_DEPTH` | integer ≥ 0 | `1` (`0` for `subordinate`) | Deepest allowed delegation |
| `AGENT_BRIDGE_CHAIN` | comma-separated `<agent>:<id>` hops | `""` | The path of hops that led here |
| `AGENT_BRIDGE_ALLOW_CYCLES` | `true` \| `false` | `false` | Allow delegating back to an agent type already in the chain |
| `AGENT_BRIDGE_MAX_CONCURRENT` | integer ≥ 1 | `4` | Maximum active bridge-spawned Antigravity agents |
| `AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS` | `true` \| `false` | `false` | Leave tools the policy refuses out of `tools/list` |

### Roles

- **`independent`** (default): all tools are available, and nothing is coupled to the other bridge. Spawns still carry a `[bridge: ... role=independent ...]` marker for traceability.
- **`primary`**: all tools are available. Every downstream Antigravity agent is told `role=subordinate` and is instructed not to delegate back to Claude Code.
- **`subordinate`**: this Claude Code session is a delegated worker. `antigravity_spawn`, `antigravity_send`, `antigravity_cancel` and `antigravity_respond` are refused with a policy error. The read-only tools still work.
- **`peer`**: delegation can go both ways, up to `AGENT_BRIDGE_MAX_DEPTH` hops, with cycle detection.

### Rules this server enforces

1. **Depth limit:** when the role is not `independent` and `DEPTH >= MAX_DEPTH`, `antigravity_spawn` and `antigravity_send` are refused.
2. **Cycle detection:** unless `ALLOW_CYCLES=true`, `antigravity_spawn` is refused if `AGENT_BRIDGE_CHAIN` already contains an `antigravity:` hop. This stops A → B → A loops, and it applies in every role.
3. **Concurrency cap:** `antigravity_spawn` is refused while `MAX_CONCURRENT` or more bridge-spawned conversations are active. A conversation counts as active while it is running or waiting on an approval, and for 30 s after it starts. The count covers every bridge process that shares the same state directory, so it is per machine, not per session.
4. **No approvals from delegates:** `antigravity_respond` is always refused when `DEPTH > 0` or the role is `subordinate`, because a delegated worker must never approve its parent's permission prompts.
5. **Fail closed:** if any `AGENT_BRIDGE_*` value is invalid, the four delegating/mutating tools are refused, and `antigravity_bridge_status` reports the error. An unknown role is treated as `subordinate`.

### What a spawn passes downstream

Each `antigravity_spawn` builds the next hop and writes it into the in-band marker:

- `depth` = `AGENT_BRIDGE_DEPTH + 1`
- `chain` = `AGENT_BRIDGE_CHAIN` + `claude:<id>`, where `<id>` is random per server process
- `max_depth` = this server's `AGENT_BRIDGE_MAX_DEPTH`
- `role`:
  - `independent` if this role is `independent`
  - otherwise `subordinate` if this role is `primary` or the new depth is at least `max_depth`
  - otherwise `peer`

The marker is also stored with the conversation in the state file. The marker and its guidance are **instructions to the Antigravity model**. The bridge cannot enforce them inside Antigravity. The hard limits are enforced by the receiving bridge, from its own environment variables, and by how the other side launches Claude Code (see below).

### Recipes

**Standalone:** register the server with no `env`. That's it.

**Claude Code as primary** (Antigravity agents work for Claude and must not call back):

```json
"env": { "AGENT_BRIDGE_ROLE": "primary" }
```

**Claude Code as a subordinate** (started by Antigravity through `antigravity-to-claude`): the launcher should set these on the `claude` process, and this server inherits them:

```sh
AGENT_BRIDGE_ROLE=subordinate
AGENT_BRIDGE_DEPTH=1
AGENT_BRIDGE_CHAIN=antigravity:<id>
AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS=true   # optional
```

For a hard guarantee, the launcher can also remove the tools entirely with `claude --disallowedTools "mcp__antigravity__*"`, or with `--strict-mcp-config` and a config that leaves this server out.

**Peers** (one delegation hop either way):

```json
"env": { "AGENT_BRIDGE_ROLE": "peer", "AGENT_BRIDGE_MAX_DEPTH": "1" }
```

With the defaults, a peer chain is limited to one hop in each direction. Deeper back-and-forth chains need both a higher `MAX_DEPTH` and `ALLOW_CYCLES=true`. Use that only if you know you want it.

## Other environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTIGRAVITY_DATA_DIR` | `$HOME/.gemini/antigravity` | Where to look for `daemon/hub_<port>.json` |
| `ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN` | — | Skip discovery and connect to this address with this token |
| `ANTIGRAVITY_MCP_STATE_DIR` | `$HOME/.antigravity-mcp` | Where `spawned.json` (the bridge-spawned conversations) is stored |

On Windows, `$HOME` means `%USERPROFILE%`.

## Notes and limits

- Antigravity must be running.
- The bridge uses an internal, undocumented API that Antigravity's own UI and agent CLI also use. An Antigravity update could change it.
- Agents run with your Antigravity permissions, including its terminal auto-execution policy.
- `antigravity_respond` only handles generic permission prompts. Approve command, browser and other prompts in the Antigravity window.
- Logs go to stderr with the prefix `[claude-to-antigravity]`.
