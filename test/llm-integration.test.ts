/**
 * LLM Mock Integration Tests
 *
 * These tests verify the complete agent loop with a ScriptedLLM:
 * - Agent fetches tools via MCP client
 * - LLM (mocked) produces tool calls
 * - Agent invokes tools via MCP client
 * - Tool results are fed back to LLM
 * - LLM produces final response
 *
 * This tests the full flow:
 * Test Process → Daemon → Adapter/Agent (with ScriptedLLM) → Daemon → Test Process
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  createTestDaemon,
  cleanupTestDaemon,
  createTestClient,
  createDaemonClient,
  sleep,
  type TestContext,
} from "./helpers/daemon-test-utils.js";
import {
  ScriptedLLM,
  createAutoPatchingLLM,
  runAgent,
  createAgentContext,
  type LLMContent,
  type AgentContext,
  type LLM,
} from "./helpers/llm-test-utils.js";
import type { MockRequestDescriptor } from "../src/types.js";

// =============================================================================
// Tests
// =============================================================================

describe.sequential("LLM Mock Integration Tests", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestDaemon();
  });

  afterEach(async () => {
    if (ctx?.daemon) {
      await cleanupTestDaemon(ctx);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 1: Basic Agent Loop - Claim and Provide Mock
  // ---------------------------------------------------------------------------
  it("should complete full agent loop: claim batch and provide mock", async () => {
    // 1. Create a test client (simulating test process)
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);

    // 2. Test client sends a batch request
    testClient.sendBatch([
      {
        requestId: "req-1",
        endpoint: "/api/users",
        method: "GET",
        metadata: {
          schema: {
            type: "array",
            items: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } } },
          },
        },
      },
    ]);

    // Wait for batch to be registered
    await sleep(50);

    // 3. Create agent context with ScriptedLLM
    const daemonClient = createDaemonClient(ctx.registry);
    const llm = new ScriptedLLM([
      // First call: LLM decides to claim the batch
      {
        content: [
          { type: "text", text: "I'll claim the pending batch first." },
          {
            type: "tool_use",
            id: "call-1",
            name: "claim_next_batch",
            input: {},
          },
        ],
      },
      // Second call: LLM sees the batch and provides mock data
      {
        content: [
          { type: "text", text: "Now I'll provide the mock data." },
          {
            type: "tool_use",
            id: "call-2",
            name: "provide_batch_mock_data",
            input: {
              batchId: "WILL_BE_REPLACED",
              claimToken: "WILL_BE_REPLACED",
              mocks: [
                {
                  requestId: "req-1",
                  data: [
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                  ],
                },
              ],
            },
          },
        ],
      },
      // Third call: LLM confirms completion
      {
        content: [{ type: "text", text: "Mock data has been provided successfully!" }],
      },
    ]);

    // 4. Run agent - but we need to intercept to get real batch info
    const agentCtx: AgentContext = {
      daemon: daemonClient,
      llm: {
        create: async (args) => {
          const response = await llm.create(args);

          // If we just claimed a batch, update the next response with real values
          for (const msg of args.messages) {
            if (typeof msg.content === "string" && msg.content.includes("tool_result")) {
              const toolResult = JSON.parse(msg.content);
              const result = JSON.parse(toolResult.content);

              // If this was a claim result, update the script
              if (result?.batchId && result?.claimToken) {
                for (const content of response.content) {
                  if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
                    content.input.batchId = result.batchId;
                    content.input.claimToken = result.claimToken;
                  }
                }
              }
            }
          }

          return response;
        },
      },
      adapterId: crypto.randomUUID(),
    };

    // 5. Run the agent
    const agentResult = await runAgent({
      ctx: agentCtx,
      query: "Please handle the pending mock request for /api/users",
    });

    // 6. Verify agent behavior
    expect(agentResult.toolCalls.length).toBe(2);
    expect(agentResult.toolCalls[0]?.name).toBe("claim_next_batch");
    expect(agentResult.toolCalls[1]?.name).toBe("provide_batch_mock_data");
    expect(agentResult.finalText).toContain("Mock data has been provided successfully!");

    // 7. Verify test client received the mock
    const mockResult = await testClient.waitForResult();
    expect(mockResult.mocks).toHaveLength(1);
    expect(mockResult.mocks[0]?.data).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Agent Gets Status Before Processing
  // ---------------------------------------------------------------------------
  it("should handle multi-step workflow: status → claim → provide", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    testClient.sendBatch([
      { requestId: "req-1", endpoint: "/api/products", method: "GET" },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);

    // Track what the agent does
    const executedTools: string[] = [];
    let capturedBatchInfo: { batchId: string; claimToken: string } | null = null;

    const llm = new ScriptedLLM([
      // Step 1: Check status
      {
        content: [
          { type: "tool_use", id: "s1", name: "get_status", input: {} },
        ],
      },
      // Step 2: Claim batch
      {
        content: [
          { type: "tool_use", id: "s2", name: "claim_next_batch", input: {} },
        ],
      },
      // Step 3: Provide mock (will be patched with real batch info)
      {
        content: [
          {
            type: "tool_use",
            id: "s3",
            name: "provide_batch_mock_data",
            input: {
              batchId: "placeholder",
              claimToken: "placeholder",
              mocks: [{ requestId: "req-1", data: { products: [] } }],
            },
          },
        ],
      },
      // Step 4: Done
      {
        content: [{ type: "text", text: "All done!" }],
      },
    ]);

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        // Capture batch info from previous tool result
        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.claimToken) {
                  capturedBatchInfo = { batchId: result.batchId, claimToken: result.claimToken };
                }
              }
            } catch {
              // Not JSON, ignore
            }
          }
        }

        // Patch provide_batch_mock_data with real values
        if (capturedBatchInfo) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = capturedBatchInfo.batchId;
              content.input.claimToken = capturedBatchInfo.claimToken;
            }
          }
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: {
        daemon: daemonClient,
        llm: wrappedLlm,
        adapterId: crypto.randomUUID(),
      },
      query: "Check status and process any pending batches",
    });

    // Verify the workflow
    expect(result.toolCalls.map((t) => t.name)).toEqual([
      "get_status",
      "claim_next_batch",
      "provide_batch_mock_data",
    ]);

    // Verify status was retrieved
    const statusResult = result.toolCalls[0]?.result as { pending: number };
    expect(statusResult.pending).toBe(1);

    // Verify claim was successful
    const claimResult = result.toolCalls[1]?.result as { batchId: string };
    expect(claimResult.batchId).toMatch(/^batch:/);

    // Verify provide was successful
    const provideResult = result.toolCalls[2]?.result as { ok: boolean };
    expect(provideResult.ok).toBe(true);

    // Verify test client got the mock
    const mockResult = await testClient.waitForResult();
    expect(mockResult.mocks[0]?.data).toEqual({ products: [] });

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Agent Handles Empty Queue Gracefully
  // ---------------------------------------------------------------------------
  it("should handle no pending batches gracefully", async () => {
    const daemonClient = createDaemonClient(ctx.registry);

    const llm = new ScriptedLLM([
      // Try to claim when nothing is pending
      {
        content: [
          { type: "tool_use", id: "c1", name: "claim_next_batch", input: {} },
        ],
      },
      // LLM sees null result and responds appropriately
      {
        content: [{ type: "text", text: "No pending batches to process." }],
      },
    ]);

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm, adapterId: crypto.randomUUID() },
      query: "Process any pending batches",
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("claim_next_batch");
    expect(result.toolCalls[0]?.result).toBeNull();
    expect(result.finalText).toContain("No pending batches to process.");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Agent Can Release Batch
  // ---------------------------------------------------------------------------
  it("should allow agent to release a batch without providing mocks", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    testClient.sendBatch([
      { requestId: "req-1", endpoint: "/api/complex", method: "POST" },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);
    let capturedBatchInfo: { batchId: string; claimToken: string } | null = null;

    const llm = new ScriptedLLM([
      // Claim
      {
        content: [
          { type: "tool_use", id: "c1", name: "claim_next_batch", input: {} },
        ],
      },
      // Release (decide can't handle this request)
      {
        content: [
          {
            type: "tool_use",
            id: "r1",
            name: "release_batch",
            input: { batchId: "placeholder", claimToken: "placeholder" },
          },
        ],
      },
      // Done
      {
        content: [{ type: "text", text: "Released the batch for another adapter." }],
      },
    ]);

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        // Extract batch info from previous results
        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.claimToken) {
                  capturedBatchInfo = result;
                }
              }
            } catch {
              // ignore
            }
          }
        }

        // Patch release_batch
        if (capturedBatchInfo) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "release_batch") {
              content.input.batchId = capturedBatchInfo.batchId;
              content.input.claimToken = capturedBatchInfo.claimToken;
            }
          }
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Try to claim but then release",
    });

    expect(result.toolCalls.map((t) => t.name)).toEqual([
      "claim_next_batch",
      "release_batch",
    ]);

    const releaseResult = result.toolCalls[1]?.result as { ok: boolean };
    expect(releaseResult.ok).toBe(true);

    // Verify batch is back in pending queue
    const status = await daemonClient.getStatus();
    expect(status.pending).toBe(1);

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Multiple Batches Sequential Processing
  // ---------------------------------------------------------------------------
  it("should process multiple batches sequentially", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);

    // Send two batches
    testClient.sendBatch([
      { requestId: "req-1", endpoint: "/api/users", method: "GET" },
    ]);
    testClient.sendBatch([
      { requestId: "req-2", endpoint: "/api/products", method: "GET" },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);
    const batchInfos: Array<{ batchId: string; claimToken: string }> = [];

    const llm = new ScriptedLLM([
      // Claim first batch
      { content: [{ type: "tool_use", id: "c1", name: "claim_next_batch", input: {} }] },
      // Provide first mock
      {
        content: [{
          type: "tool_use",
          id: "p1",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "placeholder",
            mocks: [{ requestId: "req-1", data: { users: [{ id: 1 }] } }],
          },
        }],
      },
      // Claim second batch
      { content: [{ type: "tool_use", id: "c2", name: "claim_next_batch", input: {} }] },
      // Provide second mock
      {
        content: [{
          type: "tool_use",
          id: "p2",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "placeholder",
            mocks: [{ requestId: "req-2", data: { products: [{ id: 100 }] } }],
          },
        }],
      },
      // Done
      { content: [{ type: "text", text: "Processed 2 batches!" }] },
    ]);

    let currentBatch: { batchId: string; claimToken: string } | null = null;

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        // Extract batch info
        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.claimToken) {
                  currentBatch = result;
                  batchInfos.push(result);
                }
              }
            } catch { /* ignore */ }
          }
        }

        // Patch provide calls
        if (currentBatch) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = currentBatch.batchId;
              content.input.claimToken = currentBatch.claimToken;
            }
          }
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Process all pending batches",
    });

    expect(result.toolCalls.map((t) => t.name)).toEqual([
      "claim_next_batch",
      "provide_batch_mock_data",
      "claim_next_batch",
      "provide_batch_mock_data",
    ]);

    // Verify both mocks were received
    const result1 = await testClient.waitForResult();
    const result2 = await testClient.waitForResult();

    const allMocks = [...result1.mocks, ...result2.mocks];
    expect(allMocks).toHaveLength(2);

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 6: Error Handling - Invalid Claim Token
  // ---------------------------------------------------------------------------
  it("should handle error when providing with invalid token", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    testClient.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);
    let capturedBatchId: string | null = null;

    const llm = new ScriptedLLM([
      // Claim
      { content: [{ type: "tool_use", id: "c1", name: "claim_next_batch", input: {} }] },
      // Try to provide with wrong token
      {
        content: [{
          type: "tool_use",
          id: "p1",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "wrong-token", // Deliberately wrong
            mocks: [{ requestId: "req-1", data: {} }],
          },
        }],
      },
      // LLM sees error and responds
      { content: [{ type: "text", text: "Failed to provide mock - invalid token." }] },
    ]);

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        // Get batch ID but keep wrong token
        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId) {
                  capturedBatchId = result.batchId;
                }
              }
            } catch { /* ignore */ }
          }
        }

        if (capturedBatchId) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = capturedBatchId;
              // Keep the wrong token
            }
          }
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Process batch with wrong token",
    });

    // The provide call should have failed
    const provideCall = result.toolCalls.find((t) => t.name === "provide_batch_mock_data");
    expect(provideCall?.result).toContain("Invalid claim token");

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 7: LLM Receives Metadata from Batch
  // ---------------------------------------------------------------------------
  it("should pass metadata from test to agent for schema-aware generation", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    testClient.sendBatch([
      {
        requestId: "req-1",
        endpoint: "/api/users/1",
        method: "GET",
        metadata: {
          schemaUrl: "https://api.example.com/openapi.json#/paths/~1users~1{id}/get",
          schema: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
              email: { type: "string", format: "email" },
            },
            required: ["id", "name", "email"],
          },
          instructions: "Return a user with realistic data",
        },
      },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);
    let receivedMetadata: Record<string, unknown> | undefined;
    let capturedBatch: { batchId: string; claimToken: string; requests: MockRequestDescriptor[] } | null = null;

    const llm = new ScriptedLLM([
      { content: [{ type: "tool_use", id: "c1", name: "claim_next_batch", input: {} }] },
      // The mock data should match the schema from metadata
      {
        content: [{
          type: "tool_use",
          id: "p1",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "placeholder",
            mocks: [{
              requestId: "req-1",
              data: {
                id: 1,
                name: "John Doe",
                email: "john.doe@example.com",
              },
            }],
          },
        }],
      },
      { content: [{ type: "text", text: "Generated schema-compliant mock!" }] },
    ]);

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.requests) {
                  capturedBatch = result;
                  // Capture metadata from the request
                  receivedMetadata = result.requests[0]?.metadata;
                }
              }
            } catch { /* ignore */ }
          }
        }

        if (capturedBatch) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = capturedBatch.batchId;
              content.input.claimToken = capturedBatch.claimToken;
            }
          }
        }

        return response;
      },
    };

    await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Generate mock based on schema",
    });

    // Verify metadata was passed through
    expect(receivedMetadata).toBeDefined();
    expect(receivedMetadata?.schemaUrl).toBe("https://api.example.com/openapi.json#/paths/~1users~1{id}/get");
    expect(receivedMetadata?.schema).toEqual({
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
      },
      required: ["id", "name", "email"],
    });
    expect(receivedMetadata?.instructions).toBe("Return a user with realistic data");

    // Verify mock was received
    const mockResult = await testClient.waitForResult();
    expect(mockResult.mocks[0]?.data).toEqual({
      id: 1,
      name: "John Doe",
      email: "john.doe@example.com",
    });

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 8: Full E2E with BatchMockCollector-like Pattern
  // ---------------------------------------------------------------------------
  it("should work with realistic test flow simulation", async () => {
    // This test simulates what happens in a real test:
    // 1. Test process requests mock for /api/users
    // 2. Agent sees the request with metadata
    // 3. Agent generates appropriate mock
    // 4. Test process receives and uses the mock

    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);

    // Simulate a test that needs to mock a user list endpoint
    const userListSchema = {
      summary: "List all users",
      response: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            role: { type: "string", enum: ["admin", "user", "guest"] },
          },
        },
      },
    };

    testClient.sendBatch([
      {
        requestId: "test-req-1",
        endpoint: "/api/users",
        method: "GET",
        metadata: {
          schema: userListSchema,
          testFile: "test/users.test.ts",
          testName: "should display user list",
          instructions: "Return 3 users with different roles",
        },
      },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);
    let batchInfo: { batchId: string; claimToken: string } | null = null;

    // The LLM would see the metadata and generate appropriate mock
    const llm = new ScriptedLLM([
      { content: [{ type: "tool_use", id: "c1", name: "claim_next_batch", input: {} }] },
      {
        content: [{
          type: "tool_use",
          id: "p1",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "placeholder",
            mocks: [{
              requestId: "test-req-1",
              data: [
                { id: 1, name: "Admin User", role: "admin" },
                { id: 2, name: "Regular User", role: "user" },
                { id: 3, name: "Guest User", role: "guest" },
              ],
            }],
          },
        }],
      },
      { content: [{ type: "text", text: "Generated 3 users with different roles as requested." }] },
    ]);

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.claimToken) {
                  batchInfo = result;
                }
              }
            } catch { /* ignore */ }
          }
        }

        if (batchInfo) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = batchInfo.batchId;
              content.input.claimToken = batchInfo.claimToken;
            }
          }
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Handle mock requests for the test",
    });

    // Verify the agent completed successfully
    expect(result.iterations).toBe(3);
    expect(result.finalText).toContain("Generated 3 users with different roles as requested.");

    // Verify the mock data
    const mockResult = await testClient.waitForResult();
    const mockData = mockResult.mocks[0]?.data as Array<{ id: number; name: string; role: string }>;

    expect(mockData).toHaveLength(3);
    expect(mockData.map((u) => u.role)).toEqual(["admin", "user", "guest"]);
    expect(mockData.every((u) => typeof u.id === "number" && typeof u.name === "string")).toBe(true);

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 9: Agent Handles Lease Expiration Gracefully
  // ---------------------------------------------------------------------------
  it("should handle lease expiration and allow retry", async () => {
    const testClient = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    testClient.sendBatch([
      { requestId: "req-1", endpoint: "/api/slow", method: "GET" },
    ]);
    await sleep(50);

    const daemonClient = createDaemonClient(ctx.registry);

    // Script: Agent claims with very short lease, waits too long, then retries
    const llm = new ScriptedLLM([
      // First claim with short lease
      {
        content: [{
          type: "tool_use",
          id: "c1",
          name: "claim_next_batch",
          input: { leaseMs: 30 }, // Very short lease
        }],
      },
      // Try to provide (will fail due to expired lease)
      {
        content: [{
          type: "tool_use",
          id: "p1",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder",
            claimToken: "placeholder",
            mocks: [{ requestId: "req-1", data: { slow: true } }],
          },
        }],
      },
      // Agent sees error and reclaims
      {
        content: [{
          type: "tool_use",
          id: "c2",
          name: "claim_next_batch",
          input: {},
        }],
      },
      // Retry provide with new claim
      {
        content: [{
          type: "tool_use",
          id: "p2",
          name: "provide_batch_mock_data",
          input: {
            batchId: "placeholder2",
            claimToken: "placeholder2",
            mocks: [{ requestId: "req-1", data: { retried: true } }],
          },
        }],
      },
      // Success
      {
        content: [{ type: "text", text: "Successfully retried after lease expiration." }],
      },
    ]);

    let claimCount = 0;
    let currentBatch: { batchId: string; claimToken: string } | null = null;

    const wrappedLlm: LLM = {
      create: async (args) => {
        const response = await llm.create(args);

        // Extract batch info from previous results
        for (const msg of args.messages) {
          if (typeof msg.content === "string") {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.content) {
                const result = JSON.parse(parsed.content);
                if (result?.batchId && result?.claimToken) {
                  claimCount++;
                  currentBatch = result;
                }
              }
            } catch { /* ignore */ }
          }
        }

        // Patch tool calls
        if (currentBatch) {
          for (const content of response.content) {
            if (content.type === "tool_use" && content.name === "provide_batch_mock_data") {
              content.input.batchId = currentBatch.batchId;
              content.input.claimToken = currentBatch.claimToken;
            }
          }
        }

        // Simulate slow processing after first claim to trigger lease expiration
        if (claimCount === 1) {
          await sleep(80); // Wait for lease to expire
        }

        return response;
      },
    };

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm: wrappedLlm, adapterId: crypto.randomUUID() },
      query: "Handle slow request with potential timeout",
    });

    // Agent should have claimed twice (once expired, once successful)
    const claimCalls = result.toolCalls.filter((t) => t.name === "claim_next_batch");
    expect(claimCalls.length).toBe(2);

    // The first provide should have failed (batch returned to pending after lease expiration)
    const firstProvide = result.toolCalls.find(
      (t) => t.name === "provide_batch_mock_data" && typeof t.result === "string"
    );
    expect(firstProvide?.result).toMatch(/not in claimed state|expired/);

    // The second provide should have succeeded
    const provideCalls = result.toolCalls.filter((t) => t.name === "provide_batch_mock_data");
    const lastProvide = provideCalls[provideCalls.length - 1];
    expect((lastProvide?.result as { ok?: boolean })?.ok).toBe(true);

    // Verify test client got the mock
    const mockResult = await testClient.waitForResult();
    expect(mockResult.mocks[0]?.data).toEqual({ retried: true });

    testClient.close();
  });

  // ---------------------------------------------------------------------------
  // Test 10: Agent Timeout When No Batches Available
  // ---------------------------------------------------------------------------
  it("should handle max iterations when waiting for batches", async () => {
    const daemonClient = createDaemonClient(ctx.registry);

    // Script: Agent repeatedly tries to claim but nothing is available
    const llm = new ScriptedLLM([
      { content: [{ type: "tool_use", id: "c1", name: "claim_next_batch", input: {} }] },
      { content: [{ type: "tool_use", id: "c2", name: "claim_next_batch", input: {} }] },
      { content: [{ type: "tool_use", id: "c3", name: "claim_next_batch", input: {} }] },
      { content: [{ type: "text", text: "No batches available after 3 attempts." }] },
    ]);

    const result = await runAgent({
      ctx: { daemon: daemonClient, llm, adapterId: crypto.randomUUID() },
      query: "Try to claim batches",
      maxIterations: 5,
    });

    // All claims should return null
    const claimResults = result.toolCalls
      .filter((t) => t.name === "claim_next_batch")
      .map((t) => t.result);
    
    expect(claimResults).toEqual([null, null, null]);
    expect(result.iterations).toBe(4);
    expect(result.finalText).toContain("No batches available after 3 attempts.");
  });
});

