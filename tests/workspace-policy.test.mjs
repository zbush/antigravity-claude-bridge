import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isWithin,
  loadWorkspacePolicy,
  resolveWorkspaceDir,
} from "../antigravity-to-claude/server/workspace-policy.mjs";

const helperA = new URL("../antigravity-to-claude/server/workspace-policy.mjs", import.meta.url);
const helperB = new URL("../claude-to-antigravity/server/workspace-policy.mjs", import.meta.url);
const agServer = fileURLToPath(new URL("../claude-to-antigravity/server/index.mjs", import.meta.url));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge roots "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("each connector ships an identical copy of the workspace helper", async () => {
  assert.equal(await readFile(helperA, "utf8"), await readFile(helperB, "utf8"));
});

test("workspace policy parsing is strict and fails closed", async t => {
  const dir = await tempDir(t);
  const real = realpathSync.native(dir);
  assert.deepEqual(loadWorkspacePolicy({ env: {}, cwd: dir }).roots, [real]);
  assert.equal(loadWorkspacePolicy({ env: {}, cwd: dir }).allowEdits, false);
  assert.equal(loadWorkspacePolicy({ env: { AGENT_BRIDGE_ALLOW_EDITS: "true" }, cwd: dir }).allowEdits, true);
  for (const value of ["TRUE", " true", "1", "yes"]) {
    const policy = loadWorkspacePolicy({ env: { AGENT_BRIDGE_ALLOW_EDITS: value }, cwd: dir });
    assert.equal(policy.allowEdits, false);
    assert.equal(policy.errors.length, 1);
  }
  for (const value of ["[]", "{}", "nope", '"' + dir.replace(/\\/g, "\\\\") + '"', JSON.stringify(["relative"]), JSON.stringify([path.join(dir, "missing")])]) {
    const policy = loadWorkspacePolicy({ env: { AGENT_BRIDGE_WORKSPACE_ROOTS: value }, cwd: dir });
    assert.ok(policy.errors.length > 0, value);
    assert.deepEqual(policy.roots, []);
    assert.throws(() => resolveWorkspaceDir(policy, dir), /Workspace policy is invalid/);
  }
  const volume = path.parse(dir).root;
  assert.match(loadWorkspacePolicy({ env: {}, cwd: volume }).errors.join(), /volume root/);
  assert.deepEqual(loadWorkspacePolicy({ env: { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([dir]) }, cwd: volume }).roots, [real]);
});

test("containment uses canonical paths, not string prefixes", async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, "ab");
  const sibling = path.join(dir, "abc");
  await mkdir(path.join(root, "inner"), { recursive: true });
  await mkdir(sibling);
  await symlink(sibling, path.join(root, "link"), "junction");
  const policy = loadWorkspacePolicy({ env: { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([root]) } });
  assert.equal(resolveWorkspaceDir(policy, path.join(root, "inner")), realpathSync.native(path.join(root, "inner")));
  assert.equal(resolveWorkspaceDir(policy, path.join(root, "inner", "..")), realpathSync.native(root));
  assert.throws(() => resolveWorkspaceDir(policy, sibling), /outside the workspace roots/);
  assert.throws(() => resolveWorkspaceDir(policy, path.join(root, "link")), /outside the workspace roots/);
  assert.throws(() => resolveWorkspaceDir(policy, path.join(root, "..")), /outside the workspace roots/);
  assert.equal(isWithin(root, path.join(root, "..x")), true);
  if (process.platform === "win32") assert.equal(isWithin("C:\\work", "D:\\work"), false);
});

async function connectAntigravity(t, extraEnv = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bridge roots "));
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9",
    ANTIGRAVITY_CSRF_TOKEN: "test",
    ANTIGRAVITY_DATA_DIR: path.join(cwd, "data"),
    ANTIGRAVITY_MCP_STATE_DIR: path.join(cwd, "state"),
  };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("AGENT_BRIDGE_")) delete env[key];
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [agServer], { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const closed = once(child, "close");
  // Remove the server's cwd only after it exits (Windows refuses to delete a process cwd).
  t.after(async () => { child.stdin.end(); await closed; await rm(cwd, { recursive: true, force: true }); });
  let nextId = 0;
  const requests = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const reply = JSON.parse(line);
    requests.get(reply.id)?.(reply);
    requests.delete(reply.id);
  });
  function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  function request(method, params) {
    const id = ++nextId;
    const reply = new Promise(resolve => requests.set(id, resolve));
    send({ id, method, params });
    return { id, reply };
  }
  async function call(name, args = {}) {
    const r = await request("tools/call", { name, arguments: args }).reply;
    return r.error ? { error: r.error } : { isError: Boolean(r.result.isError), text: r.result.content[0].text };
  }
  return { call, request, send, cwd };
}

test("antigravity_spawn refuses a cwd outside the workspace roots", { timeout: 20000 }, async t => {
  const { call, cwd } = await connectAntigravity(t, { AGENT_BRIDGE_ALLOW_EDITS: "true" });
  const outside = await tempDir(t);
  await symlink(outside, path.join(cwd, "escape"), "junction");
  for (const target of [outside, path.join(cwd, "escape"), "relative"]) {
    const reply = await call("antigravity_spawn", { prompt: "task", cwd: target });
    assert.equal(reply.error.code, -32602);
    assert.match(reply.error.data.reason, /Bridge policy refused antigravity_spawn/);
  }
  // Inside the roots, the guard passes and the call proceeds to the (unreachable) IDE.
  const inside = await call("antigravity_spawn", { prompt: "task", cwd });
  assert.ok(inside.isError);
  assert.doesNotMatch(inside.text, /Bridge policy refused/);

  const status = JSON.parse((await call("antigravity_bridge_status")).text);
  assert.deepEqual(status.workspace.roots, [realpathSync.native(cwd)]);
  assert.equal(status.workspace.allow_edits, true);
});

test("the default registration refuses work using IDE permissions", async t => {
  const { call, cwd } = await connectAntigravity(t);
  for (const name of ["antigravity_spawn", "antigravity_send", "antigravity_respond"]) {
    const reply = await call(name, { cwd, prompt: "test" });
    assert.equal(reply.error.code, -32602);
    assert.match(reply.error.data.reason, /AGENT_BRIDGE_ALLOW_EDITS=true/);
  }
});

test("invalid workspace config refuses spawn but keeps status tools", { timeout: 20000 }, async t => {
  const { call, cwd } = await connectAntigravity(t, { AGENT_BRIDGE_ALLOW_EDITS: "True" });
  const reply = await call("antigravity_spawn", { prompt: "task", cwd });
  assert.equal(reply.error.code, -32602);
  assert.match(reply.error.data.reason, /Bridge policy refused antigravity_spawn.*AGENT_BRIDGE_ALLOW_EDITS/s);
  const status = await call("antigravity_bridge_status");
  assert.equal(status.isError, false);
  assert.match(JSON.parse(status.text).workspace.errors.join(), /AGENT_BRIDGE_ALLOW_EDITS/);
});

async function mockIde(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const method = req.url.split("/").at(-1);
    calls.push(method);
    const result = await handler(method, JSON.parse(input));
    if (result !== undefined) res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { calls, env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:" + server.address().port, AGENT_BRIDGE_ALLOW_EDITS: "true" } };
}

const workspace = dir => ({ workspaceFolderAbsoluteUri: pathToFileURL(dir).href });

test("IDE conversation reads, listings and cancellation respect all reported roots", async t => {
  const sums = {};
  const ide = await mockIde(t, method => method === "GetAllCascadeTrajectories" ? { trajectorySummaries: sums } : {});
  const { cwd, call, request } = await connectAntigravity(t, ide.env);
  const outside = await tempDir(t);
  for (const [id, workspaces] of Object.entries({
    mine: [workspace(cwd)], other: [workspace(cwd)], mixed: [workspace(cwd), workspace(outside)], unknown: [],
  })) sums[id] = { workspaces };
  await mkdir(path.join(cwd, "state"));
  await writeFile(path.join(cwd, "state", "spawned.json"), JSON.stringify({ mine: {}, mixed: {} }));

  assert.equal((await request("initialize", {}).reply).result.serverInfo.name, "antigravity-local");
  const list = async args => JSON.parse((await call("antigravity_list", args)).text).map(row => row.conversation_id).sort();
  assert.deepEqual(await list({}), ["mine"]);
  assert.deepEqual(await list({ mine_only: false }), ["mine", "other"]);
  for (const id of ["mixed", "unknown"]) {
    for (const [name, args] of [
      ["antigravity_status", {}], ["antigravity_result", { detail: "markdown" }],
      ["antigravity_result", { detail: "steps" }], ["antigravity_result", {}],
      ["antigravity_cancel", {}], ["antigravity_cancel", { force_tree: true }],
      ["antigravity_wait", { conversation_ids: [id] }],
      ["antigravity_respond", { allow: false }], ["antigravity_send", { message: "hello" }],
    ]) {
      const reply = await call(name, { conversation_id: id, ...args });
      assert.equal(reply.error?.code, -32602, name);
      assert.match(reply.error.data.reason, /workspace roots/);
    }
  }
  assert.deepEqual([...new Set(ide.calls)], ["GetAllCascadeTrajectories"]);
  assert.equal((await call("antigravity_status", { conversation_id: "other" })).isError, false);
  assert.equal((await call("antigravity_result", { conversation_id: "mine", detail: "markdown" })).isError, false);
  assert.ok(ide.calls.includes("ConvertTrajectoryToMarkdown"));
  assert.equal((await call("antigravity_result", { conversation_id: "mine", detail: "bogus" })).error.code, -32602);
});

test("cancelling any waiting IDE request aborts its pending poll", { timeout: 15000 }, async t => {
  let cwd, onPoll, blockPoll = false;
  const ide = await mockIde(t, method => {
    if (method === "GetAllCascadeTrajectories") {
      if (blockPoll) { onPoll(); return; } // A hung IDE, including the response body.
      return { trajectorySummaries: { conversation: { workspaces: [workspace(cwd)] } } };
    }
    if (method === "StartCascade") return { cascadeId: "conversation" };
    if (method === "SendUserCascadeMessage") blockPoll = true;
    return {};
  });
  const client = await connectAntigravity(t, ide.env);
  cwd = client.cwd;
  for (const [name, args] of [
    ["antigravity_spawn", { cwd, prompt: "hello", wait: true }],
    ["antigravity_send", { conversation_id: "conversation", message: "again", wait: true }],
    ["antigravity_wait", { conversation_ids: ["conversation"] }],
  ]) {
    blockPoll = name === "antigravity_wait";
    const polling = new Promise(resolve => { onPoll = resolve; });
    const { id, reply } = client.request("tools/call", { name, arguments: args });
    await polling;
    client.send({ method: "notifications/cancelled", params: { requestId: id } });
    const response = await reply;
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /abort/i);
    assert.ok((await client.request("ping").reply).result);
  }
});

test("multiple IDE bridges share the spawn cap, retain both writes and recover a dead lock owner", { timeout: 20000 }, async t => {
  let starts = 0;
  const ide = await mockIde(t, method => {
    if (method === "StartCascade") return { cascadeId: "spawn-" + ++starts };
    return {}; // The IDE has not published the new conversations yet.
  });
  const stateDir = await tempDir(t);
  const lock = path.join(stateDir, "spawned.json.lock");
  const dead = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  await once(dead, "close");
  await mkdir(lock);
  await writeFile(path.join(lock, dead.pid + ".dead"), "");
  const env = { ...ide.env, ANTIGRAVITY_MCP_STATE_DIR: stateDir, AGENT_BRIDGE_MAX_CONCURRENT: "2" };
  const clients = await Promise.all(Array.from({ length: 4 }, () => connectAntigravity(t, env)));
  const replies = await Promise.all(clients.map(client => client.call("antigravity_spawn", { cwd: client.cwd, prompt: "hi" })));
  assert.equal(starts, 2, JSON.stringify(replies));
  assert.equal(replies.filter(r => !r.error && !r.isError).length, 2);
  for (const reply of replies.filter(r => r.error || r.isError)) {
    assert.equal(reply.error?.code, -32602, JSON.stringify(reply));
    assert.match(reply.error.data.reason, /concurrency limit/);
  }
  const file = path.join(stateDir, "spawned.json");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort(), ["spawn-1", "spawn-2"]);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a third-agent return to Antigravity is blocked for both new and existing conversations", async t => {
  const hops = [{ from: "antigravity", to: "codex", id: "one" }, { from: "codex", to: "claude", id: "two" }];
  const { call, cwd } = await connectAntigravity(t, {
    AGENT_BRIDGE_ALLOW_EDITS: "true", AGENT_BRIDGE_MAX_DEPTH: "5",
    AGENT_BRIDGE_CONTEXT: JSON.stringify({ version: 1, hops, remaining_hops: 3 }),
  });
  for (const [name, args] of [
    ["antigravity_spawn", { cwd, prompt: "p" }], ["antigravity_send", { conversation_id: "id", message: "p" }],
  ]) {
    const { error } = await call(name, args);
    assert.equal(error.code, -32602);
    assert.match(error.data.reason, /cycle prevented/);
  }
});
