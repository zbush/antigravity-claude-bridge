import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { nextContext, readContext, registeredContext, senderHistory } from "./context.mjs";

const SERVER_NAME = "claude-local";
const SERVER_VERSION = "1.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const MAX_RECENT_EVENTS = 40;
const MAX_STDERR_CHARS = 16000;
const MAX_REVIEW_DIFF_CHARS = 120000;

const VALID_BRIDGE_ROLES = new Set(["independent", "primary", "subordinate", "peer"]);
const SPAWN_DELEGATING_TOOLS = new Set([
  "claude_run",
  "claude_resume",
  "claude_fork",
  "claude_review",
  "claude_spawn",
]);
const MUTATING_TOOLS = new Set([...SPAWN_DELEGATING_TOOLS, "claude_job_cancel"]);

const jobs = new Map();
const activeChildren = new Set();
const requestControllers = new Map();

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function sendJsonRpc(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendJsonRpc({ jsonrpc: "2.0", id, error });
}

function parseBoolEnv(name, defaultValue, configErrors) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  configErrors.push(`${name}="${process.env[name]}" must be "true" or "false"`);
  return defaultValue;
}

function parseIntEnv(name, defaultValue, minValue, configErrors) {
  const raw = String(process.env[name] ?? "").trim();
  if (raw === "") return defaultValue;
  if (!/^\d+$/.test(raw) || Number(raw) < minValue) {
    configErrors.push(`${name}="${process.env[name]}" must be an integer >= ${minValue}`);
    return defaultValue;
  }
  return Number(raw);
}

function getBridgePolicy() {
  const rawRole = String(process.env.AGENT_BRIDGE_ROLE ?? "")
    .trim()
    .toLowerCase();
  const configErrors = [];
  let role = "independent";
  if (rawRole !== "") {
    if (VALID_BRIDGE_ROLES.has(rawRole)) {
      role = rawRole;
    } else {
      configErrors.push(
        `AGENT_BRIDGE_ROLE="${process.env.AGENT_BRIDGE_ROLE}" must be one of ${Array.from(VALID_BRIDGE_ROLES).join(", ")}`
      );
      role = "subordinate"; // fail closed
    }
  }
  const depth = parseIntEnv("AGENT_BRIDGE_DEPTH", 0, 0, configErrors);
  const defaultMaxDepth = role === "subordinate" ? 0 : 1;
  const maxDepth = parseIntEnv("AGENT_BRIDGE_MAX_DEPTH", defaultMaxDepth, 0, configErrors);
  const chain = String(process.env.AGENT_BRIDGE_CHAIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let context;
  try { context = registeredContext(process.env, "antigravity", depth, chain, maxDepth); }
  catch (error) { configErrors.push(error.message); }
  const allowCycles = parseBoolEnv("AGENT_BRIDGE_ALLOW_CYCLES", false, configErrors);
  const maxConcurrent = parseIntEnv("AGENT_BRIDGE_MAX_CONCURRENT", 4, 1, configErrors);
  const hideRestrictedTools = parseBoolEnv("AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS", false, configErrors);
  const callbackDisallowedTools = String(
    process.env.AGENT_BRIDGE_CALLBACK_DISALLOWED_TOOLS ?? "mcp__antigravity__*"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    role,
    depth: context?.hops.length ?? depth,
    maxDepth,
    chain: context?.hops.map(h => h.from + ":" + h.id) ?? chain,
    context,
    allowCycles,
    maxConcurrent,
    hideRestrictedTools,
    callbackDisallowedTools,
    configErrors: configErrors.length > 0 ? configErrors : undefined,
  };
}

function parseInBandBridgeMarker(text, { requireLineStart = false } = {}) {
  if (typeof text !== "string" || !text) return null;
  const pattern = requireLineStart
    ? /^\[bridge:\s*(origin=claude\b[^\]]*)\]/im
    : /\[bridge:\s*([^\]]+)\]/i;
  const match = text.match(pattern);
  if (!match) return null;
  const fields = {};
  for (const part of match[1].trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return {
    origin: fields.origin || null,
    context: fields.ctx === undefined ? undefined : readContext(Buffer.from(fields.ctx, "base64url").toString("utf8"), "antigravity"),
    role: fields.role && VALID_BRIDGE_ROLES.has(fields.role) ? fields.role : null,
    depth: fields.depth !== undefined && /^\d+$/.test(fields.depth) ? Number(fields.depth) : null,
    maxDepth:
      fields.max_depth !== undefined && /^\d+$/.test(fields.max_depth)
        ? Number(fields.max_depth)
        : null,
    chain: fields.chain
      ? fields.chain
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

function evaluateDelegationPolicy(toolName, rawParams = {}) {
  const policy = getBridgePolicy();
  const inBand =
    parseInBandBridgeMarker(rawParams.bridge_context, { requireLineStart: false }) ||
    parseInBandBridgeMarker(rawParams.prompt, { requireLineStart: true });

  // Merge in-band marker (from Claude -> Antigravity RPC messages) with local env policy.
  let effectiveRole = policy.role;
  if (inBand?.role === "subordinate") {
    effectiveRole = "subordinate";
  }
  let context = policy.context;
  let effectiveMaxDepth = Math.min(policy.maxDepth, policy.depth + (context?.remaining_hops ?? 0));
  if (inBand) {
    effectiveMaxDepth = Math.min(effectiveMaxDepth, inBand.maxDepth ?? effectiveMaxDepth);
    const marker = inBand.context ?? senderHistory(inBand.chain, "antigravity", Math.max(0, effectiveMaxDepth - inBand.chain.length));
    if (inBand.depth !== null && marker.hops.length !== inBand.depth) throw new Error("Bridge marker depth disagrees with its history.");
    if (context?.hops.some((hop, i) => JSON.stringify(hop) !== JSON.stringify(marker.hops[i]))) {
      throw new Error("Bridge marker conflicts with the registered hop history.");
    }
    context = marker;
    effectiveMaxDepth = Math.min(effectiveMaxDepth, marker.hops.length + marker.remaining_hops);
  }
  const effectiveDepth = context?.hops.length ?? policy.depth;
  const effectiveChain = context?.hops.map(h => h.from + ":" + h.id) ?? policy.chain;

  if (!MUTATING_TOOLS.has(toolName)) {
    return { allowed: true, policy, effectiveRole, effectiveDepth, effectiveMaxDepth, effectiveChain };
  }

  if (policy.configErrors && policy.configErrors.length > 0) {
    return {
      allowed: false,
      reason: `Delegation blocked by fail-closed bridge policy: invalid configuration (${policy.configErrors.join("; ")}). Fix the AGENT_BRIDGE_* variables.`,
    };
  }

  if (effectiveRole === "subordinate") {
    return {
      allowed: false,
      reason:
        "Delegation blocked by bridge policy: AGENT_BRIDGE_ROLE is 'subordinate'. Subordinate instances may only use read-only status tools.",
    };
  }

  if (toolName === "claude_job_cancel") {
    return { allowed: true, policy, effectiveRole, effectiveDepth, effectiveMaxDepth, effectiveChain };
  }

  if (effectiveDepth >= effectiveMaxDepth) {
    return {
      allowed: false,
      reason: `Delegation blocked by bridge policy: current depth (${effectiveDepth}) reached AGENT_BRIDGE_MAX_DEPTH (${effectiveMaxDepth}).`,
    };
  }

  if (
    !policy.allowCycles &&
    effectiveChain.some((entry) => entry.toLowerCase().startsWith("claude:"))
  ) {
    return {
      allowed: false,
      reason: `Delegation blocked by cycle guard: target 'claude' is already in AGENT_BRIDGE_CHAIN (${effectiveChain.join(",")}). Set AGENT_BRIDGE_ALLOW_CYCLES=true to override.`,
    };
  }

  const runningCount = activeChildren.size;
  if (runningCount >= policy.maxConcurrent) {
    return {
      allowed: false,
      reason: `Delegation blocked by concurrency limit: ${runningCount} active Claude Code job(s) running (AGENT_BRIDGE_MAX_CONCURRENT=${policy.maxConcurrent}).`,
    };
  }

  return {
    allowed: true,
    policy,
    effectiveRole,
    effectiveDepth,
    effectiveMaxDepth,
    effectiveChain,
    context,
  };
}

function buildDownstreamBridgeConfig(jobId, policyEval) {
  const { policy, effectiveRole, effectiveDepth, effectiveMaxDepth, effectiveChain, context } = policyEval;
  const nextDepth = effectiveDepth + 1;
  const nextChain = [...effectiveChain, `antigravity:${jobId}`];
  const envelope = nextContext(context, "antigravity", "claude", effectiveMaxDepth - effectiveDepth, jobId);

  let downstreamRole = "independent";
  if (effectiveRole === "primary") {
    downstreamRole = "subordinate";
  } else if (effectiveRole === "peer") {
    downstreamRole = nextDepth >= effectiveMaxDepth ? "subordinate" : "peer";
  }

  const blockCallbackTools =
    effectiveRole === "primary" ||
    (effectiveRole === "peer" && nextDepth >= effectiveMaxDepth);

  return {
    env: {
      AGENT_BRIDGE_CONTEXT: JSON.stringify(envelope),
      AGENT_BRIDGE_ROLE: downstreamRole,
      AGENT_BRIDGE_DEPTH: String(nextDepth),
      AGENT_BRIDGE_MAX_DEPTH: String(effectiveMaxDepth),
      AGENT_BRIDGE_CHAIN: nextChain.join(","),
      AGENT_BRIDGE_ALLOW_CYCLES: policy.allowCycles ? "true" : "false",
      AGENT_BRIDGE_MAX_CONCURRENT: String(policy.maxConcurrent),
      AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS: policy.hideRestrictedTools ? "true" : "false",
    },
    extraDisallowedTools: blockCallbackTools ? policy.callbackDisallowedTools : [],
    downstreamRole,
    nextDepth,
    nextChain,
  };
}

function parseSemver(versionStr) {
  const match = String(versionStr || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va && vb) {
    for (let i = 0; i < 3; i += 1) {
      if (va[i] !== vb[i]) return vb[i] - va[i];
    }
    return b.localeCompare(a);
  }
  if (va) return -1;
  if (vb) return 1;
  return b.localeCompare(a);
}

function findClaudeInVersionedDir(baseDir, binaryName) {
  if (!baseDir || !fs.existsSync(baseDir)) return null;
  let versionEntries;
  try {
    versionEntries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareSemverDesc);
  } catch {
    return null;
  }

  for (const ver of versionEntries) {
    const verDir = path.join(baseDir, ver);
    const direct = path.join(verDir, binaryName);
    if (fs.existsSync(direct)) return direct;
    try {
      const subDirs = fs
        .readdirSync(verDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const sub of subDirs) {
        const nested = path.join(verDir, sub.name, binaryName);
        if (fs.existsSync(nested)) return nested;
      }
    } catch {
      // ignore unreadable subdirectories
    }
  }
  return null;
}

function findClaudeInExtensionsDir(extDir, binaryName) {
  if (!extDir || !fs.existsSync(extDir)) return null;
  try {
    const dirs = fs
      .readdirSync(extDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("anthropic.claude-code-"))
      .map((d) => d.name)
      .sort((a, b) => {
        const va = a.replace(/^anthropic\.claude-code-/, "");
        const vb = b.replace(/^anthropic\.claude-code-/, "");
        return compareSemverDesc(va, vb);
      });
    for (const dir of dirs) {
      const candidate = path.join(extDir, dir, "resources", "native-binary", binaryName);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore unreadable extension directories
  }
  return null;
}

function findOnPath(binaryNames) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(dir => path.isAbsolute(dir));
  for (const dir of dirs) {
    for (const name of binaryNames) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      } catch {
        // ignore permission errors on PATH entries
      }
    }
  }
  return null;
}

function discoverClaudeBinary() {
  const isWin = process.platform === "win32";
  const exeName = isWin ? "claude.exe" : "claude";
  const home = os.homedir();

  // 1. Explicit env override
  const configured = process.env.CLAUDE_CLI_BIN;
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.statSync(configured, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("CLAUDE_CLI_BIN must point to an existing absolute file.");
    }
    if (isWin && !/\.(exe|[cm]?js)$/i.test(configured)) {
      throw new Error("CLAUDE_CLI_BIN must point to a Windows .exe or JavaScript CLI entry point.");
    }
    return { path: configured, source: "CLAUDE_CLI_BIN" };
  }

  // 2. Standalone CLI on standard native install paths or PATH
  const standaloneCandidates = [
    path.join(home, ".local", "bin", exeName),
    path.join(home, ".claude", "local", exeName),
  ];
  for (const candidate of standaloneCandidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, source: "standalone" };
    }
  }

  const fromPath = findOnPath(isWin ? ["claude.exe", path.join("node_modules", "@anthropic-ai", "claude-code", "cli.js")] : ["claude"]);
  if (fromPath) {
    return { path: fromPath, source: "PATH" };
  }

  // 3. Claude Desktop bundled Claude Code CLI (auto-updates to latest semver)
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const desktopBin = findClaudeInVersionedDir(
      path.join(appData, "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }

    // MSIX virtualized Roaming path fallback
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const packagesDir = path.join(localAppData, "Packages");
    if (fs.existsSync(packagesDir)) {
      try {
        const claudePkgs = fs
          .readdirSync(packagesDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith("Claude_"))
          .map((d) => d.name);
        for (const pkg of claudePkgs) {
          const msixBin = findClaudeInVersionedDir(
            path.join(packagesDir, pkg, "LocalCache", "Roaming", "Claude", "claude-code"),
            exeName
          );
          if (msixBin) {
            return { path: msixBin, source: "claude-desktop-msix" };
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (process.platform === "darwin") {
    const desktopBin = findClaudeInVersionedDir(
      path.join(home, "Library", "Application Support", "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }
  } else {
    const desktopBin = findClaudeInVersionedDir(
      path.join(home, ".config", "Claude", "claude-code"),
      exeName
    );
    if (desktopBin) {
      return { path: desktopBin, source: "claude-desktop" };
    }
  }

  // 4. IDE extension bundled native binary (VS Code / Cursor)
  const ideDirs = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  for (const extDir of ideDirs) {
    const extBin = findClaudeInExtensionsDir(extDir, exeName);
    if (extBin) {
      return { path: extBin, source: "ide-extension" };
    }
  }

  return null;
}

function resolveClaudeInvocation(claudeArgs) {
  const discovered = discoverClaudeBinary();
  if (!discovered) throw new Error("Cannot find Claude Code. Set CLAUDE_CLI_BIN to its absolute executable path.");
  const useNode = /\.[cm]?js$/i.test(discovered.path);
  return {
    command: useNode ? process.execPath : discovered.path,
    args: useNode ? [discovered.path, ...claudeArgs] : claudeArgs,
    shell: false,
    binary: discovered.path,
    source: discovered.source,
  };
}

function buildChildEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Avoid nested-session guards if the parent environment sets these.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function clampTimeoutMs(timeoutSeconds) {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, timeoutSeconds))
      : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function validateCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("'cwd' must be a non-empty absolute directory path.");
  }
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  return resolved;
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
    throw new Error("Diff-only review accepts at most " + MAX_REVIEW_DIFF_CHARS + " characters. Split the diff and review each part.");
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

function appendCommonClaudeFlags(
  args,
  params,
  { defaultPermissionMode, forceReadOnly = false, extraDisallowedTools = [] } = {}
) {
  const permMode = forceReadOnly
    ? "plan"
    : params.permission_mode || defaultPermissionMode || "acceptEdits";

  args.push("--permission-mode", permMode);
  args.push("--permission-prompts", "none");

  if (!forceReadOnly && permMode === "bypassPermissions") {
    args.push("--allow-dangerously-skip-permissions");
  }

  if (params.model) args.push("--model", String(params.model));
  if (params.effort) args.push("--effort", String(params.effort));
  if (params.agent) args.push("--agent", String(params.agent));

  if (params.worktree_name && String(params.worktree_name).trim()) {
    args.push("--worktree", String(params.worktree_name).trim());
  } else if (params.worktree) {
    args.push("--worktree");
  }

  if (Array.isArray(params.add_dirs)) {
    for (const dir of params.add_dirs) {
      if (typeof dir === "string" && dir.trim()) {
        args.push("--add-dir", path.resolve(dir));
      }
    }
  }

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

  if (params.append_system_prompt && String(params.append_system_prompt).trim()) {
    args.push("--append-system-prompt", String(params.append_system_prompt));
  }

  if (
    typeof params.max_budget_usd === "number" &&
    Number.isFinite(params.max_budget_usd) &&
    params.max_budget_usd > 0
  ) {
    args.push("--max-budget-usd", String(params.max_budget_usd));
  }

  if (params.ide) args.push("--ide");
  if (params.ephemeral) args.push("--no-session-persistence");
}

function buildClaudeArgs(mode, params, extraDisallowedTools = []) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  if (mode === "run") {
    appendCommonClaudeFlags(args, params, {
      defaultPermissionMode: "acceptEdits",
      extraDisallowedTools,
    });
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "resume") {
    if (params.session_id) {
      args.push("--resume", String(params.session_id));
    } else if (params.last) {
      args.push("--continue");
    } else {
      throw new Error("Provide either 'session_id' or 'last: true' for claude_resume.");
    }
    appendCommonClaudeFlags(args, params, {
      defaultPermissionMode: "acceptEdits",
      extraDisallowedTools,
    });
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "fork") {
    if (!params.session_id) {
      throw new Error("'session_id' is required for claude_fork.");
    }
    args.push("--resume", String(params.session_id), "--fork-session");
    appendCommonClaudeFlags(args, params, {
      defaultPermissionMode: "acceptEdits",
      extraDisallowedTools,
    });
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "review") {
    const fields = TOOLS.find(tool => tool.name === "claude_review").inputSchema.properties;
    for (const key of Object.keys(params)) {
      if (key !== "mode" && !Object.hasOwn(fields, key)) throw new Error("Unsupported review parameter: " + key);
    }
    if (params.review_diff !== undefined && (typeof params.review_diff !== "string" ||
        ["base", "commit", "uncommitted"].some(key => Object.hasOwn(params, key)))) {
      throw new Error("review_diff must be a string and is a separate review target.");
    }
    const supported = ["Read", "Glob", "Grep"];
    const readTools = params.allowed_tools === undefined ? supported : params.allowed_tools;
    if (!Array.isArray(readTools) || !readTools.every(tool => supported.includes(tool))) {
      throw new Error("Review allowed_tools must be an array containing only Read, Glob or Grep.");
    }
    if (params.disallowed_tools !== undefined && (!Array.isArray(params.disallowed_tools) ||
        !params.disallowed_tools.every(tool => typeof tool === "string"))) throw new Error("disallowed_tools must be a string array.");
    args.push("--restricted", "--strict-mcp-config", "--tools", readTools.join(","));
    const reviewParams = {
      model: params.model,
      effort: params.effort,
      max_budget_usd: params.max_budget_usd,
      ephemeral: params.ephemeral ?? true,
      allowed_tools: readTools,
      disallowed_tools: params.disallowed_tools,
    };
    appendCommonClaudeFlags(args, reviewParams, {
      forceReadOnly: true,
      extraDisallowedTools,
    });
    const stdinPrompt = buildReviewPrompt(params.cwd, params);
    return { args, stdinPrompt };
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

function extractCommandRecord(block) {
  const name = block.name;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  if (name === "Bash" || name === "PowerShell") {
    return {
      tool: name,
      command: input.command || input.cmd || "",
      description: input.description || undefined,
    };
  }
  return null;
}

function extractFileChangeRecord(block) {
  const name = block.name;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    return {
      tool: name,
      file_path: input.file_path || input.notebook_path || input.path || "",
    };
  }
  return null;
}

function terminateOwnedTree(child, force = true) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch (err) { if (err.code !== "ESRCH") throw err; }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const root = [process.env.SystemRoot, process.env.WINDIR].find(dir => /^[a-z]:[\\/]/i.test(dir ?? ""));
  if (root && spawnSync(path.join(root, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)], {
    windowsHide: true, stdio: "ignore", timeout: 2000,
  }).status === 0) return;
  try { process.kill(child.pid, 0); } catch (err) { if (err.code === "ESRCH") return; }
  try { child.kill("SIGKILL"); } catch (err) { if (err.code === "ESRCH") return; }
  throw new Error("Windows could not confirm process-tree termination.");
}

function createRunner(mode, rawParams, policyEval, requestSignal) {
  requestSignal?.throwIfAborted();
  const cwd = validateCwd(rawParams.cwd);
  if (
    (mode === "run" || mode === "resume" || mode === "fork") &&
    !String(rawParams.prompt || "").trim()
  ) {
    throw new Error(`'prompt' is required for mode '${mode}'.`);
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const downstream = buildDownstreamBridgeConfig(jobId, policyEval);
  const params = { ...rawParams, cwd };
  const { args, stdinPrompt } = buildClaudeArgs(
    mode,
    params,
    downstream.extraDisallowedTools
  );
  const invocation = resolveClaudeInvocation(args);
  const timeoutMs = clampTimeoutMs(params.timeout_seconds);

  const state = {
    job_id: jobId,
    mode,
    cwd,
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    session_id: params.session_id || null,
    model: params.model || null,
    claude_code_version: null,
    binary: invocation.binary,
    bridge: {
      role: policyEval.effectiveRole,
      downstream_role: downstream.downstreamRole,
      depth: downstream.nextDepth,
      max_depth: policyEval.effectiveMaxDepth,
      chain: downstream.nextChain,
      callback_tools_blocked: downstream.extraDisallowedTools,
    },
    exit_code: null,
    signal: null,
    response: "",
    messages: [],
    commands: [],
    file_changes: [],
    permission_denials: [],
    usage: null,
    total_cost_usd: null,
    num_turns: null,
    terminal_reason: null,
    errors: [],
    recent_events: [],
    stderr: "",
    pid: null,
    cancel: null,
  };

  let stdoutBuffer = "";
  let receivedResult = false;
  let settled = false;
  let child = null;
  let timer = null;

  const pushRecent = (summary) => {
    if (!summary) return;
    state.recent_events.push(summary);
    if (state.recent_events.length > MAX_RECENT_EVENTS) {
      state.recent_events.shift();
    }
  };

  const handleJsonLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (evt.session_id) {
      state.session_id = evt.session_id;
    }

    if (evt.type === "system" && evt.subtype === "init") {
      if (evt.model) state.model = evt.model;
      if (evt.claude_code_version) state.claude_code_version = evt.claude_code_version;
      pushRecent({
        type: "init",
        session_id: evt.session_id,
        model: evt.model,
        permission_mode: evt.permissionMode,
      });
      return;
    }

    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      if (evt.is_api_error_message || evt.error) {
        const textParts = evt.message.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const errMsg = textParts || String(evt.error || "API error");
        if (!state.errors.includes(errMsg)) state.errors.push(errMsg);
        pushRecent({ type: "error", error: evt.error, message: errMsg.slice(0, 240) });
        return;
      }

      const textChunks = [];
      for (const block of evt.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textChunks.push(block.text);
        } else if (block.type === "tool_use") {
          const cmd = extractCommandRecord(block);
          if (cmd) {
            state.commands.push(cmd);
            pushRecent({ type: "command", tool: cmd.tool, command: cmd.command.slice(0, 200) });
          } else {
            const fc = extractFileChangeRecord(block);
            if (fc) {
              state.file_changes.push(fc);
              pushRecent({ type: "file_change", tool: fc.tool, file_path: fc.file_path });
            } else {
              pushRecent({ type: "tool_use", tool: block.name });
            }
          }
        }
      }

      const joinedText = textChunks.join("\n").trim();
      if (joinedText) {
        state.messages.push(joinedText);
        state.response = joinedText;
        pushRecent({ type: "assistant_message", text_preview: joinedText.slice(0, 240) });
      }
      return;
    }

    if (evt.type === "result") {
      receivedResult = true;
      if (typeof evt.result === "string" && evt.result.trim()) {
        state.response = evt.result;
      }
      if (evt.usage) state.usage = evt.usage;
      if (typeof evt.total_cost_usd === "number") state.total_cost_usd = evt.total_cost_usd;
      if (typeof evt.num_turns === "number") state.num_turns = evt.num_turns;
      if (evt.terminal_reason) state.terminal_reason = evt.terminal_reason;
      if (Array.isArray(evt.permission_denials) && evt.permission_denials.length > 0) {
        state.permission_denials = evt.permission_denials;
      }
      if (evt.is_error || (evt.subtype && evt.subtype !== "success")) {
        const msg =
          typeof evt.result === "string" && evt.result.trim()
            ? evt.result.trim()
            : Array.isArray(evt.errors) && evt.errors.length > 0
              ? evt.errors.join("; ")
              : `Claude Code exited with subtype=${evt.subtype || "error"}`;
        if (!state.errors.includes(msg)) state.errors.push(msg);
      }
      pushRecent({
        type: "result",
        subtype: evt.subtype,
        is_error: Boolean(evt.is_error),
        num_turns: evt.num_turns,
        total_cost_usd: evt.total_cost_usd,
      });
      return;
    }

    if (evt.type === "error") {
      const msg = typeof evt.message === "string" ? evt.message : JSON.stringify(evt);
      if (!state.errors.includes(msg)) state.errors.push(msg);
      pushRecent({ type: "error", message: msg.slice(0, 240) });
    }
  };

  const donePromise = new Promise((resolve) => {
    child = spawn(invocation.command, invocation.args, {
      cwd,
      env: buildChildEnv(downstream.env),
      shell: invocation.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    state.pid = child.pid ?? null;
    activeChildren.add(child);

    let exitGraceTimer = null, forceTimer, confirmationTimer;
    let stopping = null;
    let killError = false;
    const abortRequest = () => state.cancel();

    const finalize = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(confirmationTimer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      requestSignal?.removeEventListener("abort", abortRequest);
      state.cancel = null;
      activeChildren.delete(child);

      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore stream cleanup errors
      }

      if (stdoutBuffer.trim()) {
        handleJsonLine(stdoutBuffer);
        stdoutBuffer = "";
      }

      if (!stopping && /unknown option[^\n]*--restricted/i.test(state.stderr)) {
        state.errors.push("Restricted review requires Claude Code 2.1.248 or newer.");
      }
      if (!stopping && code === 0 && !receivedResult) state.errors.push("Claude Code exited without a terminal result.");
      state.status = killError ? "failed" : stopping || (code === 0 && !state.errors.length ? "completed" : "failed");
      state.exit_code = code;
      state.signal = signal;
      state.completed_at = new Date().toISOString();
      resolve(state);
    };

    const signalTree = force => {
      try { terminateOwnedTree(child, force); }
      catch (err) { killError = true; state.errors.push(err.message); }
    };
    const stop = (status, reason) => {
      if (settled || stopping) return false;
      if (child.exitCode !== null || child.signalCode !== null) return false;
      stopping = status;
      state.errors.push(reason);
      child.stdin.destroy();
      confirmationTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        state.status = "termination_unconfirmed";
        state.errors.push("Process termination unconfirmed. Poll job status for the observed exit.");
        child.stdout.destroy();
        child.stderr.destroy();
        // Complete this caller's wait. The job and concurrency slot belong to the process until exit.
        resolve({ ...state, errors: [...state.errors] });
      }, 5000);
      signalTree(process.platform === "win32");
      if (process.platform !== "win32") forceTimer = setTimeout(() => signalTree(true), 1500);
      return true;
    };
    state.cancel = () => stop("cancelled", "Cancelled by caller.");
    requestSignal?.addEventListener("abort", abortRequest, { once: true });

    timer = setTimeout(() => {
      stop("timed_out", `Timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleJsonLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (state.stderr.length < MAX_STDERR_CHARS) {
        state.stderr += chunk.slice(0, MAX_STDERR_CHARS - state.stderr.length);
      }
    });

    child.on("error", (err) => {
      state.errors.push(err.message);
      if (!child.pid) finalize(-1, null);
    });

    child.on("exit", (code, signal) => {
      if (settled || exitGraceTimer) return;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(confirmationTimer);
      if (stopping && process.platform !== "win32") signalTree(true);
      exitGraceTimer = setTimeout(() => finalize(code, signal), 500);
      exitGraceTimer.unref();
    });

    child.on("close", finalize);

    child.stdin.on("error", err => { if (err.code !== "EPIPE") state.errors.push(err.message); });
    if (stdinPrompt !== null) {
      child.stdin.write(stdinPrompt);
    }
    child.stdin.end();
  });

  jobs.set(jobId, state);
  return { state, donePromise };
}

function formatStatePayload(state, includeFullOutput = true) {
  const elapsedSeconds = Math.round(
    ((state.completed_at ? Date.parse(state.completed_at) : Date.now()) -
      Date.parse(state.started_at)) /
      1000
  );
  const payload = {
    job_id: state.job_id,
    mode: state.mode,
    status: state.status,
    cwd: state.cwd,
    session_id: state.session_id,
    model: state.model,
    claude_code_version: state.claude_code_version,
    bridge: state.bridge,
    elapsed_seconds: elapsedSeconds,
    exit_code: state.exit_code,
    num_turns: state.num_turns,
    total_cost_usd: state.total_cost_usd,
    usage: state.usage,
    commands_run: state.commands.length,
    file_changes_count: state.file_changes.length,
    permission_denials_count: state.permission_denials.length,
    errors: state.errors,
  };
  if (state.terminal_reason) {
    payload.terminal_reason = state.terminal_reason;
  }
  if (includeFullOutput) {
    payload.response = state.response;
    if (state.commands.length > 0) payload.commands = state.commands.slice(-20);
    if (state.file_changes.length > 0) payload.file_changes = state.file_changes.slice(-20);
    if (state.permission_denials.length > 0) {
      payload.permission_denials = state.permission_denials.slice(-20);
    }
    if (state.status !== "completed" && state.stderr.trim()) {
      payload.stderr = state.stderr.trim();
    }
  } else {
    payload.recent_events = state.recent_events.slice(-10);
    if (state.response) {
      payload.response_preview = state.response.slice(0, 400);
    }
  }
  return payload;
}

function runQuickCommand(invocation, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      env: buildChildEnv(),
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\nTimed out`.trim() });
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const PERMISSION_MODE_SCHEMA = {
  type: "string",
  enum: ["plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
  description:
    "Permission mode for headless Claude Code. 'plan' = read-only analysis; 'acceptEdits' (default) = auto-allow workspace file edits (pair with allowed_tools for shell commands); 'auto' = classifier-based auto-approval; 'dontAsk' = deny anything not explicitly allowed; 'bypassPermissions' = unrestricted.",
};

const EFFORT_SCHEMA = {
  type: "string",
  enum: ["low", "medium", "high", "xhigh", "max"],
  description: "Optional reasoning effort level for the Claude Code session.",
};

const BRIDGE_CONTEXT_SCHEMA = {
  type: "string",
  description:
    "Optional in-band '[bridge: ...]' header from an upstream delegated prompt, used to enforce depth, hierarchy, and cycle limits.",
};

const TOOLS = [
  {
    name: "claude_run",
    description:
      "Run a local Claude Code agent synchronously on a task and return its final response, session_id (for resuming/forking), commands executed, file changes, permission denials, cost, and token usage.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Complete task instructions for the Claude Code agent.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the repository or working directory.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: {
          type: "string",
          description:
            "Optional model override (e.g. 'sonnet', 'opus', 'haiku', or full model name; defaults to user's Claude Code config).",
        },
        effort: EFFORT_SCHEMA,
        worktree: {
          type: "boolean",
          description:
            "Run Claude Code in a new managed Git worktree to isolate edits from the main working tree.",
        },
        worktree_name: {
          type: "string",
          description: "Optional name for the managed Git worktree (implies worktree: true).",
        },
        add_dirs: {
          type: "array",
          items: { type: "string" },
          description: "Optional extra directories Claude Code can access alongside cwd.",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of pre-approved tool specs for unattended execution (e.g. ['Read', 'Edit', 'Write', 'Bash(npm test)', 'Bash(git *)']).",
        },
        disallowed_tools: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of tools to explicitly deny (e.g. ['Bash(rm *)', 'WebFetch']).",
        },
        append_system_prompt: {
          type: "string",
          description: "Optional extra instructions appended to Claude Code's system prompt.",
        },
        agent: {
          type: "string",
          description: "Optional custom Claude Code agent name to use for the session.",
        },
        max_budget_usd: {
          type: "number",
          description: "Optional maximum dollar budget for this run.",
        },
        ide: {
          type: "boolean",
          description:
            "Automatically connect to a running local Claude Code IDE extension on startup if one is available.",
        },
        ephemeral: {
          type: "boolean",
          description: "Run without persisting session files to disk (--no-session-persistence).",
        },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "claude_resume",
    description:
      "Continue an existing local Claude Code session by session_id (or the most recent session in cwd with last: true) with follow-up instructions.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID returned from an earlier claude_run or claude_spawn call.",
        },
        last: {
          type: "boolean",
          description:
            "Resume the most recent Claude Code session in cwd (--continue) when session_id is omitted.",
        },
        prompt: {
          type: "string",
          description: "Follow-up prompt for the resumed Claude Code session.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        worktree: { type: "boolean", description: "Run in a managed Git worktree." },
        worktree_name: { type: "string", description: "Optional Git worktree name." },
        add_dirs: { type: "array", items: { type: "string" } },
        allowed_tools: { type: "array", items: { type: "string" } },
        disallowed_tools: { type: "array", items: { type: "string" } },
        max_budget_usd: { type: "number" },
        ide: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "claude_fork",
    description:
      "Fork an existing local Claude Code session into a new independent thread (--fork-session) with new instructions.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Existing Claude Code session UUID to fork.",
        },
        prompt: {
          type: "string",
          description: "Instructions for the forked branch.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        worktree: {
          type: "boolean",
          description: "Run the forked session in a new managed Git worktree.",
        },
        worktree_name: { type: "string", description: "Optional Git worktree name." },
        add_dirs: { type: "array", items: { type: "string" } },
        allowed_tools: { type: "array", items: { type: "string" } },
        disallowed_tools: { type: "array", items: { type: "string" } },
        max_budget_usd: { type: "number" },
        ide: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["session_id", "prompt", "cwd"],
    },
  },
  {
    name: "claude_review",
    description:
      "Run a restricted read-only Claude Code review of uncommitted changes, a base branch, a commit, or a supplied diff.",
    inputSchema: {
      type: "object",
      properties: {
        review_diff: { type: "string", description: "Prepared diff. When supplied, the bridge skips Git in cwd." },
        allowed_tools: { type: "array", items: { enum: ["Read", "Glob", "Grep"] }, description: "Use [] for a diff-only review." },
        disallowed_tools: { type: "array", items: { type: "string" } },
        ephemeral: { type: "boolean" },
        cwd: {
          type: "string",
          description: "Absolute working directory. A supplied review_diff does not require a Git repository.",
        },
        uncommitted: {
          type: "boolean",
          description:
            "Review staged, unstaged, and untracked changes (default if no target is given).",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (e.g. 'main').",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA.",
        },
        title: {
          type: "string",
          description: "Optional title for the review summary.",
        },
        prompt: {
          type: "string",
          description: "Optional custom review focus or checklist.",
        },
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        max_budget_usd: { type: "number" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "claude_spawn",
    description:
      "Start a local Claude Code agent asynchronously in the background and immediately return a job_id. Use this to orchestrate multiple local Claude Code agents in parallel, then poll with claude_job_status.",
    inputSchema: {
      type: "object",
      properties: {
        review_diff: { type: "string", description: "Prepared diff when mode is review." },
        mode: {
          type: "string",
          enum: ["run", "resume", "fork", "review"],
          description: "Execution mode. Default: 'run'.",
        },
        prompt: {
          type: "string",
          description: "Task instructions (required for run, resume, fork; optional for review).",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        session_id: {
          type: "string",
          description: "Session UUID when mode is 'resume' or 'fork'.",
        },
        last: {
          type: "boolean",
          description: "Resume most recent session in cwd when mode is 'resume' without session_id.",
        },
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        worktree: {
          type: "boolean",
          description:
            "Recommended when spawning multiple parallel editing Claude Code agents in the same repo.",
        },
        worktree_name: { type: "string" },
        add_dirs: { type: "array", items: { type: "string" } },
        allowed_tools: { type: "array", items: { type: "string" } },
        disallowed_tools: { type: "array", items: { type: "string" } },
        append_system_prompt: { type: "string" },
        agent: { type: "string" },
        max_budget_usd: { type: "number" },
        ide: { type: "boolean" },
        uncommitted: { type: "boolean" },
        base: { type: "string" },
        commit: { type: "string" },
        title: { type: "string" },
        ephemeral: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: { type: "number" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "claude_job_status",
    description:
      "Inspect the status and output of a background Claude Code job started by claude_spawn, or list all tracked jobs when job_id is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Specific job_id to inspect. Omit to list all tracked jobs.",
        },
      },
    },
  },
  {
    name: "claude_job_cancel",
    description: "Cancel a currently running background Claude Code job by job_id.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by claude_spawn.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "claude_status",
    description:
      "Check the local Claude Code installation, authentication status (`claude auth status`), and active AGENT_BRIDGE_* policy.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function getVisibleTools() {
  const policy = getBridgePolicy();
  if (!policy.hideRestrictedTools) return TOOLS;
  if (policy.role === "subordinate" || (policy.configErrors && policy.configErrors.length > 0)) {
    return TOOLS.filter((t) => !MUTATING_TOOLS.has(t.name));
  }
  const spawnBlocked =
    (policy.role !== "independent" && policy.depth >= policy.maxDepth) ||
    (!policy.allowCycles &&
      policy.chain.some((entry) => entry.toLowerCase().startsWith("claude:")));
  if (!spawnBlocked) return TOOLS;
  return TOOLS.filter((t) => !SPAWN_DELEGATING_TOOLS.has(t.name));
}

async function handleToolCall(name, args = {}, requestSignal) {
  const policyEval = evaluateDelegationPolicy(name, args);
  if (!policyEval.allowed) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: policyEval.reason,
              bridge: getBridgePolicy(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  switch (name) {
    case "claude_run": {
      const { donePromise } = createRunner("run", args, policyEval, requestSignal);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    case "claude_resume": {
      const { donePromise } = createRunner("resume", args, policyEval, requestSignal);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    case "claude_fork": {
      const { donePromise } = createRunner("fork", args, policyEval, requestSignal);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    case "claude_review": {
      const { donePromise } = createRunner("review", args, policyEval, requestSignal);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    case "claude_spawn": {
      const mode = args.mode || "run";
      const { state } = createRunner(mode, args, policyEval);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                job_id: state.job_id,
                mode: state.mode,
                status: state.status,
                pid: state.pid,
                cwd: state.cwd,
                bridge: state.bridge,
                started_at: state.started_at,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "claude_job_status": {
      if (args.job_id) {
        const job = jobs.get(String(args.job_id));
        if (!job) {
          return {
            content: [{ type: "text", text: `Unknown job_id: ${args.job_id}` }],
            isError: true,
          };
        }
        const includeFull = job.status !== "running";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatStatePayload(job, includeFull), null, 2),
            },
          ],
          isError: ["failed", "timed_out", "termination_unconfirmed"].includes(job.status),
        };
      }

      const list = Array.from(jobs.values()).map((j) => formatStatePayload(j, false));
      return {
        content: [{ type: "text", text: JSON.stringify({ jobs: list }, null, 2) }],
      };
    }

    case "claude_job_cancel": {
      const job = jobs.get(String(args.job_id || ""));
      if (!job) {
        return {
          content: [{ type: "text", text: `Unknown job_id: ${args.job_id}` }],
          isError: true,
        };
      }
      if (job.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { job_id: job.job_id, cancelled: false, status: job.status },
                null,
                2
              ),
            },
          ],
        };
      }
      const cancelled = job.cancel ? job.cancel() : false;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { job_id: job.job_id, cancelled, status: job.status },
              null,
              2
            ),
          },
        ],
      };
    }

    case "claude_status": {
      const discovered = discoverClaudeBinary();
      const versionInv = resolveClaudeInvocation(["--version"]);
      const authInv = resolveClaudeInvocation(["auth", "status"]);
      const [verRes, authRes] = await Promise.all([
        runQuickCommand(versionInv),
        runQuickCommand(authInv),
      ]);

      let authParsed = null;
      if (authRes.stdout) {
        try {
          authParsed = JSON.parse(authRes.stdout);
        } catch {
          authParsed = authRes.stdout;
        }
      }

      const payload = {
        binary: discovered ? discovered.path : versionInv.binary,
        source: discovered ? discovered.source : versionInv.source,
        version: verRes.ok ? verRes.stdout : null,
        version_error: verRes.ok ? undefined : verRes.stderr || `exit ${verRes.code}`,
        auth: authParsed,
        auth_error: authRes.ok ? undefined : authRes.stderr || `exit ${authRes.code}`,
        bridge: getBridgePolicy(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !verRes.ok,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      const requestedVersion =
        params && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }

    if (method === "notifications/cancelled") {
      requestControllers.get(params?.requestId)?.abort();
      return;
    }
    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      if (!isNotification) sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: getVisibleTools() });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const controller = new AbortController();
      requestControllers.set(id, controller);
      try {
        const result = await handleToolCall(toolName, toolArgs, controller.signal);
        sendResult(id, result);
      } finally {
        requestControllers.delete(id);
      }
      return;
    }

    if (!isNotification) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) {
      sendError(id, -32603, err instanceof Error ? err.message : String(err));
    } else {
      log(`Notification error (${method}): ${err}`);
    }
  }
}

function shutdown() {
  for (const child of activeChildren) {
    try {
      terminateOwnedTree(child);
    } catch (err) {
      log(err.message);
    }
  }
  activeChildren.clear();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let inFlightRequests = 0;
let stdinClosed = false;

function maybeExitOnStdinClose() {
  if (stdinClosed && inFlightRequests === 0) {
    shutdown();
    process.exit(0);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
    return;
  }
  inFlightRequests += 1;
  Promise.resolve(handleRequest(parsed)).finally(() => {
    inFlightRequests -= 1;
    maybeExitOnStdinClose();
  });
});

rl.on("close", () => {
  stdinClosed = true;
  maybeExitOnStdinClose();
});
