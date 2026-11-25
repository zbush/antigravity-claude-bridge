import fs from "node:fs";
import readline from "node:readline";
import { getVisibleTools, handleToolCall } from "./tools.mjs";
import { shutdown } from "./process.mjs";
import { InvalidParams } from "./errors.mjs";

const SERVER_NAME = "claude-local";
const SERVER_VERSION = "1.2.0";
const iconFile = new URL("../../assets/icon-64.png", import.meta.url);
const icons = fs.existsSync(iconFile) ? [{
  src: "data:image/png;base64," + fs.readFileSync(iconFile, "base64"),
  mimeType: "image/png", sizes: ["64x64"],
}] : [];
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const requestControllers = new Map();

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function sendJsonRpc(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendJsonRpc({ jsonrpc: "2.0", id, error });
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      const requestedVersion =
        params && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, icons },
      });
      return;
    }

    if (method === "notifications/cancelled") {
      requestControllers.get(params?.requestId)?.abort();
      return;
    }
    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      if (!isNotification) sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: getVisibleTools() });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments === undefined ? {} : params.arguments;
      if (!isNotification && requestControllers.has(id)) {
        sendError(id, -32600, "Duplicate in-flight request ID.");
        return;
      }
      const controller = new AbortController();
      if (!isNotification) requestControllers.set(id, controller);
      try {
        const result = await handleToolCall(toolName, toolArgs, controller.signal);
        if (!isNotification) sendResult(id, result);
      } catch (error) {
        if (error instanceof InvalidParams) throw error;
        if (!isNotification) sendResult(id, { content: [{ type: "text", text: error.message }], isError: true });
      } finally {
        if (!isNotification) requestControllers.delete(id);
      }
      return;
    }

    if (!isNotification) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) {
      sendError(id, err instanceof InvalidParams ? -32602 : -32603, err.message, err.data);
    } else {
      log(`Notification error (${method}): ${err}`);
    }
  }
}

export function startServer() {
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let inFlightRequests = 0;
  let stdinClosed = false;

  function maybeExitOnStdinClose() {
    if (stdinClosed && inFlightRequests === 0) {
      shutdown();
      process.exit(0);
    }
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }
    inFlightRequests += 1;
    Promise.resolve(handleRequest(parsed)).finally(() => {
      inFlightRequests -= 1;
      maybeExitOnStdinClose();
    });
  });

  rl.on("close", () => {
    stdinClosed = true;
    maybeExitOnStdinClose();
  });
}
