/**
 * MCP Adapter - The MCP stdio server that bridges AI clients to the Daemon.
 *
 * Each MCP client (Cursor, Claude Desktop, etc.) spawns one Adapter process.
 * The Adapter:
 * - Exposes MCP tools (claim_next_batch, provide_batch_mock_data, get_status)
 * - Discovers and connects to ALL active Daemons via IPC
 * - Does NOT bind any ports (avoids conflicts)
 * - Works across projects without requiring --project-root
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MultiDaemonClient, type ExtendedRunInfo, type AggregatedStatusResult } from "./multi-daemon-client.js";
import type {
  ClaimNextBatchResult,
  ProvideBatchResult,
  GetBatchResult,
} from "../shared/protocol.js";

// =============================================================================
// Types
// =============================================================================

type Logger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: (...args: unknown[]) => void;
};

export interface AdapterOptions {
  logger?: Logger;
  version?: string;
}

// =============================================================================
// Tool Definitions
// =============================================================================

const TOOLS = [
  {
    name: "get_status",
    description: "Get the current status of the mock-mcp daemon, including active test runs and pending batches.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_runs",
    description: "List all active test runs connected to the daemon.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "claim_next_batch",
    description: `Claim the next pending mock batch for processing. This acquires a lease on the batch.
    
You MUST call this before provide_batch_mock_data. The batch will be locked for 30 seconds (configurable via leaseMs).
If you don't provide mock data within the lease time, the batch will be released for another adapter to claim.`,
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Optional: Filter to only claim batches from a specific test run.",
        },
        leaseMs: {
          type: "number",
          description: "Optional: Lease duration in milliseconds. Default: 30000 (30 seconds).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_batch",
    description: "Get details of a specific batch by ID (read-only, does not claim).",
    inputSchema: {
      type: "object",
      properties: {
        batchId: {
          type: "string",
          description: "The batch ID to retrieve.",
        },
      },
      required: ["batchId"],
    },
  },
  {
    name: "provide_batch_mock_data",
    description: `Provide mock response data for a claimed batch.
    
You MUST first call claim_next_batch to get the batchId and claimToken.
The mocks array must contain exactly one mock for each request in the batch.`,
    inputSchema: {
      type: "object",
      properties: {
        batchId: {
          type: "string",
          description: "The batch ID (from claim_next_batch).",
        },
        claimToken: {
          type: "string",
          description: "The claim token (from claim_next_batch).",
        },
        mocks: {
          type: "array",
          description: "Array of mock responses, one for each request in the batch.",
          items: {
            type: "object",
            properties: {
              requestId: {
                type: "string",
                description: "The requestId from the original request.",
              },
              data: {
                description: "The mock response data (any JSON value).",
              },
              status: {
                type: "number",
                description: "Optional HTTP status code. Default: 200.",
              },
              headers: {
                type: "object",
                description: "Optional response headers.",
              },
              delayMs: {
                type: "number",
                description: "Optional delay before returning the mock (ms).",
              },
            },
            required: ["requestId", "data"],
          },
        },
      },
      required: ["batchId", "claimToken", "mocks"],
    },
  },
  {
    name: "release_batch",
    description: "Release a claimed batch without providing mock data. Use this if you cannot generate appropriate mocks.",
    inputSchema: {
      type: "object",
      properties: {
        batchId: {
          type: "string",
          description: "The batch ID to release.",
        },
        claimToken: {
          type: "string",
          description: "The claim token.",
        },
        reason: {
          type: "string",
          description: "Optional reason for releasing.",
        },
      },
      required: ["batchId", "claimToken"],
    },
  },
] as const;

// =============================================================================
// Adapter
// =============================================================================

export async function runAdapter(opts: AdapterOptions = {}): Promise<void> {
  const logger = opts.logger ?? console;
  const version = opts.version ?? "0.5.0";

  // Create multi-daemon client that discovers all active daemons
  logger.error("🔍 Initializing mock-mcp adapter (multi-daemon mode)...");

  const multiDaemon = new MultiDaemonClient({ logger });

  // Discover active daemons
  const daemons = await multiDaemon.discoverDaemons();
  if (daemons.length > 0) {
    logger.error(`✅ Found ${daemons.length} active daemon(s):`);
    for (const d of daemons) {
      const status = d.healthy ? "healthy" : "unhealthy";
      logger.error(`   - ${d.registry.projectId}: ${d.registry.projectRoot} (${status})`);
    }
  } else {
    logger.error("ℹ️  No active daemons found. Waiting for test processes to start...");
  }

  // Create MCP server
  const server = new Server(
    {
      name: "mock-mcp-adapter",
      version,
    },
    {
      capabilities: { tools: {} },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "get_status": {
          const result = await multiDaemon.getAggregatedStatus();
          return buildToolResponse(formatAggregatedStatus(result));
        }

        case "list_runs": {
          const result = await multiDaemon.listAllRuns();
          return buildToolResponse(formatExtendedRuns(result));
        }

        case "claim_next_batch": {
          const result = await multiDaemon.claimNextBatch({
            runId: args?.runId as string | undefined,
            leaseMs: args?.leaseMs as number | undefined,
          });
          return buildToolResponse(formatClaimResult(result));
        }

        case "get_batch": {
          if (!args?.batchId) {
            throw new Error("batchId is required");
          }
          const result = await multiDaemon.getBatch(args.batchId as string);
          if (!result) {
            throw new Error(`Batch not found: ${args.batchId}`);
          }
          return buildToolResponse(formatBatch(result));
        }

        case "provide_batch_mock_data": {
          if (!args?.batchId || !args?.claimToken || !args?.mocks) {
            throw new Error("batchId, claimToken, and mocks are required");
          }
          const result = await multiDaemon.provideBatch({
            batchId: args.batchId as string,
            claimToken: args.claimToken as string,
            mocks: args.mocks as Parameters<typeof multiDaemon.provideBatch>[0]["mocks"],
          });
          return buildToolResponse(formatProvideResult(result));
        }

        case "release_batch": {
          if (!args?.batchId || !args?.claimToken) {
            throw new Error("batchId and claimToken are required");
          }
          const result = await multiDaemon.releaseBatch({
            batchId: args.batchId as string,
            claimToken: args.claimToken as string,
            reason: args?.reason as string | undefined,
          });
          return buildToolResponse(JSON.stringify(result, null, 2));
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Tool error (${name}): ${message}`);
      return buildToolResponse(`Error: ${message}`, true);
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.error("✅ MCP adapter ready (stdio transport)");
}

// =============================================================================
// Response Formatting
// =============================================================================

function buildToolResponse(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function formatAggregatedStatus(status: AggregatedStatusResult): string {
  if (status.daemons.length === 0) {
    return `# Mock MCP Status

No active daemons found. Start a test with \`MOCK_MCP=1\` to begin.
`;
  }

  const lines = [
    "# Mock MCP Status\n",
    "## Summary",
    `- **Active Daemons**: ${status.daemons.filter(d => d.healthy).length}`,
    `- **Total Active Runs**: ${status.totalRuns}`,
    `- **Total Pending Batches**: ${status.totalPending}`,
    `- **Total Claimed Batches**: ${status.totalClaimed}`,
    "",
    "## Daemons\n",
  ];

  for (const daemon of status.daemons) {
    const healthIcon = daemon.healthy ? "✅" : "❌";
    lines.push(`### ${healthIcon} ${daemon.projectRoot}`);
    lines.push(`- **Project ID**: ${daemon.projectId}`);
    lines.push(`- **Version**: ${daemon.version}`);
    lines.push(`- **PID**: ${daemon.pid}`);
    if (daemon.healthy) {
      lines.push(`- **Uptime**: ${Math.round(daemon.uptime / 1000)}s`);
      lines.push(`- **Runs**: ${daemon.runs}`);
      lines.push(`- **Pending**: ${daemon.pending}`);
      lines.push(`- **Claimed**: ${daemon.claimed}`);
    } else {
      lines.push(`- **Status**: Not responding`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatExtendedRuns(runs: ExtendedRunInfo[]): string {
  if (runs.length === 0) {
    return "No active test runs.\n\nStart a test with `MOCK_MCP=1` to begin.";
  }

  const lines = ["# Active Test Runs\n"];

  // Group by project
  const byProject = new Map<string, ExtendedRunInfo[]>();
  for (const run of runs) {
    const key = run.projectRoot;
    if (!byProject.has(key)) {
      byProject.set(key, []);
    }
    byProject.get(key)!.push(run);
  }

  for (const [projectRoot, projectRuns] of byProject) {
    lines.push(`## Project: ${projectRoot}\n`);

    for (const run of projectRuns) {
      lines.push(`### Run: ${run.runId}`);
      lines.push(`- **PID**: ${run.pid}`);
      lines.push(`- **CWD**: ${run.cwd}`);
      lines.push(`- **Started**: ${run.startedAt}`);
      lines.push(`- **Pending Batches**: ${run.pendingBatches}`);
      if (run.testMeta) {
        if (run.testMeta.testFile) {
          lines.push(`- **Test File**: ${run.testMeta.testFile}`);
        }
        if (run.testMeta.testName) {
          lines.push(`- **Test Name**: ${run.testMeta.testName}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatClaimResult(result: (ClaimNextBatchResult & { projectId: string; projectRoot: string }) | null): string {
  if (!result) {
    return "No pending batches available to claim.\n\nMake sure a test is running with `MOCK_MCP=1` and has pending mock requests.";
  }

  const lines = [
    "# Batch Claimed Successfully\n",
    `**Batch ID**: \`${result.batchId}\``,
    `**Claim Token**: \`${result.claimToken}\``,
    `**Run ID**: ${result.runId}`,
    `**Project**: ${result.projectRoot}`,
    `**Lease Until**: ${new Date(result.leaseUntil).toISOString()}`,
    "",
    "## Requests\n",
  ];

  for (const req of result.requests) {
    lines.push(`### ${req.method} ${req.endpoint}`);
    lines.push(`- **Request ID**: \`${req.requestId}\``);
    if (req.body !== undefined) {
      lines.push(`- **Body**: \`\`\`json\n${JSON.stringify(req.body, null, 2)}\n\`\`\``);
    }
    if (req.headers) {
      lines.push(`- **Headers**: ${JSON.stringify(req.headers)}`);
    }
    if (req.metadata) {
      lines.push(`- **Metadata**: ${JSON.stringify(req.metadata)}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("**Next step**: Call `provide_batch_mock_data` with the batch ID, claim token, and mock data for each request.");

  return lines.join("\n");
}

function formatBatch(result: GetBatchResult): string {
  const lines = [
    `# Batch: ${result.batchId}\n`,
    `**Status**: ${result.status}`,
    `**Run ID**: ${result.runId}`,
    `**Created**: ${new Date(result.createdAt).toISOString()}`,
  ];

  if (result.claim) {
    lines.push(`**Claimed by**: ${result.claim.adapterId}`);
    lines.push(`**Lease until**: ${new Date(result.claim.leaseUntil).toISOString()}`);
  }

  lines.push("", "## Requests\n");

  for (const req of result.requests) {
    lines.push(`### ${req.method} ${req.endpoint}`);
    lines.push(`- **Request ID**: \`${req.requestId}\``);
    if (req.body !== undefined) {
      lines.push(`- **Body**: \`\`\`json\n${JSON.stringify(req.body, null, 2)}\n\`\`\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatProvideResult(result: ProvideBatchResult): string {
  if (result.ok) {
    return `✅ ${result.message ?? "Mock data provided successfully."}`;
  }
  return `❌ Failed to provide mock data: ${result.message}`;
}
