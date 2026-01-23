/**
 * MultiDaemonClient - Aggregates multiple daemon connections for cross-project operation.
 *
 * This client discovers all active daemons and can perform operations across them.
 * It's designed for MCP adapters that need to work without knowing the specific project root.
 */

import http from "node:http";
import crypto from "node:crypto";
import {
  discoverAllDaemons,
  readRegistry,
  type DaemonRegistry,
} from "../shared/discovery.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ClaimNextBatchResult,
  ProvideBatchResult,
  GetStatusResult,
  ListRunsResult,
  GetBatchResult,
  RunInfo,
} from "../shared/protocol.js";
import type { MockResponseDescriptor } from "../types.js";

// =============================================================================
// Types
// =============================================================================

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

export interface MultiDaemonClientOptions {
  logger?: Logger;
  cacheDir?: string;
}

interface DaemonConnection {
  registry: DaemonRegistry;
  healthy: boolean;
}

// Extended run info that includes daemon info
export interface ExtendedRunInfo extends RunInfo {
  projectId: string;
  projectRoot: string;
}

// Extended status that aggregates all daemons
export interface AggregatedStatusResult {
  daemons: (GetStatusResult & { healthy: boolean })[];
  totalRuns: number;
  totalPending: number;
  totalClaimed: number;
}

// =============================================================================
// MultiDaemonClient
// =============================================================================

export class MultiDaemonClient {
  private readonly logger: Logger;
  private readonly cacheDir?: string;
  private readonly adapterId: string;

  constructor(opts: MultiDaemonClientOptions = {}) {
    this.logger = opts.logger ?? console;
    this.cacheDir = opts.cacheDir;
    this.adapterId = crypto.randomUUID();
  }

  // ===========================================================================
  // Discovery
  // ===========================================================================

  /**
   * Discover all active and healthy daemons.
   */
  async discoverDaemons(): Promise<DaemonConnection[]> {
    return discoverAllDaemons(this.cacheDir);
  }

  // ===========================================================================
  // Aggregated RPC Methods
  // ===========================================================================

  /**
   * Get aggregated status from all daemons.
   */
  async getAggregatedStatus(): Promise<AggregatedStatusResult> {
    const daemons = await this.discoverDaemons();
    const statuses: (GetStatusResult & { healthy: boolean })[] = [];
    let totalRuns = 0;
    let totalPending = 0;
    let totalClaimed = 0;

    for (const { registry, healthy } of daemons) {
      if (!healthy) {
        statuses.push({
          version: registry.version,
          projectId: registry.projectId,
          projectRoot: registry.projectRoot,
          pid: registry.pid,
          uptime: 0,
          runs: 0,
          pending: 0,
          claimed: 0,
          totalBatches: 0,
          healthy: false,
        });
        continue;
      }

      try {
        const status = await this.rpc<GetStatusResult>(registry, "getStatus", {});
        statuses.push({ ...status, healthy: true });
        totalRuns += status.runs;
        totalPending += status.pending;
        totalClaimed += status.claimed;
      } catch (error) {
        this.logger.warn(`Failed to get status from daemon ${registry.projectId}: ${error}`);
        statuses.push({
          version: registry.version,
          projectId: registry.projectId,
          projectRoot: registry.projectRoot,
          pid: registry.pid,
          uptime: 0,
          runs: 0,
          pending: 0,
          claimed: 0,
          totalBatches: 0,
          healthy: false,
        });
      }
    }

    return { daemons: statuses, totalRuns, totalPending, totalClaimed };
  }

  /**
   * List all runs across all daemons.
   */
  async listAllRuns(): Promise<ExtendedRunInfo[]> {
    const daemons = await this.discoverDaemons();
    const allRuns: ExtendedRunInfo[] = [];

    for (const { registry, healthy } of daemons) {
      if (!healthy) continue;

      try {
        const result = await this.rpc<ListRunsResult>(registry, "listRuns", {});
        for (const run of result.runs) {
          allRuns.push({
            ...run,
            projectId: registry.projectId,
            projectRoot: registry.projectRoot,
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to list runs from daemon ${registry.projectId}: ${error}`);
      }
    }

    return allRuns;
  }

  /**
   * Claim the next available batch from any daemon.
   * Searches through all daemons in order until finding one with a pending batch.
   */
  async claimNextBatch(args: {
    runId?: string;
    leaseMs?: number;
  }): Promise<(ClaimNextBatchResult & { projectId: string; projectRoot: string }) | null> {
    const daemons = await this.discoverDaemons();

    for (const { registry, healthy } of daemons) {
      if (!healthy) continue;

      try {
        const result = await this.rpc<ClaimNextBatchResult | null>(registry, "claimNextBatch", {
          adapterId: this.adapterId,
          runId: args.runId,
          leaseMs: args.leaseMs,
        });

        if (result) {
          return {
            ...result,
            projectId: registry.projectId,
            projectRoot: registry.projectRoot,
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to claim batch from daemon ${registry.projectId}: ${error}`);
      }
    }

    return null;
  }

  /**
   * Provide mock data for a batch.
   * Automatically routes to the correct daemon based on batchId.
   */
  async provideBatch(args: {
    batchId: string;
    claimToken: string;
    mocks: MockResponseDescriptor[];
  }): Promise<ProvideBatchResult> {
    // Extract runId from batchId to find the right daemon
    // batchId format: "batch:{runId}:{seq}"
    const parts = args.batchId.split(":");
    if (parts.length < 2) {
      return { ok: false, message: `Invalid batchId format: ${args.batchId}` };
    }

    const daemons = await this.discoverDaemons();

    // Try all daemons until we find one that has this batch
    for (const { registry, healthy } of daemons) {
      if (!healthy) continue;

      try {
        const result = await this.rpc<ProvideBatchResult>(registry, "provideBatch", {
          adapterId: this.adapterId,
          batchId: args.batchId,
          claimToken: args.claimToken,
          mocks: args.mocks,
        });
        return result;
      } catch (error) {
        // Check if it's a "not found" error - if so, try next daemon
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not found") || msg.includes("Not found")) {
          continue;
        }
        // Other error - return it
        return { ok: false, message: msg };
      }
    }

    return { ok: false, message: `Batch not found: ${args.batchId}` };
  }

  /**
   * Release a batch.
   */
  async releaseBatch(args: {
    batchId: string;
    claimToken: string;
    reason?: string;
  }): Promise<{ ok: boolean; message?: string }> {
    const daemons = await this.discoverDaemons();

    for (const { registry, healthy } of daemons) {
      if (!healthy) continue;

      try {
        const result = await this.rpc<{ ok: boolean }>(registry, "releaseBatch", {
          adapterId: this.adapterId,
          batchId: args.batchId,
          claimToken: args.claimToken,
          reason: args.reason,
        });
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not found") || msg.includes("Not found")) {
          continue;
        }
        return { ok: false, message: msg };
      }
    }

    return { ok: false, message: `Batch not found: ${args.batchId}` };
  }

  /**
   * Get a specific batch by ID.
   */
  async getBatch(batchId: string): Promise<GetBatchResult | null> {
    const daemons = await this.discoverDaemons();

    for (const { registry, healthy } of daemons) {
      if (!healthy) continue;

      try {
        const result = await this.rpc<GetBatchResult>(registry, "getBatch", { batchId });
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("not found") || msg.includes("Not found")) {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  // ===========================================================================
  // Internal RPC
  // ===========================================================================

  private rpc<T>(
    registry: DaemonRegistry,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          socketPath: registry.ipcPath,
          path: "/control",
          headers: {
            "content-type": "application/json",
            "x-mock-mcp-token": registry.token,
          },
          timeout: 30000,
        },
        (res) => {
          let buf = "";
          res.on("data", (chunk) => (buf += chunk));
          res.on("end", () => {
            try {
              const response = JSON.parse(buf) as JsonRpcResponse;
              if (response.error) {
                reject(new Error(response.error.message));
              } else {
                resolve(response.result as T);
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on("error", (err) => {
        reject(new Error(`Daemon connection failed: ${err.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Daemon request timeout"));
      });

      req.end(JSON.stringify(payload));
    });
  }
}
