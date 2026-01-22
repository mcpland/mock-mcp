/**
 * Core types for mock-mcp.
 */

// =============================================================================
// Core Types
// =============================================================================

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

/**
 * Resolved mock with typed data.
 */
export interface ResolvedMock<T = unknown>
  extends Omit<MockResponseDescriptor, "data"> {
  data: T;
}
