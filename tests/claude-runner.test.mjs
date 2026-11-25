import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../antigravity-to-claude/server/index.mjs", import.meta.url));

async function connect(t, { missing = false, delayedExit = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "claude bridge "));
  const cli = path.join(cwd, "fixture.cjs");
  if (!missing) await writeFile(cli, `
    let input = "";
    process.stdin.setEncoding("utf8").on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      if (process.argv.includes("--restricted")) {
        if (input.includes("fixture-missing-result")) return;
        if (input.includes("fixture-terminal-error")) {
          process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "fixture error" }));
          return;
        }
        const args = process.argv.slice(2);
        console.log(JSON.stringify({type: "result", result: args[args.indexOf("--tools")+1] === "" ? input : JSON.stringify(args)}));
      } else {
        require("node:fs").writeFileSync("fixture.pid", String(process.pid));
        setTimeout(() => {}, 20000);
      }
    });
  `);
  const env = { ...process.env, CLAUDE_CLI_BIN: cli };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("AGENT_BRIDGE_")) delete env[key];
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
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
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
  const running = call("claude_run", { prompt: "fixture" });
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
