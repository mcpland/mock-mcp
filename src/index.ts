/**
 * mock-mcp CLI entry point.
 *
 * Commands:
 * - `mock-mcp adapter` (default): Start the MCP adapter for AI clients
 * - `mock-mcp daemon`: Start the daemon process (usually auto-started)
 * - `mock-mcp status`: Show daemon status
 * - `mock-mcp stop`: Stop the daemon
 *
 * The new architecture uses a Daemon + Adapter pattern:
 * - Daemon: Single process per project, manages all test runs and batches
 * - Adapter: One per MCP client, forwards tool calls to daemon
 */

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import process from "node:process";
import http from "node:http";
import fs from "node:fs/promises";

// =============================================================================
// CLI Implementation
// =============================================================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "adapter";

  switch (command) {
    case "adapter":
      await runAdapterCommand(args.slice(1));
      break;

    case "daemon":
      await runDaemonCommand(args.slice(1));
      break;

    case "status":
      await runStatusCommand(args.slice(1));
      break;

    case "stop":
      await runStopCommand(args.slice(1));
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    case "version":
    case "--version":
    case "-v":
      await printVersion();
      break;

    default:
      // Default to adapter command
      await runAdapterCommand(args);
  }
}

// =============================================================================
// Command: adapter
// =============================================================================

async function runAdapterCommand(_args: string[]): Promise<void> {
  const { runAdapter } = await import("./adapter/adapter.js");
  await runAdapter();
}

// =============================================================================
// Command: daemon
// =============================================================================

async function runDaemonCommand(args: string[]): Promise<void> {
  const { MockMcpDaemon } = await import("./daemon/daemon.js");
  const { resolveProjectRoot } = await import("./shared/discovery.js");

  // Parse arguments
  let projectRoot: string | undefined;
  let token: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project-root" && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    } else if (arg === "--token" && args[i + 1]) {
      token = args[i + 1];
      i++;
    }
  }

  projectRoot = projectRoot ?? resolveProjectRoot();
  const cacheDir = process.env.MOCK_MCP_CACHE_DIR || undefined;

  if (!token) {
    console.error("Error: --token is required for daemon mode");
    process.exitCode = 1;
    return;
  }

  // Get version from package.json
  const version = await getVersion();

  const daemon = new MockMcpDaemon({
    projectRoot,
    token,
    version,
    cacheDir,
  });

  await daemon.start();

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    console.error(`\n${signal} received, shutting down...`);
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// =============================================================================
// Command: status
// =============================================================================

async function runStatusCommand(_args: string[]): Promise<void> {
  const {
    resolveProjectRoot,
    computeProjectId,
    getPaths,
    readRegistry,
  } = await import("./shared/discovery.js");

  const projectRoot = resolveProjectRoot();
  const projectId = computeProjectId(projectRoot);
  const { registryPath, ipcPath } = getPaths(projectId);

  console.log(`Project Root: ${projectRoot}`);
  console.log(`Project ID: ${projectId}`);
  console.log(`IPC Path: ${ipcPath}`);
  console.log("");

  // Read registry
  const registry = await readRegistry(registryPath);
  if (!registry) {
    console.log("❌ Daemon is not running (no registry found)");
    return;
  }

  console.log(`Registry PID: ${registry.pid}`);
  console.log(`Started At: ${registry.startedAt}`);
  console.log("");

  // Health check
  try {
    const status = await getDaemonStatus(ipcPath, registry.token);
    console.log("✅ Daemon is running\n");
    console.log(`Version: ${status.version}`);
    console.log(`Uptime: ${Math.round(status.uptime / 1000)}s`);
    console.log(`Active Runs: ${status.runs}`);
    console.log(`Pending Batches: ${status.pending}`);
    console.log(`Claimed Batches: ${status.claimed}`);
  } catch (error) {
    console.log("❌ Daemon is not responding");
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getDaemonStatus(
  ipcPath: string,
  token: string
): Promise<{
  version: string;
  uptime: number;
  runs: number;
  pending: number;
  claimed: number;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "status",
      method: "getStatus",
      params: {},
    });

    const req = http.request(
      {
        method: "POST",
        socketPath: ipcPath,
        path: "/control",
        headers: {
          "content-type": "application/json",
          "x-mock-mcp-token": token,
        },
        timeout: 5000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const result = JSON.parse(buf);
            if (result.error) {
              reject(new Error(result.error.message));
            } else {
              resolve(result.result);
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end(payload);
  });
}

// =============================================================================
// Command: stop
// =============================================================================

async function runStopCommand(_args: string[]): Promise<void> {
  const {
    resolveProjectRoot,
    computeProjectId,
    getPaths,
    readRegistry,
  } = await import("./shared/discovery.js");

  const projectRoot = resolveProjectRoot();
  const projectId = computeProjectId(projectRoot);
  const { registryPath, ipcPath } = getPaths(projectId);

  const registry = await readRegistry(registryPath);
  if (!registry) {
    console.log("Daemon is not running.");
    return;
  }

  // Try to send SIGTERM to the daemon
  try {
    process.kill(registry.pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID: ${registry.pid})`);

    // Wait a bit and check if it's gone
    await new Promise((r) => setTimeout(r, 1000));

    try {
      process.kill(registry.pid, 0);
      console.log("Daemon is still running, sending SIGKILL...");
      process.kill(registry.pid, "SIGKILL");
    } catch {
      // Process is gone, which is what we want
    }
  } catch (error) {
    console.log(`Daemon process (PID: ${registry.pid}) is not running.`);
  }

  // Clean up registry and socket
  try {
    await fs.rm(registryPath);
    console.log("Registry cleaned up.");
  } catch {
    // Ignore
  }

  if (process.platform !== "win32") {
    try {
      await fs.rm(ipcPath);
      console.log("Socket cleaned up.");
    } catch {
      // Ignore
    }
  }

  console.log("Done.");
}

// =============================================================================
// Help
// =============================================================================

function printHelp(): void {
  console.log(`
mock-mcp - AI-assisted mock generation for integration tests

USAGE:
  mock-mcp [command] [options]

COMMANDS:
  adapter     Start the MCP adapter (default)
              This is what you configure in your MCP client.

  daemon      Start the daemon process
              Usually auto-started by adapter/test code.

  status      Show daemon status for current project

  stop        Stop the daemon for current project

  help        Show this help message

  version     Show version

EXAMPLES:
  # In your MCP client configuration (Cursor, Claude Desktop, etc.):
  {
    "mcpServers": {
      "mock-mcp": {
        "command": "npx",
        "args": ["-y", "mock-mcp", "adapter"]
      }
    }
  }

  # Check daemon status:
  mock-mcp status

  # Stop daemon:
  mock-mcp stop

ENVIRONMENT:
  MOCK_MCP=1              Enable mock generation in test code
  MOCK_MCP_CACHE_DIR      Override cache directory for daemon files

For more information, visit: https://github.com/mcpland/mock-mcp
`);
}

async function printVersion(): Promise<void> {
  const version = await getVersion();
  console.log(`mock-mcp v${version}`);
}

async function getVersion(): Promise<string> {
  return "0.5.0";
}

// =============================================================================
// Entry Point Detection
// =============================================================================

const isCliExecution = (() => {
  if (typeof process === "undefined" || !process.argv?.[1]) {
    return false;
  }

  // Resolve symlinks for proper comparison
  const scriptPath = realpathSync(process.argv[1]!);
  return import.meta.url === pathToFileURL(scriptPath).href;
})();

if (isCliExecution) {
  runCli().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

// =============================================================================
// Exports
// =============================================================================

// Server exports (for programmatic use)
export { MockMcpDaemon, type MockMcpDaemonOptions } from "./daemon/daemon.js";
export { runAdapter, type AdapterOptions, DaemonClient } from "./adapter/index.js";

// Client exports
export {
  BatchMockCollector,
  type BatchMockCollectorOptions,
  type RequestMockOptions,
} from "./client/batch-mock-collector.js";
export { connect, type ConnectOptions, type MockClient } from "./client/connect.js";

// Shared exports
export {
  ensureDaemonRunning,
  resolveProjectRoot,
  computeProjectId,
  type DaemonRegistry,
} from "./shared/discovery.js";

// Type exports
export type { ResolvedMock, MockRequestDescriptor, MockResponseDescriptor } from "./types.js";
