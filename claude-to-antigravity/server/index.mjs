#!/usr/bin/env node
// claude-to-antigravity: MCP bridge that lets an MCP client (e.g. Claude Code) spawn, steer and
// read agent conversations in a locally running Google Antigravity IDE.
//
// Talks to Antigravity's local language server over its Connect/JSON RPC endpoint, discovered
// from <ANTIGRAVITY_DATA_DIR>/daemon/hub_<port>.json (default ~/.gemini/antigravity). Zero dependencies.
//
// Delegation policy follows the shared AGENT_BRIDGE_* contract (see ../README.md).

import { followupPolicy, nextContext, registeredContext } from './context.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeWorkspacePolicy, loadWorkspacePolicy, resolveWorkspaceDir } from './workspace-policy.mjs';

const SERVER_NAME = 'antigravity';
const SERVER_VERSION = '0.3.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = path.join(HERE, '..', 'default-cascade-config.json');
const AG_DIR = process.env.ANTIGRAVITY_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const STATE_DIR = process.env.ANTIGRAVITY_MCP_STATE_DIR || path.join(os.homedir(), '.antigravity-mcp');
const SPAWNED_FILE = path.join(STATE_DIR, 'spawned.json');
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const TAG = 'claude-mcp';
// A conversation spawned this recently counts as active even if Antigravity still reports it idle.
const SPAWN_GRACE_MS = 30000;

const log = (...a) => process.stderr.write(`[claude-to-antigravity] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s || '');

// ---------------------------------------------------------------- bridge policy (AGENT_BRIDGE_*)

const ROLES = ['independent', 'primary', 'subordinate', 'peer'];
const DELEGATING_TOOLS = ['antigravity_spawn', 'antigravity_send'];
const MUTATING_TOOLS = ['antigravity_spawn', 'antigravity_send', 'antigravity_cancel', 'antigravity_respond'];
const READ_ONLY_TOOLS = ['antigravity_status', 'antigravity_wait', 'antigravity_result', 'antigravity_list', 'antigravity_models', 'antigravity_bridge_status'];

class PolicyError extends Error {}

function loadBridgePolicy(env = process.env) {
  const errors = [];
  const raw = (k) => String(env[k] ?? '').trim();
  const int = (k, def, min) => {
    const v = raw(k);
    if (v === '') return def;
    if (!/^\d+$/.test(v) || Number(v) < min) { errors.push(`${k}="${v}" must be an integer >= ${min}`); return def; }
    return Number(v);
  };
  const bool = (k) => {
    const v = raw(k).toLowerCase();
    if (v === '' || v === 'false') return false;
    if (v === 'true') return true;
    errors.push(`${k}="${raw(k)}" must be "true" or "false"`);
    return false;
  };

  let role = raw('AGENT_BRIDGE_ROLE').toLowerCase() || 'independent';
  if (!ROLES.includes(role)) {
    errors.push(`AGENT_BRIDGE_ROLE="${raw('AGENT_BRIDGE_ROLE')}" must be one of ${ROLES.join(', ')}`);
    role = 'subordinate'; // fail closed
  }
  const depth = int('AGENT_BRIDGE_DEPTH', 0, 0);
  const maxDepth = int('AGENT_BRIDGE_MAX_DEPTH', role === 'subordinate' ? 0 : 1, 0);
  const maxConcurrent = int('AGENT_BRIDGE_MAX_CONCURRENT', 4, 1);
  const chainRaw = raw('AGENT_BRIDGE_CHAIN');
  const chain = chainRaw ? chainRaw.split(',').map((h) => h.trim()).filter(Boolean) : [];
  let context;
  try { context = registeredContext(env, 'claude', depth, chain, maxDepth); }
  catch (error) { errors.push(error.message); }
  const allowCycles = bool('AGENT_BRIDGE_ALLOW_CYCLES');
  const hideRestricted = bool('AGENT_BRIDGE_HIDE_RESTRICTED_TOOLS');

  return {
    role, depth: context?.hops.length ?? depth, maxDepth, maxConcurrent,
    chain: context?.hops.map(h => h.from + ':' + h.id) ?? chain, context, allowCycles, hideRestricted, errors,
  };
}

const BRIDGE = loadBridgePolicy();
if (BRIDGE.errors.length) log('invalid AGENT_BRIDGE_* configuration; mutating tools disabled:', BRIDGE.errors.join('; '));

// Workspace ceiling for the cwd of new spawns. Antigravity agents run with the IDE's own permissions,
// so the operator must opt in before a request can launch or steer one.
const WORKSPACE = loadWorkspacePolicy();
if (WORKSPACE.errors.length) log('invalid workspace configuration; antigravity_spawn disabled:', WORKSPACE.errors.join('; '));

const isAntigravityHop = (h) => h.toLowerCase().startsWith('antigravity:');

// Tools refused by static policy (independent of Antigravity's live state), with the reason.
function restrictions(p = BRIDGE) {
  const r = {};
  const add = (names, why) => names.forEach((n) => { if (!r[n]) r[n] = why; });
  if (p.errors.length) {
    add(MUTATING_TOOLS, `invalid bridge configuration (${p.errors.join('; ')}). Fix the AGENT_BRIDGE_* variables`);
  }
  if (p.role === 'subordinate') {
    add(MUTATING_TOOLS, 'AGENT_BRIDGE_ROLE=subordinate: this session is a delegated worker and may only inspect Antigravity conversations, not start, steer, stop or approve them');
  }
  const ideWork = [...DELEGATING_TOOLS, 'antigravity_respond'];
  if (WORKSPACE.errors.length) add(ideWork, WORKSPACE.errors.join('; '));
  else if (!WORKSPACE.allowEdits) add(ideWork, 'set AGENT_BRIDGE_ALLOW_EDITS=true to allow work with the IDE permissions');
  if (p.depth > 0) {
    add(['antigravity_respond'], `AGENT_BRIDGE_DEPTH=${p.depth}: a delegated worker must never approve permission prompts`);
  }
  if (p.depth >= p.maxDepth || p.context?.remaining_hops === 0) {
    add(DELEGATING_TOOLS, `delegation depth limit reached (AGENT_BRIDGE_DEPTH=${p.depth} >= AGENT_BRIDGE_MAX_DEPTH=${p.maxDepth})`);
  }
  if (!p.allowCycles && p.chain.some(isAntigravityHop)) {
    add(['antigravity_spawn'], `cycle prevented: AGENT_BRIDGE_CHAIN (${p.chain.join(',')}) already contains an antigravity hop, so delegating back to Antigravity would loop (set AGENT_BRIDGE_ALLOW_CYCLES=true to permit)`);
  }
  return r;
}

function refusal(tool, why) {
  return `Bridge policy refused ${tool}: ${why}. Read-only tools still work (${READ_ONLY_TOOLS.join(', ')}). ` +
    'Do the work directly, or report back to whoever delegated this task.';
}

// The policy the downstream Antigravity agent is told to follow.
function downstream(p = BRIDGE) {
  const context = nextContext(p.context, 'claude', 'antigravity', p.maxDepth - p.depth);
  const depth = context.hops.length;
  const role = p.role === 'independent' ? 'independent'
    : p.role === 'primary' || context.remaining_hops === 0 ? 'subordinate'
    : 'peer';
  return { role, depth, maxDepth: depth + context.remaining_hops, chain: context.hops.map(h => h.from + ':' + h.id).join(','), context };
}

// ---------------------------------------------------------------- delegation labeling

// Every message this bridge sends is labeled, so Antigravity models (in this conversation and
// in others that later see its summary) don't mistake delegated work for the user's own requests.
const TITLE_PREFIX = '[Claude] ';
const DELEGATION_OPENER = '[DELEGATED TASK: from Claude Code, not typed by the user]';
const HEADER_END = '\n---\n\n';
const FOLLOWUP_HEADER = '[FROM CLAUDE CODE: delegated follow-up, not typed by the user]\n\n';
const REPORT_FOOTER =
  '\n\n---\nWhen you are finished, end with a concise final report: what you did, files you changed, ' +
  'how you verified it, and anything unresolved. This final message is what the requester will read.';

function markerLine(down) {
  const encoded = Buffer.from(JSON.stringify(down.context)).toString('base64url');
  return `[bridge: origin=claude role=${down.role} depth=${down.depth} max_depth=${down.maxDepth} chain=${down.chain} ctx=${encoded}]`;
}

function delegationHeader(down) {
  const marker = markerLine(down);
  let policy = '';
  if (down.role === 'subordinate') {
    policy =
      '- Bridge policy: you are a SUBORDINATE worker for this task. Do not call any claude_* tools and do not delegate ' +
      'any part of this task back to Claude Code. Do the work yourself and report back.\n';
  } else if (down.role === 'peer') {
    policy =
      `- Bridge policy: peer mode, delegation depth ${down.depth} of ${down.maxDepth}. Delegate back to Claude Code (claude_* tools) ` +
      'only if truly necessary, and pass the [bridge: ...] line above forward unchanged so the next bridge can enforce depth and cycle limits.\n';
  }
  return (
    DELEGATION_OPENER + '\n' +
    marker + '\n' +
    'This conversation was started by Claude Code (Anthropic\'s coding agent) through the Antigravity MCP bridge, ' +
    'on the user\'s behalf. The user did not write this message and may not be watching this conversation. ' +
    'Your final message is returned to Claude Code, which reports back to the user.\n' +
    '- Treat this as a sub-task delegated by another agent, not as a direct request from the user.\n' +
    '- If this work comes up elsewhere (other conversations, memories, knowledge items), attribute it to a Claude Code ' +
    'delegation, not to the user.\n' +
    '- Later messages labeled [FROM CLAUDE CODE] also come from Claude Code. Unlabeled messages come from the user ' +
    'directly and take precedence.\n' +
    policy +
    HEADER_END.slice(1)
  );
}

// Split an input step into who sent it and the text without bridge boilerplate.
function unwrapInput(raw) {
  if (raw.startsWith(DELEGATION_OPENER)) {
    const i = raw.indexOf(HEADER_END);
    return { who: 'claude', body: (i >= 0 ? raw.slice(i + HEADER_END.length) : raw).replace(REPORT_FOOTER, '') };
  }
  if (raw.startsWith(FOLLOWUP_HEADER)) return { who: 'claude', body: raw.slice(FOLLOWUP_HEADER.length) };
  return { who: 'user', body: raw };
}

const delegatedTitle = (title, prompt) => {
  const base = (title || prompt.split('\n').find((l) => l.trim()) || 'Delegated task').trim();
  return base.startsWith(TITLE_PREFIX) ? base : TITLE_PREFIX + clip(base, 70).replace(/… \[\+\d+ chars\]$/, '…');
};

// ---------------------------------------------------------------- connection

let conn = null;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function discover() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
    return { base: addr.startsWith('http') ? addr : `http://${addr}`, token: process.env.ANTIGRAVITY_CSRF_TOKEN };
  }
  const dir = path.join(AG_DIR, 'daemon');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => /^hub_\d+\.json$/.test(n)); } catch {}
  const hubs = files
    .map((n) => { const p = path.join(dir, n); try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), mtime: fs.statSync(p).mtimeMs }; } catch { return null; } })
    .filter((h) => h && h.httpPort && h.csrfToken && (!h.pid || pidAlive(h.pid)))
    .sort((a, b) => b.mtime - a.mtime);
  if (!hubs.length) {
    throw new Error(`Antigravity does not appear to be running (no live hub file in ${dir}). Open the Antigravity app and try again.`);
  }
  return { base: `http://127.0.0.1:${hubs[0].httpPort}`, token: hubs[0].csrfToken };
}

async function rpc(method, body = {}, { timeoutMs = 60000, retry = true } = {}) {
  if (!conn) conn = discover();
  let res;
  try {
    res = await fetch(`${conn.base}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': conn.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Antigravity may have restarted on a new port: rediscover once.
    if (retry) { conn = null; return rpc(method, body, { timeoutMs, retry: false }); }
    throw new Error(`Could not reach Antigravity language server (${method}): ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 401 || res.status === 403) && retry) { conn = null; return rpc(method, body, { timeoutMs, retry: false }); }
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    throw new Error(`Antigravity ${method} failed (${res.status}): ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------- helpers

function toFileUri(p) {
  const abs = path.resolve(p);
  const s = abs.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) return `file:///${m[1].toLowerCase()}%3A/${m[2].split('/').map(encodeURIComponent).join('/')}`;
  return 'file://' + s.split('/').map(encodeURIComponent).join('/');
}

function fromFileUri(u) {
  try { return fileURLToPath(u.replace(/^file:\/\/\/([a-z])%3a\//i, 'file:///$1:/')); } catch { return u; }
}

function checkConversationWorkspaces(info) {
  if (!Array.isArray(info.workspaces) || !info.workspaces.length) throw new Error('The IDE did not report workspace roots for this conversation.');
  for (const workspace of info.workspaces) {
    resolveWorkspaceDir(WORKSPACE, fromFileUri(workspace.workspaceFolderAbsoluteUri), 'conversation workspace');
  }
}

function loadSpawned() {
  try { return JSON.parse(fs.readFileSync(SPAWNED_FILE, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read Antigravity bridge conversation state: ' + error.message);
  }
}
function saveSpawned(id, info) {
  const all = loadSpawned();
  all[id] = { ...(all[id] || {}), ...info };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = SPAWNED_FILE + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(all, null, 1), { flag: 'wx' });
    fs.renameSync(temp, SPAWNED_FILE);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const shortStatus = (s) => (s || 'UNKNOWN').replace(/^CASCADE_RUN_STATUS_/, '').toLowerCase();
const shortType = (t) => (t || '').replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase();

async function allSummaries() {
  const r = await rpc('GetAllCascadeTrajectories', {});
  return r.trajectorySummaries || {};
}

async function summary(id) {
  const s = (await allSummaries())[id];
  if (!s) throw new Error(`No Antigravity conversation with id ${id}.`);
  return s;
}

async function stepsFrom(id, offset = 0) {
  const r = await rpc('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: Math.max(0, offset) }, { timeoutMs: 120000 });
  return r.steps || [];
}

function describeWaiting(s) {
  return (s.waitingSteps || []).map((w) => {
    const step = w.step || {};
    const ri = step.requestedInteraction || {};
    const kind = Object.keys(ri)[0] || shortType(step.type);
    const spec = ri[kind] || {};
    const detail = spec.actionDescription || spec.resource?.target || spec.commandLine || spec.question || spec.url || '';
    return { step_index: w.stepIndex ?? w.index, kind, type: shortType(step.type), detail: clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 400), raw: clip(JSON.stringify(ri), 800) };
  });
}

function isDone(s) {
  return s.status === 'CASCADE_RUN_STATUS_IDLE' && !s.notFullyIdle && !s.hasRunningSubagents;
}

// Bridge-spawned conversations (by any process sharing this state dir) that are still active.
async function activeSpawned() {
  const mine = loadSpawned();
  const sums = await allSummaries();
  const now = Date.now();
  return Object.entries(mine)
    .filter(([id, info]) => {
      const s = sums[id];
      if (!s || s.annotations?.archived) return false;
      return !isDone(s) || now - Date.parse(info.created || 0) < SPAWN_GRACE_MS;
    })
    .map(([id]) => id);
}

// Serializes the concurrency check + StartCascade so parallel spawns can't overshoot the cap.
let spawnQueue = Promise.resolve();
function serialized(fn) {
  const run = spawnQueue.then(fn, fn);
  spawnQueue = run.catch(() => {});
  return run;
}

function finalResponse(steps) {
  let lastUser = -1;
  steps.forEach((st, i) => { if (st.type === 'CORTEX_STEP_TYPE_USER_INPUT') lastUser = i; });
  for (let i = steps.length - 1; i > lastUser; i--) {
    const pr = steps[i].plannerResponse;
    const text = pr && (pr.modifiedResponse || pr.response);
    if (text && text.trim()) return text.trim();
  }
  for (let i = steps.length - 1; i > lastUser; i--) {
    const em = steps[i].errorMessage?.error;
    if (em) return `[agent error] ${em.userErrorMessage || ''} ${em.shortError || ''}`.trim();
  }
  return '';
}

function stepLine(st, idx) {
  const t = shortType(st.type);
  const status = (st.status || '').replace(/^CORTEX_STEP_STATUS_/, '').toLowerCase();
  const tag = `#${idx} ${t}${status && status !== 'done' ? ` (${status})` : ''}`;
  if (st.userInput) {
    const raw = st.userInput.userResponse || st.userInput.items?.map((x) => x.text).join(' ') || '';
    const { who, body } = unwrapInput(raw);
    return `${tag} [from ${who}]: ${clip(body, 300)}`;
  }
  if (st.plannerResponse) {
    const pr = st.plannerResponse;
    const calls = (pr.toolCalls || []).map((c) => `${c.name}(${clip(c.argumentsJson || '', 160)})`).join(', ');
    const text = pr.modifiedResponse || pr.response || '';
    return `${tag}: ${clip(text.replace(/\s+/g, ' '), 400)}${calls ? ` [calls: ${calls}]` : ''}`;
  }
  if (st.runCommand) return `${tag}: $ ${clip(st.runCommand.commandLine, 200)}${st.runCommand.exitCode !== undefined ? ` → exit ${st.runCommand.exitCode}` : ''}`;
  if (st.viewFile) return `${tag}: ${st.viewFile.absolutePathUri ? fromFileUri(st.viewFile.absolutePathUri) : ''}`;
  if (st.codeAction) {
    const spec = st.codeAction.actionSpec || {};
    const kind = Object.keys(spec)[0] || 'edit';
    const uri = spec[kind]?.path?.absoluteUri || spec[kind]?.absoluteUri || JSON.stringify(spec[kind] || {}).match(/file:\/\/[^"]+/)?.[0];
    return `${tag}: ${kind} ${uri ? fromFileUri(uri) : ''}`;
  }
  if (st.errorMessage) return `${tag}: ${clip(st.errorMessage.error?.shortError || st.errorMessage.error?.userErrorMessage, 300)}`;
  if (st.generic) {
    const title = st.generic.result?.stepRenderInfo?.title;
    if (st.generic.result?.stepRenderInfo?.hidden) return null;
    return `${tag}: ${clip(title || JSON.stringify(st.generic.args || {}), 200)}`;
  }
  const payloadKey = Object.keys(st).find((k) => !['type', 'status', 'metadata', 'permissions', 'completedInteractions', 'requestedInteraction'].includes(k));
  return `${tag}${payloadKey ? `: ${clip(JSON.stringify(st[payloadKey]), 200)}` : ''}`;
}

// ---------------------------------------------------------------- agent config

let cachedConfig = null;
let modelCache = null;

async function models() {
  if (!modelCache) {
    const r = await rpc('GetCascadeModelConfigData', {});
    modelCache = (r.clientModelConfigs || []).map((m) => ({
      label: m.label, model_id: m.modelId, enum: m.modelOrAlias?.model || m.modelOrAlias?.alias,
      disabled: !!m.disabled, quota_remaining: m.quotaInfo?.remainingFraction, quota_reset: m.quotaInfo?.resetTime,
      tag: m.tagTitle, description: m.tagDescription,
    }));
  }
  return modelCache;
}

async function resolveModel(q) {
  if (!q) return null;
  const list = await models();
  const n = q.toLowerCase();
  const hit = list.find((m) => [m.enum, m.model_id, m.label].some((v) => v && v.toLowerCase() === n))
    || list.find((m) => [m.model_id, m.label].some((v) => v && v.toLowerCase().includes(n)));
  if (!hit) throw new Error(`Unknown model "${q}". Available: ${list.map((m) => `${m.label} (${m.model_id})`).join(', ')}`);
  return hit;
}

// The IDE sends a full agent config with every user message. Mirror the one the user's
// own Antigravity conversations use, so spawned agents get identical tools/hooks/settings.
async function baseConfig() {
  if (cachedConfig) return structuredClone(cachedConfig);
  const mine = loadSpawned();
  try {
    const sums = Object.entries(await allSummaries())
      .filter(([id, s]) => !mine[id] && s.lastUserInputStepIndex !== undefined && s.trajectoryType === 'CORTEX_TRAJECTORY_TYPE_CASCADE')
      .sort((a, b) => String(b[1].lastUserInputTime || '').localeCompare(String(a[1].lastUserInputTime || '')));
    for (const [id, s] of sums.slice(0, 3)) {
      const steps = await stepsFrom(id, s.lastUserInputStepIndex);
      const cfg = steps.find((st) => st.userInput?.userConfig)?.userInput.userConfig;
      if (cfg?.plannerConfig) { cachedConfig = cfg; break; }
    }
  } catch (e) { log('could not read IDE config, using bundled default:', e.message); }
  if (!cachedConfig) cachedConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  return structuredClone(cachedConfig);
}

async function buildConfig(modelQuery) {
  const cfg = await baseConfig();
  if (modelQuery) {
    const m = await resolveModel(modelQuery);
    cfg.plannerConfig = cfg.plannerConfig || {};
    cfg.plannerConfig.planModel = m.enum;
    delete cfg.plannerConfig.requestedModel;
  }
  return cfg;
}

// ---------------------------------------------------------------- waiting

async function waitFor(ids, { mode = 'all', timeoutSeconds = 600, baselines = {} } = {}) {
  const started = Date.now();
  const deadline = started + Math.max(1, timeoutSeconds) * 1000;
  const sawBusy = {};
  const doneStreak = {};
  while (true) {
    const sums = await allSummaries();
    const state = {};
    for (const id of ids) {
      const s = sums[id];
      if (!s) { state[id] = 'missing'; continue; }
      const waiting = s.waitingSteps?.length > 0;
      if (!isDone(s)) sawBusy[id] = true;
      const progressed = sawBusy[id] || (s.stepCount || 0) > (baselines[id] ?? -1) + 1 || Date.now() - started > 20000;
      if (waiting) state[id] = 'needs_attention';
      else if (isDone(s) && progressed) { doneStreak[id] = (doneStreak[id] || 0) + 1; state[id] = doneStreak[id] >= 2 ? 'done' : 'settling'; }
      else { doneStreak[id] = 0; state[id] = 'running'; }
    }
    const vals = Object.values(state);
    const finished = (v) => v === 'done' || v === 'missing' || v === 'needs_attention';
    if (mode === 'any' ? vals.some((v) => v === 'done' || v === 'needs_attention') : vals.every(finished)) return { state, timedOut: false };
    if (Date.now() > deadline) return { state, timedOut: true };
    await sleep(2500);
  }
}

async function report(id, { includeResponse = true, maxChars = 12000 } = {}) {
  const s = await summary(id);
  const out = {
    conversation_id: id,
    title: s.annotations?.title || s.summary || '',
    status: shortStatus(s.status),
    done: isDone(s),
    step_count: s.stepCount,
    workspaces: (s.workspaces || []).map((w) => fromFileUri(w.workspaceFolderAbsoluteUri)),
    last_modified: s.lastModifiedTime,
  };
  if (s.latestExecutorTerminationReason) out.termination = s.latestExecutorTerminationReason.replace(/^EXECUTOR_TERMINATION_REASON_/, '').toLowerCase();
  if (s.hasRunningSubagents) out.running_subagents = true;
  const waiting = describeWaiting(s);
  if (waiting.length) {
    out.needs_attention = waiting;
    out.hint = restrictions().antigravity_respond
      ? 'The agent is blocked on an approval. This bridge may not answer it (see antigravity_bridge_status); the user must approve it in the Antigravity window.'
      : 'The agent is blocked on an approval. Ask the user, then call antigravity_respond (permission prompts) or have them approve it in the Antigravity window.';
  }
  if (includeResponse) {
    const from = s.lastUserInputStepIndex ?? Math.max(0, (s.stepCount || 0) - 40);
    out.final_response = clip(finalResponse(await stepsFrom(id, from)), maxChars) || (out.done ? '(no text response)' : '(still working)');
  }
  return out;
}

// ---------------------------------------------------------------- tools

const tools = {
  antigravity_spawn: {
    description:
      'Start a new Antigravity agent (a Gemini-powered sub-agent in the local Antigravity IDE) on a task, in its own conversation, working in `cwd`. ' +
      'Returns a conversation_id immediately unless wait=true. Use this to offload self-contained work (research, investigations, implementation, reviews) ' +
      'without spending your own context; spawn several in parallel, then collect them with antigravity_wait. The agent sees nothing of your conversation, ' +
      'so write a complete, self-contained brief. Agents run with the user\'s Antigravity settings (they can run commands and edit files in cwd). ' +
      'Subject to the bridge policy (see antigravity_bridge_status).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Complete, self-contained task brief for the agent. A header marking it as delegated by Claude Code (not typed by the user) is added automatically.' },
        cwd: { type: 'string', description: 'Absolute path of the workspace folder the agent should work in. Must be inside the host\'s AGENT_BRIDGE_WORKSPACE_ROOTS.' },
        title: { type: 'string', description: 'Optional short title for the Antigravity Agent Manager; always prefixed with "[Claude] ". Defaults to the first line of the prompt.' },
        model: { type: 'string', description: 'Optional model: label, model id, or substring (see antigravity_models). Defaults to the IDE default.' },
        wait: { type: 'boolean', description: 'Block until the agent finishes and return its final response. Default false.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait when wait=true. Default 600.' },
        append_report_instructions: { type: 'boolean', description: 'Append an instruction asking the agent to end with a concise final report. Default true.' },
      },
      required: ['prompt', 'cwd'],
    },
    async run({ prompt, cwd, title, model, wait = false, timeout_seconds = 600, append_report_instructions = true }) {
      if (!prompt || !cwd) throw new Error('prompt and cwd are required.');
      try {
        cwd = resolveWorkspaceDir(WORKSPACE, cwd, 'cwd');
      } catch (e) {
        throw new PolicyError(refusal('antigravity_spawn', e.message.replace(/\.$/, '')));
      }
      const cascadeConfig = await buildConfig(model);
      const down = downstream();
      const shownTitle = delegatedTitle(title, prompt);
      const cascadeId = await serialized(async () => {
        const active = await activeSpawned();
        if (active.length >= BRIDGE.maxConcurrent) {
          throw new PolicyError(refusal('antigravity_spawn',
            `concurrency limit reached (${active.length} active bridge-spawned agents, AGENT_BRIDGE_MAX_CONCURRENT=${BRIDGE.maxConcurrent}). ` +
            `Wait for or cancel one of: ${active.join(', ')}`));
        }
        const { cascadeId: id } = await rpc('StartCascade', {
          source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
          trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
          workspaceUris: [toFileUri(cwd)],
          tags: [TAG],
        });
        if (!id) throw new Error('Antigravity did not return a conversation id.');
        saveSpawned(id, { cwd, title: shownTitle, model: model || '', created: new Date().toISOString(), bridge: down });
        return id;
      });
      await rpc('UpdateConversationAnnotations', { cascadeId, annotations: { title: shownTitle, tags: [TAG] }, mergeAnnotations: true }).catch((e) => log('title:', e.message));
      const text = delegationHeader(down) + prompt + (append_report_instructions ? REPORT_FOOTER : '');
      await rpc('SendUserCascadeMessage', { cascadeId, items: [{ text }], cascadeConfig });
      if (!wait) return { conversation_id: cascadeId, status: 'running', cwd, bridge: down, note: 'Poll with antigravity_wait or antigravity_status.' };
      const w = await waitFor([cascadeId], { timeoutSeconds: timeout_seconds, baselines: { [cascadeId]: 0 } });
      return { ...(await report(cascadeId)), timed_out: w.timedOut };
    },
  },

  antigravity_send: {
    description: 'Send a follow-up message to an existing Antigravity conversation (to steer it, answer a question, or continue its work). Optionally wait for it to finish. Subject to the bridge policy.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        message: { type: 'string' },
        model: { type: 'string', description: 'Optional model override for this turn.' },
        wait: { type: 'boolean', description: 'Default false.' },
        timeout_seconds: { type: 'number', description: 'Default 600.' },
      },
      required: ['conversation_id', 'message'],
    },
    async run({ conversation_id, message, model, wait = false, timeout_seconds = 600 }) {
      const before = await summary(conversation_id);
      checkConversationWorkspaces(before);
      const cascadeConfig = await buildConfig(model);
      const current = downstream();
      const original = loadSpawned()[conversation_id]?.bridge;
      const down = original ? followupPolicy(current, original) : current;
      if (original && (down.role !== original.role || down.maxDepth !== original.maxDepth)) {
        saveSpawned(conversation_id, { bridge: down });
      }
      await rpc('SendUserCascadeMessage', { cascadeId: conversation_id, items: [{ text: FOLLOWUP_HEADER + markerLine(down) + '\n\n' + message }], cascadeConfig });
      if (!wait) return { conversation_id, status: 'running', note: 'Message sent.' };
      const w = await waitFor([conversation_id], { timeoutSeconds: timeout_seconds, baselines: { [conversation_id]: before.stepCount || 0 } });
      return { ...(await report(conversation_id)), timed_out: w.timedOut };
    },
  },

  antigravity_wait: {
    description:
      'Wait for one or more Antigravity conversations to finish (or to block on an approval), then return each one\'s status and final response. ' +
      'mode "all" waits for every id; "any" returns as soon as one finishes. On timeout, returns current state; just call again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_ids: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['all', 'any'], description: 'Default "all".' },
        timeout_seconds: { type: 'number', description: 'Default 600.' },
        max_chars_per_response: { type: 'number', description: 'Truncate each final response. Default 8000.' },
      },
      required: ['conversation_ids'],
    },
    async run({ conversation_ids, mode = 'all', timeout_seconds = 600, max_chars_per_response = 8000 }) {
      if (!conversation_ids?.length) throw new Error('conversation_ids is empty.');
      const w = await waitFor(conversation_ids, { mode, timeoutSeconds: timeout_seconds });
      const results = [];
      for (const id of conversation_ids) {
        if (w.state[id] === 'missing') { results.push({ conversation_id: id, status: 'missing' }); continue; }
        const finished = w.state[id] === 'done' || w.state[id] === 'needs_attention';
        results.push(await report(id, { includeResponse: finished, maxChars: max_chars_per_response }));
      }
      return { timed_out: w.timedOut, results };
    },
  },

  antigravity_status: {
    description: 'Get the current status of an Antigravity conversation: running/idle, step count, pending approvals, and (if finished) its final response.',
    inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } }, required: ['conversation_id'] },
    async run({ conversation_id }) { return report(conversation_id); },
  },

  antigravity_result: {
    description:
      'Read an Antigravity conversation\'s output. detail="final": last agent message only (cheapest). "steps": one line per step (tool calls, commands, files, messages) — ' +
      'good for auditing what the agent did. "markdown": the full chat transcript as markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        detail: { type: 'string', enum: ['final', 'steps', 'markdown'], description: 'Default "final".' },
        since_step: { type: 'number', description: 'For "steps": start at this step index. Default: the last user message.' },
        max_chars: { type: 'number', description: 'Truncate output. Default 20000.' },
      },
      required: ['conversation_id'],
    },
    async run({ conversation_id, detail = 'final', since_step, max_chars = 20000 }) {
      if (detail === 'markdown') {
        const r = await rpc('ConvertTrajectoryToMarkdown', { conversationId: conversation_id }, { timeoutMs: 120000 });
        return clip(r.markdown || '', max_chars);
      }
      const s = await summary(conversation_id);
      const from = since_step ?? s.lastUserInputStepIndex ?? 0;
      const steps = await stepsFrom(conversation_id, from);
      if (detail === 'final') return clip(finalResponse(steps), max_chars) || `(no response yet; status ${shortStatus(s.status)})`;
      const lines = steps.map((st, i) => stepLine(st, from + i)).filter(Boolean);
      return clip(`status: ${shortStatus(s.status)}, steps ${from}..${(s.stepCount || 1) - 1}\n` + lines.join('\n'), max_chars);
    },
  },

  antigravity_list: {
    description: 'List Antigravity conversations (most recent first) with id, title, status and workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Default 20.' },
        mine_only: { type: 'boolean', description: 'Only conversations spawned through this MCP. Default false.' },
        include_archived: { type: 'boolean', description: 'Default false.' },
      },
    },
    async run({ limit = 20, mine_only = false, include_archived = false }) {
      const mine = loadSpawned();
      return Object.entries(await allSummaries())
        .filter(([id, s]) => (!mine_only || mine[id]) && (include_archived || !s.annotations?.archived))
        .sort((a, b) => String(b[1].lastModifiedTime || '').localeCompare(String(a[1].lastModifiedTime || '')))
        .slice(0, limit)
        .map(([id, s]) => ({
          conversation_id: id,
          title: s.annotations?.title || s.summary || '',
          status: shortStatus(s.status),
          needs_attention: (s.waitingSteps?.length || 0) > 0 || undefined,
          steps: s.stepCount,
          workspace: s.workspaces?.[0] ? fromFileUri(s.workspaces[0].workspaceFolderAbsoluteUri) : undefined,
          spawned_by_mcp: !!mine[id] || undefined,
          last_modified: s.lastModifiedTime,
        }));
    },
  },

  antigravity_cancel: {
    description: 'Stop a running Antigravity conversation. force_tree=true also force-stops its sub-agents and background tasks. Subject to the bridge policy.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string' }, force_tree: { type: 'boolean', description: 'Default false.' } },
      required: ['conversation_id'],
    },
    async run({ conversation_id, force_tree = false }) {
      if (force_tree) await rpc('ForceStopCascadeTree', { conversationId: conversation_id });
      else await rpc('CancelCascadeInvocation', { cascadeId: conversation_id, killBackgroundTasks: true });
      await sleep(1000);
      return report(conversation_id, { includeResponse: false });
    },
  },

  antigravity_respond: {
    description:
      'Answer a permission prompt an Antigravity agent is blocked on (see needs_attention from antigravity_status/wait). ' +
      'Only approve with the user\'s go-ahead. Command/browser approvals of other kinds must be handled in the Antigravity window. ' +
      'Always refused when this bridge is itself a delegated worker (AGENT_BRIDGE_DEPTH > 0 or role subordinate).',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        allow: { type: 'boolean' },
        scope: { type: 'string', enum: ['once', 'conversation'], description: 'How long the grant lasts. Default "once".' },
        deny_reason: { type: 'string', description: 'Optional instruction to the agent when denying.' },
        step_index: { type: 'number', description: 'Which waiting step to answer. Default: the first one.' },
      },
      required: ['conversation_id', 'allow'],
    },
    async run({ conversation_id, allow, scope = 'once', deny_reason, step_index }) {
      const s = await summary(conversation_id);
      const waiting = s.waitingSteps || [];
      checkConversationWorkspaces(s);
      const w = step_index === undefined ? waiting[0] : waiting.find((x) => (x.stepIndex ?? x.index) === step_index);
      if (!w) throw new Error('That conversation is not waiting on any approval.');
      const ri = w.step?.requestedInteraction || {};
      if (!ri.permission) throw new Error(`The pending request is a "${Object.keys(ri)[0] || 'unknown'}" interaction; approve it in the Antigravity window.`);
      const interaction = {
        trajectoryId: s.trajectoryId,
        stepIndex: w.stepIndex ?? w.index,
        permission: {
          allow,
          scope: scope === 'conversation' ? 'PERMISSION_SCOPE_CONVERSATION' : 'PERMISSION_SCOPE_ONCE',
          ...(deny_reason && !allow ? { userDenyInstruction: deny_reason } : {}),
        },
      };
      await rpc('HandleCascadeUserInteraction', { conversationId: conversation_id, interaction });
      await sleep(1000);
      return report(conversation_id, { includeResponse: false });
    },
  },

  antigravity_models: {
    description: 'List the models available to Antigravity agents, with remaining quota.',
    inputSchema: { type: 'object', properties: {} },
    async run() { modelCache = null; return (await models()).filter((m) => !m.disabled); },
  },

  antigravity_bridge_status: {
    description:
      'Show this bridge\'s delegation policy (AGENT_BRIDGE_* settings): role, depth, limits, chain, which tools are refused and why, ' +
      'how many bridge-spawned agents are active, and the [bridge: ...] marker a new spawn would carry. Read-only; always available.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      let active;
      try { active = (await activeSpawned()).length; } catch (e) { active = `unknown (${e.message})`; }
      const preview = restrictions().antigravity_spawn ? null : downstream();
      return {
        role: BRIDGE.role,
        depth: BRIDGE.depth,
        max_depth: BRIDGE.maxDepth,
        chain: BRIDGE.chain.join(','),
        allow_cycles: BRIDGE.allowCycles,
        max_concurrent: BRIDGE.maxConcurrent,
        active_spawned: active,
        hide_restricted_tools: BRIDGE.hideRestricted,
        hop: preview?.chain.split(',').at(-1) ?? null,
        next_spawn_marker: preview,
        refused_tools: restrictions(),
        config_errors: BRIDGE.errors.length ? BRIDGE.errors : undefined,
        workspace: {
          ...describeWorkspacePolicy(WORKSPACE),
          note: 'Roots limit the cwd of new antigravity_spawn calls only. Agents use the IDE\'s own permissions; existing conversations are not limited.',
        },
      };
    },
  },
};

// ---------------------------------------------------------------- MCP stdio transport

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function serverInstructions() {
  let text =
    'Bridge to the local Google Antigravity IDE. Use antigravity_spawn to hand self-contained tasks to Antigravity agents ' +
    '(they run in parallel and do not consume your context), antigravity_wait to collect results, and antigravity_result for detail. ' +
    'Write complete briefs: agents cannot see this conversation.';
  const refused = Object.keys(restrictions());
  if (refused.length) {
    text += ` Bridge policy (role=${BRIDGE.role}, depth=${BRIDGE.depth}/${BRIDGE.maxDepth}) refuses: ${refused.join(', ')}. ` +
      'See antigravity_bridge_status for reasons.';
  }
  return text;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: serverInstructions(),
        };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': {
        const hidden = BRIDGE.hideRestricted ? restrictions() : {};
        result = {
          tools: Object.entries(tools)
            .filter(([name]) => !hidden[name])
            .map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        };
        break;
      }
      case 'tools/call': {
        const name = params?.name;
        const t = tools[name];
        if (!t) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
        const blocked = restrictions()[name];
        if (blocked) {
          result = { content: [{ type: 'text', text: refusal(name, blocked) }], isError: true };
          break;
        }
        try {
          const out = await t.run(params.arguments || {});
          result = { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: e instanceof PolicyError ? e.message : `Error: ${e.message}` }], isError: true };
        }
        break;
      }
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, ...)
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
}

let buf = '';
let inFlight = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && inFlight === 0) process.exit(0);
}

function dispatchLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    inFlight += 1;
    Promise.resolve(handle(m)).finally(() => {
      inFlight -= 1;
      maybeExit();
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    dispatchLine(line);
  }
});
process.stdin.on('end', () => {
  const trailing = buf.trim();
  buf = '';
  if (trailing) dispatchLine(trailing);
  stdinEnded = true;
  maybeExit();
});
log(`v${SERVER_VERSION} ready (role=${BRIDGE.role}, depth=${BRIDGE.depth}/${BRIDGE.maxDepth})`);
