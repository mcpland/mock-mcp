import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { connect } from "../src/client/connect.js";
import {
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESPONSE,
  type BatchMockRequestMessage,
  type BatchMockResponseMessage,
} from "../src/types.js";
import { TestMockMCPServer } from "../src/server/test-mock-mcp-server.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFileContents(
  filePath: string,
  timeoutMs = 500,
  intervalMs = 10,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await wait(intervalMs);
    }
  }

  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitFor<T>(
  factory: () => T | undefined,
  timeoutMs = 500,
  intervalMs = 10,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = factory();
    if (result !== undefined) {
      return result;
    }
    await wait(intervalMs);
  }

  throw new Error("Timed out waiting for condition");
}

async function closeServer(server: WebSocketServer) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("BatchMockCollector", () => {
  let wss: WebSocketServer | undefined;

  afterEach(async () => {
    if (wss) {
      await closeServer(wss);
      wss = undefined;
    }
  });

  it("batches requests issued during the same macrotask", async () => {
    wss = new WebSocketServer({ port: 0 });
    const address = wss.address() as AddressInfo;
    const wsUrl = `ws://127.0.0.1:${address.port}`;
    const received: BatchMockRequestMessage[] = [];

    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()) as BatchMockRequestMessage);
      });
    });

    const collector = await connect({
      wsUrl,
      timeoutMs: 1_000,
      batchDebounceMs: 0,
    });

    const mockPromise = Promise.all([
      collector.requestMock("/api/users", "GET"),
      collector.requestMock("/api/orders", "GET"),
    ]);

    const message = await waitFor(
      () => received.length > 0 ? received[0] : undefined,
    );

    // Echo mock data back to the collector so the promises resolve.
    wss.clients.forEach((socket) => {
      const response: BatchMockResponseMessage = {
        type: BATCH_MOCK_RESPONSE,
        batchId: "batch-test",
        mocks: message.requests.map((request) => ({
          requestId: request.requestId,
          data: { endpoint: request.endpoint },
        })),
      };
      socket.send(JSON.stringify(response));
    });

    const [users, orders] = await mockPromise;
    expect(message.requests).toHaveLength(2);
    expect(users).toEqual({ endpoint: "/api/users" });
    expect(orders).toEqual({ endpoint: "/api/orders" });

    await collector.close();
  });
});

describe("TestMockMCPServer", () => {
  it("tracks pending batches and forwards mock data", async () => {
    const server = new TestMockMCPServer({
      port: 0,
      enableMcpTransport: false,
    });

    await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const payload: BatchMockRequestMessage = {
      type: BATCH_MOCK_REQUEST,
      requests: [
        { requestId: "req-1", endpoint: "/api/users", method: "GET" },
        { requestId: "req-2", endpoint: "/api/orders", method: "GET" },
      ],
    };

    ws.send(JSON.stringify(payload));

    const batch = await waitFor(
      () => (server.getPendingBatches()[0] ? server.getPendingBatches()[0] : undefined),
    );

    const responses: BatchMockResponseMessage[] = [];
    ws.on("message", (data) => {
      responses.push(JSON.parse(data.toString()) as BatchMockResponseMessage);
    });

    await server.provideMockData({
      batchId: batch.batchId,
      mocks: batch.requests.map((request, index) => ({
        requestId: request.requestId,
        data: { index },
      })),
    });

    const response = await waitFor(
      () => (responses.length > 0 ? responses[0] : undefined),
    );

    expect(response.batchId).toBe(batch.batchId);
    expect(response.mocks).toHaveLength(2);
    expect(server.getPendingBatches()).toHaveLength(0);

    ws.close();
    await server.stop();
  });

  it("optionally logs mock batches to disk when enabled", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "mock-mcp-"));
    const server = new TestMockMCPServer({
      port: 0,
      enableMcpTransport: false,
      mockLogOptions: {
        enabled: true,
        directory: tempDir,
      },
    });

    await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const payload: BatchMockRequestMessage = {
      type: BATCH_MOCK_REQUEST,
      requests: [
        {
          requestId: "req-1",
          endpoint: "/api/users",
          method: "GET",
          metadata: {
            testCaseId: "example-case",
            testFile: "tests/example.test.ts",
          },
        },
      ],
    };

    ws.send(JSON.stringify(payload));

    const batch = await waitFor(
      () => (server.getPendingBatches()[0] ? server.getPendingBatches()[0] : undefined),
    );

    await server.provideMockData({
      batchId: batch.batchId,
      mocks: [
        {
          requestId: "req-1",
          data: { value: 42 },
        },
      ],
    });

    const filePath = path.join(tempDir, `mock-${batch.batchId}.json`);
    const loggedContent = await waitForFileContents(filePath);
    const logged = JSON.parse(loggedContent) as {
      batchId: string;
      context?: Record<string, unknown>;
      requests: Array<{
        requestId: string;
        metadata?: Record<string, unknown>;
        mock?: { data: unknown };
      }>;
    };

    expect(logged.batchId).toBe(batch.batchId);
    expect(logged.requests).toHaveLength(1);
    expect(logged.requests[0]?.mock?.data).toEqual({ value: 42 });
    expect(logged.requests[0]?.metadata?.testFile).toBe("tests/example.test.ts");
    expect(logged.context?.testCaseId).toBe("example-case");

    ws.close();
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });
});
