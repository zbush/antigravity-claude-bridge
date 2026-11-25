import { nextContext, readContext, registeredContext, senderHistory } from "../context.mjs";
import { activeChildren } from "./process.mjs";
import { policyCheck } from "./errors.mjs";

const VALID_BRIDGE_ROLES = new Set(["independent", "primary", "subordinate", "peer"]);
const SPAWN_DELEGATING_TOOLS = new Set([
  "claude_run",
  "claude_resume",
  "claude_fork",
  "claude_review",
  "claude_spawn",
]);
const MUTATING_TOOLS = new Set([...SPAWN_DELEGATING_TOOLS, "claude_job_cancel"]);

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
    process.env.AGENT_BRIDGE_CALLBACK_DISALLOWED_TOOLS ?? "mcp__antigravity-local__*,mcp__antigravity__*"
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
  let match;
  if (requireLineStart) {
    for (const line of text.split(/\r?\n/, 3)) {
      if (line.trim() === "---") break;
      match = /^\[bridge:[ \t]*(origin=claude\b[^\]]*)\]/i.exec(line);
      if (match) break;
      // The IDE can put its delegation label and a blank line before the marker.
      if (line.trim() && !/^\[(?:DELEGATED TASK|FROM CLAUDE CODE):[^\]]*\]\s*$/i.test(line)) break;
    }
  } else {
    match = /\[bridge:\s*([^\]]+)\]/i.exec(text);
  }
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

function evaluateDelegationPolicy(toolName, rawParams = {}, policy = getBridgePolicy()) {
  return policyCheck(() => evaluateWithContext(policy, toolName, rawParams));
}

function evaluateWithContext(policy, toolName, rawParams) {
  const markers = [
    parseInBandBridgeMarker(rawParams.bridge_context),
    parseInBandBridgeMarker(rawParams.prompt, { requireLineStart: true }),
  ].filter(Boolean);

  let effectiveRole = policy.role;
  let context = policy.context;
  let effectiveMaxDepth = Math.min(policy.maxDepth, policy.depth + (context?.remaining_hops ?? 0));
  for (const inBand of markers) {
    if (inBand.role === "subordinate") effectiveRole = "subordinate";
    effectiveMaxDepth = Math.min(effectiveMaxDepth, inBand.maxDepth ?? effectiveMaxDepth);
    const marker = inBand.context ?? senderHistory(inBand.chain, "antigravity", Math.max(0, effectiveMaxDepth - inBand.chain.length));
    if (inBand.depth !== null && marker.hops.length !== inBand.depth) throw new Error("Bridge marker depth disagrees with its history.");
    if (policy.context?.hops.some((hop, i) => JSON.stringify(hop) !== JSON.stringify(marker.hops[i]))) {
      throw new Error("Bridge marker conflicts with the registered hop history.");
    }
    if (context && marker.hops.slice(0, context.hops.length).some((hop, i) => JSON.stringify(hop) !== JSON.stringify(context.hops[i]))) {
      throw new Error("Bridge markers contain conflicting hop histories.");
    }
    if (!context || marker.hops.length >= context.hops.length) context = marker;
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
    (context?.hops.some(h => h.from === "claude") ??
      effectiveChain.some(entry => entry.toLowerCase().startsWith("claude:")))
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

export { getBridgePolicy, evaluateDelegationPolicy, buildDownstreamBridgeConfig };
