export const BATCH_MOCK_REQUEST = "BATCH_MOCK_REQUEST" as const;
export const BATCH_MOCK_RESPONSE = "BATCH_MOCK_RESPONSE" as const;

/**
 * Shape of a mock request emitted by the test process.
 */
export interface MockRequestDescriptor {
  requestId: string;
  endpoint: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Shape of the mock data that needs to be returned for a request.
 */
export interface MockResponseDescriptor {
  requestId: string;
  data: unknown;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface BatchMockRequestMessage {
  type: typeof BATCH_MOCK_REQUEST;
  requests: MockRequestDescriptor[];
}

export interface BatchMockResponseMessage {
  type: typeof BATCH_MOCK_RESPONSE;
  batchId: string;
  mocks: MockResponseDescriptor[];
}

export interface PendingBatchSummary {
  batchId: string;
  timestamp: string;
  requestCount: number;
  requests: MockRequestDescriptor[];
}

export interface ProvideBatchMockDataArgs {
  batchId: string;
  mocks: MockResponseDescriptor[];
}

export interface ToolResponseText {
  content: Array<{
    type: "text";
    text: string;
  }>;
}
