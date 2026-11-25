import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { EDITS_ENV } from "../workspace-policy.mjs";
import { TOOLS, READ_TOOLS, EDIT_TOOLS, ORDINARY_PERMISSION_MODES, EFFORT_SCHEMA } from "./schemas.mjs";
import { findOnPath } from "./discovery.mjs";
import { InvalidParams, PolicyError } from "./errors.mjs";

const MAX_REVIEW_DIFF_CHARS = 120000;

const ORDINARY_PARAMS = new Set([
  "mode", "prompt", "cwd", "session_id", "last", "permission_mode", "model", "effort", "add_dirs",
  "allowed_tools", "disallowed_tools", "append_system_prompt", "max_budget_usd", "ephemeral",
  "bridge_context", "timeout_seconds",
]);
const ESCAPING_PARAMS = {
  agent: "custom agents load project or user definitions that can grant extra tools",
  worktree: "managed worktrees run worktree hooks and create directories outside the validated cwd",
  worktree_name: "managed worktrees run worktree hooks and create directories outside the validated cwd",
  ide: "IDE connections add MCP tools outside the granted tool set",
};
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLBACK_SERVER_NAME = "antigravity-local";
const DELEGATION_HEADER = "AGENT-TO-AGENT DELEGATION\nSending agent: Google Antigravity. Receiving agent: Claude Code.\nThis task was delegated by Google Antigravity on the user's behalf. The human may not have seen the sending conversation. Attribute relayed claims to Google Antigravity.";

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateOrdinaryParams(mode, params) {
  for (const key of Object.keys(params)) {
    if (Object.hasOwn(ESCAPING_PARAMS, key)) {
      throw new PolicyError(`'${key}' is not available for ordinary Claude launches: ${ESCAPING_PARAMS[key]}.`);
    }
    if (!ORDINARY_PARAMS.has(key)) throw new InvalidParams(`Unsupported ${mode} parameter: ${key}`);
  }
  if (mode === "run" && params.session_id !== undefined) {
    throw new InvalidParams("'session_id' applies only to resume and fork.");
  }
  if (params.permission_mode !== undefined && !ORDINARY_PERMISSION_MODES.includes(params.permission_mode)) {
    throw new PolicyError(`permission_mode must be one of ${ORDINARY_PERMISSION_MODES.join(", ")}; permission bypass and auto-approval are not available.`);
  }
}

function validateCommonParams(params) {
  if (params.model !== undefined && (typeof params.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/.test(params.model))) {
    throw new InvalidParams("model must be a model alias or name.");
  }
  if (params.effort !== undefined && !EFFORT_SCHEMA.enum.includes(params.effort)) {
    throw new InvalidParams(`effort must be one of ${EFFORT_SCHEMA.enum.join(", ")}.`);
  }
  for (const key of ["add_dirs", "allowed_tools", "disallowed_tools"]) {
    if (params[key] !== undefined && !isStringArray(params[key])) throw new InvalidParams(`${key} must be a string array.`);
  }
  if (params.append_system_prompt !== undefined && typeof params.append_system_prompt !== "string") {
    throw new InvalidParams("append_system_prompt must be a string.");
  }
}

// Built-in tools for an ordinary launch: the host ceiling, optionally narrowed by the caller.
function resolveOrdinaryTools(params, workspace) {
  const ceiling = workspace.allowEdits ? [...READ_TOOLS, ...EDIT_TOOLS] : READ_TOOLS;
  if (params.allowed_tools === undefined) return ceiling;
  const unknown = params.allowed_tools.filter((t) => !ceiling.includes(t));
  if (unknown.length) {
    throw new PolicyError(
      `allowed_tools may only narrow the host ceiling (${ceiling.join(", ")}); refused: ${unknown.join(", ")}.` +
        (workspace.allowEdits ? "" : ` Edit and Write require ${EDITS_ENV}=true on the host.`)
    );
  }
  return ceiling.filter((t) => params.allowed_tools.includes(t));
}

function resolveCallbackServer() {
  const candidate = fileURLToPath(new URL("../../../claude-to-antigravity/server/index.mjs", import.meta.url));
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// The reciprocal Claude -> Antigravity callback is registered only in explicit peer mode while the
// downstream hop may still delegate, and only from the claude-to-antigravity server shipped in this
// same installation. User and project MCP servers are never loaded (--strict-mcp-config).
function buildCallbackMcpConfig(policyEval, downstream) {
  if (policyEval.policy?.role !== "peer" || downstream.downstreamRole !== "peer") return null;
  if (downstream.extraDisallowedTools.length > 0) return null;
  const server = resolveCallbackServer();
  if (!server) return null;
  return {
    server,
    config: JSON.stringify({
      mcpServers: { [CALLBACK_SERVER_NAME]: { type: "stdio", command: process.execPath, args: [server], env: downstream.env } },
    }),
  };
}

function runGitSafe(cwd, gitArgs) {
  try {
    const git = findOnPath([process.platform === "win32" ? "git.exe" : "git"]);
    if (!git) throw new Error("Cannot find Git on PATH.");
    return execFileSync(git, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...gitArgs], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : "";
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

function buildReviewPrompt(cwd, params) {
  const sections = [];
  const diffOnly = params.allowed_tools?.length === 0;
  if (params.title) {
    sections.push(`# Review Title: ${String(params.title).trim()}`);
  }

  let targetDescription = "uncommitted changes (staged, unstaged, and untracked files)";
  let diffContent = "";
  let gitContextError = null;

  try {
    if (params.review_diff !== undefined) {
      targetDescription = "the supplied diff";
      diffContent = params.review_diff;
    } else if (params.commit) {
      const sha = String(params.commit).trim();
      targetDescription = `commit ${sha}`;
      const commit = runGitSafe(cwd, ["rev-parse", "--verify", "--end-of-options", sha + "^{commit}"]).trim();
      diffContent = runGitSafe(cwd, ["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", commit, "--"]);
    } else if (params.base) {
      const base = String(params.base).trim();
      targetDescription = `branch diff against '${base}' (${base}...HEAD)`;
      const commit = runGitSafe(cwd, ["rev-parse", "--verify", "--end-of-options", base + "^{commit}"]).trim();
      const stat = runGitSafe(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", `${commit}...HEAD`, "--"]);
      const patch = runGitSafe(cwd, ["diff", "--no-ext-diff", "--no-textconv", `${commit}...HEAD`, "--"]);
      diffContent = `${stat}\n${patch}`.trim();
    } else {
      const status = runGitSafe(cwd, ["status", "--short"]);
      const staged = runGitSafe(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--cached"]);
      const unstaged = runGitSafe(cwd, ["diff", "--no-ext-diff", "--no-textconv"]);
      const parts = [];
      if (status.trim()) parts.push(`## git status --short\n${status.trim()}`);
      if (staged.trim()) parts.push(`## Staged diff (git diff --cached)\n${staged.trim()}`);
      if (unstaged.trim()) parts.push(`## Unstaged diff (git diff)\n${unstaged.trim()}`);
      diffContent = parts.join("\n\n");
    }
  } catch (err) {
    if (diffOnly) throw new Error("Cannot prepare the diff for a diff-only review: " + err.message);
    gitContextError = err instanceof Error ? err.message : String(err);
  }
  if (diffOnly && diffContent.length > MAX_REVIEW_DIFF_CHARS) {
    throw new InvalidParams("Diff-only review accepts at most " + MAX_REVIEW_DIFF_CHARS + " characters. Split the diff and review each part.");
  }

  sections.push(
    [
      `Perform a thorough, read-only code review of ${targetDescription} in ${cwd}.`,
      "Focus on correctness bugs, regressions, security issues, edge cases, race conditions, missing error handling, and test coverage gaps.",
      "Cite exact file paths and line numbers for each finding, ordered by severity (Critical / High / Medium / Low).",
      diffOnly ? "Base the review on the supplied diff alone." : "You may read surrounding files in the repository for context. Do not modify files.",
    ].join("\n")
  );

  if (params.prompt && String(params.prompt).trim()) {
    sections.push(`## Additional Review Focus\n${String(params.prompt).trim()}`);
  }

  if (gitContextError) {
    sections.push(
      `## Git Context Note\nPre-collecting git diff failed (${gitContextError}). Inspect the repository directly using your read-only tools.`
    );
  } else if (!diffContent.trim()) {
    sections.push("## Diff\nNo git diff output was found for the requested target.");
  } else if (diffContent.length > MAX_REVIEW_DIFF_CHARS) {
    sections.push(
      `## Diff (truncated to ${MAX_REVIEW_DIFF_CHARS} of ${diffContent.length} chars; inspect full files with Read/Grep as needed)\n\`\`\`diff\n${diffContent.slice(0, MAX_REVIEW_DIFF_CHARS)}\n\`\`\``
    );
  } else {
    sections.push(`## Diff\n\`\`\`diff\n${diffContent}\n\`\`\``);
  }

  return sections.join("\n\n");
}

// Shared by every launch mode. Never emits permission bypass, agents, worktrees, or IDE hooks.
function appendCommonClaudeFlags(
  args,
  params,
  { permissionMode, extraDisallowedTools = [], addDirs = [] } = {}
) {
  args.push("--permission-mode", permissionMode);
  args.push("--permission-prompts", "none");

  if (params.model) args.push("--model", String(params.model));
  if (params.effort) args.push("--effort", String(params.effort));

  for (const dir of addDirs) args.push("--add-dir", dir);

  if (Array.isArray(params.allowed_tools) && params.allowed_tools.length > 0) {
    const cleaned = params.allowed_tools.map((t) => String(t).trim()).filter(Boolean);
    if (cleaned.length > 0) {
      args.push("--allowedTools", cleaned.join(","));
    }
  }

  const mergedDisallowed = Array.from(
    new Set([
      ...(Array.isArray(params.disallowed_tools) ? params.disallowed_tools : []),
      ...extraDisallowedTools,
    ])
      .values()
  )
    .map((t) => String(t).trim())
    .filter(Boolean);

  if (mergedDisallowed.length > 0) {
    args.push("--disallowedTools", mergedDisallowed.join(","));
  }

  const extra = params.append_system_prompt;
  args.push("--append-system-prompt", extra?.trim() ? DELEGATION_HEADER + "\n\n" + extra : DELEGATION_HEADER);

  if (
    typeof params.max_budget_usd === "number" &&
    Number.isFinite(params.max_budget_usd) &&
    params.max_budget_usd > 0
  ) {
    args.push("--max-budget-usd", String(params.max_budget_usd));
  }

  if (params.ephemeral) args.push("--no-session-persistence");
}

function buildClaudeArgs(mode, params, { extraDisallowedTools = [], tools = [], addDirs = [], callback = null } = {}) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  if (mode === "run" || mode === "resume" || mode === "fork") {
    if (mode !== "run") args.push("--resume", params.session_id);
    if (mode === "fork") args.push("--fork-session");
    args.push("--restricted", "--strict-mcp-config");
    if (callback) args.push("--mcp-config", callback.config);
    args.push("--tools", tools.join(","));
    const canEdit = tools.some((t) => EDIT_TOOLS.includes(t));
    const ordinaryParams = {
      model: params.model,
      effort: params.effort,
      // Narrowing comes from --tools; pre-approve only the callback server's tools, if registered.
      allowed_tools: callback ? [`mcp__${CALLBACK_SERVER_NAME}`] : undefined,
      disallowed_tools: params.disallowed_tools,
      append_system_prompt: params.append_system_prompt,
      max_budget_usd: params.max_budget_usd,
      ephemeral: params.ephemeral,
    };
    appendCommonClaudeFlags(args, ordinaryParams, {
      permissionMode: params.permission_mode ?? (canEdit ? "acceptEdits" : "plan"),
      extraDisallowedTools,
      addDirs,
    });
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "review") {
    const fields = TOOLS.find(tool => tool.name === "claude_review").inputSchema.properties;
    for (const key of Object.keys(params)) {
      if (key !== "mode" && !Object.hasOwn(fields, key)) throw new InvalidParams("Unsupported review parameter: " + key);
    }
    if (params.review_diff !== undefined && (typeof params.review_diff !== "string" ||
        ["base", "commit", "uncommitted"].some(key => Object.hasOwn(params, key)))) {
      throw new InvalidParams("review_diff must be a string and is a separate review target.");
    }
    for (const key of ["title", "base", "commit"]) {
      const value = params[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.trimStart().startsWith("-"))) {
        throw new InvalidParams(key + " must be a non-empty string that does not start with a flag.");
      }
    }
    const supported = READ_TOOLS;
    const readTools = params.allowed_tools === undefined ? supported : params.allowed_tools;
    if (!Array.isArray(readTools) || !readTools.every(tool => supported.includes(tool))) {
      throw new PolicyError("Review allowed_tools must be an array containing only Read, Glob or Grep.");
    }
    args.push("--restricted", "--strict-mcp-config", "--tools", readTools.join(","));
    const reviewParams = {
      append_system_prompt: params.append_system_prompt,
      model: params.model,
      effort: params.effort,
      max_budget_usd: params.max_budget_usd,
      ephemeral: params.ephemeral ?? true,
      allowed_tools: readTools,
      disallowed_tools: params.disallowed_tools,
    };
    appendCommonClaudeFlags(args, reviewParams, {
      permissionMode: "plan",
      extraDisallowedTools,
    });
    const stdinPrompt = buildReviewPrompt(params.cwd, params);
    return { args, stdinPrompt };
  }

  throw new InvalidParams(`Unsupported mode: ${mode}`);
}

export { validateCommonParams, validateOrdinaryParams, resolveOrdinaryTools, buildCallbackMcpConfig, buildClaudeArgs, SESSION_ID_PATTERN };
