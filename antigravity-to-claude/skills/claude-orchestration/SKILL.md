---
name: claude-orchestration
description: >-
  Orchestrate local Anthropic Claude Code agents through the claude-local MCP server.
  Use this skill whenever the user asks to delegate work to Claude Code, run parallel
  Claude Code workers, resume or fork a Claude Code thread, check local Claude Code
  auth/status, or ask Claude Code for a code review or second opinion.
---

# Local Claude Code Agent Orchestration

The `claude-local` MCP server wraps the locally installed Claude Code CLI
(`claude -p --output-format stream-json --verbose`, auto-discovered from `CLAUDE_BIN` /
`CLAUDE_CLI_BIN`, `PATH`, Claude Desktop's bundled `claude-code` directory, or IDE extensions)
so you can delegate bounded tasks and coordinate parallel Claude Code workers using the user's
existing local Claude Code auth.

## Tool Selection

| Goal | Tool |
| :--- | :--- |
| Verify local Claude Code binary, version, auth, workspace roots, and bridge policy | `claude_status` |
| Single scoped task (wait for result) | `claude_run` |
| Continue an earlier Claude Code thread started by this bridge | `claude_resume` (pass `session_id`; `last` is not supported) |
| Explore an alternative branch from an existing bridge thread | `claude_fork` |
| Non-interactive read-only code review (uncommitted, branch diff, commit, or prepared diff) | `claude_review` |
| Run 2+ Claude Code agents in parallel without blocking | `claude_spawn` -> `claude_job_status` (and `claude_job_cancel` if needed) |

## Hierarchy & Recursion Guardrails

When this conversation itself was delegated from Claude Code (indicated by a `[Claude]`
title or an in-band `[bridge: ...]` marker in the opening prompt header):

1. **Respect `role=subordinate` and depth limits.** If the incoming prompt header contains
   `[bridge: ... role=subordinate ...]` or `depth >= max_depth`, do **NOT** call
   `claude_run`, `claude_resume`, `claude_fork`, `claude_review`, or `claude_spawn`.
   Complete the task directly yourself.
2. **Propagate `bridge_context` in bidirectional mode.** If the incoming prompt header contains a
   `[bridge: ...]` marker and delegation is explicitly permitted (`role=peer` and
   `depth < max_depth`), pass that exact `[bridge: ...]` string in the `bridge_context`
   parameter so the server enforces depth and agent-level cycle limits automatically.

## Orchestration Guidelines

1. **Always pass an exact absolute `cwd` inside the host's workspace roots.** The server rejects directories outside `AGENT_BRIDGE_WORKSPACE_ROOTS`. Check `claude_status` → `workspace` for the allowed roots.
2. **Work within the host tool ceiling.** Claude Code only gets `Read`, `Glob`, and `Grep`, plus `Edit` and `Write` when the host sets `AGENT_BRIDGE_ALLOW_EDITS=true`. It has no shell, so it cannot run tests or Git. Pass an `allowed_tools` subset to narrow further. `permission_mode` accepts `plan`, `acceptEdits`, or `dontAsk`. `agent`, `worktree`, and `ide` are rejected.
3. **Avoid parallel writers on the same files.** Managed worktrees are not available, so give each concurrent editing agent separate files or directories.
4. **Write self-contained briefs.** Claude Code runs in its own fresh context with an automatic `AGENT-TO-AGENT DELEGATION` system attribution header and does not see this conversation. Include:
   - Concrete goal and scope (exact files/modules to inspect or change)
   - Constraints and conventions to follow
   - Expected output summary. Run any tests yourself, because Claude Code has no shell.
5. **Leverage `session_id` for multi-turn loops.** Save the `session_id` returned by `claude_run` or `claude_job_status`. You can resume (after the run finishes) or fork it with the same `cwd` while this server process is running.
6. **Verify before handing back.** After Claude Code modifies files, inspect the git diff or run tests yourself before reporting completion to the user.
