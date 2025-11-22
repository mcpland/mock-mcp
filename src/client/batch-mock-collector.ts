import WebSocket, { type RawData } from "ws";
import {
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESPONSE,
  type BatchMockRequestMessage,
  type BatchMockResponseMessage,
  type MockRequestDescriptor,
  type MockResponseDescriptor,
  type ResolvedMock,
} from "../types.js";
import { isEnabled } from "./util.js";

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

export interface BatchMockCollectorOptions {
  /**
   * TCP port exposed by {@link TestMockMCPServer}.
   *
   * @default 3002
   */
  port?: number;
  /**
   * Timeout for individual mock requests in milliseconds.
   *
   * @default 60000
   */
  timeout?: number;
  /**
   * Delay (in milliseconds) that determines how long the collector waits before
   * flushing the current batch. Setting this to 0 mirrors the "flush on the next
   * macrotask" approach described in the technical design document.
   *
   * @default 0
   */
  batchDebounceMs?: number;
  /**
   * Maximum number of requests that may be included in a single batch payload.
   * Requests that exceed this limit will be split into multiple batches.
   *
   * @default 50
   */
  maxBatchSize?: number;
  /**
   * Optional custom logger. Defaults to `console`.
   */
  logger?: Logger;
  /**
   * Interval for WebSocket heartbeats in milliseconds. Set to 0 to disable.
   *
   * @default 15000
   */
  heartbeatIntervalMs?: number;
  /**
   * Automatically attempt to reconnect when the WebSocket closes unexpectedly.
   *
   * @default true
   */
  enableReconnect?: boolean;
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

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_BATCH_DEBOUNCE_MS = 0;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_PORT = 3002;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Collects HTTP requests issued during a single macrotask and forwards them to
 * the MCP server as a batch for AI-assisted mock generation.
 */
export class BatchMockCollector {
  private ws: WebSocket;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly queuedRequestIds = new Set<string>();
  private readonly timeout: number;
  private readonly batchDebounceMs: number;
  private readonly maxBatchSize: number;
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly enableReconnect: boolean;
  private readonly port: number;

  private batchTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private requestIdCounter = 0;
  private closed = false;

  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(options: BatchMockCollectorOptions = {}) {
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.batchDebounceMs = options.batchDebounceMs ?? DEFAULT_BATCH_DEBOUNCE_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.logger = options.logger ?? console;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.enableReconnect = options.enableReconnect ?? true;
    this.port = options.port ?? DEFAULT_PORT;

    this.resetReadyPromise();
    this.ws = this.createWebSocket();
    this.setupWebSocket();
  }

  /**
   * Ensures the underlying WebSocket connection is ready for use.
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
          new Error(
            `Mock request timed out after ${this.timeout}ms: ${method} ${endpoint}`
          )
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
   * Wait for all requests that are currently pending to settle. Requests
   * created after this method is called are not included.
   */
  async waitForPendingRequests(): Promise<void> {
    if (!isEnabled()) {
      return;
    }
    const pendingCompletions = Array.from(this.pendingRequests.values()).map(
      (pending) => pending.completion
    );

    const results = await Promise.all(pendingCompletions);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    if (rejected) {
      throw rejected.reason;
    }
  }

  /**
   * Close the underlying connection and fail all pending requests.
   */
  async close(code?: number): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
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
    this.queuedRequestIds.clear();

    const closePromise = new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
    });

    this.ws.close(code);
    this.failAllPending(new Error("BatchMockCollector has been closed"));

    await closePromise;
  }

  private setupWebSocket() {
    this.ws.on("open", () => {
      this.logger.log("🔌 Connected to mock MCP WebSocket endpoint");
      this.readyResolve?.();
      this.startHeartbeat();
    });

    this.ws.on("message", (data: RawData) => this.handleMessage(data));

    this.ws.on("error", (error) => {
      this.logger.error("❌ WebSocket error:", error);
      this.readyReject?.(
        error instanceof Error ? error : new Error(String(error))
      );
      this.failAllPending(
        error instanceof Error ? error : new Error(String(error))
      );
    });

    this.ws.on("close", () => {
      this.logger.warn("🔌 WebSocket connection closed");
      this.stopHeartbeat();
      this.failAllPending(new Error("WebSocket connection closed"));
      if (!this.closed && this.enableReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private createWebSocket() {
    const wsUrl = `ws://localhost:${this.port}`;
    return new WebSocket(wsUrl);
  }

  private resetReadyPromise() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private startHeartbeat() {
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimer) {
      return;
    }

    let lastPong = Date.now();
    this.ws.on("pong", () => {
      lastPong = Date.now();
    });

    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();
      if (now - lastPong > this.heartbeatIntervalMs * 2) {
        this.logger.warn(
          "Heartbeat missed; closing socket to trigger reconnect..."
        );
        this.ws.close();
        return;
      }

      this.ws.ping();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closed) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.warn("🔄 Reconnecting to mock MCP WebSocket endpoint...");
      this.stopHeartbeat();
      this.resetReadyPromise();
      this.ws = this.createWebSocket();
      this.setupWebSocket();
    }, 1_000);

    this.reconnectTimer.unref?.();
  }

  private handleMessage(data: RawData) {
    let parsed: BatchMockResponseMessage | undefined;

    try {
      parsed = JSON.parse(data.toString()) as BatchMockResponseMessage;
    } catch (error) {
      this.logger.error("Failed to parse server message:", error);
      return;
    }

    if (parsed.type !== BATCH_MOCK_RESPONSE) {
      this.logger.warn("Received unsupported message type", parsed.type);
      return;
    }

    this.logger.debug?.(
      `📦 Received mock data for ${parsed.mocks.length} requests (batch ${parsed.batchId})`
    );

    for (const mock of parsed.mocks) {
      this.resolveRequest(mock);
    }
  }

  private resolveRequest(mock: BatchMockResponseMessage["mocks"][number]) {
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

  private enqueueRequest(requestId: string) {
    this.queuedRequestIds.add(requestId);

    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushQueue();
    }, this.batchDebounceMs);
  }

  private flushQueue() {
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

  private sendBatch(requests: MockRequestDescriptor[]) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      const error = new Error("WebSocket is not open");
      requests.forEach((request) =>
        this.rejectRequest(request.requestId, error)
      );
      return;
    }

    const payload: BatchMockRequestMessage = {
      type: BATCH_MOCK_REQUEST,
      requests,
    };

    this.logger.debug?.(
      `📤 Sending batch with ${requests.length} request(s) to MCP server`
    );
    this.ws.send(JSON.stringify(payload));
  }

  private buildResolvedMock<T>(
    mock: MockResponseDescriptor
  ): ResolvedMock<T> {
    return {
      requestId: mock.requestId,
      data: mock.data as T,
      status: mock.status,
      headers: mock.headers,
      delayMs: mock.delayMs,
    };
  }

  private rejectRequest(requestId: string, error: Error) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }

  private failAllPending(error: Error) {
    for (const requestId of Array.from(this.pendingRequests.keys())) {
      this.rejectRequest(requestId, error);
    }
  }
}
