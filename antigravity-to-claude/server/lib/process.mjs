import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const activeChildren = new Set();

function buildChildEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Avoid nested-session guards if the parent environment sets these.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
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

function shutdown() {
  for (const child of activeChildren) {
    try {
      terminateOwnedTree(child);
    } catch (err) {
      process.stderr.write(err.message + "\n");
    }
  }
  activeChildren.clear();
}

export { activeChildren, buildChildEnv, terminateOwnedTree, runQuickCommand, shutdown };
