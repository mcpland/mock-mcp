import { BatchMockCollector } from "./batch-mock-collector.js";
import type { BatchMockCollectorOptions } from "./batch-mock-collector.js";
import { isEnabled } from "./util.js";

export type ConnectOptions = number | BatchMockCollectorOptions | undefined;

/**
 * Convenience helper that creates a {@link BatchMockCollector} and waits for the
 * underlying WebSocket connection to become ready before resolving.
 */
export const connect = async (
  options?: ConnectOptions
): Promise<BatchMockCollector | void> => {
  if (!isEnabled()) {
    console.log("[mock-mcp] Skipping (set MOCK_MCP=1 to enable)");
    return;
  }
  const resolvedOptions: BatchMockCollectorOptions =
    typeof options === "number" ? { port: options } : options ?? {};

  const collector = new BatchMockCollector(resolvedOptions);
  await collector.waitUntilReady();
  return collector;
};
