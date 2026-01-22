/**
 * Integration tests for mock-mcp.
 *
 * The main tests are in test/concurrency.test.ts which covers:
 * - Daemon lifecycle and state management
 * - Multiple adapter concurrent claims
 * - Lease expiration and recovery
 * - Multi-run isolation
 * - Run disconnection cleanup
 * - High concurrency pressure tests
 *
 * This file contains additional unit tests for specific components.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveProjectRoot, computeProjectId, getCacheDir } from "../src/shared/discovery.js";

const originalMockMcpEnv = process.env.MOCK_MCP;

beforeAll(() => {
  process.env.MOCK_MCP = "1";
});

afterAll(() => {
  process.env.MOCK_MCP = originalMockMcpEnv;
});

describe("Discovery", () => {
  it("resolves project root correctly", () => {
    const root = resolveProjectRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });

  it("computes stable project ID", () => {
    const root = resolveProjectRoot();
    const id1 = computeProjectId(root);
    const id2 = computeProjectId(root);

    expect(id1).toBe(id2);
    expect(id1.length).toBe(16); // sha256 truncated to 16 chars
    expect(/^[a-f0-9]+$/.test(id1)).toBe(true);
  });

  it("gets cache directory", () => {
    const cacheDir = getCacheDir();
    expect(cacheDir).toBeDefined();
    expect(typeof cacheDir).toBe("string");
  });
});
