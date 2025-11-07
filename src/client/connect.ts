import { BatchMockCollector } from "./batch-mock-collector.js";
import type { BatchMockCollectorOptions } from "./batch-mock-collector.js";

export type ConnectOptions = string | BatchMockCollectorOptions;

/**
 * Convenience helper that creates a {@link BatchMockCollector} and waits for the
 * underlying WebSocket connection to become ready before resolving.
 */
export const connect = async (
  options: ConnectOptions,
): Promise<BatchMockCollector> => {
  const resolvedOptions =
    typeof options === "string" ? { wsUrl: options } : options;

  const collector = new BatchMockCollector(resolvedOptions);
  await collector.waitUntilReady();
  return collector;
};
