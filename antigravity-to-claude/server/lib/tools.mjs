import { describeWorkspacePolicy, loadWorkspacePolicy } from "../workspace-policy.mjs";
import { discoverClaudeBinary, resolveClaudeInvocation } from "./discovery.mjs";
import { activeChildren, runQuickCommand } from "./process.mjs";
import { getBridgePolicy, evaluateDelegationPolicy } from "./policy.mjs";
import { jobs, createRunner, formatStatePayload } from "./runner.mjs";
import { TOOLS } from "./schemas.mjs";
import { InvalidParams, PolicyError } from "./errors.mjs";

function getVisibleTools() {
  const policy = getBridgePolicy();
  if (!policy.hideRestrictedTools) return TOOLS;
  return TOOLS.filter(tool => evaluateDelegationPolicy(tool.name, {}, policy).allowed);
}

async function handleToolCall(name, args = {}, requestSignal) {
  const tool = TOOLS.find(tool => tool.name === name);
  if (!tool) throw new InvalidParams("Unknown tool: " + name);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new InvalidParams("Tool arguments must be an object.");
  const policyEval = evaluateDelegationPolicy(name, args);
  if (!policyEval.allowed) throw new PolicyError(policyEval.reason);
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    if (args[key] === undefined) continue;
    const valid = schema.type === "array" ? Array.isArray(args[key])
      : schema.type === "number" ? (typeof args[key] === "number" && Number.isFinite(args[key]))
      : typeof args[key] === schema.type;
    if (!valid) throw new InvalidParams(key + " must have type " + schema.type + ".");
  }
  switch (name) {
    case "claude_run":
    case "claude_resume":
    case "claude_fork":
    case "claude_review": {
      const { donePromise } = createRunner(name.slice("claude_".length), args, policyEval, requestSignal);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    case "claude_spawn": {
      const mode = args.mode ?? "run";
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
                capabilities: state.capabilities,
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
      if (args.job_id !== undefined) {
        const job = jobs.get(String(args.job_id));
        if (!job) throw new InvalidParams("Unknown job_id: " + (args.job_id ?? ""));
        const includeFull = job.status !== "running";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatStatePayload(job, includeFull), null, 2),
            },
          ],
          isError: ["failed", "cancelled", "timed_out", "termination_unconfirmed"].includes(job.status),
        };
      }

      const list = Array.from(jobs.values()).map((j) => formatStatePayload(j, false));
      return {
        content: [{ type: "text", text: JSON.stringify({ jobs: list }, null, 2) }],
      };
    }

    case "claude_job_cancel": {
      const job = jobs.get(String(args.job_id || ""));
      if (!job) throw new InvalidParams("Unknown job_id: " + (args.job_id ?? ""));
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
      const status = {
        bridge: policyEval.policy,
        workspace: describeWorkspacePolicy(loadWorkspacePolicy()),
        active_jobs: activeChildren.size,
      };
      let discovered;
      try { discovered = discoverClaudeBinary(); }
      catch (error) {
        const payload = { binary: null, binary_error: error.message, version: null, auth: null, ...status };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
      }
      const versionInv = resolveClaudeInvocation(["--version"], discovered);
      const authInv = resolveClaudeInvocation(["auth", "status"], discovered);
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
        binary: discovered.path,
        source: discovered.source,
        version: verRes.ok ? verRes.stdout : null,
        version_error: verRes.ok ? undefined : verRes.stderr || `exit ${verRes.code}`,
        auth: authParsed,
        auth_error: authRes.ok ? undefined : authRes.stderr || `exit ${authRes.code}`,
        ...status,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !verRes.ok || !authRes.ok,
      };
    }
  }
}

export { getVisibleTools, handleToolCall };
