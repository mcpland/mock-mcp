/**
 * Concurrency tests for the Daemon + Adapter architecture.
 *
 * These tests verify that the new architecture correctly handles:
 * - Multiple adapters claiming batches concurrently
 * - Lease expiration and recovery
 * - Multi-run isolation
 * - Run disconnection cleanup
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
} from "./helpers/index.js";

// =============================================================================
// Tests
// =============================================================================

describe("Daemon Concurrency", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestDaemon();
  });

  afterEach(async () => {
    await cleanupTestDaemon(ctx);
  });

  // ---------------------------------------------------------------------------
  // Test 1: Dual adapter concurrent claim
  // ---------------------------------------------------------------------------
  it("should allow only one adapter to claim a batch", async () => {
    // Create a test client and send a batch
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/users", method: "GET" },
    ]);

    // Create two adapters
    const adapterA = createDaemonClient(ctx.registry);
    const adapterB = createDaemonClient(ctx.registry);

    // Both try to claim concurrently
    const [claimA, claimB] = await Promise.all([
      adapterA.claimNextBatch({}),
      adapterB.claimNextBatch({}),
    ]);

    // Only one should succeed
    const claims = [claimA, claimB].filter((c) => c !== null);
    expect(claims.length).toBe(1);

    // The winner should be able to provide
    const winner = claimA ? adapterA : adapterB;
    const claim = (claimA ?? claimB)!;

    const result = await winner.provideBatch({
      batchId: claim.batchId,
      claimToken: claim.claimToken,
      mocks: [{ requestId: "req-1", data: { id: 1, name: "Test User" } }],
    });

    expect(result.ok).toBe(true);

    // Client should receive the result
    const mockResult = await client.waitForResult();
    expect(mockResult.mocks[0]?.data).toEqual({ id: 1, name: "Test User" });

    client.close();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Lease expiration and recovery
  // ---------------------------------------------------------------------------
  it("should recover batch after lease expiration", async () => {
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);

    const adapterA = createDaemonClient(ctx.registry);
    const adapterB = createDaemonClient(ctx.registry);

    // Adapter A claims with short lease (default 100ms in test)
    const claimA = await adapterA.claimNextBatch({ leaseMs: 50 });
    expect(claimA).not.toBeNull();

    // Wait for lease to expire
    await sleep(80);

    // Adapter B should now be able to claim the same batch
    const claimB = await adapterB.claimNextBatch({});
    expect(claimB).not.toBeNull();
    expect(claimB!.batchId).toBe(claimA!.batchId);

    // Adapter B can provide
    const result = await adapterB.provideBatch({
      batchId: claimB!.batchId,
      claimToken: claimB!.claimToken,
      mocks: [{ requestId: "req-1", data: { recovered: true } }],
    });

    expect(result.ok).toBe(true);

    // Adapter A's old claim token should be rejected
    await expect(
      adapterA.provideBatch({
        batchId: claimA!.batchId,
        claimToken: claimA!.claimToken,
        mocks: [{ requestId: "req-1", data: { old: true } }],
      })
    ).rejects.toThrow();

    client.close();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Wrong claim token rejection
  // ---------------------------------------------------------------------------
  it("should reject provide with wrong claim token", async () => {
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);

    const adapter = createDaemonClient(ctx.registry);
    const claim = await adapter.claimNextBatch({});
    expect(claim).not.toBeNull();

    // Try to provide with wrong token
    await expect(
      adapter.provideBatch({
        batchId: claim!.batchId,
        claimToken: "wrong-token",
        mocks: [{ requestId: "req-1", data: {} }],
      })
    ).rejects.toThrow("Invalid claim token");

    client.close();
  });

  // ---------------------------------------------------------------------------
  // Test 4: Multi-run isolation
  // ---------------------------------------------------------------------------
  it("should isolate batches between runs", async () => {
    const runIdA = crypto.randomUUID();
    const runIdB = crypto.randomUUID();

    const clientA = await createTestClient(
      ctx.registry.ipcPath,
      ctx.registry.token,
      runIdA
    );
    const clientB = await createTestClient(
      ctx.registry.ipcPath,
      ctx.registry.token,
      runIdB
    );

    // Each client sends a batch
    clientA.sendBatch([
      { requestId: "req-a-1", endpoint: "/api/a", method: "GET" },
    ]);
    clientB.sendBatch([
      { requestId: "req-b-1", endpoint: "/api/b", method: "GET" },
    ]);

    const adapter = createDaemonClient(ctx.registry);

    // Claim specifically from run A
    const claimA = await adapter.claimNextBatch({ runId: runIdA });
    expect(claimA).not.toBeNull();
    expect(claimA!.runId).toBe(runIdA);
    expect(claimA!.requests[0]?.requestId).toBe("req-a-1");

    // Claim specifically from run B
    const claimB = await adapter.claimNextBatch({ runId: runIdB });
    expect(claimB).not.toBeNull();
    expect(claimB!.runId).toBe(runIdB);
    expect(claimB!.requests[0]?.requestId).toBe("req-b-1");

    clientA.close();
    clientB.close();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Run disconnection cleanup
  // ---------------------------------------------------------------------------
  it("should clean up batches when run disconnects", async () => {
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);

    const adapter = createDaemonClient(ctx.registry);

    // Verify batch exists
    const statusBefore = await adapter.getStatus();
    expect(statusBefore.pending).toBe(1);

    // Disconnect the client
    client.close();

    // Wait for cleanup
    await sleep(100);

    // Batch should be gone
    const statusAfter = await adapter.getStatus();
    expect(statusAfter.pending).toBe(0);

    // Trying to claim should return null
    const claim = await adapter.claimNextBatch({});
    expect(claim).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 6: High concurrency pressure test
  // ---------------------------------------------------------------------------
  it("should handle concurrent batches without duplicates", async () => {
    const numBatches = 10;
    const numAdapters = 3;

    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);

    // Send multiple batches
    for (let i = 0; i < numBatches; i++) {
      client.sendBatch([
        { requestId: `req-${i}`, endpoint: `/api/${i}`, method: "GET" },
      ]);
    }

    // Create multiple adapters
    const adapters = Array.from({ length: numAdapters }, () =>
      createDaemonClient(ctx.registry)
    );

    // Track claimed and fulfilled batches
    const claimedBatchIds = new Set<string>();
    const fulfilledBatchIds = new Set<string>();

    // All adapters try to claim and provide
    const claimPromises = adapters.flatMap((adapter) =>
      Array.from({ length: Math.ceil(numBatches / numAdapters) + 1 }, async () => {
        const claim = await adapter.claimNextBatch({});
        if (!claim) return;

        // Check for duplicate claims (shouldn't happen)
        if (claimedBatchIds.has(claim.batchId)) {
          throw new Error(`Duplicate claim: ${claim.batchId}`);
        }
        claimedBatchIds.add(claim.batchId);

        // Provide mock data
        try {
          await adapter.provideBatch({
            batchId: claim.batchId,
            claimToken: claim.claimToken,
            mocks: claim.requests.map((r) => ({
              requestId: r.requestId,
              data: { fulfilled: true },
            })),
          });
          fulfilledBatchIds.add(claim.batchId);
        } catch {
          // May fail if lease expired or run disconnected
        }
      })
    );

    await Promise.all(claimPromises);

    // Each batch should be fulfilled exactly once
    expect(fulfilledBatchIds.size).toBe(numBatches);

    client.close();
  });

  // ---------------------------------------------------------------------------
  // Test 7: Status and list runs
  // ---------------------------------------------------------------------------
  it("should correctly report status and runs", async () => {
    const adapter = createDaemonClient(ctx.registry);

    // Initial status
    const status1 = await adapter.getStatus();
    expect(status1.runs).toBe(0);
    expect(status1.pending).toBe(0);

    // Connect a client
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);

    const status2 = await adapter.getStatus();
    expect(status2.runs).toBe(1);

    // Send a batch
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);

    // Small delay for daemon to process
    await sleep(10);

    const status3 = await adapter.getStatus();
    expect(status3.pending).toBe(1);

    // List runs
    const runs = await adapter.listRuns();
    expect(runs.runs.length).toBe(1);
    expect(runs.runs[0]?.pendingBatches).toBe(1);

    client.close();
  });

  // ---------------------------------------------------------------------------
  // Test 8: Release batch
  // ---------------------------------------------------------------------------
  it("should allow releasing a claimed batch", async () => {
    const client = await createTestClient(ctx.registry.ipcPath, ctx.registry.token);
    client.sendBatch([
      { requestId: "req-1", endpoint: "/api/test", method: "GET" },
    ]);

    const adapterA = createDaemonClient(ctx.registry);
    const adapterB = createDaemonClient(ctx.registry);

    // Adapter A claims
    const claimA = await adapterA.claimNextBatch({});
    expect(claimA).not.toBeNull();

    // Adapter B can't claim (batch is taken)
    const claimBefore = await adapterB.claimNextBatch({});
    expect(claimBefore).toBeNull();

    // Adapter A releases
    const releaseResult = await adapterA.releaseBatch({
      batchId: claimA!.batchId,
      claimToken: claimA!.claimToken,
    });
    expect(releaseResult.ok).toBe(true);

    // Adapter B can now claim
    const claimAfter = await adapterB.claimNextBatch({});
    expect(claimAfter).not.toBeNull();
    expect(claimAfter!.batchId).toBe(claimA!.batchId);

    client.close();
  });
});
