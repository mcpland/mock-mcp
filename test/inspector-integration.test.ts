/**
 * Integration tests using @modelcontextprotocol/inspector CLI mode.
 *
 * These tests run the MCP adapter through the official inspector CLI,
 * which provides true end-to-end testing of the MCP protocol.
 *
 * Usage:
 *   yarn test test/inspector-integration.test.ts
 *
 * Prerequisites:
 *   - yarn build (to create dist/index.js)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import WebSocket from "ws";
import type { Duplex } from "node:stream";
import {
  computeProjectId,
  getPaths,
} from "../src/shared/discovery.js";
import {
  HELLO_TEST,
  HELLO_ACK,
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESULT,
  type HelloTestMessage,
  type BatchMockRequestMessage,
  type BatchMockResultMessage,
} from "../src/shared/protocol.js";
import type { MockRequestDescriptor } from "../src/types.js";

// =============================================================================
// Constants
// =============================================================================

const DIST_PATH = path.resolve(process.cwd(), "dist", "index.js");
const INSPECTOR_TIMEOUT = 30000; // 30 seconds for inspector commands

// Unique cache directory for this test file to avoid conflicts with other tests
let inspectorCacheDir: string;

// =============================================================================
// Types
// =============================================================================

interface InspectorResult {
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  content?: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

interface TestClient {
  ws: WebSocket;
  runId: string;
  sendBatch: (requests: MockRequestDescriptor[]) => void;
  waitForResult: (timeoutMs?: number) => Promise<BatchMockResultMessage>;
  close: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Run the MCP inspector CLI and return the parsed JSON result.
 * Uses spawnSync to avoid shell escaping issues with JSON arguments.
 */
function runInspector(args: string[]): InspectorResult {
  const { spawnSync } = require("node:child_process");

  // Build the full argument list
  const fullArgs = [
    "-y", "@modelcontextprotocol/inspector",
    "--cli",
    "node", DIST_PATH,
    ...args,
  ];

  const result = spawnSync("npx", fullArgs, {
    encoding: "utf-8",
    timeout: INSPECTOR_TIMEOUT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      // Use isolated cache directory to avoid conflicts with other tests
      MOCK_MCP_CACHE_DIR: inspectorCacheDir,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || "";
    const stdout = result.stdout?.toString() || "";
    throw new Error(`Inspector failed (exit ${result.status}): ${stderr || stdout}`);
  }

  const output = result.stdout?.toString()?.trim() || "";
  return JSON.parse(output);
}

/**
 * Run inspector with tool call.
 */
function callTool(toolName: string, args: Record<string, unknown> = {}): InspectorResult {
  const cmdArgs = ["--method", "tools/call", "--tool-name", toolName];

  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) {
      cmdArgs.push("--tool-arg", `${key}=${JSON.stringify(value)}`);
    }
  }

  return runInspector(cmdArgs);
}

/**
 * Get the text content from an inspector result.
 */
function getTextContent(result: InspectorResult): string {
  if (result.content && result.content.length > 0) {
    return result.content[0]!.text;
  }
  return "";
}

/**
 * Create a test client that connects to the daemon via WebSocket.
 */
function createTestClient(
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
          waitForResult: (timeoutMs = 10000) => {
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

/**
 * Read the daemon registry file.
 */
async function readRegistry(registryPath: string): Promise<{ token: string; ipcPath: string } | null> {
  try {
    const txt = await fs.readFile(registryPath, "utf-8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Wait for condition with timeout.
 */
async function waitFor<T>(
  condition: () => Promise<T | null | undefined> | T | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 100 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await condition();
    if (result !== null && result !== undefined) {
      return result;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// =============================================================================
// File-level Setup/Teardown
// =============================================================================

// Create isolated cache directory before all tests in this file
beforeAll(async () => {
  inspectorCacheDir = path.join(os.tmpdir(), `mock-mcp-inspector-test-${crypto.randomUUID()}`);
  await fs.mkdir(inspectorCacheDir, { recursive: true });
});

// Clean up cache directory after all tests
afterAll(async () => {
  if (inspectorCacheDir) {
    // Stop any running daemon first
    try {
      const projectId = computeProjectId(process.cwd());
      const { ipcPath } = getPaths(projectId, inspectorCacheDir);
      // Give daemon time to shut down gracefully
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // Ignore cleanup errors
    }
    await fs.rm(inspectorCacheDir, { recursive: true, force: true }).catch(() => {});
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("Inspector CLI Integration Tests", () => {
  beforeAll(async () => {
    // Ensure build is up to date
    try {
      await fs.access(DIST_PATH);
    } catch {
      throw new Error(
        `dist/index.js not found. Run 'yarn build' before running tests.`
      );
    }
  });

  describe("tools/list", () => {
    it("should list all available tools", () => {
      const result = runInspector(["--method", "tools/list"]);

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);

      const toolNames = result.tools!.map((t) => t.name);
      expect(toolNames).toContain("get_status");
      expect(toolNames).toContain("list_runs");
      expect(toolNames).toContain("claim_next_batch");
      expect(toolNames).toContain("get_batch");
      expect(toolNames).toContain("provide_batch_mock_data");
      expect(toolNames).toContain("release_batch");
    });

    it("should have proper schema for each tool", () => {
      const result = runInspector(["--method", "tools/list"]);

      for (const tool of result.tools!) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  describe("get_status tool", () => {
    it("should return daemon status", () => {
      const result = callTool("get_status");

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();

      const text = getTextContent(result);
      expect(text).toContain("Mock MCP Daemon Status");
      expect(text).toContain("Version");
      expect(text).toContain("Project ID");
      expect(text).toContain("Pending");
      expect(text).toContain("Claimed");
    });
  });

  describe("list_runs tool", () => {
    it("should return empty list when no runs are connected", () => {
      const result = callTool("list_runs");

      expect(result.isError).toBe(false);
      const text = getTextContent(result);
      expect(text).toContain("No active test runs");
    });
  });

  describe("claim_next_batch tool", () => {
    it("should return no batches when queue is empty", () => {
      const result = callTool("claim_next_batch");

      expect(result.isError).toBe(false);
      const text = getTextContent(result);
      expect(text).toContain("No pending batches available");
    });
  });

  describe("get_batch tool", () => {
    it("should return error for non-existent batch", () => {
      const result = callTool("get_batch", { batchId: "non-existent-batch-id" });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Error");
    }, 15000);
  });
});

/**
 * E2E Flow Tests using DaemonClient for persistent adapter connection.
 *
 * NOTE: The MCP Inspector CLI creates a new adapter instance for each invocation,
 * which means each call has a different adapterId. For E2E flows that require
 * the same adapter to claim and provide (like provide_batch_mock_data),
 * we need to use the DaemonClient directly.
 *
 * The Inspector CLI tests above verify that each individual tool works correctly
 * when invoked via the MCP protocol. These E2E tests verify the full flow
 * works with a persistent adapter connection.
 */
describe("Inspector CLI E2E Flow Tests (with DaemonClient)", () => {
  let testClient: TestClient | null = null;
  let projectId: string;
  let registryPath: string;
  let ipcPath: string;

  beforeAll(async () => {
    // Get project paths using the isolated cache directory
    const projectRoot = process.cwd();
    projectId = computeProjectId(projectRoot);
    const paths = getPaths(projectId, inspectorCacheDir);
    registryPath = paths.registryPath;
    ipcPath = paths.ipcPath;
  });

  afterEach(async () => {
    // Clean up test client if created
    if (testClient) {
      testClient.close();
      testClient = null;
      // Wait for cleanup
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  it("should verify claim returns expected format via inspector", async () => {
    // Step 1: Start by getting status to ensure daemon is running
    const statusResult = callTool("get_status");
    expect(statusResult.isError).toBe(false);

    // Step 2: Read daemon registry to get connection info
    const registry = await waitFor(
      () => readRegistry(registryPath),
      { timeoutMs: 5000 }
    );
    expect(registry).not.toBeNull();

    // Step 3: Connect a test client
    testClient = await createTestClient(registry!.ipcPath, registry!.token);

    // Step 4: Verify test run appears in list_runs
    await waitFor(async () => {
      const runsResult = callTool("list_runs");
      const text = getTextContent(runsResult);
      if (text.includes(testClient!.runId)) {
        return true;
      }
      return null;
    }, { timeoutMs: 5000 });

    // Step 5: Send a batch request from test client
    const requests: MockRequestDescriptor[] = [
      {
        requestId: "test-req-1",
        endpoint: "/api/users/1",
        method: "GET",
      },
      {
        requestId: "test-req-2",
        endpoint: "/api/posts",
        method: "POST",
        body: { title: "Test", content: "Hello" },
      },
    ];
    testClient.sendBatch(requests);

    // Step 6: Claim the batch via inspector
    const claimResult = await waitFor(() => {
      const result = callTool("claim_next_batch");
      const text = getTextContent(result);
      if (text.includes("Batch Claimed Successfully")) {
        return result;
      }
      return null;
    }, { timeoutMs: 5000 });

    const claimText = getTextContent(claimResult);

    // Extract batchId and claimToken from response
    const batchIdMatch = claimText.match(/\*\*Batch ID\*\*: `([^`]+)`/);
    const claimTokenMatch = claimText.match(/\*\*Claim Token\*\*: `([^`]+)`/);

    expect(batchIdMatch).not.toBeNull();
    expect(claimTokenMatch).not.toBeNull();

    // Verify request details in claim result
    expect(claimText).toContain("GET /api/users/1");
    expect(claimText).toContain("POST /api/posts");
    expect(claimText).toContain("test-req-1");
    expect(claimText).toContain("test-req-2");
    expect(claimText).toContain("Batch ID");
    expect(claimText).toContain("Claim Token");
    expect(claimText).toContain("Lease Until");
    expect(claimText).toContain("Next step");
  }, 30000);

  it("should verify list_runs shows test client when connected", async () => {
    // Get status to ensure daemon is running
    const statusResult = callTool("get_status");
    expect(statusResult.isError).toBe(false);

    // Read daemon registry
    const registry = await waitFor(
      () => readRegistry(registryPath),
      { timeoutMs: 5000 }
    );
    expect(registry).not.toBeNull();

    // Connect a test client
    testClient = await createTestClient(registry!.ipcPath, registry!.token);

    // Verify test run appears in list_runs
    const runsResult = await waitFor(async () => {
      const result = callTool("list_runs");
      const text = getTextContent(result);
      if (text.includes(testClient!.runId)) {
        return result;
      }
      return null;
    }, { timeoutMs: 5000 });

    const runsText = getTextContent(runsResult);
    expect(runsText).toContain("Active Test Runs");
    expect(runsText).toContain(testClient.runId);
    expect(runsText).toContain("PID");
    expect(runsText).toContain("Started");
  }, 30000);

  it("should verify claim_next_batch returns null when no batches pending", async () => {
    // Get status to ensure daemon is running
    const statusResult = callTool("get_status");
    expect(statusResult.isError).toBe(false);

    // Read daemon registry
    const registry = await waitFor(
      () => readRegistry(registryPath),
      { timeoutMs: 5000 }
    );
    expect(registry).not.toBeNull();

    // Connect a test client but don't send any batches
    testClient = await createTestClient(registry!.ipcPath, registry!.token);

    // Wait a bit for the client to be registered
    await new Promise((r) => setTimeout(r, 200));

    // Claim should return no batches
    const claimResult = callTool("claim_next_batch");
    expect(claimResult.isError).toBe(false);
    const text = getTextContent(claimResult);
    expect(text).toContain("No pending batches available");
  }, 30000);
});

describe("Inspector CLI Error Handling Tests", () => {
  it("should handle missing required arguments gracefully", () => {
    // Call provide_batch_mock_data without required args
    const result = callTool("provide_batch_mock_data");

    expect(result.isError).toBe(true);
    const text = getTextContent(result);
    expect(text).toContain("Error");
    expect(text).toMatch(/required/i);
  });

  it("should handle invalid batch ID", () => {
    const result = callTool("get_batch", { batchId: "invalid-batch-id-12345" });

    expect(result.isError).toBe(true);
    const text = getTextContent(result);
    expect(text).toContain("Error");
  }, 15000);

  it("should handle invalid claim token", async () => {
    // This test needs a valid batch to claim first
    // We'll test with a clearly invalid token format
    const args = [
      "--method", "tools/call",
      "--tool-name", "provide_batch_mock_data",
      "--tool-arg", "batchId=fake-batch",
      "--tool-arg", "claimToken=fake-token",
      "--tool-arg", `mocks=${JSON.stringify([{ requestId: "r1", data: {} }])}`,
    ];
    const result = runInspector(args);

    expect(result.isError).toBe(true);
    const text = getTextContent(result);
    expect(text).toContain("Error");
  });
});
