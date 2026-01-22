/**
 * Daemon Client - HTTP/JSON-RPC client for communicating with the Daemon.
 *
 * Used by the MCP Adapter to call daemon RPC methods.
 */

import http from "node:http";
import crypto from "node:crypto";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ClaimNextBatchResult,
  ProvideBatchResult,
  GetStatusResult,
  ListRunsResult,
  GetBatchResult,
} from "../shared/protocol.js";
import type { MockResponseDescriptor } from "../types.js";

// =============================================================================
// Daemon Client
// =============================================================================

export class DaemonClient {
  constructor(
    private readonly ipcPath: string,
    private readonly token: string,
    private readonly adapterId: string
  ) {}

  // ===========================================================================
  // RPC Methods
  // ===========================================================================

  async getStatus(): Promise<GetStatusResult> {
    return this.rpc<GetStatusResult>("getStatus", {});
  }

  async listRuns(): Promise<ListRunsResult> {
    return this.rpc<ListRunsResult>("listRuns", {});
  }

  async claimNextBatch(args: {
    runId?: string;
    leaseMs?: number;
  }): Promise<ClaimNextBatchResult | null> {
    return this.rpc<ClaimNextBatchResult | null>("claimNextBatch", {
      adapterId: this.adapterId,
      runId: args.runId,
      leaseMs: args.leaseMs,
    });
  }

  async provideBatch(args: {
    batchId: string;
    claimToken: string;
    mocks: MockResponseDescriptor[];
  }): Promise<ProvideBatchResult> {
    return this.rpc<ProvideBatchResult>("provideBatch", {
      adapterId: this.adapterId,
      batchId: args.batchId,
      claimToken: args.claimToken,
      mocks: args.mocks,
    });
  }

  async releaseBatch(args: {
    batchId: string;
    claimToken: string;
    reason?: string;
  }): Promise<{ ok: boolean }> {
    return this.rpc<{ ok: boolean }>("releaseBatch", {
      adapterId: this.adapterId,
      batchId: args.batchId,
      claimToken: args.claimToken,
      reason: args.reason,
    });
  }

  async getBatch(batchId: string): Promise<GetBatchResult> {
    return this.rpc<GetBatchResult>("getBatch", { batchId });
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
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
          socketPath: this.ipcPath,
          path: "/control",
          headers: {
            "content-type": "application/json",
            "x-mock-mcp-token": this.token,
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
