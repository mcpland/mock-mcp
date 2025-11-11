import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { type AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import packageJson from "../../package.json" assert { type: "json" };
import {
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESPONSE,
  type BatchMockRequestMessage,
  type BatchMockResponseMessage,
  type MockRequestDescriptor,
  type MockResponseDescriptor,
  type PendingBatchSummary,
  type ProvideBatchMockDataArgs,
  type ToolResponseText,
} from "../types.js";

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

interface BatchRecord extends PendingBatchSummary {
  ws: WebSocket;
  expiresAt?: number;
}

export interface TestMockMCPServerOptions {
  port?: number;
  logger?: Logger;
  batchTtlMs?: number;
  sweepIntervalMs?: number;
  enableMcpTransport?: boolean;
  transportFactory?: () => Transport;
  serverName?: string;
  serverVersion?: string;
  mockLogOptions?: MockLogOptions;
}

export interface MockLogOptions {
  enabled?: boolean;
  directory?: string;
}

const DEFAULT_PORT = 3002;
const DEFAULT_BATCH_TTL_MS = 5 * 60 * 1000;

/**
 * Bridges the integration-test process and the MCP client, making it possible
 * to generate realistic mock data on demand.
 */
export class TestMockMCPServer {
  private readonly logger: Logger;
  private readonly options: Required<
    Pick<TestMockMCPServerOptions, "batchTtlMs" | "enableMcpTransport">
  > &
    Omit<TestMockMCPServerOptions, "batchTtlMs" | "enableMcpTransport">;

  private wss?: WebSocketServer;
  private cleanupTimer?: NodeJS.Timeout;
  private mcpServer?: Server;
  private transport?: Transport;
  private started = false;
  private actualPort?: number;

  private readonly pendingBatches = new Map<string, BatchRecord>();
  private readonly clients = new Set<WebSocket>();
  private batchCounter = 0;

  constructor(options: TestMockMCPServerOptions = {}) {
    this.logger = options.logger ?? console;
    this.options = {
      port: options.port,
      logger: this.logger,
      batchTtlMs: options.batchTtlMs ?? DEFAULT_BATCH_TTL_MS,
      sweepIntervalMs: options.sweepIntervalMs,
      enableMcpTransport: options.enableMcpTransport ?? true,
      transportFactory: options.transportFactory,
      serverName: options.serverName ?? "test-mock-server",
      serverVersion:
        options.serverVersion ?? (packageJson.version as string) ?? "0.0.0",
      mockLogOptions: options.mockLogOptions,
    };
  }

  /**
   * Start both the WebSocket server (for the test runner) and the MCP server
   * (for the AI client).
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.startWebSocketServer();

    if (this.options.enableMcpTransport) {
      await this.startMcpServer();
    }

    this.started = true;
  }

  /**
   * Shut down all transports and clear pending batches.
   */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      this.wss.close(() => resolve());
      this.wss = undefined;
    });

    if (this.transport) {
      await this.transport.close().catch((error) => {
        this.logger.warn("Failed to close MCP transport:", error);
      });
      this.transport = undefined;
    }

    this.pendingBatches.clear();
    this.mcpServer = undefined;
    this.started = false;
  }

  /**
   * Expose the TCP port that the WebSocket server is listening on. Useful when
   * `port=0` is supplied for ephemeral environments or tests.
   */
  get port(): number | undefined {
    return this.actualPort ?? this.options.port;
  }

  /**
   * Return summaries of all batches that are awaiting AI-provided mock data.
   */
  getPendingBatches(): PendingBatchSummary[] {
    return Array.from(this.pendingBatches.values()).map(
      ({ batchId, timestamp, requests }) => ({
        batchId,
        timestamp,
        requestCount: requests.length,
        requests,
      })
    );
  }

  /**
   * Send AI-generated mock data back to the corresponding test process.
   */
  async provideMockData(
    args: ProvideBatchMockDataArgs
  ): Promise<ToolResponseText> {
    const { batchId, mocks } = args;
    const batch = this.pendingBatches.get(batchId);

    if (!batch) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    const missing = mocks.find(
      (mock) =>
        !batch.requests.some((request) => request.requestId === mock.requestId)
    );

    if (missing) {
      throw new Error(
        `Mock data references unknown requestId: ${missing.requestId}`
      );
    }

    if (batch.ws.readyState !== WebSocket.OPEN) {
      this.pendingBatches.delete(batchId);
      throw new Error(
        `Test process disconnected before mocks were provided for ${batchId}`
      );
    }

    try {
      await this.persistMockBatch(batch, mocks);
    } catch (error) {
      this.logger.warn(`Failed to persist mock batch ${batchId}:`, error);
    }

    const payload: BatchMockResponseMessage = {
      type: BATCH_MOCK_RESPONSE,
      batchId,
      mocks,
    };

    batch.ws.send(JSON.stringify(payload));
    this.pendingBatches.delete(batchId);

    this.logger.log(
      `✅ Delivered ${mocks.length} mock(s) to test process for ${batchId}`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Provided mock data for ${batchId}`,
          }),
        },
      ],
    };
  }

  private async startWebSocketServer(): Promise<void> {
    if (this.wss) {
      return;
    }

    const desiredPort = this.options.port ?? DEFAULT_PORT;

    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: desiredPort });
      this.wss = wss;

      wss.once("listening", () => {
        const address = wss.address() as AddressInfo;
        this.actualPort = address?.port ?? desiredPort;
        this.logger.log(
          `🚀 WebSocket server listening on ws://localhost:${this.actualPort}`
        );
        resolve();
      });

      wss.once("error", (error) => {
        this.logger.error("Failed to start WebSocket server:", error);
        reject(error);
      });

      wss.on("connection", (ws) => this.handleConnection(ws));
    });

    if (this.options.batchTtlMs > 0) {
      const interval =
        this.options.sweepIntervalMs ??
        Math.min(this.options.batchTtlMs, 30_000);
      this.cleanupTimer = setInterval(
        () => this.sweepExpiredBatches(),
        interval
      );
      this.cleanupTimer.unref?.();
    }
  }

  private async startMcpServer(): Promise<void> {
    if (this.mcpServer) {
      return;
    }

    this.mcpServer = new Server(
      {
        name: this.options.serverName,
        version: this.options.serverVersion,
      },
      {
        capabilities: { tools: {} },
      }
    );

    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_pending_batches",
          description: "Inspect pending mock batches produced by the test run",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "provide_batch_mock_data",
          description: "Provide mock data for a specific batch",
          inputSchema: {
            type: "object",
            properties: {
              batchId: {
                type: "string",
              },
              mocks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    requestId: { type: "string" },
                    data: {
                      type: "object",
                    },
                    status: {
                      type: "number",
                    },
                    headers: {
                      type: "object",
                    },
                    delayMs: {
                      type: "number",
                    },
                  },
                  required: ["requestId", "data"],
                },
              },
            },
            required: ["batchId", "mocks"],
          },
        },
      ],
    }));

    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = (request.params.arguments ?? {}) as ProvideBatchMockDataArgs;

      if (toolName === "get_pending_batches") {
        this.logger.log("📋 MCP client inspected pending batches");
        return this.buildToolResponse(
          JSON.stringify(this.getPendingBatches(), null, 2)
        );
      }

      if (toolName === "provide_batch_mock_data") {
        return this.provideMockData(args);
      }

      throw new Error(`Unknown tool: ${toolName}`);
    });

    this.transport =
      this.options.transportFactory?.() ?? new StdioServerTransport();
    await this.mcpServer.connect(this.transport);
    this.logger.log("✅ MCP server is ready (stdio transport)");
  }

  private handleConnection(ws: WebSocket) {
    this.logger.log("🔌 Test process connected");
    this.clients.add(ws);

    ws.on("message", (data) => this.handleClientMessage(ws, data));
    ws.on("close", () => {
      this.logger.log("🔌 Test process disconnected");
      this.clients.delete(ws);
      this.dropBatchesForClient(ws);
    });
    ws.on("error", (error) => {
      this.logger.error("Test process WebSocket error:", error);
      this.dropBatchesForClient(ws);
    });
  }

  private handleClientMessage(ws: WebSocket, data: RawData) {
    let payload: BatchMockRequestMessage | undefined;

    try {
      payload = JSON.parse(data.toString()) as BatchMockRequestMessage;
    } catch (error) {
      this.logger.error("Failed to parse WebSocket message:", error);
      return;
    }

    if (payload.type !== BATCH_MOCK_REQUEST) {
      this.logger.warn("Unsupported message type received:", payload.type);
      return;
    }

    if (!Array.isArray(payload.requests) || payload.requests.length === 0) {
      this.logger.warn("Received a batch without requests");
      return;
    }

    this.handleBatchRequest(ws, payload.requests);
  }

  private handleBatchRequest(ws: WebSocket, requests: MockRequestDescriptor[]) {
    const batchId = `batch-${++this.batchCounter}`;
    const timestamp = new Date().toISOString();
    const expiresAt = this.options.batchTtlMs
      ? Date.now() + this.options.batchTtlMs
      : undefined;

    this.pendingBatches.set(batchId, {
      batchId,
      timestamp,
      requestCount: requests.length,
      requests,
      ws,
      expiresAt,
    });

    this.logger.log(
      [
        `📥 Received ${requests.length} request(s) (${batchId})`,
        ...requests.map(
          (req, index) =>
            `   ${index + 1}. ${req.method} ${req.endpoint} (${req.requestId})`
        ),
      ].join("\n")
    );
    this.logger.log("⏳ Awaiting mock data from MCP client...");
  }

  private dropBatchesForClient(ws: WebSocket) {
    for (const [batchId, batch] of this.pendingBatches) {
      if (batch.ws === ws) {
        this.pendingBatches.delete(batchId);
        this.logger.warn(
          `🧹 Dropped pending batch ${batchId} because the test client disconnected`
        );
      }
    }
  }

  private sweepExpiredBatches() {
    const now = Date.now();

    for (const [batchId, batch] of this.pendingBatches) {
      if (batch.expiresAt && batch.expiresAt <= now) {
        this.pendingBatches.delete(batchId);
        this.logger.warn(
          `🧹 Removed expired batch ${batchId} (waited more than ${
            this.options.batchTtlMs / 1000
          }s)`
        );
      }
    }
  }

  private async persistMockBatch(
    batch: BatchRecord,
    mocks: MockResponseDescriptor[]
  ): Promise<void> {
    const mockLogOptions = this.options.mockLogOptions;
    if (!mockLogOptions?.enabled) {
      return;
    }

    const directory = path.resolve(
      process.cwd(),
      mockLogOptions.directory ?? "logs"
    );
    await mkdir(directory, { recursive: true });

    const entry = this.buildLogEntry(batch, mocks);
    const filePath = path.join(directory, `mock-${batch.batchId}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
    this.logger.log(`📝 Saved mock batch ${batch.batchId} to ${filePath}`);
  }

  private buildLogEntry(
    batch: BatchRecord,
    mocks: MockResponseDescriptor[]
  ): MockLogEntry {
    const mockMap = new Map(mocks.map((mock) => [mock.requestId, mock]));
    return {
      batchId: batch.batchId,
      timestamp: batch.timestamp,
      requestCount: batch.requestCount,
      context: this.extractBatchContext(batch.requests),
      requests: batch.requests.map((request) => ({
        ...request,
        mock: mockMap.get(request.requestId),
      })),
      mocks,
    };
  }

  private extractBatchContext(
    requests: MockRequestDescriptor[]
  ): Record<string, unknown> | undefined {
    const contextKeys = ["testCaseId", "testFile", "testTitle", "testName"];
    const context: Record<string, unknown> = {};

    for (const key of contextKeys) {
      const requestWithValue = requests.find(
        (request) => request.metadata && request.metadata[key] !== undefined
      );
      if (requestWithValue?.metadata) {
        context[key] = requestWithValue.metadata[key];
      }
    }

    const metadataSnapshots = requests
      .map((request) => request.metadata)
      .filter((metadata): metadata is Record<string, unknown> => {
        if (!metadata) {
          return false;
        }
        return Object.keys(metadata).length > 0;
      });

    if (metadataSnapshots.length > 0) {
      context.metadata = metadataSnapshots;
    }

    return Object.keys(context).length > 0 ? context : undefined;
  }

  private buildToolResponse(text: string): ToolResponseText {
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }
}

interface MockLogEntry {
  batchId: string;
  timestamp: string;
  requestCount: number;
  context?: Record<string, unknown>;
  requests: Array<MockRequestDescriptor & { mock?: MockResponseDescriptor }>;
  mocks: MockResponseDescriptor[];
}
