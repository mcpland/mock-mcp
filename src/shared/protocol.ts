/**
 * Protocol definitions for mock-mcp Daemon communication.
 *
 * Defines message types for:
 * - Test channel (WebSocket /test): Test process ↔ Daemon
 * - Control channel (HTTP /control): Adapter ↔ Daemon (JSON-RPC)
 */

import type { MockRequestDescriptor, MockResponseDescriptor } from "../types.js";

// =============================================================================
// Message Type Constants
// =============================================================================

// Test channel messages
export const HELLO_TEST = "HELLO_TEST" as const;
export const HELLO_ACK = "HELLO_ACK" as const;
export const BATCH_MOCK_REQUEST = "BATCH_MOCK_REQUEST" as const;
export const BATCH_MOCK_RESULT = "BATCH_MOCK_RESULT" as const;
export const HEARTBEAT = "HEARTBEAT" as const;
export const HEARTBEAT_ACK = "HEARTBEAT_ACK" as const;

// Control channel methods (JSON-RPC)
export const RPC_GET_STATUS = "getStatus" as const;
export const RPC_LIST_RUNS = "listRuns" as const;
export const RPC_CLAIM_NEXT_BATCH = "claimNextBatch" as const;
export const RPC_PROVIDE_BATCH = "provideBatch" as const;
export const RPC_RELEASE_BATCH = "releaseBatch" as const;
export const RPC_GET_BATCH = "getBatch" as const;

// =============================================================================
// Test Channel Messages
// =============================================================================

/**
 * HELLO message from test process to daemon.
 * Must be the first message after WebSocket connection.
 */
export interface HelloTestMessage {
  type: typeof HELLO_TEST;
  token: string;
  runId: string;
  pid: number;
  cwd: string;
  testMeta?: {
    testFile?: string;
    testName?: string;
  };
}

/**
 * Acknowledgment of HELLO from daemon.
 */
export interface HelloAckMessage {
  type: typeof HELLO_ACK;
  runId: string;
}

/**
 * Batch mock request from test process.
 */
export interface BatchMockRequestMessage {
  type: typeof BATCH_MOCK_REQUEST;
  runId: string;
  requests: MockRequestDescriptor[];
}

/**
 * Batch mock result from daemon to test process.
 */
export interface BatchMockResultMessage {
  type: typeof BATCH_MOCK_RESULT;
  batchId: string;
  mocks: MockResponseDescriptor[];
}

/**
 * Heartbeat from test process.
 */
export interface HeartbeatMessage {
  type: typeof HEARTBEAT;
  runId: string;
}

/**
 * Heartbeat acknowledgment from daemon.
 */
export interface HeartbeatAckMessage {
  type: typeof HEARTBEAT_ACK;
  runId: string;
}

/**
 * Union type for all test channel messages (from test process).
 */
export type TestChannelIncomingMessage =
  | HelloTestMessage
  | BatchMockRequestMessage
  | HeartbeatMessage;

/**
 * Union type for all test channel messages (from daemon).
 */
export type TestChannelOutgoingMessage =
  | HelloAckMessage
  | BatchMockResultMessage
  | HeartbeatAckMessage;

// =============================================================================
// Control Channel (JSON-RPC)
// =============================================================================

/**
 * JSON-RPC 2.0 request structure.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response structure.
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Error codes
export const RPC_ERROR_PARSE = -32700;
export const RPC_ERROR_INVALID_REQUEST = -32600;
export const RPC_ERROR_METHOD_NOT_FOUND = -32601;
export const RPC_ERROR_INVALID_PARAMS = -32602;
export const RPC_ERROR_INTERNAL = -32603;
export const RPC_ERROR_NOT_FOUND = -32000;
export const RPC_ERROR_UNAUTHORIZED = -32001;
export const RPC_ERROR_CONFLICT = -32002;
export const RPC_ERROR_EXPIRED = -32003;

// =============================================================================
// RPC Parameters and Results
// =============================================================================

/**
 * Parameters for claimNextBatch RPC.
 */
export interface ClaimNextBatchParams {
  adapterId: string;
  runId?: string; // Optional: filter by specific run
  leaseMs?: number; // Default: 30000
}

/**
 * Result of claimNextBatch RPC.
 */
export interface ClaimNextBatchResult {
  batchId: string;
  runId: string;
  requests: MockRequestDescriptor[];
  claimToken: string;
  leaseUntil: number; // Unix timestamp in milliseconds
}

/**
 * Parameters for provideBatch RPC.
 */
export interface ProvideBatchParams {
  adapterId: string;
  batchId: string;
  claimToken: string;
  mocks: MockResponseDescriptor[];
}

/**
 * Result of provideBatch RPC.
 */
export interface ProvideBatchResult {
  ok: boolean;
  message?: string;
}

/**
 * Parameters for releaseBatch RPC.
 */
export interface ReleaseBatchParams {
  adapterId: string;
  batchId: string;
  claimToken: string;
  reason?: string;
}

/**
 * Parameters for getBatch RPC.
 */
export interface GetBatchParams {
  batchId: string;
}

/**
 * Result of getStatus RPC.
 */
export interface GetStatusResult {
  version: string;
  projectId: string;
  projectRoot: string;
  pid: number;
  uptime: number;
  runs: number;
  pending: number;
  claimed: number;
  totalBatches: number;
}

/**
 * Result of listRuns RPC.
 */
export interface ListRunsResult {
  runs: RunInfo[];
}

export interface RunInfo {
  runId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  lastSeen: number;
  pendingBatches: number;
  testMeta?: {
    testFile?: string;
    testName?: string;
  };
}

/**
 * Result of getBatch RPC.
 */
export interface GetBatchResult {
  batchId: string;
  runId: string;
  requests: MockRequestDescriptor[];
  status: BatchStatus;
  createdAt: number;
  claim?: {
    adapterId: string;
    leaseUntil: number;
  };
}

// =============================================================================
// Internal Types
// =============================================================================

export type BatchStatus = "pending" | "claimed" | "fulfilled" | "expired";

export interface RunRecord {
  runId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  lastSeen: number;
  testMeta?: {
    testFile?: string;
    testName?: string;
  };
}

export interface BatchRecord {
  batchId: string;
  runId: string;
  requests: MockRequestDescriptor[];
  createdAt: number;
  status: BatchStatus;
  claim?: {
    adapterId: string;
    claimToken: string;
    leaseUntil: number;
  };
}

// =============================================================================
// Message Validation
// =============================================================================

export function isHelloTestMessage(msg: unknown): msg is HelloTestMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Partial<HelloTestMessage>;
  return (
    m.type === HELLO_TEST &&
    typeof m.token === "string" &&
    typeof m.runId === "string" &&
    typeof m.pid === "number" &&
    typeof m.cwd === "string"
  );
}

export function isBatchMockRequestMessage(
  msg: unknown
): msg is BatchMockRequestMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Partial<BatchMockRequestMessage>;
  return (
    m.type === BATCH_MOCK_REQUEST &&
    typeof m.runId === "string" &&
    Array.isArray(m.requests)
  );
}

export function isHeartbeatMessage(msg: unknown): msg is HeartbeatMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Partial<HeartbeatMessage>;
  return m.type === HEARTBEAT && typeof m.runId === "string";
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Partial<JsonRpcRequest>;
  return (
    m.jsonrpc === "2.0" &&
    (typeof m.id === "string" || typeof m.id === "number") &&
    typeof m.method === "string"
  );
}
