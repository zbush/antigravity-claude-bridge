import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../antigravity-to-claude/server/index.mjs", import.meta.url));
const callbackServer = realpathSync.native(fileURLToPath(new URL("../claude-to-antigravity/server/index.mjs", import.meta.url)));
const SESSION = "11111111-1111-4111-8111-111111111111";

async function tempDir(t, prefix = "claude bridge ") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(t, { missing = false, delayedExit = false, env: extraEnv = {}, serverCwd } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "claude bridge "));
  const cli = path.join(cwd, "fixture.cjs");
  // The fixture echoes its argv (plus the inherited workspace roots) unless --tools is empty.
  if (!missing) await writeFile(cli, `
    let input = "";
    process.stdin.setEncoding("utf8").on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      if (input.includes("fixture-hang")) {
        require("node:fs").writeFileSync("fixture.pid", String(process.pid));
        setTimeout(() => {}, 20000);
        return;
      }
      if (input.includes("fixture-missing-result")) return;
      if (input.includes("fixture-terminal-error")) {
        process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "fixture error" }));
        return;
      }
      const args = process.argv.slice(2);
      const echoed = [...args, "env:" + (process.env.AGENT_BRIDGE_WORKSPACE_ROOTS ?? "")];
      console.log(JSON.stringify({ type: "result", session_id: "${SESSION}", result: args[args.indexOf("--tools")+1] === "" ? input : JSON.stringify(echoed) }));
    });
  `);
  const env = { ...process.env, CLAUDE_CLI_BIN: cli };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("AGENT_BRIDGE_")) delete env[key];
  Object.assign(env, typeof extraEnv === "function" ? extraEnv(cwd) : extraEnv);
  const args = [server];
  if (delayedExit) {
    // Simulate an OS process handle that confirms exit only after the test releases it.
    const preload = path.join(cwd, "delayed-exit.cjs");
    await writeFile(preload, `
      const cp = require("node:child_process");
      const spawn = cp.spawn;
      cp.spawn = (command, args, options) => {
        if (args[0] !== process.env.CLAUDE_CLI_BIN) return spawn(command, args, options);
        const child = new (require("node:events").EventEmitter)();
        for (const key of ["stdin", "stdout", "stderr"]) child[key] = new (require("node:stream").PassThrough)();
        child.signalCode = child.exitCode = null;
        const started = Date.now();
        const interval = setInterval(() => {
          if (!require("node:fs").existsSync("release") && Date.now() - started < 14000) return;
          clearInterval(interval);
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        }, 20);
        return child;
      };
      require("node:module").syncBuiltinESMExports();
    `);
    args.unshift("--require", preload);
    env.AGENT_BRIDGE_MAX_CONCURRENT = "1";
  }
  const child = spawn(process.execPath, args, { cwd: serverCwd ?? cwd, env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const closed = once(child, "close");
  t.after(async () => {
    child.stdin.end();
    await closed;
    await rm(cwd, { recursive: true, force: true });
  });
  let nextId = 0;
  const requests = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const reply = JSON.parse(line);
    requests.get(reply.id)?.(reply);
    requests.delete(reply.id);
  });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  function call(name, args) {
    const id = ++nextId;
    const reply = new Promise(resolve => requests.set(id, resolve));
    send({ id, method: "tools/call", params: { name, arguments: { cwd, ...args } } });
    return reply;
  }
  return { call, send, cwd };
}

function payload(reply) {
  assert.ok(reply.result, JSON.stringify(reply.error));
  return JSON.parse(reply.result.content[0].text);
}

const argsOf = result => JSON.parse(result.response);
const after = (args, flag) => args[args.indexOf(flag) + 1];

test("the explicit marker and prompt both constrain a Claude launch", async t => {
  const { call } = await connect(t, { env: { AGENT_BRIDGE_MAX_DEPTH: "3", AGENT_BRIDGE_ALLOW_CYCLES: "true" } });
  const marker = (id, role) => `[bridge: origin=claude role=${role} depth=1 max_depth=3 chain=claude:${id}]`;
  const args = { bridge_context: marker("one", "peer"), prompt: marker("one", "subordinate") + "\nReview the file." };
  const limited = await call("claude_run", args);
  assert.equal(limited.result.isError, true);
  assert.match(limited.result.content[0].text, /subordinate/);
  const conflict = await call("claude_run", { ...args, prompt: marker("two", "peer") });
  assert.match(conflict.error?.message ?? conflict.result?.content[0].text, /conflicting hop histories/);
});

test("review runs a restricted Claude with only the requested read tools", async t => {
  const { call } = await connect(t);
  const result = payload(await call("claude_review", { allowed_tools: ["Read"] }));
  assert.equal(result.status, "completed");
  const args = JSON.parse(result.response);
  assert.ok(args.includes("--restricted") && args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read");
  assert.ok(!args.includes("--worktree"));
  assert.match((await call("claude_review", { worktree: true })).error.message, /Unsupported review parameter/);
  for (const allowed_tools of ["Read", ["Bash"]]) {
    assert.match((await call("claude_review", { allowed_tools })).error.message, /allowed_tools/);
  }
  const prepared = payload(await call("claude_review", { review_diff: "fixture change", allowed_tools: [] }));
  assert.match((await call("claude_review", { review_diff: "prepared", uncommitted: false })).error.message, /separate review target/);
  assert.match(prepared.response, /the supplied diff/);
  assert.match(prepared.response, /fixture change/);
  assert.match(prepared.response, /supplied diff alone/);
  const oversized = await call("claude_review", { review_diff: "x".repeat(120001), allowed_tools: [] });
  assert.match(oversized.error.message, /Split the diff/);
  assert.doesNotMatch(prepared.response, /Git Context Note/);
});

test("invalid explicit binary fails before launch", async t => {
  const { call } = await connect(t, { missing: true });
  const reply = await call("claude_run", { prompt: "fixture" });
  assert.match(reply.error.message, /CLAUDE_CLI_BIN/);
});

test("a truncated stream or a final error without a newline fails the review", async t => {
  const { call } = await connect(t);
  for (const [review_diff, reason] of [["fixture-missing-result", /without a terminal result/], ["fixture-terminal-error", /fixture error/]]) {
    const reply = await call("claude_review", { review_diff, allowed_tools: [] });
    assert.equal(reply.result.isError, true);
    assert.match(payload(reply).errors.join(" "), reason);
  }
});

test("unconfirmed cancellation retains its slot and reconciles a late exit", { timeout: 17000 }, async t => {
  const { call, send, cwd } = await connect(t, { delayedExit: true });
  const waiting = call("claude_run", { prompt: "fixture" });
  send({ method: "notifications/cancelled", params: { requestId: 1 } });
  const uncertain = payload(await waiting);
  assert.equal(uncertain.status, "termination_unconfirmed");
  assert.ok((await call("claude_run", { prompt: "another" })).result.isError);
  await writeFile(path.join(cwd, "release"), "");
  let final;
  for (let i = 0; i < 100; i++) {
    final = payload(await call("claude_job_status", { job_id: uncertain.job_id }));
    if (final.status === "cancelled") break;
    await delay(20);
  }
  assert.equal(final.status, "cancelled");
  assert.equal(payload(await call("claude_job_cancel", { job_id: uncertain.job_id })).cancelled, false);
});

test("MCP cancellation waits for the fixture process to exit", { timeout: 12000 }, async t => {
  const { call, send, cwd } = await connect(t);
  const running = call("claude_run", { prompt: "fixture-hang" });
  let pid;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try { pid = Number(await readFile(path.join(cwd, "fixture.pid"), "utf8")); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
    if (!pid) await delay(20);
  }
  send({ method: "notifications/cancelled", params: { requestId: 1 } });
  const result = payload(await running);
  assert.ok(Number.isInteger(pid));
  assert.equal(result.status, "cancelled", JSON.stringify(result.errors));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("ordinary runs launch restricted with read tools only by default", async t => {
  const { call, cwd } = await connect(t);
  const result = payload(await call("claude_run", { prompt: "fixture" }));
  assert.equal(result.status, "completed");
  const args = argsOf(result);
  assert.ok(args.includes("--restricted") && args.includes("--strict-mcp-config"));
  assert.equal(after(args, "--tools"), "Read,Glob,Grep");
  assert.equal(after(args, "--permission-mode"), "plan");
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.some(a => /Bash|dangerously|^--(worktree|agent|ide|continue)$/.test(a)), args.join(" "));
  assert.equal(args.at(-1), "env:" + JSON.stringify([realpathSync.native(cwd)]));
  assert.deepEqual(result.capabilities.tools, ["Read", "Glob", "Grep"]);

  const narrowed = argsOf(payload(await call("claude_run", { prompt: "fixture", allowed_tools: ["Grep"] })));
  assert.equal(after(narrowed, "--tools"), "Grep");
  for (const allowed_tools of [["Bash"], ["Edit"], ["Bash(npm test)"], ["WebFetch"]]) {
    assert.match((await call("claude_run", { prompt: "fixture", allowed_tools })).error.message, /may only narrow/);
  }
  for (const permission_mode of ["bypassPermissions", "auto"]) {
    assert.match((await call("claude_run", { prompt: "fixture", permission_mode })).error.message, /permission_mode/);
  }
  for (const [key, value] of [["agent", "x"], ["worktree", true], ["worktree_name", "x"], ["ide", true]]) {
    assert.match((await call("claude_run", { prompt: "fixture", [key]: value })).error.message, /not available/);
    assert.match((await call("claude_spawn", { prompt: "fixture", [key]: value })).error.message, /not available/);
  }
  assert.match((await call("claude_spawn", { prompt: "fixture", base: "main" })).error.message, /Unsupported run parameter/);
});

test("Edit and Write require the host flag and can be narrowed", async t => {
  const { call } = await connect(t, { env: { AGENT_BRIDGE_ALLOW_EDITS: "true" } });
  const args = argsOf(payload(await call("claude_run", { prompt: "fixture" })));
  assert.equal(after(args, "--tools"), "Read,Glob,Grep,Edit,Write");
  assert.equal(after(args, "--permission-mode"), "acceptEdits");
  const narrowed = argsOf(payload(await call("claude_run", { prompt: "fixture", allowed_tools: ["Edit", "Read"] })));
  assert.equal(after(narrowed, "--tools"), "Read,Edit");
  const review = argsOf(payload(await call("claude_review", { review_diff: "d" })));
  assert.equal(after(review, "--tools"), "Read,Glob,Grep");
  assert.match((await call("claude_run", { prompt: "fixture", allowed_tools: ["Bash"] })).error.message, /may only narrow/);
});

test("invalid host configuration refuses launches but keeps status and cancellation", async t => {
  for (const env of [
    { AGENT_BRIDGE_ALLOW_EDITS: "TRUE" },
    { AGENT_BRIDGE_ALLOW_EDITS: "yes" },
    { AGENT_BRIDGE_WORKSPACE_ROOTS: "not json" },
    { AGENT_BRIDGE_WORKSPACE_ROOTS: "[]" },
    { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify(["relative/dir"]) },
    { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([path.join(os.tmpdir(), "missing-bridge-root-" + process.pid)]) },
  ]) {
    const { call } = await connect(t, { env });
    assert.match((await call("claude_run", { prompt: "fixture" })).error.message, /Workspace policy is invalid/);
    assert.match((await call("claude_review", { review_diff: "d", allowed_tools: [] })).error.message, /Workspace policy is invalid/);
    assert.deepEqual(payload(await call("claude_job_status", {})), { jobs: [] });
    assert.match((await call("claude_job_cancel", { job_id: "nope" })).result.content[0].text, /Unknown job_id/);
  }
});

test("cwd and add_dirs must resolve inside the workspace roots", async t => {
  const { call, cwd } = await connect(t);
  const outside = await tempDir(t);
  const sub = path.join(cwd, "sub");
  await mkdir(sub);
  await symlink(outside, path.join(cwd, "escape"), "junction");

  assert.match((await call("claude_run", { prompt: "fixture", cwd: outside })).error.message, /outside the workspace roots/);
  assert.match((await call("claude_review", { cwd: outside, review_diff: "d", allowed_tools: [] })).error.message, /outside the workspace roots/);
  assert.match((await call("claude_run", { prompt: "fixture", cwd: path.join(cwd, "escape") })).error.message, /outside the workspace roots/);
  assert.match((await call("claude_run", { prompt: "fixture", add_dirs: [outside] })).error.message, /add_dirs\[0\].*outside/);
  assert.match((await call("claude_run", { prompt: "fixture", add_dirs: [path.join(cwd, "escape")] })).error.message, /outside/);
  assert.match((await call("claude_run", { prompt: "fixture", cwd: "sub" })).error.message, /absolute/);
  assert.match((await call("claude_run", { prompt: "fixture", cwd: cwd + "-sibling" })).error.message, /not an existing directory/);

  const ok = payload(await call("claude_run", { prompt: "fixture", cwd: sub, add_dirs: [cwd] }));
  assert.equal(ok.cwd, realpathSync.native(sub));
  assert.equal(after(argsOf(ok), "--add-dir"), realpathSync.native(cwd));
});

test("a volume-root server cwd requires explicit workspace roots", async t => {
  const root = path.parse(os.tmpdir()).root;
  const implicit = await connect(t, { serverCwd: root });
  assert.match((await implicit.call("claude_run", { prompt: "fixture" })).error.message, /volume root/);

  const explicit = await connect(t, { serverCwd: root, env: cwd => ({ AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([cwd]) }) });
  assert.equal(payload(await explicit.call("claude_run", { prompt: "fixture" })).status, "completed");
});

test("resume and fork reuse only bridge sessions from the same cwd", async t => {
  const { call, cwd } = await connect(t);
  const sub = path.join(cwd, "sub");
  await mkdir(sub);

  assert.match((await call("claude_resume", { prompt: "again", session_id: SESSION })).error.message, /not started by this bridge/);
  assert.match((await call("claude_fork", { prompt: "again", session_id: SESSION })).error.message, /not started by this bridge/);
  assert.match((await call("claude_resume", { prompt: "again", last: true })).error.message, /'last'/);
  assert.match((await call("claude_resume", { prompt: "again", session_id: "--help" })).error.message, /UUID/);

  assert.equal(payload(await call("claude_run", { prompt: "fixture" })).session_id, SESSION);
  const resumed = argsOf(payload(await call("claude_resume", { prompt: "again", session_id: SESSION })));
  assert.equal(after(resumed, "--resume"), SESSION);
  assert.ok(resumed.includes("--restricted") && resumed.includes("--strict-mcp-config"));
  assert.equal(after(resumed, "--tools"), "Read,Glob,Grep");
  const forked = argsOf(payload(await call("claude_fork", { prompt: "again", session_id: SESSION })));
  assert.ok(forked.includes("--fork-session") && forked.includes("--restricted"));
  assert.match((await call("claude_fork", { prompt: "again", session_id: SESSION, cwd: sub })).error.message, /different cwd/);
  assert.match((await call("claude_resume", { prompt: "again", session_id: SESSION, allowed_tools: ["Edit"] })).error.message, /may only narrow/);
});

test("the Antigravity callback is registered only for explicit peers below max depth", async t => {
  const peer = await connect(t, { env: { AGENT_BRIDGE_ROLE: "peer", AGENT_BRIDGE_MAX_DEPTH: "2" } });
  const result = payload(await peer.call("claude_run", { prompt: "fixture" }));
  const args = argsOf(result);
  assert.ok(args.includes("--strict-mcp-config"));
  const config = JSON.parse(after(args, "--mcp-config"));
  assert.deepEqual(Object.keys(config.mcpServers), ["antigravity"]);
  assert.deepEqual(config.mcpServers.antigravity.args, [callbackServer]);
  assert.equal(config.mcpServers.antigravity.env.AGENT_BRIDGE_WORKSPACE_ROOTS, JSON.stringify([realpathSync.native(peer.cwd)]));
  assert.equal(config.mcpServers.antigravity.env.AGENT_BRIDGE_ROLE, "peer");
  assert.equal(after(args, "--allowedTools"), "mcp__antigravity");
  assert.equal(result.capabilities.callback_mcp, callbackServer);
  const review = argsOf(payload(await peer.call("claude_review", { review_diff: "d" })));
  assert.ok(!review.includes("--mcp-config"));

  for (const env of [
    { AGENT_BRIDGE_ROLE: "peer", AGENT_BRIDGE_MAX_DEPTH: "1" },
    { AGENT_BRIDGE_ROLE: "primary", AGENT_BRIDGE_MAX_DEPTH: "2" },
    { AGENT_BRIDGE_ROLE: "independent" },
  ]) {
    const { call } = await connect(t, { env });
    const blocked = argsOf(payload(await call("claude_run", { prompt: "fixture" })));
    assert.ok(!blocked.includes("--mcp-config"), JSON.stringify(env));
    assert.ok(!blocked.includes("--allowedTools"), JSON.stringify(env));
  }
});
