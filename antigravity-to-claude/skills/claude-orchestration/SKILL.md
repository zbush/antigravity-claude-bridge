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
(`claude -p --output-format stream-json --verbose`, auto-discovered from `CLAUDE_CLI_BIN`,
`PATH`, Claude Desktop's bundled `claude-code` directory, or IDE extensions) so you can
delegate bounded tasks and coordinate parallel Claude Code workers using the user's
existing local Claude Code auth and `~/.claude` configuration.

## Tool Selection

| Goal | Tool |
| :--- | :--- |
| Verify local Claude Code binary, version, auth, and bridge policy | `claude_status` |
| Single scoped task (wait for result) | `claude_run` |
| Continue an earlier Claude Code thread | `claude_resume` (pass `session_id` or `last: true`) |
| Explore an alternative branch from an existing thread | `claude_fork` |
| Non-interactive read-only code review (uncommitted, branch diff, or commit) | `claude_review` |
| Run 2+ Claude Code agents in parallel without blocking | `claude_spawn` -> `claude_job_status` (and `claude_job_cancel` if needed) |

## Hierarchy & Recursion Guardrails

When this conversation itself was delegated from Claude Code (indicated by a `[Claude]`
title or an in-band `[bridge: ...]` marker in the prompt):

1. **Respect `role=subordinate` and depth limits.** If the incoming prompt contains
   `[bridge: ... role=subordinate ...]` or `depth >= max_depth`, do **NOT** call
   `claude_run`, `claude_resume`, `claude_fork`, `claude_review`, or `claude_spawn`.
   Complete the task directly yourself.
2. **Propagate `bridge_context` in bidirectional mode.** If the incoming prompt contains a
   `[bridge: ...]` marker and delegation is explicitly permitted (`role=peer` and
   `depth < max_depth`), pass that exact `[bridge: ...]` string in the `bridge_context`
   parameter so the server enforces depth and cycle limits automatically.

## Orchestration Guidelines

1. **Always pass an exact absolute `cwd`.** Never rely on implicit working directories.
2. **Choose the narrowest `permission_mode` needed:**
   - Use `permission_mode: "plan"` for codebase exploration, architecture audits, bug triage, and second opinions (strictly read-only).
   - Use `permission_mode: "acceptEdits"` (default) for scoped file edits, paired with explicit `allowed_tools` (e.g. `["Read", "Edit", "Write", "Bash(npm test)", "Bash(git *)"]`) when Claude Code needs to run verification commands.
   - Use `permission_mode: "auto"` when you want Claude Code's built-in auto-mode classifier to approve safe workspace edits and dev commands.
   - Avoid `permission_mode: "bypassPermissions"` unless the user explicitly asks for it.
   - Because headless runs pass `--permission-prompts none`, check `permission_denials` in the tool response if a command was blocked, and broaden `allowed_tools` or `permission_mode` only as needed.
3. **Isolate parallel writers with `worktree: true`.** When spawning multiple Claude Code agents that edit files in the same Git repository at the same time, pass `worktree: true` (and optional `worktree_name`) so their edits do not collide on the working tree.
4. **Write self-contained briefs.** Claude Code runs in its own fresh context and does not see this conversation. Include:
   - Concrete goal and scope (exact files/modules to inspect or change)
   - Constraints and conventions to follow
   - Verification criteria (tests/checks Claude Code should run) and expected output summary
5. **Leverage `session_id` for multi-turn loops.** Save the `session_id` returned by `claude_run` or `claude_job_status` so you can follow up with `claude_resume` or branch with `claude_fork` instead of repeating full context.
6. **Verify before handing back.** After Claude Code modifies files, inspect the git diff or run tests yourself before reporting completion to the user.
