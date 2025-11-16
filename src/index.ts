#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  TestMockMCPServer,
  type TestMockMCPServerOptions,
} from "./server/test-mock-mcp-server.js";
import {
  BatchMockCollector,
  type BatchMockCollectorOptions,
  type RequestMockOptions,
} from "./client/batch-mock-collector.js";
import { connect, type ConnectOptions } from "./client/connect.js";

const DEFAULT_PORT = 3002;

console.error('mock-mcp running');

async function runCli() {
  const cliArgs = process.argv.slice(2);
  let port = Number.parseInt(process.env.MCP_SERVER_PORT ?? "", 10);
  let enableMcpTransport = true;

  if (Number.isNaN(port)) {
    port = DEFAULT_PORT;
  }

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if ((arg === "--port" || arg === "-p") && cliArgs[i + 1]) {
      port = Number.parseInt(cliArgs[i + 1] as string, 10);
      i += 1;
    } else if (arg === "--no-stdio") {
      enableMcpTransport = false;
    }
  }

  const server = new TestMockMCPServer({
    port,
    enableMcpTransport,
  });

  await server.start();

  console.error(
    `🎯 Test Mock MCP server ready on ws://localhost:${server.port ?? port}`,
  );

  const shutdown = async () => {
    console.error("👋 Shutting down Test Mock MCP server...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isCliExecution = (() => {
  if (typeof process === "undefined" || !process.argv?.[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]!).href;
})();

if (isCliExecution) {
  runCli().catch((error) => {
    console.error("Failed to start Test Mock MCP server:", error);
    process.exitCode = 1;
  });
}

export { TestMockMCPServer };
export type { TestMockMCPServerOptions };

export { BatchMockCollector };
export type { BatchMockCollectorOptions, RequestMockOptions };

export { connect };
export type { ConnectOptions };
