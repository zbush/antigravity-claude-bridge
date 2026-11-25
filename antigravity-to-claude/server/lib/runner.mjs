import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EDITS_ENV, ROOTS_ENV, loadWorkspacePolicy, resolveWorkspaceDir } from "../workspace-policy.mjs";
import { LAUNCH_MODES, EDIT_TOOLS } from "./schemas.mjs";
import { buildDownstreamBridgeConfig } from "./policy.mjs";
import { resolveClaudeInvocation } from "./discovery.mjs";
import { activeChildren, buildChildEnv, terminateOwnedTree } from "./process.mjs";
import { validateCommonParams, validateOrdinaryParams, resolveOrdinaryTools, buildCallbackMcpConfig, buildClaudeArgs, SESSION_ID_PATTERN } from "./launch.mjs";
import { InvalidParams, PolicyError, policyCheck } from "./errors.mjs";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const MAX_RECENT_EVENTS = 40;
const MAX_STDERR_CHARS = 16000;

const jobs = new Map();
const completedJobIds = [];
const MAX_COMPLETED_OUTPUTS = 50;

function retainCompletedJob(state) {
  completedJobIds.push(state.job_id);
  if (completedJobIds.length <= MAX_COMPLETED_OUTPUTS) return;
  const id = completedJobIds.shift();
  const archived = { ...jobs.get(id), output_pruned: true };
  archived.commands_run = archived.commands.length;
  archived.file_changes_count = archived.file_changes.length;
  archived.permission_denials_count = archived.permission_denials.length;
  for (const field of ["response", "messages", "commands", "file_changes", "stderr", "recent_events", "permission_denials", "errors", "usage"]) {
    delete archived[field];
  }
  jobs.set(id, archived);
}

function clampTimeoutMs(timeoutSeconds) {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, timeoutSeconds))
      : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

// Resume and fork only reuse sessions this bridge process launched in the same canonical cwd,
// so a restricted run cannot continue an unrestricted session or one rooted elsewhere.
function checkSessionReuse(mode, params, cwd, addDirs, tools) {
  if (params.last !== undefined && params.last !== false) {
    throw new PolicyError("'last' (--continue) is not available: it selects an arbitrary session. Pass the session_id returned by a bridge run.");
  }
  const sessionId = params.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new InvalidParams(`claude_${mode} requires a session_id UUID returned by a bridge run.`);
  }
  const owners = Array.from(jobs.values()).filter((job) => job.session_id === sessionId);
  if (owners.length === 0) {
    throw new PolicyError(`Session ${sessionId} was not started by this bridge process. Only bridge-launched sessions can be resumed or forked.`);
  }
  if (!owners.some((job) => job.cwd === cwd)) {
    throw new PolicyError(`Session ${sessionId} belongs to a different cwd (${owners[0].cwd}).`);
  }
  if (owners.some(job => job.status === "running" || job.status === "termination_unconfirmed")) {
    throw new PolicyError(`Session ${sessionId} is still running. Wait for its exit before reusing it.`);
  }
  if (!owners.some(job => job.cwd === cwd && job.status === "completed" && !job.ephemeral) ||
      owners.some(job => job.capabilities.add_dirs.some(dir => dir !== cwd && !addDirs.includes(dir)) ||
        job.capabilities.tools.some(tool => !tools.includes(tool)))) {
    throw new PolicyError("The saved session is unavailable or had broader permissions. Start a fresh run with this scope.");
  }
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

function createRunner(mode, rawParams, policyEval, requestSignal) {
  requestSignal?.throwIfAborted();
  if (!LAUNCH_MODES.includes(mode)) throw new InvalidParams(`Unsupported mode: ${mode}`);
  const ordinary = mode !== "review";
  const workspace = loadWorkspacePolicy();
  const resolveDir = (dir, label) => policyCheck(() => resolveWorkspaceDir(workspace, dir, label));
  const cwd = resolveDir(rawParams.cwd, "cwd");
  validateCommonParams(rawParams);
  if (ordinary) validateOrdinaryParams(mode, rawParams);
  if (ordinary && !String(rawParams.prompt || "").trim()) {
    throw new InvalidParams(`'prompt' is required for mode '${mode}'.`);
  }
  const addDirs = ordinary
    ? Array.from(new Set((rawParams.add_dirs || []).map((dir, i) => resolveDir(dir, `add_dirs[${i}]`))))
    : [];
  const tools = ordinary ? resolveOrdinaryTools(rawParams, workspace) : [];
  if (mode === "resume" || mode === "fork") checkSessionReuse(mode, rawParams, cwd, addDirs, tools);

  let jobId;
  do { jobId = crypto.randomUUID().slice(0, 8); } while (jobs.has(jobId));
  const downstream = buildDownstreamBridgeConfig(jobId, policyEval);
  const childWorkspace = { ...workspace, roots: [cwd, ...addDirs], allowEdits: tools.some(t => EDIT_TOOLS.includes(t)) };
  downstream.env[ROOTS_ENV] = JSON.stringify(childWorkspace.roots);
  downstream.env[EDITS_ENV] = String(childWorkspace.allowEdits);
  const callback = ordinary ? buildCallbackMcpConfig(policyEval, downstream) : null;
  const params = { ...rawParams, cwd };
  const { args, stdinPrompt } = buildClaudeArgs(mode, params, {
    extraDisallowedTools: downstream.extraDisallowedTools,
    tools,
    addDirs,
    callback,
  });
  const invocation = resolveClaudeInvocation(args);
  const timeoutMs = clampTimeoutMs(params.timeout_seconds);

  const state = {
    job_id: jobId,
    ephemeral: Boolean(params.ephemeral ?? !ordinary),
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
    capabilities: {
      tools: args[args.indexOf("--tools") + 1].split(",").filter(Boolean),
      add_dirs: addDirs,
      workspace_roots: childWorkspace.roots,
      callback_mcp: callback ? callback.server : null,
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

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: buildChildEnv(downstream.env),
    shell: invocation.shell,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const donePromise = new Promise((resolve) => {
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
        state.errors.push("Restricted Claude launches require Claude Code 2.1.248 or newer.");
      }
      if (!stopping && code === 0 && !receivedResult) state.errors.push("Claude Code exited without a terminal result.");
      state.status = killError ? "failed" : stopping || (code === 0 && !state.errors.length ? "completed" : "failed");
      state.exit_code = code;
      state.signal = signal;
      state.completed_at = new Date().toISOString();
      retainCompletedJob(state);
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

    child.stdin.on("error", err => {
      if (err.code !== "EPIPE" && !(process.platform === "win32" && err.code === "EOF" && err.syscall === "write")) {
        state.errors.push(err.message);
      }
    });
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
    capabilities: state.capabilities,
    elapsed_seconds: elapsedSeconds,
    exit_code: state.exit_code,
    num_turns: state.num_turns,
    total_cost_usd: state.total_cost_usd,
    usage: state.usage,
    commands_run: state.commands_run ?? state.commands.length,
    file_changes_count: state.file_changes_count ?? state.file_changes.length,
    permission_denials_count: state.permission_denials_count ?? state.permission_denials.length,
    errors: state.errors,
  };
  if (state.output_pruned) return { ...payload, output_pruned: true };
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

export { createRunner, jobs, formatStatePayload };
