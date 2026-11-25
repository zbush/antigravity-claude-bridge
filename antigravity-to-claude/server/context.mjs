import { randomUUID } from "node:crypto";

// Each independently installed connector ships this version of the wire format.
const agents = new Set(["antigravity", "claude", "codex"]);

export function validateContext(value, recipient) {
  const invalid = detail => { throw new Error("Invalid AGENT_BRIDGE_CONTEXT: " + detail); };
  if (value?.version !== 1 || !Array.isArray(value.hops) ||
      !Number.isSafeInteger(value.remaining_hops) || value.remaining_hops < 0 ||
      !Number.isSafeInteger(value.remaining_hops + value.hops.length)) {
    invalid("expected version 1, a hop list and a non-negative integer remaining_hops.");
  }
  let previous;
  const ids = new Set();
  for (const hop of value.hops) {
    if (!agents.has(hop?.from) || !agents.has(hop?.to) || hop.from === hop.to ||
        (previous && previous !== hop.from) || typeof hop.id !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(hop.id) || ids.has(hop.id)) {
      invalid("each hop needs a unique ID and a continuous route between known agents.");
    }
    ids.add(hop.id);
    previous = hop.to;
  }
  if (previous && recipient && previous !== recipient) invalid("the last hop must end at " + recipient + ".");
  return { version: 1, hops: value.hops.map(({ from, to, id }) => ({ from, to, id })), remaining_hops: value.remaining_hops };
}

export function readContext(raw, recipient) {
  if (raw === undefined) return undefined;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Invalid AGENT_BRIDGE_CONTEXT: expected a JSON object."); }
  return validateContext(parsed, recipient);
}

export function nextContext(context, from, to, budget, id = randomUUID()) {
  if (context) validateContext(context, from);
  const available = Math.min(context?.remaining_hops ?? budget, budget);
  if (!Number.isSafeInteger(available) || available < 1) throw new Error("Delegation hop budget exhausted.");
  return validateContext({
    version: 1,
    hops: [...(context?.hops ?? []), { from, to, id }],
    remaining_hops: available - 1,
  }, to);
}

export function senderHistory(chain, actor, remaining) {
  const parsed = chain.map(entry => {
    const match = /^([^:]+):([^:]+)$/.exec(entry);
    if (!match) throw new Error("Invalid legacy AGENT_BRIDGE_CHAIN.");
    return { from: match[1], id: match[2] };
  });
  return validateContext({ version: 1, remaining_hops: remaining,
    hops: parsed.map((hop, i) => ({ ...hop, to: parsed[i + 1]?.from ?? actor })) }, actor);
}

export function registeredContext(env, actor, depth, chain, maximum) {
  const canonical = readContext(env.AGENT_BRIDGE_CONTEXT, actor);
  if (canonical) {
    if (env.AGENT_BRIDGE_DEPTH !== undefined && depth !== canonical.hops.length) {
      throw new Error("AGENT_BRIDGE_DEPTH disagrees with AGENT_BRIDGE_CONTEXT.");
    }
    return canonical;
  }
  if (chain.length !== depth) throw new Error("AGENT_BRIDGE_DEPTH must match the number of legacy hops.");
  return senderHistory(chain, actor, Math.max(0, maximum - depth));
}
