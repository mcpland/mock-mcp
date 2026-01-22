/**
 * Shared test utilities for daemon and integration tests.
 *
 * Provides:
 * - Test daemon creation and cleanup
 * - Test client (WebSocket) creation
 * - DaemonClient factory
 * - Common utilities
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import WebSocket from "ws";
import { MockMcpDaemon } from "../../src/daemon/daemon.js";
import { DaemonClient } from "../../src/adapter/daemon-client.js";
import {
  computeProjectId,
  getPaths,
  type DaemonRegistry,
} from "../../src/shared/discovery.js";
import {
  HELLO_TEST,
  HELLO_ACK,
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESULT,
  type HelloTestMessage,
  type BatchMockRequestMessage,
  type BatchMockResultMessage,
} from "../../src/shared/protocol.js";
import type { MockRequestDescriptor } from "../../src/types.js";

// =============================================================================
// Types
// =============================================================================

export interface TestContext {
  daemon: MockMcpDaemon;
  registry: DaemonRegistry;
  cacheDir: string;
  projectRoot: string;
  projectId: string;
}

export interface TestClient {
  ws: WebSocket;
  runId: string;
  sendBatch: (requests: MockRequestDescriptor[]) => void;
  waitForResult: (timeoutMs?: number) => Promise<BatchMockResultMessage>;
  close: () => void;
}

export interface CreateTestDaemonOptions {
  defaultLeaseMs?: number;
  sweepIntervalMs?: number;
  idleShutdownMs?: number;
}

// =============================================================================
// Test Daemon Management
// =============================================================================

/**
 * Create an isolated test daemon with its own cache directory.
 */
export async function createTestDaemon(
  options: CreateTestDaemonOptions = {}
): Promise<TestContext> {
  // Use a unique temp directory for each test
  const cacheDir = path.join(os.tmpdir(), `mock-mcp-test-${crypto.randomUUID()}`);
  await fs.mkdir(cacheDir, { recursive: true });

  const projectRoot = process.cwd();
  const projectId = computeProjectId(projectRoot);
  const token = crypto.randomBytes(16).toString("hex");

  const daemon = new MockMcpDaemon({
    projectRoot,
    token,
    version: "test",
    cacheDir,
    defaultLeaseMs: options.defaultLeaseMs ?? 100, // Short lease for testing
    sweepIntervalMs: options.sweepIntervalMs ?? 50,
    idleShutdownMs: options.idleShutdownMs ?? 60000, // Don't auto-shutdown during tests
  });

  await daemon.start();

  const { ipcPath } = getPaths(projectId, cacheDir);
  const registry: DaemonRegistry = {
    projectId,
    projectRoot,
    ipcPath,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: "test",
  };

  return { daemon, registry, cacheDir, projectRoot, projectId };
}

/**
 * Clean up a test daemon and its cache directory.
 */
export async function cleanupTestDaemon(ctx: TestContext): Promise<void> {
  await ctx.daemon.stop();
  await fs.rm(ctx.cacheDir, { recursive: true, force: true });
}

// =============================================================================
// Test Client (WebSocket)
// =============================================================================

/**
 * Create a test client that connects to the daemon via WebSocket.
 */
export function createTestClient(
  ipcPath: string,
  token: string,
  runId: string = crypto.randomUUID()
): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost/test", {
      createConnection: (
        _options: unknown,
        oncreate: (err: Error | null, socket: Duplex) => void
      ) => {
        const socket = net.connect(ipcPath);
        socket.once("connect", () => oncreate(null, socket));
        socket.once("error", (err) => oncreate(err, socket));
        return socket;
      },
    });

    const resultQueue: BatchMockResultMessage[] = [];
    let resultResolver: ((msg: BatchMockResultMessage) => void) | null = null;

    ws.once("open", () => {
      const hello: HelloTestMessage = {
        type: HELLO_TEST,
        token,
        runId,
        pid: process.pid,
        cwd: process.cwd(),
      };
      ws.send(JSON.stringify(hello));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === HELLO_ACK) {
        resolve({
          ws,
          runId,
          sendBatch: (requests) => {
            const batch: BatchMockRequestMessage = {
              type: BATCH_MOCK_REQUEST,
              runId,
              requests,
            };
            ws.send(JSON.stringify(batch));
          },
          waitForResult: (timeoutMs = 5000) => {
            if (resultQueue.length > 0) {
              return Promise.resolve(resultQueue.shift()!);
            }
            return new Promise((res, rej) => {
              const timeout = setTimeout(() => {
                rej(new Error(`waitForResult timed out after ${timeoutMs}ms`));
              }, timeoutMs);

              resultResolver = (msg) => {
                clearTimeout(timeout);
                res(msg);
              };
            });
          },
          close: () => ws.close(),
        });
      } else if (msg.type === BATCH_MOCK_RESULT) {
        if (resultResolver) {
          resultResolver(msg);
          resultResolver = null;
        } else {
          resultQueue.push(msg);
        }
      }
    });

    ws.once("error", reject);
  });
}

// =============================================================================
// Daemon Client Factory
// =============================================================================

/**
 * Create a DaemonClient for adapter simulation.
 */
export function createDaemonClient(registry: DaemonRegistry): DaemonClient {
  return new DaemonClient(registry.ipcPath, registry.token, crypto.randomUUID());
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Sleep for specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for a condition to be truthy, polling at intervals.
 */
export async function waitFor<T>(
  condition: () => T | undefined | null,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = condition();
    if (result !== undefined && result !== null) {
      return result;
    }
    await sleep(intervalMs);
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
