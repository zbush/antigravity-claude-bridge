import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  function call(name, args = {}) {
    const id = ++nextId;
    const reply = new Promise(resolve => requests.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return reply.then(r => ({ isError: Boolean(r.result.isError), text: r.result.content[0].text }));
  }
  return { call, cwd };
}

test("antigravity_spawn refuses a cwd outside the workspace roots", { timeout: 20000 }, async t => {
  const { call, cwd } = await connectAntigravity(t, { AGENT_BRIDGE_ALLOW_EDITS: "true" });
  const outside = await tempDir(t);
  await symlink(outside, path.join(cwd, "escape"), "junction");
  for (const target of [outside, path.join(cwd, "escape"), "relative"]) {
    const reply = await call("antigravity_spawn", { prompt: "task", cwd: target });
    assert.ok(reply.isError);
    assert.match(reply.text, /Bridge policy refused antigravity_spawn/);
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
    assert.ok(reply.isError);
    assert.match(reply.text, /AGENT_BRIDGE_ALLOW_EDITS=true/);
  }
});

test("invalid workspace config refuses spawn but keeps status tools", { timeout: 20000 }, async t => {
  const { call, cwd } = await connectAntigravity(t, { AGENT_BRIDGE_ALLOW_EDITS: "True" });
  const reply = await call("antigravity_spawn", { prompt: "task", cwd });
  assert.ok(reply.isError);
  assert.match(reply.text, /Bridge policy refused antigravity_spawn.*AGENT_BRIDGE_ALLOW_EDITS/s);
  const status = await call("antigravity_bridge_status");
  assert.equal(status.isError, false);
  assert.match(JSON.parse(status.text).workspace.errors.join(), /AGENT_BRIDGE_ALLOW_EDITS/);
});
