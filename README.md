# mock-mcp

![Node CI](https://github.com/mcpland/mock-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/mock-mcp.svg)](https://www.npmjs.com/package/mock-mcp)
![license](https://img.shields.io/npm/l/mock-mcp)

Mock MCP Server - AI-generated mock data based on your **OpenAPI JSON Schema** definitions. The project uses a **Daemon + Adapter** architecture that enables multiple MCP clients (Cursor, Claude Desktop, etc.) to run simultaneously without port conflicts, while providing robust claim-based concurrency control for mock batch processing.

## Table of Contents

- [Quick Start](#quick-start)
- [Why Mock MCP](#why-mock-mcp)
- [What Mock MCP Does](#what-mock-mcp-does)
- [Architecture](#architecture)
- [Configure MCP Server](#configure-mcp-server)
- [Connect From Tests](#connect-from-tests)
- [Describe Requests with Metadata](#describe-requests-with-metadata)
- [MCP Tools](#mcp-tools)
- [CLI Commands](#cli-commands)
- [Available APIs](#available-apis)
- [Environment Variables](#environment-variables)
- [How It Works](#how-it-works)
- [Use the development scripts](#use-the-development-scripts)
- [License](#license)

## Quick Start

1. **Install the package.** Add mock-mcp as a dev dependency inside your project.

```bash
npm install -D mock-mcp
# or
yarn add -D mock-mcp
# or
pnpm add -D mock-mcp
```

2. **Configure the Model Context Protocol server.** Add mock-mcp to your MCP client configuration (Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "mock-mcp": {
      "command": "npx",
      "args": ["-y", "mock-mcp", "adapter"]
    }
  }
}
```

> **Note:** The `adapter` command connects to a shared daemon process that is automatically started when needed. This eliminates port conflicts when running multiple MCP clients simultaneously.

3. **Connect from your tests.** Use `connect` to retrieve a mock client and request data for intercepted calls.

```ts
import { render, screen, fireEvent } from "@testing-library/react";
import { connect } from "mock-mcp";

const userSchema = {
  summary: "Fetch the current user",
  response: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "number" },
      name: { type: "string" },
    },
  },
};

it("example", async () => {
  const mockClient = await connect();
  const metadata = {
    schemaUrl: "https://example.com/openapi.json#/paths/~1user/get",
    schema: userSchema,
    instructions: "Respond with a single user described by the schema.",
  };

  fetchMock.get("/user", async () => {
    const response = await mockClient.requestMock("/user", "GET", { metadata }) // add mock via mock-mcp
    return response.data
  });

  const result = await fetch("/user");
  const data = await result.json();
  expect(data).toEqual({ id: 1, name: "Jane" });
}, 10 * 60 * 1000); // 10 minute timeout for AI interaction
```

4. **Run with MCP enabled.** Prompt your AI client to run the persistent test command and provide mocks through the tools.

```
Please run the persistent test: `MOCK_MCP=true npm test test/example.test.tsx` and mock fetch data with mock-mcp
```

## Why Mock MCP

### The Problem with Traditional Mock Approaches

Testing modern web applications often feels like preparing for a battle—you need the right weapons (test cases), ammunition (mock data), and strategy (test logic). But creating mock data has always been the most tedious part:

```typescript
// Traditional approach: Manual fixture hell
const mockUsers = [
  { id: 1, name: "Alice", email: "alice@example.com", role: "admin", ... },
  { id: 2, name: "Bob", email: "bob@example.com", role: "user", ... },
  // ... 50 more lines of boring manual data entry
];
```

**Common Pain Points:**

| Challenge                   | Traditional Solutions           | Limitations                                 |
| --------------------------- | ------------------------------- | ------------------------------------------- |
| **Creating Realistic Data** | Manual JSON files or faker.js   | ❌ Time-consuming, lacks business logic     |
| **Complex Scenarios**       | Hardcoded edge cases            | ❌ Difficult to maintain, brittle           |
| **Evolving Requirements**   | Update fixtures manually        | ❌ High maintenance cost                    |
| **Learning Curve**          | New team members write fixtures | ❌ Steep learning curve for complex domains |
| **CI/CD Integration**       | Static fixtures only            | ❌ Can't adapt to new scenarios             |

### The Mock MCP Innovation

Mock MCP introduces a **paradigm shift**: instead of treating mock data as static artifacts, it makes them **AI-generated, interactive, and evolvable**.

```
Traditional:  Write Test → Create Fixtures → Run Test → Maintain Fixtures
                                ↑                          ↓
                                └──────── Pain Loop ───────┘

Mock MCP:     Write Test → AI Generates Data (Schema-Compliant) → Run Test → Solidify Code
                             ↑                                    ↓
                             └───────────── Evolution ────────────┘
```

### Schema-Driven Accuracy

Unlike "hallucinated" mocks, Mock MCP uses your actual **OpenAPI JSON Schema** definitions to ground the AI. This ensures that generated data not only looks real but strictly adheres to your API contracts, catching integration issues early.

## What Mock MCP Does

Mock MCP uses a **Daemon + Adapter** architecture to move intercepted requests from tests to AI helpers and back again.

- **Schema-aware generation** uses your provided metadata (OpenAPI JSON Schema) to ensure mocks match production behavior.
- **Batch-aware test client** collects every network interception inside a single macrotask and waits for the full response set.
- **Claim-based concurrency** prevents multiple AI clients from racing on the same batch through lease-based locking.
- **Multi-run isolation** supports concurrent test processes with distinct run IDs.
- **IPC-based communication** uses Unix Domain Sockets (macOS/Linux) or Named Pipes (Windows) instead of TCP ports, eliminating port conflicts.
- **Timeouts, TTLs, and cleanup** guard the test runner from stale batches or disconnected clients.

## Architecture

The v0.4.0 release introduces a new **Daemon + Adapter** architecture that fundamentally solves the "multiple MCP clients" problem:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Test Process  │     │     Daemon      │     │    Adapter      │
│  (your tests)   │────▶│  (per-project)  │◀────│  (per MCP client)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │  WebSocket/IPC        │  JSON-RPC/IPC         │  MCP stdio
        │                       │                       │
        ▼                       ▼                       ▼
   BatchMockCollector     Mock Bridge Daemon      MCP Tools
   - Auto-discovers       - Manages runs/batches  - claim_next_batch
   - Sends batches        - Claim/lease control   - provide_batch_mock_data
   - Receives mocks       - Multi-client safe     - get_status, list_runs
```

**Key Benefits:**

- Single daemon per project (no per-client server instances)
- IPC communication
- Full multi-client support
- Claim-based concurrency (no race conditions)
- Auto-discovery (no manual configuration)

## Configure MCP Server

Add mock-mcp to your MCP client configuration. The adapter automatically discovers or starts the daemon for your project:

```json
{
  "mcpServers": {
    "mock-mcp": {
      "command": "npx",
      "args": ["-y", "mock-mcp", "adapter"]
    }
  }
}
```

**That's it!** The daemon uses IPC (Unix Domain Sockets on macOS/Linux, Named Pipes on Windows) which:

- Eliminates port conflicts between multiple MCP clients
- Automatically shares state between all adapters in the same project
- Requires no manual coordination or environment variables

Restart your MCP client and confirm that the `mock-mcp` server exposes the tools (`get_status`, `claim_next_batch`, `provide_batch_mock_data`, etc.).

## Connect From Tests

Tests call `connect` to spin up a `BatchMockCollector` that automatically discovers and connects to the daemon:

```ts
// tests/mocks.ts
import { connect } from "mock-mcp";

// Auto-discovers daemon via IPC
const mockClient = await connect({
  timeout: 60000,
});

await page.route("**/api/users", async (route) => {
  const url = new URL(route.request().url());
  const { data } = await mockClient.requestMock(
    url.pathname,
    route.request().method()
  );

  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
});
```

Batch behaviour stays automatic: additional `requestMock` calls issued in the same macrotask are grouped, forwarded, and resolved together.

Need to pause the test until everything in-flight resolves? Call `waitForPendingRequests` to block on the current set of pending requests (anything started after the call is not included):

```ts
// After routing a few requests
await mockClient.waitForPendingRequests();
// Safe to assert on the results produced by the mocked responses
```

**Multiple test processes** can run concurrently - each gets a unique `runId` and their batches are isolated from each other.

## Describe Requests with Metadata

`requestMock` accepts an optional third argument (`RequestMockOptions`) that is forwarded without modification to the MCP server. The most important field in that object is `metadata`, which lets the test process describe each request with the exact OpenAPI JSON Schema fragment, sample payloads, or test context that the AI client needs to build a response.

When an MCP client calls `get_pending_batches`, every `requests[].metadata` entry from the test run is included in the response. That is the channel the LLM uses to understand the requested endpoint before supplying data through `provide_batch_mock_data`. Metadata is also persisted when batch logging is enabled, so you can audit what was sent to the model.

```ts
const listProductsSchema = {
  summary: "List products by popularity",
  response: {
    type: "array",
    items: {
      type: "object",
      required: ["id", "name", "price"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        price: { type: "number" },
      },
    },
  },
};

await mockClient.requestMock("/api/products", "GET", {
  metadata: {
    // Link or embed the authoritative contract for the AI to follow.
    schemaUrl:
      "https://shop.example.com/openapi.json#/paths/~1api~1products/get",
    schema: listProductsSchema,
    instructions:
      "Return 3 popular products with stable ids so the UI can snapshot them.",
    testFile: expect.getState().testPath,
  },
});
```

**Tips for useful metadata**

- Embed the OpenAPI/JSON Schema snippet (or a reference URL) that describes the response structure for the intercepted endpoint.
- Include contextual hints such as the test name, scenario, user role, or seed data so the model can mirror your expected fixtures.
- Keep the metadata JSON-serializable and deterministic; large binary blobs or class instances will be dropped.
- Reuse helper functions to centralize schema definitions so each test only supplies the endpoint-specific instructions.

## MCP Tools

The new architecture provides a richer set of tools with claim-based concurrency control:

| Tool                      | Purpose                                         | Input                                      |
| ------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `get_status`              | Get daemon status (runs, pending, claimed)      | None                                       |
| `list_runs`               | List all active test runs                       | None                                       |
| `claim_next_batch`        | Claim the next pending batch (with lease)       | `{ runId?, leaseMs? }`                     |
| `get_batch`               | Get details of a specific batch (read-only)     | `{ batchId }`                              |
| `provide_batch_mock_data` | Provide mock data for a claimed batch           | `{ batchId, claimToken, mocks }`           |
| `release_batch`           | Release a claimed batch without providing mocks | `{ batchId, claimToken, reason? }`         |

### Workflow

The new workflow uses **claim → provide** to prevent race conditions:

1. **Claim a batch** - Call `claim_next_batch` to acquire a lease on a pending batch
2. **Receive batch details** - Get `batchId`, `claimToken`, and `requests` array
3. **Generate mocks** - Create mock responses for each request
4. **Provide mocks** - Call `provide_batch_mock_data` with the claim token

```jsonc
// Step 1: Claim
{
  "name": "claim_next_batch",
  "arguments": { "leaseMs": 30000 }
}
// Returns: { "batchId": "batch:abc:1", "claimToken": "xyz", "requests": [...] }

// Step 2: Provide
{
  "name": "provide_batch_mock_data",
  "arguments": {
    "batchId": "batch:abc:1",
    "claimToken": "xyz",
    "mocks": [
      { "requestId": "req-1", "data": { "id": 1, "name": "Alice" } }
    ]
  }
}
```

**Lease expiration**: If you don't provide mocks within the lease time (default 30s), the batch is automatically released for another adapter to claim.

## CLI Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `mock-mcp adapter`  | Start the MCP adapter (default, for MCP clients)      |
| `mock-mcp daemon`   | Start the daemon process (usually auto-started)       |
| `mock-mcp status`   | Show daemon status for current project                |
| `mock-mcp stop`     | Stop the daemon for current project                   |
| `mock-mcp help`     | Show help                                             |
| `mock-mcp version`  | Show version                                          |

Example usage:

```bash
# Check if daemon is running
mock-mcp status

# Manually stop daemon
mock-mcp stop
```

## Available APIs

The library exports primitives so you can embed the workflow inside bespoke runners or scripts:

### Client APIs

- `connect(options?)` - Creates a `BatchMockCollector` and waits for daemon connection.
- `BatchMockCollector` - Low-level batching client for test environments.
- `BatchMockCollector.requestMock(endpoint, method, options?)` - Request mock data for an endpoint.
- `BatchMockCollector.waitForPendingRequests()` - Wait for pending requests to settle.
- `BatchMockCollector.getRunId()` - Get the unique run ID for this collector.

### Server APIs

- `MockMcpDaemon` - The daemon process that manages runs and batches.
- `runAdapter()` - Start the MCP adapter (stdio transport).
- `DaemonClient` - JSON-RPC client for communicating with the daemon.

### Discovery APIs

- `ensureDaemonRunning(options?)` - Ensure daemon is running, start if needed.
- `resolveProjectRoot(startDir?)` - Find project root by searching for `.git` or `package.json`.
- `computeProjectId(projectRoot)` - Compute stable project ID from path.

Each class accepts logger overrides, timeout tweaks, and other ergonomics.

## Environment Variables

| Variable             | Description                                                              | Default            |
| -------------------- | ------------------------------------------------------------------------ | ------------------ |
| `MOCK_MCP`           | Enables the test runner hook so intercepted requests are routed to mock-mcp. | unset              |
| `MOCK_MCP_CACHE_DIR` | Override the cache directory for daemon files (registry, socket, lock). | `~/.cache/mock-mcp`|

## How It Works

The new **Daemon + Adapter** architecture uses four collaborating processes:

| Process          | Responsibility                                        | Technology                               | Communication                   |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| **Test Process** | Executes test cases and intercepts HTTP requests      | Playwright/Puppeteer + BatchMockCollector| WebSocket over IPC → Daemon     |
| **Daemon**       | Manages runs, batches, claims with lease control      | Node.js + HTTP/WS on Unix socket         | IPC ↔ Test & Adapter            |
| **Adapter**      | Bridges MCP protocol to daemon RPC                    | Node.js + MCP SDK (stdio)                | stdio ↔ MCP Client, RPC → Daemon|
| **MCP Client**   | Uses AI to produce mock data via MCP tools            | Cursor / Claude Desktop / custom clients | MCP protocol → Adapter          |

### Data flow sequence with claim-based concurrency

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Test Process    │      │     Daemon       │      │     Adapter      │      │   MCP Client     │
│  (Browser Test)  │      │  (per-project)   │      │ (per MCP client) │      │      (AI)        │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │                         │
         │  1. Connect via IPC     │                         │                         │
         │     HELLO_TEST          │                         │                         │
         ├════════════════════════►│                         │                         │
         │                         │                         │                         │
         │  2. HELLO_ACK           │                         │                         │
         │◄════════════════════════┤                         │                         │
         │                         │                         │                         │
         │  3. BATCH_MOCK_REQUEST  │                         │                         │
         │     [req-1, req-2, ...] │                         │                         │
         ├════════════════════════►│                         │                         │
         │                         │                         │                         │
         │     Test paused...      │  4. Store in pending    │                         │
         │       Awaiting mocks    │     queue               │                         │
         │                         │                         │                         │
         │                         │                         │◄────────────────────────┤
         │                         │                         │  5. claim_next_batch    │
         │                         │                         │                         │
         │                         │◄────────────────────────┤                         │
         │                         │  6. RPC: claimNextBatch │                         │
         │                         │                         │                         │
         │                         ├────────────────────────►│                         │
         │                         │  7. {batch, claimToken} │                         │
         │                         │                         │                         │
         │                         │                         ├────────────────────────►│
         │                         │                         │  8. Return batch info   │
         │                         │                         │                         │
         │                         │                         │        9. AI generates  │
         │                         │                         │           mock data     │
         │                         │                         │                         │
         │                         │                         │◄────────────────────────┤
         │                         │                         │  10. provide_batch_     │
         │                         │                         │      mock_data          │
         │                         │                         │                         │
         │                         │◄────────────────────────┤                         │
         │                         │  11. RPC: provideBatch  │                         │
         │                         │      + claimToken       │                         │
         │                         │                         │                         │
         │  12. BATCH_MOCK_RESULT  │                         │                         │
         │      [mock-1, mock-2]   │                         │                         │
         │◄════════════════════════┤                         │                         │
         │                         │                         │                         │
         │  13. Resolve promises   │                         │                         │
         │      Test continues     │                         │                         │
         ▼                         ▼                         ▼                         ▼

Protocol Summary:
─────────────────
- Test Process ←→ Daemon: WebSocket over IPC (Unix socket / Named pipe)
  Message types: HELLO_TEST, BATCH_MOCK_REQUEST, BATCH_MOCK_RESULT

- Adapter ←→ Daemon: HTTP JSON-RPC over IPC
  Methods: claimNextBatch, provideBatch, getStatus, listRuns

- MCP Client ←→ Adapter: MCP protocol (stdio)
  Tools: claim_next_batch, provide_batch_mock_data, get_status, list_runs

Key Features:
──────────────
✓ uses IPC instead of TCP - No port conflicts
✓ Multi-client support - multiple MCP clients can run simultaneously
✓ Claim-based concurrency - prevents race conditions on batches
✓ Lease expiration - auto-recovery if adapter crashes
✓ Multi-run isolation - concurrent test processes are isolated
✓ Auto-discovery - no manual configuration needed
```

## Use the development scripts

```bash
yarn test              # runs Vitest suites
yarn test:concurrency  # runs concurrency tests specifically
yarn dev               # tsx watch mode for the CLI
yarn dev:adapter       # tsx watch mode for adapter
yarn lint              # eslint --ext .ts
yarn build             # compile TypeScript
```

Tests create isolated daemon instances with temporary cache directories, so they can run safely without affecting your development environment.

## License

MIT
