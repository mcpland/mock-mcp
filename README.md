# mock-mcp

![Node CI](https://github.com/mcpland/mock-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/mock-mcp.svg)](https://www.npmjs.com/package/mock-mcp)
![license](https://img.shields.io/npm/l/mock-mcp)

An end-to-end mock data workflow for integration tests powered by the Model Context Protocol (MCP).  
It pairs a WebSocket bridge that batches live test requests with an MCP server that exposes tooling to any compatible AI client (Cursor, Claude Desktop, custom clients, etc.).

## Features

- **Batch-aware test client** – collects every network interception inside the same macrotask and pauses the test until mock data arrives.
- **MCP tooling** – `get_pending_batches` and `provide_batch_mock_data` describe the current test state and accept AI-generated payloads.
- **WebSocket bridge** – keeps the test runner, the MCP server, and the AI client decoupled while supporting multiple concurrent runs.
- **Timeouts, TTLs, and cleanup** – protects the test runner from stale batches or disconnected clients.

## Quick Start

**Step 1: Install**

```bash
npm install -D mock-mcp
```

**Step 2: Configure Model Context Protocol (MCP) server** (e.g., in Claude Desktop config):

```json
{
  "mock-mcp": {
    "command": "npx",
    "args": ["-y", "mock-mcp@latest"]
  }
}
```

**Step 3: Connect from your test:**

```ts
import { render, screen, fireEvent } from "@testing-library/react";
import { connect } from "mock-mcp";

it("example", async () => {
  const mockClient = await connect();
  // mock user with id 1
  fetchMock.get("/user", () =>
    mockClient.requestMock("/user", "GET", { metadata })
  );

  const result = await fetch("/user");
  const data = await result.json();
  expect(data).toEqual({ id: 1 });
}); // 10 minute timeout for AI interaction
```

**Step 4: Run with MCP enabled:**

Prompt:

```
Please run the persistent test: `MOCK_MCP=true npm test test/example.test.tsx` and mock fetch data with mock-mcp
```

### CLI flags and env

| Option            | Description                                                        | Default |
| ----------------- | ------------------------------------------------------------------ | ------- |
| `--port`, `-p`    | WebSocket port for test runners                                    | `3002`  |
| `--no-stdio`      | Disable the MCP stdio transport (useful for local debugging/tests) | enabled |
| `MCP_SERVER_PORT` | Same as `--port`                                                   | `3002`  |

The CLI installs a SIGINT/SIGTERM handler so `Ctrl+C` shuts everything down gracefully.

### Connecting an MCP client (Cursor example)

Add the server to your MCP client configuration:

```json
{
  "mcpServers": {
    "mock-mcp": {
      "command": "npx",
      "args": ["-y", "mock-mcp@latest"],
      "env": {
        "MCP_SERVER_PORT": "3002"
      }
    }
  }
}
```

Restart the client—you should see the `mock-mcp` server with two tools available.

## Using the Batch Client in Tests

```ts
// tests/mocks.ts
import { connect } from "mock-mcp";

const mockClient = await connect({
  port: 3002,
  timeout: 60000,
});

await page.route("**/api/users", async (route) => {
  const url = new URL(route.request().url());
  const data = await mockClient.requestMock(
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

Batch behaviour is automatic—any additional `requestMock` calls issued in the same macrotask are grouped before being forwarded to the server.

## MCP Tools

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

## Library API

- `TestMockMCPServer` – start/stop the WebSocket + MCP tooling bridge programmatically.
- `BatchMockCollector` – low-level batching client used by the test runner.
- `connect(options)` – convenience helper that instantiates `BatchMockCollector` and waits for the WebSocket connection to open.

Both classes accept logger overrides, timeout tweaks, and other ergonomics surfaced in the technical design.

## How It Works

1. Tests call `BatchMockCollector.requestMock()` whenever they intercept an HTTP request (e.g., via Playwright/Puppeteer routing).
2. Requests issued during the same macrotask are sent to the `TestMockMCPServer` through a WebSocket batch message.
3. The server exposes pending batches to the MCP client through tooling; the AI generates context-aware responses.
4. AI-provided mock data is routed back through the WebSocket bridge, resolving the pending promises inside the test.

### Three-Process Collaboration Model

| Process        | Responsibility                                          | Technology                                   | Communication              |
| -------------- | ------------------------------------------------------- | -------------------------------------------- | -------------------------- |
| **Test Process** | Executes test cases and intercepts HTTP requests        | Playwright/Puppeteer + WebSocket client      | WebSocket → MCP Server     |
| **MCP Server**   | Coordinates batches and forwards data between parties   | Node.js + WebSocket server + MCP SDK         | stdio ↔ MCP Client<br>WebSocket ↔ Test Process |
| **MCP Client**   | Uses AI to produce mock data via MCP tools              | Cursor / Claude Desktop / custom clients     | MCP protocol → MCP Server  |

### Data Flow Sequence

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


## Development & Testing

```bash
pnpm test        # runs Vitest suites
pnpm dev         # tsx watch mode for the CLI
pnpm lint        # eslint --ext .ts
```

Vitest suites spin up ephemeral WebSocket servers, so avoid running them concurrently with an already running instance on the same port.

## License

MIT
