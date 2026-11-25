# Antigravity → Claude Code Plugin (`claude-local`)

An Antigravity plugin that lets **Google Antigravity** orchestrate your locally installed **Anthropic Claude Code CLI** via a zero-dependency Node.js MCP stdio server.

## Binary Auto-Discovery

`server/index.mjs` resolves the local `claude` binary automatically in this order:

1. `CLAUDE_CLI_BIN` environment variable (optional explicit override)
2. Standalone install (`~/.local/bin/claude`, `~/.claude/local/claude`, or `PATH`)
3. Claude Desktop's bundled auto-updating Claude Code binary (highest semver in `%APPDATA%\Claude\claude-code\`, MSIX `LocalCache\Roaming\Claude\claude-code\`, macOS `~/Library/Application Support/Claude/claude-code/`, or Linux `~/.config/Claude/claude-code/`)
4. VS Code / Cursor Claude Code extension native binary (`anthropic.claude-code-*`)

Leaving `CLAUDE_CLI_BIN` unset ensures the server automatically picks up newer versions as Claude Desktop updates.

## Included Components

- **MCP Server (`claude-local`)**: Exposes `claude_run`, `claude_resume`, `claude_fork`, `claude_review`, `claude_spawn`, `claude_job_status`, `claude_job_cancel`, and `claude_status`.
- **Skill (`claude-orchestration`)**: Guides Antigravity on permission modes, `allowed_tools`, `--worktree` isolation, session reuse, and `[bridge: ...]` recursion guardrails.

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

See the [root README](../README.md) for topology presets (independent, strict hierarchy, or bidirectional peer mode), `AGENT_BRIDGE_*` environment variables, and non-PATH Node.js configuration.
