import { BatchMockCollector } from "./batch-mock-collector.js";
import type { BatchMockCollectorOptions } from "./batch-mock-collector.js";

export type ConnectOptions = number | BatchMockCollectorOptions | undefined;

/**
 * Convenience helper that creates a {@link BatchMockCollector} and waits for the
 * underlying WebSocket connection to become ready before resolving.
 */
export const connect = async (
  options?: ConnectOptions
): Promise<BatchMockCollector | void> => {
  const isEnabled =
    process.env.MOCK_MCP !== undefined && process.env.MOCK_MCP !== "0";

  if (!isEnabled) {
    console.log("[mock-mcp] Skipping (set MOCK_MCP=1 to enable)");
    return;
  }
  const resolvedOptions: BatchMockCollectorOptions =
    typeof options === "number" ? { port: options } : options ?? {};

  const collector = new BatchMockCollector(resolvedOptions);
  await collector.waitUntilReady();
  return collector;
};
