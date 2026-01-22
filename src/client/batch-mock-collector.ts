/**
 * BatchMockCollector - Collects HTTP requests and sends them to the daemon for mock generation.
 *
 * Features:
 * - Connects to daemon via IPC (Unix Domain Socket / Named Pipe)
 * - Automatically discovers and starts daemon if needed
 * - Uses runId for multi-run isolation
 * - Sends HELLO handshake on connection
 * - Batches concurrent requests for efficient processing
 */

import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import { ensureDaemonRunning, resolveProjectRoot, type DaemonRegistry } from "../shared/discovery.js";
import {
  HELLO_TEST,
  HELLO_ACK,
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESULT,
  type HelloTestMessage,
  type HelloAckMessage,
  type BatchMockRequestMessage as ProtocolBatchMockRequestMessage,
  type BatchMockResultMessage,
} from "../shared/protocol.js";
import type {
  MockRequestDescriptor,
  MockResponseDescriptor,
  ResolvedMock,
} from "../types.js";
import { isEnabled } from "./util.js";

// =============================================================================
// Types
// =============================================================================

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

export interface BatchMockCollectorOptions {
  /**
   * Timeout for individual mock requests in milliseconds.
   * @default 60000
   */
  timeout?: number;

  /**
   * Delay (in milliseconds) before flushing the current batch.
   * Setting to 0 flushes on the next macrotask.
   * @default 0
   */
  batchDebounceMs?: number;

  /**
   * Maximum number of requests that may be included in a single batch.
   * @default 50
   */
  maxBatchSize?: number;

  /**
   * Optional custom logger. Defaults to console.
   */
  logger?: Logger;

  /**
   * Interval for WebSocket heartbeats in milliseconds. Set to 0 to disable.
   * @default 15000
   */
  heartbeatIntervalMs?: number;

  /**
   * Automatically attempt to reconnect when the WebSocket closes unexpectedly.
   * @default true
   */
  enableReconnect?: boolean;

  /**
   * Optional project root override. By default, auto-detected from process.cwd().
   * Use this when you want to explicitly specify the project root directory.
   */
  projectRoot?: string;

  /**
   * Path to the current test file. The project root will be auto-detected
   * by searching upward for .git or package.json from this file's directory.
   *
   * This is useful in test frameworks like Jest/Vitest:
   * @example
   * ```typescript
   * // Jest
   * const mockMcpClient = await connect({
   *   filePath: expect.getState().testPath,
   * });
   *
   * // Vitest
   * const mockMcpClient = await connect({
   *   filePath: import.meta.url,
   * });
   * ```
   *
   * Note: If both `filePath` and `projectRoot` are provided, `projectRoot` takes precedence.
   */
  filePath?: string;

  /**
   * Optional test metadata to include in the HELLO message.
   */
  testMeta?: {
    testFile?: string;
    testName?: string;
  };
}

export interface RequestMockOptions {
  body?: unknown;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

interface PendingRequest {
  request: MockRequestDescriptor;
  resolve: (mock: MockResponseDescriptor) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  completion: Promise<PromiseSettledResult<void>>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_BATCH_DEBOUNCE_MS = 0;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

// =============================================================================
// BatchMockCollector
// =============================================================================

/**
 * Collects HTTP requests and forwards them to the daemon for AI-assisted mock generation.
 *
 * New architecture:
 * - Connects to daemon via IPC (not TCP port)
 * - Sends HELLO handshake with runId
 * - Uses the new protocol (BATCH_MOCK_REQUEST → BATCH_MOCK_RESULT)
 */
export class BatchMockCollector {
  private ws?: WebSocket;
  private registry?: DaemonRegistry;

  private readonly runId = crypto.randomUUID();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly queuedRequestIds = new Set<string>();

  private readonly timeout: number;
  private readonly batchDebounceMs: number;
  private readonly maxBatchSize: number;
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly enableReconnect: boolean;
  private readonly projectRoot?: string;
  private readonly testMeta?: { testFile?: string; testName?: string };

  private batchTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private requestIdCounter = 0;
  private closed = false;
  private authed = false;

  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(options: BatchMockCollectorOptions = {}) {
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.batchDebounceMs = options.batchDebounceMs ?? DEFAULT_BATCH_DEBOUNCE_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.logger = options.logger ?? console;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.enableReconnect = options.enableReconnect ?? true;
    this.testMeta = options.testMeta;

    // Resolve projectRoot: explicit projectRoot > filePath > auto-detect
    this.projectRoot = this.resolveProjectRootFromOptions(options);

    this.logger.log(`[mock-mcp] BatchMockCollector created`);
    this.logger.log(`[mock-mcp]   runId: ${this.runId}`);
    this.logger.log(`[mock-mcp]   timeout: ${this.timeout}ms`);
    this.logger.log(`[mock-mcp]   batchDebounceMs: ${this.batchDebounceMs}ms`);
    this.logger.log(`[mock-mcp]   maxBatchSize: ${this.maxBatchSize}`);
    this.logger.log(`[mock-mcp]   heartbeatIntervalMs: ${this.heartbeatIntervalMs}ms`);
    this.logger.log(`[mock-mcp]   enableReconnect: ${this.enableReconnect}`);
    this.logger.log(`[mock-mcp]   projectRoot: ${this.projectRoot ?? "(auto-detect)"}`);
    if (options.filePath) {
      this.logger.log(`[mock-mcp]   filePath: ${options.filePath}`);
    }

    this.resetReadyPromise();
    this.initConnection({
      timeout: this.timeout,
    });
  }

  /**
   * Resolve projectRoot from options.
   * Priority: projectRoot > filePath > undefined (auto-detect)
   */
  private resolveProjectRootFromOptions(options: BatchMockCollectorOptions): string | undefined {
    // If explicit projectRoot is provided, use it
    if (options.projectRoot) {
      return options.projectRoot;
    }

    // If filePath is provided, resolve projectRoot from it
    if (options.filePath) {
      let filePath = options.filePath;

      // Handle file:// URLs (e.g., from import.meta.url in Vitest)
      if (filePath.startsWith("file://")) {
        try {
          filePath = fileURLToPath(filePath);
        } catch {
          // If conversion fails, try using the path as-is
          filePath = filePath.replace(/^file:\/\//, "");
        }
      }

      // Get the directory containing the file
      const dir = path.dirname(filePath);

      // Find the project root by searching upward for .git or package.json
      const resolved = resolveProjectRoot(dir);
      this.logger.log(`[mock-mcp]   Resolved projectRoot from filePath:`);
      this.logger.log(`[mock-mcp]     filePath: ${options.filePath}`);
      this.logger.log(`[mock-mcp]     dir: ${dir}`);
      this.logger.log(`[mock-mcp]     projectRoot: ${resolved}`);
      return resolved;
    }

    // Auto-detect from process.cwd()
    return undefined;
  }

  /**
   * Ensures the underlying connection is ready for use.
   */
  async waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Request mock data for a specific endpoint/method pair.
   */
  async requestMock<T = unknown>(
    endpoint: string,
    method: string,
    options: RequestMockOptions = {}
  ): Promise<ResolvedMock<T>> {
    if (this.closed) {
      throw new Error("BatchMockCollector has been closed");
    }

    await this.waitUntilReady();

    const requestId = `req-${++this.requestIdCounter}`;
    const request: MockRequestDescriptor = {
      requestId,
      endpoint,
      method,
      body: options.body,
      headers: options.headers,
      metadata: options.metadata,
    };

    let settleCompletion!: (result: PromiseSettledResult<void>) => void;
    const completion = new Promise<PromiseSettledResult<void>>((resolve) => {
      settleCompletion = resolve;
    });

    return new Promise<ResolvedMock<T>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.rejectRequest(
          requestId,
          new Error(`Mock request timed out after ${this.timeout}ms: ${method} ${endpoint}`)
        );
      }, this.timeout);

      this.pendingRequests.set(requestId, {
        request,
        resolve: (mock) => {
          settleCompletion({ status: "fulfilled", value: undefined });
          resolve(this.buildResolvedMock<T>(mock));
        },
        reject: (error) => {
          settleCompletion({ status: "rejected", reason: error });
          reject(error);
        },
        timeoutId,
        completion,
      });

      this.enqueueRequest(requestId);
    });
  }

  /**
   * Wait for all currently pending requests to settle.
   */
  async waitForPendingRequests(): Promise<void> {
    if (!isEnabled()) {
      return;
    }

    const pendingCompletions = Array.from(this.pendingRequests.values()).map(
      (p) => p.completion
    );

    const results = await Promise.all(pendingCompletions);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );

    if (rejected) {
      throw rejected.reason;
    }
  }

  /**
   * Close the connection and fail all pending requests.
   */
  async close(code?: number): Promise<void> {
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] close() called with code: ${code ?? "(default)"}`);

    if (this.closed) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Already closed, returning`);
      return;
    }

    this.closed = true;
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Cleaning up timers...`);

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const pendingCount = this.pendingRequests.size;
    const queuedCount = this.queuedRequestIds.size;
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Pending requests: ${pendingCount}, Queued: ${queuedCount}`);

    this.queuedRequestIds.clear();

    const closePromise = new Promise<void>((resolve) => {
      if (!this.ws) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
    });

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Closing WebSocket...`);
    this.ws?.close(code);
    this.failAllPending(new Error("BatchMockCollector has been closed"));

    await closePromise;
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] ✅ Connection closed`);
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  private async initConnection({
    timeout = 10000,
  }): Promise<void> {
    const initStartTime = Date.now();
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Initializing connection...`);

    try {
      // Ensure daemon is running and get registry
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Ensuring daemon is running...`);
      const daemonStartTime = Date.now();

      this.registry = await ensureDaemonRunning({
        projectRoot: this.projectRoot,
        timeoutMs: timeout,
      });

      const daemonElapsed = Date.now() - daemonStartTime;
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Daemon ready (${daemonElapsed}ms)`);
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   Project ID: ${this.registry.projectId}`);
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   Daemon PID: ${this.registry.pid}`);
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   IPC Path: ${this.registry.ipcPath}`);

      // Create WebSocket connection
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Creating WebSocket connection...`);
      const wsStartTime = Date.now();

      this.ws = await this.createWebSocket(this.registry.ipcPath);

      const wsElapsed = Date.now() - wsStartTime;
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] WebSocket created (${wsElapsed}ms)`);

      this.setupWebSocket();

      const totalElapsed = Date.now() - initStartTime;
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Connection initialized (total: ${totalElapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - initStartTime;
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] Connection init failed after ${elapsed}ms:`, error);
      this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private createWebSocket(ipcPath: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Creating WebSocket to IPC: ${ipcPath}`);

      // Create WebSocket over IPC using custom agent
      const agent = new http.Agent({
        // @ts-expect-error: Node.js supports socketPath for Unix sockets
        socketPath: ipcPath,
      });

      const ws = new WebSocket("ws://localhost/test", {
        agent,
      });

      ws.once("open", () => {
        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] WebSocket opened`);
        resolve(ws);
      });
      ws.once("error", (err) => {
        this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] WebSocket connection error:`, err);
        reject(err);
      });
    });
  }

  private setupWebSocket(): void {
    if (!this.ws || !this.registry) {
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}] setupWebSocket called but ws or registry is missing`);
      return;
    }

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Setting up WebSocket event handlers...`);
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   Current readyState: ${this.ws.readyState}`);

    this.ws.on("message", (data: RawData) => this.handleMessage(data));

    this.ws.on("error", (error) => {
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] ❌ WebSocket ERROR:`, error);
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}]   authed: ${this.authed}`);
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}]   readyState: ${this.ws?.readyState}`);
      if (!this.authed) {
        this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
      }
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
    });

    this.ws.on("close", (code, reason) => {
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}] 🔌 WebSocket CLOSE`);
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}]   code: ${code}`);
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}]   reason: ${reason?.toString() || "(none)"}`);
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}]   authed: ${this.authed}`);
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}]   closed: ${this.closed}`);
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}]   enableReconnect: ${this.enableReconnect}`);
      this.authed = false;
      this.stopHeartbeat();
      this.failAllPending(new Error(`Daemon connection closed (code: ${code})`));

      if (!this.closed && this.enableReconnect) {
        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Will attempt reconnect...`);
        this.scheduleReconnect();
      }
    });

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] WebSocket event handlers configured`);

    // WebSocket is already open (createWebSocket waits for 'open'), send HELLO immediately
    if (this.ws.readyState === WebSocket.OPEN) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] 🔌 WebSocket already OPEN - sending HELLO`);
      this.sendHello();
    }
  }

  private sendHello(): void {
    if (!this.ws || !this.registry) {
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}] sendHello called but ws or registry is missing`);
      return;
    }

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Sending HELLO handshake...`);
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   runId: ${this.runId}`);
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   pid: ${process.pid}`);
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   cwd: ${process.cwd()}`);
    if (this.testMeta) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   testFile: ${this.testMeta.testFile ?? "(none)"}`);
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   testName: ${this.testMeta.testName ?? "(none)"}`);
    }

    const hello: HelloTestMessage = {
      type: HELLO_TEST,
      token: this.registry.token,
      runId: this.runId,
      pid: process.pid,
      cwd: process.cwd(),
      testMeta: this.testMeta,
    };

    this.ws.send(JSON.stringify(hello));
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] HELLO sent, waiting for HELLO_ACK...`);
  }

  private handleMessage(data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] Failed to parse server message`);
      return;
    }

    const msgType = (msg as { type?: string })?.type;

    // Handle HELLO_ACK
    if (this.isHelloAck(msg)) {
      this.authed = true;
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] ✅ Received HELLO_ACK - Authenticated!`);
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   Connection is now READY`);
      this.readyResolve?.();
      this.startHeartbeat();
      return;
    }

    // Handle BATCH_MOCK_RESULT
    if (this.isBatchMockResult(msg)) {
      this.logger.log(
        `[mock-mcp] [${this.runId.slice(0, 8)}] 📦 Received BATCH_MOCK_RESULT`
      );
      this.logger.log(
        `[mock-mcp] [${this.runId.slice(0, 8)}]   batchId: ${msg.batchId}`
      );
      this.logger.log(
        `[mock-mcp] [${this.runId.slice(0, 8)}]   mocks count: ${msg.mocks.length}`
      );

      for (const mock of msg.mocks) {
        this.logger.log(
          `[mock-mcp] [${this.runId.slice(0, 8)}]   - ${mock.requestId}: status=${mock.status ?? 200}`
        );
        this.resolveRequest(mock);
      }
      return;
    }

    // Handle HEARTBEAT_ACK (ignore silently)
    if (msgType === "HEARTBEAT_ACK") {
      return;
    }

    this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}] Received unknown message type: ${msgType}`);
  }

  private isHelloAck(msg: unknown): msg is HelloAckMessage {
    return (
      msg !== null &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === HELLO_ACK
    );
  }

  private isBatchMockResult(msg: unknown): msg is BatchMockResultMessage {
    return (
      msg !== null &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === BATCH_MOCK_RESULT &&
      Array.isArray((msg as { mocks?: unknown }).mocks)
    );
  }

  // ===========================================================================
  // Request Management
  // ===========================================================================

  private resolveRequest(mock: MockResponseDescriptor): void {
    const pending = this.pendingRequests.get(mock.requestId);
    if (!pending) {
      this.logger.warn(`Received mock for unknown request: ${mock.requestId}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(mock.requestId);

    const resolve = () => pending.resolve(mock);
    if (mock.delayMs && mock.delayMs > 0) {
      setTimeout(resolve, mock.delayMs);
    } else {
      resolve();
    }
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }

  private failAllPending(error: Error): void {
    for (const requestId of Array.from(this.pendingRequests.keys())) {
      this.rejectRequest(requestId, error);
    }
  }

  // ===========================================================================
  // Batching
  // ===========================================================================

  private enqueueRequest(requestId: string): void {
    this.queuedRequestIds.add(requestId);

    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushQueue();
    }, this.batchDebounceMs);
  }

  private flushQueue(): void {
    const queuedIds = Array.from(this.queuedRequestIds);
    this.queuedRequestIds.clear();

    if (queuedIds.length === 0) {
      return;
    }

    for (let i = 0; i < queuedIds.length; i += this.maxBatchSize) {
      const chunkIds = queuedIds.slice(i, i + this.maxBatchSize);
      const requests: MockRequestDescriptor[] = [];

      for (const id of chunkIds) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          requests.push(pending.request);
        }
      }

      if (requests.length > 0) {
        this.sendBatch(requests);
      }
    }
  }

  private sendBatch(requests: MockRequestDescriptor[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] Cannot send batch - WebSocket not open`);
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}]   ws exists: ${!!this.ws}`);
      this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}]   readyState: ${this.ws?.readyState}`);
      const error = new Error("WebSocket is not open");
      for (const req of requests) {
        this.rejectRequest(req.requestId, error);
      }
      return;
    }

    const payload: ProtocolBatchMockRequestMessage = {
      type: BATCH_MOCK_REQUEST,
      runId: this.runId,
      requests,
    };

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] 📤 Sending BATCH_MOCK_REQUEST`);
    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   requests: ${requests.length}`);
    for (const req of requests) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}]   - ${req.requestId}: ${req.method} ${req.endpoint}`);
    }

    this.ws.send(JSON.stringify(payload));
  }

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimer) {
      return;
    }

    let lastPong = Date.now();
    this.ws?.on("pong", () => {
      lastPong = Date.now();
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();
      if (now - lastPong > this.heartbeatIntervalMs * 2) {
        this.logger.warn("Heartbeat missed; closing socket to trigger reconnect...");
        this.ws.close();
        return;
      }

      this.ws.ping();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ===========================================================================
  // Reconnection
  // ===========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Reconnect already scheduled, skipping`);
      return;
    }
    if (this.closed) {
      this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Client is closed, not reconnecting`);
      return;
    }

    this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Scheduling reconnect in 1000ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.logger.warn(`[mock-mcp] [${this.runId.slice(0, 8)}] 🔄 Attempting reconnect to daemon...`);
      this.stopHeartbeat();
      this.resetReadyPromise();
      this.authed = false;

      const reconnectStartTime = Date.now();

      try {
        // Re-discover daemon (it may have restarted)
        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Re-discovering daemon...`);
        this.registry = await ensureDaemonRunning({
          projectRoot: this.projectRoot,
        });

        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Daemon found, creating new WebSocket...`);
        this.ws = await this.createWebSocket(this.registry.ipcPath);
        this.setupWebSocket();

        const elapsed = Date.now() - reconnectStartTime;
        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] ✅ Reconnect successful (${elapsed}ms)`);
      } catch (error) {
        const elapsed = Date.now() - reconnectStartTime;
        this.logger.error(`[mock-mcp] [${this.runId.slice(0, 8)}] ❌ Reconnection failed after ${elapsed}ms:`, error);
        this.logger.log(`[mock-mcp] [${this.runId.slice(0, 8)}] Will retry reconnect...`);
        this.scheduleReconnect();
      }
    }, 1000);

    this.reconnectTimer.unref?.();
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private buildResolvedMock<T>(mock: MockResponseDescriptor): ResolvedMock<T> {
    return {
      requestId: mock.requestId,
      data: mock.data as T,
      status: mock.status,
      headers: mock.headers,
      delayMs: mock.delayMs,
    };
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  /**
   * Get the run ID for this collector instance.
   */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Get the daemon registry information (after connection).
   */
  getRegistry(): DaemonRegistry | undefined {
    return this.registry;
  }
}
