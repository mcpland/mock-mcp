import { BatchMockCollector } from "./batch-mock-collector.js";
import type {
  BatchMockCollectorOptions,
  RequestMockOptions,
} from "./batch-mock-collector.js";
import type { ResolvedMock } from "../types.js";
import { isEnabled } from "./util.js";

/**
 * Options for connecting to the mock-mcp daemon.
 */
export type ConnectOptions = BatchMockCollectorOptions | undefined;

/**
 * Interface for the mock client returned by connect().
 */
export interface MockClient {
  waitUntilReady(): Promise<void>;
  requestMock<T = unknown>(
    endpoint: string,
    method: string,
    options?: RequestMockOptions
  ): Promise<ResolvedMock<T>>;
  waitForPendingRequests(): Promise<void>;
  close(code?: number): Promise<void>;
  /** Get the unique run ID for this connection */
  getRunId(): string;
}

/**
 * A no-op mock client used when MOCK_MCP is not enabled.
 */
class DisabledMockClient implements MockClient {
  private readonly runId = "disabled";

  async waitUntilReady(): Promise<void> {
    return;
  }

  async requestMock<T>(): Promise<ResolvedMock<T>> {
    throw new Error(
      "[mock-mcp] MOCK_MCP is not enabled. Set MOCK_MCP=1 to enable mock generation."
    );
  }

  async waitForPendingRequests(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }

  getRunId(): string {
    return this.runId;
  }
}

/**
 * Connect to the mock-mcp daemon for AI-assisted mock generation.
 *
 * This function:
 * 1. Automatically discovers or starts the daemon for your project
 * 2. Establishes a WebSocket connection via IPC
 * 3. Returns a MockClient for requesting mocks
 *
 * The daemon uses Unix Domain Sockets (macOS/Linux) or Named Pipes (Windows)
 * instead of TCP ports, eliminating port conflicts when multiple MCP clients
 * are running simultaneously.
 *
 * @example
 * ```typescript
 * import { connect } from 'mock-mcp';
 *
 * const client = await connect();
 *
 * const mock = await client.requestMock<User>('/api/users/1', 'GET');
 * console.log(mock.data); // AI-generated mock data
 *
 * await client.close();
 * ```
 */
export const connect = async (
  options?: ConnectOptions
): Promise<MockClient> => {
  const logger = options?.logger ?? console;
  const startTime = Date.now();

  logger.log("[mock-mcp] connect() called");
  logger.log(`[mock-mcp]   PID: ${process.pid}`);
  logger.log(`[mock-mcp]   CWD: ${process.cwd()}`);
  logger.log(`[mock-mcp]   MOCK_MCP env: ${process.env.MOCK_MCP ?? "(not set)"}`);

  if (!isEnabled()) {
    logger.log("[mock-mcp] Skipping (set MOCK_MCP=1 to enable)");
    return new DisabledMockClient();
  }

  logger.log("[mock-mcp] Creating BatchMockCollector...");

  const collector = new BatchMockCollector(options ?? {});
  const runId = collector.getRunId();

  logger.log(`[mock-mcp] Run ID: ${runId}`);
  logger.log("[mock-mcp] Waiting for connection to be ready...");

  try {
    await collector.waitUntilReady();
    const elapsed = Date.now() - startTime;
    const registry = collector.getRegistry();

    logger.log("[mock-mcp] ========== Connection Established ==========");
    logger.log(`[mock-mcp]   Run ID: ${runId}`);
    logger.log(`[mock-mcp]   Daemon PID: ${registry?.pid ?? "unknown"}`);
    logger.log(`[mock-mcp]   Project ID: ${registry?.projectId ?? "unknown"}`);
    logger.log(`[mock-mcp]   IPC Path: ${registry?.ipcPath ?? "unknown"}`);
    logger.log(`[mock-mcp]   Connection time: ${elapsed}ms`);
    logger.log("[mock-mcp] ==============================================");

    return collector;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error("[mock-mcp] ========== Connection Failed ==========");
    logger.error(`[mock-mcp]   Run ID: ${runId}`);
    logger.error(`[mock-mcp]   Error: ${error instanceof Error ? error.message : String(error)}`);
    logger.error(`[mock-mcp]   Elapsed time: ${elapsed}ms`);
    logger.error("[mock-mcp] =========================================");
    throw error;
  }
};
