# mock-mcp

![Node CI](https://github.com/mcpland/mock-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/mock-mcp.svg)](https://www.npmjs.com/package/mock-mcp)
![license](https://img.shields.io/npm/l/mock-mcp)

Mock MCP orchestrates AI-generated mock data for integration tests via the Model Context Protocol (MCP). The project pairs a WebSocket batch bridge with MCP tooling so Cursor, Claude Desktop, or any compatible client can fulfill intercepted requests in real time.

## Table of Contents
- [Quick Start](#quick-start)
- [Why Mock MCP](#why-mock-mcp)
- [What Mock MCP Does](#what-mock-mcp-does)
- [Configure MCP Server](#configure-mcp-server)
- [Connect From Tests](#connect-from-tests)
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

4. **Run with MCP enabled.** Prompt your AI client to run the persistent test command and provide mocks through the tools.

   ```
   Please run the persistent test: `MOCK_MCP=true npm test test/example.test.tsx` and mock fetch data with mock-mcp
   ```

## Why Mock MCP

Mock MCP keeps integration tests responsive by batching intercepted HTTP requests inside the same macrotask. Tests pause only until AI-crafted mocks arrive, and the WebSocket bridge, MCP server, and AI client stay decoupled so multiple suites can run concurrently without leaking state.

**Practical benefits**

- **Faster feedback loops** resume UI assertions as soon as responses land, so suites spend less time idling.
- **Parallel-friendly infrastructure** lets many engineers share the MCP server without request collisions.
- **Resilient operations** enforce timeouts, TTLs, and cleanup so stale batches never poison later runs.
- **Client choice** keeps MCP transport details abstract, enabling Cursor, Claude Desktop, or custom clients out of the box.

## What Mock MCP Does

Mock MCP pairs a WebSocket batch bridge with MCP tooling to move intercepted requests from tests to AI helpers and back again.

- **Batch-aware test client** collects every network interception inside a single macrotask and waits for the full response set.
- **MCP tooling** exposes `get_pending_batches` and `provide_batch_mock_data` so AI agents understand the waiting requests and push data back.
- **WebSocket bridge** connects the test runner to the MCP server while hiding transport details from both sides.
- **Timeouts, TTLs, and cleanup** guard the test runner from stale batches or disconnected clients.

## Configure MCP Server

CLI flags keep the WebSocket bridge and the MCP transports aligned. Use them to adapt the server to your local ports while the Environment Variables section covers per-process overrides:

| Option            | Description                                                        | Default |
| ----------------- | ------------------------------------------------------------------ | ------- |
| `--port`, `-p`    | WebSocket port for test runners                                    | `3002`  |
| `--no-stdio`      | Disable the MCP stdio transport (useful for local debugging/tests) | enabled |

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

Batch behaviour stays automatic: additional `requestMock` calls issued in the same macrotask are grouped, forwarded, and resolved together.

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
- `connect(options)` instantiates `BatchMockCollector` and waits for the WebSocket connection to open.

Each class accepts logger overrides, timeout tweaks, and other ergonomics surfaced in the technical design.

## Environment Variables

| Variable          | Description                                                                 | Default |
| ----------------- | --------------------------------------------------------------------------- | ------- |
| `MCP_SERVER_PORT` | Overrides the WebSocket port used by both the CLI and any spawned MCP host. | `3002`  |
| `MOCK_MCP`        | Enables the test runner hook so intercepted requests are routed to mock-mcp. | unset   |

## How It Works

Three collaborating processes share responsibilities while staying loosely coupled:

| Process          | Responsibility                                          | Technology                                   | Communication                              |
| ---------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| **Test Process** | Executes test cases and intercepts HTTP requests        | Playwright/Puppeteer + WebSocket client      | WebSocket → MCP Server                     |
| **MCP Server**   | Coordinates batches and forwards data between parties   | Node.js + WebSocket server + MCP SDK         | stdio ↔ MCP Client · WebSocket ↔ Test Flow |
| **MCP Client**   | Uses AI to produce mock data via MCP tools              | Cursor / Claude Desktop / custom clients     | MCP protocol → MCP Server                  |

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
