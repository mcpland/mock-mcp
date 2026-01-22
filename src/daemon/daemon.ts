/**
 * Mock Bridge Daemon - The core singleton process for mock-mcp.
 *
 * Responsibilities:
 * - Listen on IPC (Unix Domain Socket / Windows Named Pipe)
 * - Accept test process connections via WebSocket /test
 * - Accept adapter connections via HTTP /control (JSON-RPC)
 * - Manage runs, batches, claims with lease-based concurrency control
 * - Clean up expired claims and disconnected runs
 */

import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import {
  getPaths,
  computeProjectId,
  writeRegistry,
  type DaemonRegistry,
} from "../shared/discovery.js";
import {
  HELLO_TEST,
  HELLO_ACK,
  BATCH_MOCK_REQUEST,
  BATCH_MOCK_RESULT,
  HEARTBEAT,
  HEARTBEAT_ACK,
  RPC_GET_STATUS,
  RPC_LIST_RUNS,
  RPC_CLAIM_NEXT_BATCH,
  RPC_PROVIDE_BATCH,
  RPC_RELEASE_BATCH,
  RPC_GET_BATCH,
  RPC_ERROR_NOT_FOUND,
  RPC_ERROR_UNAUTHORIZED,
  RPC_ERROR_CONFLICT,
  RPC_ERROR_EXPIRED,
  RPC_ERROR_INTERNAL,
  RPC_ERROR_METHOD_NOT_FOUND,
  isHelloTestMessage,
  isBatchMockRequestMessage,
  isHeartbeatMessage,
  isJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RunRecord,
  type BatchRecord,
  type BatchStatus,
  type HelloAckMessage,
  type BatchMockResultMessage,
  type HeartbeatAckMessage,
  type ClaimNextBatchParams,
  type ClaimNextBatchResult,
  type ProvideBatchParams,
  type ProvideBatchResult,
  type ReleaseBatchParams,
  type GetBatchParams,
  type GetStatusResult,
  type ListRunsResult,
  type GetBatchResult,
} from "../shared/protocol.js";
import type { MockResponseDescriptor } from "../types.js";

// =============================================================================
// Types
// =============================================================================

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

export interface MockMcpDaemonOptions {
  projectRoot: string;
  token: string;
  version: string;
  cacheDir?: string;
  logger?: Logger;
  /** Default lease time for batch claims (ms). Default: 30000 */
  defaultLeaseMs?: number;
  /** Interval for sweeping expired claims (ms). Default: 5000 */
  sweepIntervalMs?: number;
  /** Auto-shutdown after this many ms of inactivity (no runs/adapters). Default: 600000 (10min) */
  idleShutdownMs?: number;
}

interface RunState extends RunRecord {
  ws: WebSocket;
}

// =============================================================================
// Mock Bridge Daemon
// =============================================================================

export class MockMcpDaemon {
  private readonly logger: Logger;
  private readonly opts: Required<
    Pick<
      MockMcpDaemonOptions,
      "projectRoot" | "token" | "version" | "defaultLeaseMs" | "sweepIntervalMs" | "idleShutdownMs"
    >
  > &
    Omit<MockMcpDaemonOptions, "projectRoot" | "token" | "version" | "defaultLeaseMs" | "sweepIntervalMs" | "idleShutdownMs">;

  private server?: http.Server;
  private wss?: WebSocketServer;
  private sweepTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private startedAt?: number;

  // State management
  private readonly runs = new Map<string, RunState>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly pendingQueue: string[] = []; // batchIds in order
  private batchSeq = 0;

  constructor(options: MockMcpDaemonOptions) {
    this.logger = options.logger ?? console;
    this.opts = {
      projectRoot: options.projectRoot,
      token: options.token,
      version: options.version,
      cacheDir: options.cacheDir,
      logger: this.logger,
      defaultLeaseMs: options.defaultLeaseMs ?? 30000,
      sweepIntervalMs: options.sweepIntervalMs ?? 5000,
      idleShutdownMs: options.idleShutdownMs ?? 600000,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    const projectId = computeProjectId(this.opts.projectRoot);
    const { base, registryPath, ipcPath } = getPaths(projectId, this.opts.cacheDir);

    await fs.mkdir(base, { recursive: true });

    // Clean up stale socket file on Unix
    if (process.platform !== "win32") {
      try {
        await fs.rm(ipcPath);
      } catch {
        // Ignore if doesn't exist
      }
    }

    // Create HTTP server
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server = server;

    // Create WebSocket server (noServer mode for path-based routing)
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    // Handle WebSocket upgrades
    server.on("upgrade", (req, socket, head) => {
      // Check path
      if (!req.url?.startsWith("/test")) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    // Handle WebSocket connections
    wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));

    // Start listening on IPC
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ipcPath, () => {
        this.logger.error(`🚀 Daemon listening on ${ipcPath}`);
        resolve();
      });
    });

    this.startedAt = Date.now();

    // Write registry
    const registry: DaemonRegistry = {
      projectId,
      projectRoot: this.opts.projectRoot,
      ipcPath,
      token: this.opts.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: this.opts.version,
    };
    await writeRegistry(registryPath, registry);

    // Start sweep timer
    this.sweepTimer = setInterval(() => this.sweepExpiredClaims(), this.opts.sweepIntervalMs);
    this.sweepTimer.unref?.();

    // Start idle shutdown timer
    this.resetIdleTimer();

    this.logger.error(`✅ Daemon ready (project: ${projectId}, pid: ${process.pid})`);
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Close all WebSocket connections
    for (const run of this.runs.values()) {
      run.ws.close(1001, "Daemon shutting down");
    }
    this.runs.clear();

    // Close servers
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });

    this.batches.clear();
    this.pendingQueue.length = 0;

    this.logger.error("👋 Daemon stopped");
  }

  // ===========================================================================
  // HTTP Handler (/health, /control)
  // ===========================================================================

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            pid: process.pid,
            version: this.opts.version,
            projectId: computeProjectId(this.opts.projectRoot),
          })
        );
        return;
      }

      // Control endpoint (JSON-RPC)
      if (req.method === "POST" && req.url === "/control") {
        // Token validation
        const token = req.headers["x-mock-mcp-token"];
        if (token !== this.opts.token) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // Parse body
        const body = await this.readBody(req);
        let rpcReq: unknown;
        try {
          rpcReq = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        if (!isJsonRpcRequest(rpcReq)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON-RPC request" }));
          return;
        }

        const rpcRes = await this.handleRpc(rpcReq);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcRes));
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    } catch (e: unknown) {
      this.logger.error("HTTP handler error:", e);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(e instanceof Error ? e.message : String(e));
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (chunk) => (buf += chunk));
      req.on("end", () => resolve(buf));
      req.on("error", reject);
    });
  }

  // ===========================================================================
  // WebSocket Handler (/test)
  // ===========================================================================

  private handleWsConnection(ws: WebSocket, _req: http.IncomingMessage): void {
    let authed = false;
    let runId: string | null = null;

    // Require HELLO within 5 seconds
    const helloTimeout = setTimeout(() => {
      if (!authed) {
        ws.close(1008, "HELLO timeout");
      }
    }, 5000);

    ws.on("message", (data: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this.logger.warn("Invalid JSON from test process");
        return;
      }

      // First message must be HELLO
      if (!authed) {
        if (!isHelloTestMessage(msg)) {
          ws.close(1008, "Expected HELLO_TEST");
          return;
        }

        if (msg.token !== this.opts.token) {
          ws.close(1008, "Invalid token");
          return;
        }

        authed = true;
        clearTimeout(helloTimeout);
        runId = msg.runId;

        const runState: RunState = {
          runId,
          pid: msg.pid,
          cwd: msg.cwd,
          startedAt: new Date().toISOString(),
          lastSeen: Date.now(),
          testMeta: msg.testMeta,
          ws,
        };
        this.runs.set(runId, runState);

        const ack: HelloAckMessage = { type: HELLO_ACK, runId };
        ws.send(JSON.stringify(ack));

        this.logger.error(`🔌 Test run connected: ${runId} (pid: ${msg.pid})`);
        this.resetIdleTimer();
        return;
      }

      // Handle authenticated messages
      if (isBatchMockRequestMessage(msg)) {
        this.handleBatchRequest(runId!, msg.requests, ws);
        return;
      }

      if (isHeartbeatMessage(msg)) {
        const run = this.runs.get(msg.runId);
        if (run) {
          run.lastSeen = Date.now();
        }
        const ack: HeartbeatAckMessage = { type: HEARTBEAT_ACK, runId: msg.runId };
        ws.send(JSON.stringify(ack));
        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      if (runId) {
        this.cleanupRun(runId);
      }
    });

    ws.on("error", (err) => {
      this.logger.error("WebSocket error:", err);
      if (runId) {
        this.cleanupRun(runId);
      }
    });
  }

  private handleBatchRequest(
    runId: string,
    requests: BatchRecord["requests"],
    ws: WebSocket
  ): void {
    const batchId = `batch:${runId}:${++this.batchSeq}`;

    const batch: BatchRecord = {
      batchId,
      runId,
      requests,
      createdAt: Date.now(),
      status: "pending",
    };

    this.batches.set(batchId, batch);
    this.pendingQueue.push(batchId);

    this.logger.error(
      [
        `📥 Received ${requests.length} request(s) (${batchId})`,
        ...requests.map(
          (req, i) => `   ${i + 1}. ${req.method} ${req.endpoint} (${req.requestId})`
        ),
      ].join("\n")
    );
    this.logger.error("⏳ Awaiting mock data from MCP adapter...");
  }

  private cleanupRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    this.runs.delete(runId);

    // Clean up batches for this run
    for (const [batchId, batch] of this.batches) {
      if (batch.runId === runId) {
        this.batches.delete(batchId);
      }
    }

    // Remove from pending queue
    for (let i = this.pendingQueue.length - 1; i >= 0; i--) {
      const bid = this.pendingQueue[i];
      if (!this.batches.has(bid!)) {
        this.pendingQueue.splice(i, 1);
      }
    }

    this.logger.error(`🔌 Test run disconnected: ${runId}`);
    this.resetIdleTimer();
  }

  // ===========================================================================
  // JSON-RPC Handler
  // ===========================================================================

  private async handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      // Sweep expired claims before handling any request
      this.sweepExpiredClaims();

      const params = (req.params ?? {}) as Record<string, unknown>;

      switch (req.method) {
        case RPC_GET_STATUS:
          return this.rpcSuccess(req.id, this.getStatus());

        case RPC_LIST_RUNS:
          return this.rpcSuccess(req.id, this.listRuns());

        case RPC_CLAIM_NEXT_BATCH:
          return this.rpcSuccess(req.id, this.claimNextBatch(params as unknown as ClaimNextBatchParams));

        case RPC_PROVIDE_BATCH:
          return this.rpcSuccess(req.id, await this.provideBatch(params as unknown as ProvideBatchParams));

        case RPC_RELEASE_BATCH:
          return this.rpcSuccess(req.id, this.releaseBatch(params as unknown as ReleaseBatchParams));

        case RPC_GET_BATCH:
          return this.rpcSuccess(req.id, this.getBatch(params as unknown as GetBatchParams));

        default:
          return this.rpcError(req.id, RPC_ERROR_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = this.getErrorCode(e);
      return this.rpcError(req.id, code, msg);
    }
  }

  private getErrorCode(e: unknown): number {
    if (e instanceof RpcError) {
      return e.code;
    }
    return RPC_ERROR_INTERNAL;
  }

  private rpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private rpcError(id: string | number, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  // ===========================================================================
  // RPC Methods
  // ===========================================================================

  private getStatus(): GetStatusResult {
    const pending = this.pendingQueue.filter((bid) => {
      const b = this.batches.get(bid);
      return b && b.status === "pending";
    }).length;

    const claimed = Array.from(this.batches.values()).filter(
      (b) => b.status === "claimed"
    ).length;

    return {
      version: this.opts.version,
      projectId: computeProjectId(this.opts.projectRoot),
      projectRoot: this.opts.projectRoot,
      pid: process.pid,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      runs: this.runs.size,
      pending,
      claimed,
      totalBatches: this.batches.size,
    };
  }

  private listRuns(): ListRunsResult {
    const runs = Array.from(this.runs.values()).map((r) => {
      const pendingBatches = Array.from(this.batches.values()).filter(
        (b) => b.runId === r.runId && b.status === "pending"
      ).length;

      return {
        runId: r.runId,
        pid: r.pid,
        cwd: r.cwd,
        startedAt: r.startedAt,
        lastSeen: r.lastSeen,
        pendingBatches,
        testMeta: r.testMeta,
      };
    });

    return { runs };
  }

  private claimNextBatch(params: ClaimNextBatchParams): ClaimNextBatchResult | null {
    const { adapterId, runId, leaseMs = this.opts.defaultLeaseMs } = params;

    if (!adapterId) {
      throw new RpcError(RPC_ERROR_UNAUTHORIZED, "adapterId required");
    }

    // Find a claimable batch
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const batchId = this.pendingQueue[i]!;
      const batch = this.batches.get(batchId);

      if (!batch || batch.status !== "pending") {
        continue;
      }

      // Filter by runId if specified
      if (runId && batch.runId !== runId) {
        continue;
      }

      // Claim this batch
      this.pendingQueue.splice(i, 1);

      batch.status = "claimed";
      batch.claim = {
        adapterId,
        claimToken: crypto.randomUUID(),
        leaseUntil: Date.now() + leaseMs,
      };

      this.logger.error(`🔒 Batch ${batchId} claimed by adapter ${adapterId.slice(0, 8)}...`);

      return {
        batchId: batch.batchId,
        runId: batch.runId,
        requests: batch.requests,
        claimToken: batch.claim.claimToken,
        leaseUntil: batch.claim.leaseUntil,
      };
    }

    // No batch available
    return null;
  }

  private async provideBatch(params: ProvideBatchParams): Promise<ProvideBatchResult> {
    const { adapterId, batchId, claimToken, mocks } = params;

    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new RpcError(RPC_ERROR_NOT_FOUND, `Batch not found: ${batchId}`);
    }

    if (batch.status !== "claimed" || !batch.claim) {
      throw new RpcError(RPC_ERROR_CONFLICT, `Batch not in claimed state: ${batchId}`);
    }

    if (batch.claim.adapterId !== adapterId) {
      throw new RpcError(RPC_ERROR_UNAUTHORIZED, "Not the owner of this batch");
    }

    if (batch.claim.claimToken !== claimToken) {
      throw new RpcError(RPC_ERROR_UNAUTHORIZED, "Invalid claim token");
    }

    if (batch.claim.leaseUntil <= Date.now()) {
      // Lease expired - put back in pending
      batch.status = "pending";
      batch.claim = undefined;
      this.pendingQueue.push(batchId);
      throw new RpcError(RPC_ERROR_EXPIRED, "Claim lease expired");
    }

    // Validate mocks
    this.validateMocks(batch, mocks);

    // Get the run
    const run = this.runs.get(batch.runId);
    if (!run) {
      this.batches.delete(batchId);
      throw new RpcError(RPC_ERROR_NOT_FOUND, "Run is gone");
    }

    if (run.ws.readyState !== WebSocket.OPEN) {
      this.batches.delete(batchId);
      throw new RpcError(RPC_ERROR_NOT_FOUND, "Test process disconnected");
    }

    // Send mock result to test process
    const result: BatchMockResultMessage = {
      type: BATCH_MOCK_RESULT,
      batchId,
      mocks,
    };
    run.ws.send(JSON.stringify(result));

    // Mark as fulfilled and remove
    batch.status = "fulfilled";
    this.batches.delete(batchId);

    this.logger.error(`✅ Delivered ${mocks.length} mock(s) for ${batchId}`);

    return { ok: true, message: `Provided ${mocks.length} mock(s) for ${batchId}` };
  }

  private validateMocks(batch: BatchRecord, mocks: MockResponseDescriptor[]): void {
    const expectedIds = new Set(batch.requests.map((r) => r.requestId));
    const providedIds = new Set<string>();

    for (const mock of mocks) {
      if (!expectedIds.has(mock.requestId)) {
        throw new RpcError(
          RPC_ERROR_CONFLICT,
          `Mock references unknown requestId: ${mock.requestId}`
        );
      }
      if (providedIds.has(mock.requestId)) {
        throw new RpcError(
          RPC_ERROR_CONFLICT,
          `Duplicate mock for requestId: ${mock.requestId}`
        );
      }
      providedIds.add(mock.requestId);
    }

    const missing = Array.from(expectedIds).filter((id) => !providedIds.has(id));
    if (missing.length > 0) {
      throw new RpcError(
        RPC_ERROR_CONFLICT,
        `Missing mocks for requestId(s): ${missing.join(", ")}`
      );
    }
  }

  private releaseBatch(params: ReleaseBatchParams): { ok: boolean } {
    const { adapterId, batchId, claimToken } = params;

    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new RpcError(RPC_ERROR_NOT_FOUND, `Batch not found: ${batchId}`);
    }

    if (batch.status !== "claimed" || !batch.claim) {
      throw new RpcError(RPC_ERROR_CONFLICT, `Batch not in claimed state: ${batchId}`);
    }

    if (batch.claim.adapterId !== adapterId || batch.claim.claimToken !== claimToken) {
      throw new RpcError(RPC_ERROR_UNAUTHORIZED, "Not the owner of this batch");
    }

    // Release back to pending
    batch.status = "pending";
    batch.claim = undefined;
    this.pendingQueue.push(batchId);

    this.logger.error(`🔓 Batch ${batchId} released by adapter`);

    return { ok: true };
  }

  private getBatch(params: GetBatchParams): GetBatchResult {
    const batch = this.batches.get(params.batchId);
    if (!batch) {
      throw new RpcError(RPC_ERROR_NOT_FOUND, `Batch not found: ${params.batchId}`);
    }

    return {
      batchId: batch.batchId,
      runId: batch.runId,
      requests: batch.requests,
      status: batch.status,
      createdAt: batch.createdAt,
      claim: batch.claim
        ? { adapterId: batch.claim.adapterId, leaseUntil: batch.claim.leaseUntil }
        : undefined,
    };
  }

  // ===========================================================================
  // Maintenance
  // ===========================================================================

  private sweepExpiredClaims(): void {
    const now = Date.now();

    for (const batch of this.batches.values()) {
      if (batch.status === "claimed" && batch.claim && batch.claim.leaseUntil <= now) {
        this.logger.warn(`⏰ Claim expired for ${batch.batchId}, returning to pending`);
        batch.status = "pending";
        batch.claim = undefined;
        this.pendingQueue.push(batch.batchId);
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    // Only set idle timer if no runs are connected
    if (this.runs.size === 0) {
      this.idleTimer = setTimeout(() => {
        if (this.runs.size === 0) {
          this.logger.error("💤 No activity, shutting down daemon...");
          this.stop().then(() => process.exit(0));
        }
      }, this.opts.idleShutdownMs);
      this.idleTimer.unref?.();
    }
  }
}

// =============================================================================
// RPC Error
// =============================================================================

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "RpcError";
  }
}
