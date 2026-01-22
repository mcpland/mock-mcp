/**
 * LLM mocking utilities for integration tests.
 *
 * Provides:
 * - ScriptedLLM: Deterministic LLM for testing
 * - LLM interface types
 * - Agent loop implementation
 * - Auto-patching LLM wrapper for dynamic batch info
 */

import crypto from "node:crypto";
import { DaemonClient } from "../../src/adapter/daemon-client.js";
import type { MockResponseDescriptor } from "../../src/types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tool specification (similar to what MCP returns)
 */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * LLM response content types
 */
export type LLMContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * LLM interface that can be mocked
 */
export interface LLM {
  create(args: {
    messages: LLMMessage[];
    tools: ToolSpec[];
  }): Promise<{ content: LLMContent[] }>;
}

/**
 * Message in a conversation
 */
export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string | LLMContent[];
}

/**
 * Agent context for running the agent loop
 */
export interface AgentContext {
  daemon: DaemonClient;
  llm: LLM;
  adapterId: string;
}

/**
 * Result of running the agent loop
 */
export interface AgentResult {
  finalText: string[];
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  iterations: number;
}

// =============================================================================
// ScriptedLLM
// =============================================================================

/**
 * A scripted LLM that returns predefined responses in sequence.
 * Perfect for integration testing without real LLM calls.
 */
export class ScriptedLLM implements LLM {
  private callCount = 0;
  private readonly callLog: Array<{
    messages: LLMMessage[];
    tools: ToolSpec[];
  }> = [];

  constructor(private script: Array<{ content: LLMContent[] }>) {}

  async create(args: { messages: LLMMessage[]; tools: ToolSpec[] }) {
    this.callLog.push({ messages: args.messages, tools: args.tools });

    const next = this.script[this.callCount++];
    if (!next) {
      throw new Error(
        `ScriptedLLM: script exhausted after ${this.callCount - 1} calls`
      );
    }
    return next;
  }

  getCallLog() {
    return this.callLog;
  }

  getCallCount() {
    return this.callCount;
  }
}

// =============================================================================
// Auto-Patching LLM Wrapper
// =============================================================================

/**
 * Options for creating an auto-patching LLM wrapper.
 */
export interface AutoPatchingLLMOptions {
  /** Tool names that need batch info patching (default: ['provide_batch_mock_data', 'release_batch']) */
  patchableTools?: string[];
}

/**
 * Create an LLM wrapper that automatically patches tool calls with real batch info.
 *
 * This solves the problem where scripted responses need dynamic batch IDs and claim tokens.
 */
export function createAutoPatchingLLM(
  baseLlm: LLM,
  options: AutoPatchingLLMOptions = {}
): LLM {
  const patchableTools = options.patchableTools ?? ["provide_batch_mock_data", "release_batch"];
  let capturedBatchInfo: { batchId: string; claimToken: string } | null = null;

  return {
    create: async (args) => {
      const response = await baseLlm.create(args);

      // Extract batch info from previous tool results in messages
      for (const msg of args.messages) {
        if (typeof msg.content === "string") {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed.content) {
              const result = JSON.parse(parsed.content);
              if (result?.batchId && result?.claimToken) {
                capturedBatchInfo = {
                  batchId: result.batchId,
                  claimToken: result.claimToken,
                };
              }
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }

      // Patch tool calls with captured batch info
      if (capturedBatchInfo) {
        for (const content of response.content) {
          if (content.type === "tool_use" && patchableTools.includes(content.name)) {
            content.input.batchId = capturedBatchInfo.batchId;
            content.input.claimToken = capturedBatchInfo.claimToken;
          }
        }
      }

      return response;
    },
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * Get available tools from the daemon (simulating MCP tools/list)
 */
export function getAvailableTools(): ToolSpec[] {
  return [
    {
      name: "get_status",
      description: "Get daemon status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_runs",
      description: "List active test runs",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "claim_next_batch",
      description: "Claim the next pending batch",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          leaseMs: { type: "number" },
        },
      },
    },
    {
      name: "provide_batch_mock_data",
      description: "Provide mock data for a claimed batch",
      inputSchema: {
        type: "object",
        properties: {
          batchId: { type: "string" },
          claimToken: { type: "string" },
          mocks: { type: "array" },
        },
        required: ["batchId", "claimToken", "mocks"],
      },
    },
    {
      name: "release_batch",
      description: "Release a claimed batch",
      inputSchema: {
        type: "object",
        properties: {
          batchId: { type: "string" },
          claimToken: { type: "string" },
        },
        required: ["batchId", "claimToken"],
      },
    },
  ];
}

// =============================================================================
// Tool Execution
// =============================================================================

/**
 * Execute a tool call against the daemon
 */
export async function executeTool(
  ctx: AgentContext,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ result: unknown; isError: boolean }> {
  try {
    switch (toolName) {
      case "get_status": {
        const result = await ctx.daemon.getStatus();
        return { result, isError: false };
      }
      case "list_runs": {
        const result = await ctx.daemon.listRuns();
        return { result, isError: false };
      }
      case "claim_next_batch": {
        const result = await ctx.daemon.claimNextBatch({
          runId: toolInput.runId as string | undefined,
          leaseMs: toolInput.leaseMs as number | undefined,
        });
        return { result, isError: false };
      }
      case "provide_batch_mock_data": {
        const result = await ctx.daemon.provideBatch({
          batchId: toolInput.batchId as string,
          claimToken: toolInput.claimToken as string,
          mocks: toolInput.mocks as MockResponseDescriptor[],
        });
        return { result, isError: false };
      }
      case "release_batch": {
        const result = await ctx.daemon.releaseBatch({
          batchId: toolInput.batchId as string,
          claimToken: toolInput.claimToken as string,
          reason: toolInput.reason as string | undefined,
        });
        return { result, isError: false };
      }
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (error) {
    return {
      result: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

// =============================================================================
// Agent Loop
// =============================================================================

export interface RunAgentOptions {
  ctx: AgentContext;
  query: string;
  maxIterations?: number;
}

/**
 * Run the agent loop - this is the core LLM + MCP integration pattern.
 */
export async function runAgent(params: RunAgentOptions): Promise<AgentResult> {
  const { ctx, query, maxIterations = 10 } = params;
  const tools = getAvailableTools();

  const messages: LLMMessage[] = [{ role: "user", content: query }];
  const finalText: string[] = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }> = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // Call LLM
    const response = await ctx.llm.create({ messages, tools });

    let hasToolCall = false;

    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
        continue;
      }

      if (content.type === "tool_use") {
        hasToolCall = true;

        // Execute the tool
        const { result, isError } = await executeTool(
          ctx,
          content.name,
          content.input
        );

        toolCalls.push({
          name: content.name,
          input: content.input,
          result,
        });

        // Add assistant's tool use to conversation
        messages.push({
          role: "assistant",
          content: response.content,
        });

        // Add tool result as user message
        messages.push({
          role: "user",
          content: JSON.stringify({
            type: "tool_result",
            tool_use_id: content.id,
            content: JSON.stringify(result),
            is_error: isError,
          }),
        });

        // Break to let LLM see the result
        break;
      }
    }

    if (!hasToolCall) {
      // No more tool calls, agent is done
      break;
    }
  }

  return { finalText, toolCalls, iterations };
}

// =============================================================================
// Helper Factories
// =============================================================================

/**
 * Create an AgentContext with a new adapter ID.
 */
export function createAgentContext(
  daemon: DaemonClient,
  llm: LLM
): AgentContext {
  return {
    daemon,
    llm,
    adapterId: crypto.randomUUID(),
  };
}
