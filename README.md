# mock-mcp

![Node CI](https://github.com/mcpland/mock-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/mock-mcp.svg)](https://www.npmjs.com/package/mock-mcp)
![license](https://img.shields.io/npm/l/mock-mcp)

Mock MCP Server - AI-generated mock data based on your **OpenAPI JSON Schema** definitions. The project pairs a WebSocket batch bridge with MCP tooling so Cursor, Claude Desktop, or any compatible client can fulfill intercepted requests in real time, ensuring strict contract compliance.

## Table of Contents

- [Quick Start](#quick-start)
- [Why Mock MCP](#why-mock-mcp)
- [What Mock MCP Does](#what-mock-mcp-does)
- [Configure MCP Server](#configure-mcp-server)
- [Connect From Tests](#connect-from-tests)
- [Describe Requests with Metadata](#describe-requests-with-metadata)
- [MCP tools](#mcp-tools)
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

2. **Configure the Model Context Protocol server.** For example, Claude Desktop can launch the binary through npx:

```json
{
  "mock-mcp": {
    "command": "npx",
    "args": ["-y", "mock-mcp@latest"]
  }
}
```

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

Mock MCP pairs a WebSocket batch bridge with MCP tooling to move intercepted requests from tests to AI helpers and back again.

- **Schema-aware generation** uses your provided metadata (OpenAPI JSON Schema) to ensure mocks match production behavior.
- **Batch-aware test client** collects every network interception inside a single macrotask and waits for the full response set.
- **MCP tooling** exposes `get_pending_batches` and `provide_batch_mock_data` so AI agents understand the waiting requests and push data back.
- **WebSocket bridge** connects the test runner to the MCP server while hiding transport details from both sides.
- **Timeouts, TTLs, and cleanup** guard the test runner from stale batches or disconnected clients.

## Configure MCP Server

CLI flags keep the WebSocket bridge and the MCP transports aligned. Use them to adapt the server to your local ports while the Environment Variables section covers per-process overrides:

| Option         | Description                                                        | Default |
| -------------- | ------------------------------------------------------------------ | ------- |
| `--port`, `-p` | WebSocket port for test runners                                    | `3002`  |
| `--no-stdio`   | Disable the MCP stdio transport (useful for local debugging/tests) | enabled |

The CLI installs a SIGINT/SIGTERM handler so `Ctrl+C` shuts everything down cleanly.

**Add the server to MCP clients.** MCP clients such as Cursor or Claude Desktop need an entry in their configuration so they can launch the bridge:

```json
{
  "mcpServers": {
    "mock-mcp": {
      "command": "npx",
      "args": ["-y", "mock-mcp@latest"],
      "env": {
        "MCP_SERVER_PORT": "3002" // 3002 is the default port
      }
    }
  }
}
```

Restart the client and confirm that the `mock-mcp` server exposes two tools.

## Connect From Tests

Tests call `connect` to spin up a `BatchMockCollector`, intercept HTTP calls, and wait for fulfilled data:

```ts
// tests/mocks.ts
import { connect } from "mock-mcp";

const mockClient = await connect({
  port: 3002,
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

## MCP tools

Two tools keep the queue visible to AI agents and deliver mocks back to waiting tests:

| Tool                      | Purpose                                    | Response                                                |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `get_pending_batches`     | Lists queued batches with request metadata | JSON string (array of `{batchId, timestamp, requests}`) |
| `provide_batch_mock_data` | Sends mock payloads for a specific batch   | JSON string reporting success                           |

Example payload for `provide_batch_mock_data`:

```jsonc
{
  "batchId": "batch-3",
  "mocks": [
    {
      "requestId": "req-7",
      "data": { "users": [{ "id": 1, "name": "Alice" }] }
    }
  ]
}
```

## Available APIs

The library exports primitives so you can embed the workflow inside bespoke runners or scripts:

- `TestMockMCPServer` starts and stops the WebSocket plus MCP tooling bridge programmatically.
- `BatchMockCollector` provides a low-level batching client used directly inside test environments.
- `BatchMockCollector.waitForPendingRequests()` waits for the currently pending mock requests to settle (resolves when all finish, rejects if any fail).
- `connect(options)` instantiates `BatchMockCollector` and waits for the WebSocket connection to open.

Each class accepts logger overrides, timeout tweaks, and other ergonomics surfaced in the technical design.

## Environment Variables

| Variable          | Description                                                                  | Default |
| ----------------- | ---------------------------------------------------------------------------- | ------- |
| `MCP_SERVER_PORT` | Overrides the WebSocket port used by both the CLI and any spawned MCP host.  | `3002`  |
| `MOCK_MCP`        | Enables the test runner hook so intercepted requests are routed to mock-mcp. | unset   |

## How It Works

Three collaborating processes share responsibilities while staying loosely coupled:

| Process          | Responsibility                                        | Technology                               | Communication                              |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| **Test Process** | Executes test cases and intercepts HTTP requests      | Playwright/Puppeteer + WebSocket client  | WebSocket → MCP Server                     |
| **MCP Server**   | Coordinates batches and forwards data between parties | Node.js + WebSocket server + MCP SDK     | stdio ↔ MCP Client · WebSocket ↔ Test Flow |
| **MCP Client**   | Uses AI to produce mock data via MCP tools            | Cursor / Claude Desktop / custom clients | MCP protocol → MCP Server                  |

### Data flow sequence clarifies message order

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Test Process    │         │   MCP Server     │         │  MCP Client      │
│  (Browser Test)  │         │                  │         │     (AI)         │
└────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
         │                            │                            │
         │  1. Start Test             │                            │
         │     page.goto()            │                            │
         ├───────────────────────────►│                            │
         │                            │                            │
         │  2. Trigger concurrent     │                            │
         │     requests               │                            │
         │     fetch /api/users       │                            │
         │     fetch /api/products    │                            │
         │     fetch /api/orders      │                            │
         │     (Promises pending)     │                            │
         │                            │                            │
         │  3. setTimeout(0) batches  │                            │
         │     BATCH_MOCK_REQUEST     │                            │
         │     [req-1, req-2, req-3]  │                            │
         ├═══════════════════════════►│                            │
         │                            │                            │
         │     Test paused...         │  4. Store batch in queue   │
         │       Awaiting mocks       │     pendingBatches.set()   │
         │                            │                            │
         │                            │  5. Wait for MCP Client    │
         │                            │     to call tools          │
         │                            │                            │
         │                            │◄───────────────────────────┤
         │                            │  6. Tool Call:             │
         │                            │     get_pending_batches    │
         │                            │                            │
         │                            │  7. Return batch info      │
         │                            ├───────────────────────────►│
         │                            │  [{batchId, requests}]     │
         │                            │                            │
         │                            │        8. AI analyzes      │
         │                            │           Generates mocks  │
         │                            │                            │
         │                            │◄───────────────────────────┤
         │                            │  9. Tool Call:             │
         │                            │     provide_batch_mock_data│
         │                            │     {mocks: [...]}         │
         │                            │                            │
         │  10. BATCH_MOCK_RESPONSE   │                            │
         │      [mock-1, mock-2, ...] │                            │
         │◄═══════════════════════════┤                            │
         │                            │                            │
         │  11. Batch resolve         │                            │
         │      req-1.resolve()       │                            │
         │      req-2.resolve()       │                            │
         │      req-3.resolve()       │                            │
         │                            │                            │
         │  12. Test continues        │                            │
         │      Assertions &          │                            │
         │      Verification          │                            │
         │                            │                            │
         │  13. Test Complete ✓       │                            │
         ▼                            ▼                            ▼

Protocol Summary:
─────────────────
- Test Process ←→ MCP Server: WebSocket/IPC
  Message types: BATCH_MOCK_REQUEST, BATCH_MOCK_RESPONSE

- MCP Server ←→ MCP Client: Stdio/JSON-RPC (MCP Protocol)
  Tools: get_pending_batches, provide_batch_mock_data

Key Features:
──────────────
✓ Batch processing of concurrent requests
✓ Non-blocking test execution during AI mock generation
✓ Real-time mock data generation by AI
✓ Automatic promise resolution after mock provision
```

## Use the development scripts

```bash
pnpm test        # runs Vitest suites
pnpm dev         # tsx watch mode for the CLI
pnpm lint        # eslint --ext .ts
```

Vitest suites spin up ephemeral WebSocket servers, so avoid running them concurrently with an already running instance on the same port.

## License

MIT
