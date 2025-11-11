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
  // Check environment - skip in CI or if not explicitly enabled
  if (!process.env.MOCK_MCP || process.env.CI) {
    console.log("[mock-mcp] Skipping in CI/non-dev environment");
    return;
  }
  const resolvedOptions: BatchMockCollectorOptions =
    typeof options === "number" ? { port: options } : options ?? {};

  const collector = new BatchMockCollector(resolvedOptions);
  await collector.waitUntilReady();
  return collector;
};
