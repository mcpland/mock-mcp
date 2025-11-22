import { BatchMockCollector } from "./batch-mock-collector.js";
import type {
  BatchMockCollectorOptions,
  RequestMockOptions,
} from "./batch-mock-collector.js";
import type { ResolvedMock } from "../types.js";
import { isEnabled } from "./util.js";

export type ConnectOptions = number | BatchMockCollectorOptions | undefined;
export interface MockClient {
  waitUntilReady(): Promise<void>;
  requestMock<T = unknown>(
    endpoint: string,
    method: string,
    options?: RequestMockOptions
  ): Promise<ResolvedMock<T>>;
  waitForPendingRequests(): Promise<void>;
  close(code?: number): Promise<void>;
}

class DisabledMockClient implements MockClient {
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
}

/**
 * Convenience helper that creates a {@link BatchMockCollector} and waits for the
 * underlying WebSocket connection to become ready before resolving.
 */
export const connect = async (
  options?: ConnectOptions
): Promise<MockClient> => {
  const resolvedOptions: BatchMockCollectorOptions =
    typeof options === "number" ? { port: options } : options ?? {};

  if (!isEnabled()) {
    console.log("[mock-mcp] Skipping (set MOCK_MCP=1 to enable)");
    return new DisabledMockClient();
  }

  const collector = new BatchMockCollector(resolvedOptions);
  await collector.waitUntilReady();
  return collector;
};
