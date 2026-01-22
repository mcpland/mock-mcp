/**
 * Discovery module for mock-mcp Daemon + Adapter architecture.
 *
 * Provides:
 * - Project root resolution (up-search for .git / package.json)
 * - Project ID computation (sha256 of realpath)
 * - Registry/lock file path management
 * - IPC path (Unix Domain Socket / Windows Named Pipe)
 * - ensureDaemonRunning() - atomic daemon startup with lock
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Debug logging function - disabled in production to avoid file I/O overhead
function debugLog(_msg: string) {
  // Uncomment for debugging daemon startup issues:
  // try {
  //   const logPath = path.join(os.tmpdir(), "mock-mcp-debug.log");
  //   fssync.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${_msg}\n`);
  // } catch { /* ignore */ }
}

// In CJS builds, import.meta.url is replaced with __importMetaUrl by tsup
// When re-bundled by another tool (Vitest, esbuild, webpack), the URL may not
// be a valid file:// URL, so we need graceful fallback
const __curDirname = (() => {
  try {
    const metaUrl = import.meta.url;
    // Check if it's a valid file:// URL before calling fileURLToPath
    if (metaUrl && typeof metaUrl === "string" && metaUrl.startsWith("file://")) {
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {
    // Fallback on any error
  }
  // Fallback: use process.cwd() - this is acceptable because getDaemonEntryPath()
  // will use process.argv[1] as fallback if the dist path doesn't exist
  return process.cwd();
})();

// =============================================================================
// Types
// =============================================================================

export interface DaemonRegistry {
  projectId: string;
  projectRoot: string;
  ipcPath: string; // UDS path or \\.\pipe\...
  token: string;
  pid: number;
  startedAt: string;
  version: string;
}

export interface EnsureDaemonOptions {
  projectRoot?: string;
  timeoutMs?: number;
  /** For testing: override cache directory */
  cacheDir?: string;
}

// =============================================================================
// Project Root Resolution
// =============================================================================

/**
 * Resolve the project root by searching upward for .git or package.json.
 * Falls back to the starting directory if nothing is found.
 */
export function resolveProjectRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    // Check for .git directory
    const gitPath = path.join(current, ".git");
    try {
      const stat = fssync.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Ignore - continue searching
    }

    // Check for package.json
    const pkgPath = path.join(current, "package.json");
    try {
      fssync.accessSync(pkgPath, fssync.constants.F_OK);
      return current;
    } catch {
      // Ignore - continue searching
    }

    current = path.dirname(current);
  }

  // Fallback to start directory
  return path.resolve(startDir);
}

// =============================================================================
// Project ID Computation
// =============================================================================

/**
 * Compute a stable project ID from the project root path.
 * Uses sha256 of the realpath, truncated to 16 characters.
 */
export function computeProjectId(projectRoot: string): string {
  const real = fssync.realpathSync(projectRoot);
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

// =============================================================================
// Cache Directory
// =============================================================================

/**
 * Get the cache directory for mock-mcp files.
 * Priority: override > MOCK_MCP_CACHE_DIR env > XDG_CACHE_HOME > LOCALAPPDATA (Windows) > ~/.cache
 */
export function getCacheDir(override?: string): string {
  if (override) {
    return override;
  }

  // Check MOCK_MCP_CACHE_DIR environment variable for test isolation
  const envCacheDir = process.env.MOCK_MCP_CACHE_DIR;
  if (envCacheDir) {
    return envCacheDir;
  }

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) {
    return xdg;
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }

  const home = os.homedir();
  if (home) {
    return path.join(home, ".cache");
  }

  return os.tmpdir();
}

// =============================================================================
// Path Management
// =============================================================================

export interface DaemonPaths {
  base: string;
  registryPath: string;
  lockPath: string;
  ipcPath: string;
}

/**
 * Get all relevant paths for a given project ID.
 */
export function getPaths(projectId: string, cacheDir?: string): DaemonPaths {
  const base = path.join(getCacheDir(cacheDir), "mock-mcp");
  const registryPath = path.join(base, `${projectId}.json`);
  const lockPath = path.join(base, `${projectId}.lock`);

  // IPC path: Unix Domain Socket on Unix, Named Pipe on Windows
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mock-mcp-${projectId}`
      : path.join(base, `${projectId}.sock`);

  return { base, registryPath, lockPath, ipcPath };
}

// =============================================================================
// Registry Management
// =============================================================================

/**
 * Read the daemon registry file.
 */
export async function readRegistry(
  registryPath: string
): Promise<DaemonRegistry | null> {
  try {
    const txt = await fs.readFile(registryPath, "utf-8");
    return JSON.parse(txt) as DaemonRegistry;
  } catch (error) {
    debugLog(`readRegistry error for ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Write the daemon registry file with restricted permissions.
 */
export async function writeRegistry(
  registryPath: string,
  registry: DaemonRegistry
): Promise<void> {
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), {
    encoding: "utf-8",
    mode: 0o600, // Read/write for owner only
  });
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Check if the daemon is healthy by making an HTTP request to /health.
 */
export async function healthCheck(
  ipcPath: string,
  timeoutMs: number = 2000
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        method: "GET",
        socketPath: ipcPath,
        path: "/health",
        timeout: timeoutMs,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

// =============================================================================
// Lock Management
// =============================================================================

/**
 * Try to acquire an exclusive lock file.
 * Returns the file handle if successful, null otherwise.
 */
export async function tryAcquireLock(
  lockPath: string
): Promise<fssync.promises.FileHandle | null> {
  try {
    // O_EXCL ensures atomic creation - fails if file exists
    const fh = await fs.open(lockPath, "wx");
    // Write our PID to the lock file
    await fh.write(`${process.pid}\n`);
    return fh;
  } catch {
    return null;
  }
}

/**
 * Release the lock file.
 */
export async function releaseLock(
  lockPath: string,
  fh: fssync.promises.FileHandle
): Promise<void> {
  await fh.close();
  await fs.rm(lockPath).catch(() => {
    // Ignore removal errors
  });
}

// =============================================================================
// Token Generation
// =============================================================================

/**
 * Generate a random token for daemon authentication.
 */
export function randomToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

// =============================================================================
// Daemon Entry Point Resolution
// =============================================================================

/**
 * Get the path to the daemon entry point.
 *
 * This function handles multiple scenarios:
 * 1. Direct execution from source (development)
 * 2. Execution from dist (production)
 * 3. When re-bundled by another tool (Vitest, esbuild, webpack)
 *
 * We use require.resolve to reliably find the mock-mcp package location,
 * which works even when the code is re-bundled by another tool.
 */
export function getDaemonEntryPath(): string {
  // Strategy 1: Use require.resolve to find the mock-mcp package
  // This works reliably even when re-bundled by Vitest or other tools
  // We use process.cwd() as the base path so that require.resolve searches
  // from the user's project directory, not from the bundled code location
  try {
    // Create a require function rooted at process.cwd()
    // This ensures we search node_modules from the user's project
    const cwdRequire = createRequire(pathToFileURL(path.join(process.cwd(), "index.js")).href);
    // require.resolve will find the package entry point based on package.json exports
    // In CJS context, it resolves to dist/index.cjs; in ESM, to dist/index.js
    const resolved = cwdRequire.resolve("mock-mcp");
    const distDir = path.dirname(resolved);
    // Always use .js version for daemon (ESM) as it's the bin entry point
    const daemonEntry = path.join(distDir, "index.js");
    if (fssync.existsSync(daemonEntry)) {
      return daemonEntry;
    }
  } catch {
    // Strategy 1 failed, try next
  }

  // Strategy 2: Use __curDirname (from import.meta.url)
  // This works when running directly from the package
  try {
    const packageRoot = resolveProjectRoot(__curDirname);
    const distPath = path.join(packageRoot, "dist", "index.js");
    if (fssync.existsSync(distPath)) {
      return distPath;
    }
  } catch {
    // Strategy 2 failed, try next
  }

  // Strategy 3: Fallback to process.argv[1]
  // This works when the CLI is invoked directly
  if (process.argv[1]) {
    return process.argv[1];
  }

  // Last resort: construct path from cwd (may not work)
  return path.join(process.cwd(), "dist", "index.js");
}

// =============================================================================
// Ensure Daemon Running
// =============================================================================

/**
 * Ensure the daemon is running for the given project.
 *
 * This function:
 * 1. Checks if a daemon is already running (via registry + health check)
 * 2. If not, acquires a lock and spawns a new daemon
 * 3. Waits for the daemon to become healthy
 * 4. Returns the registry information
 *
 * Thread-safe: multiple processes calling this concurrently will only start one daemon.
 */
export async function ensureDaemonRunning(
  opts: EnsureDaemonOptions = {}
): Promise<DaemonRegistry> {
  const projectRoot = opts.projectRoot ?? resolveProjectRoot();
  const projectId = computeProjectId(projectRoot);
  const { base, registryPath, lockPath, ipcPath } = getPaths(
    projectId,
    opts.cacheDir
  );
  const timeoutMs = opts.timeoutMs ?? 10000;

  // Ensure cache directory exists
  await fs.mkdir(base, { recursive: true });

  // Check if daemon is already running
  const existing = await readRegistry(registryPath);
  debugLog(`Registry read result: ${existing ? "Found (PID " + existing.pid + ")" : "Null"}`);

  if (existing) {
    // Retry health check a few times to be robust against transient load
    let healthy = false;
    for (let i = 0; i < 3; i++) {
        debugLog(`Checking health attempt ${i+1}/3 on ${existing.ipcPath}`);
        healthy = await healthCheck(existing.ipcPath);
        debugLog(`Health check attempt ${i + 1}/3 result: ${healthy}`);
        if (healthy) break;
        await new Promise((r) => setTimeout(r, 200));
    }

    if (healthy) {
      debugLog("Existing daemon is healthy, returning");
      return existing;
    } else {
      debugLog("Existing daemon is NOT healthy (after retries), will restart");
    }
  } else {
    debugLog("No existing registry found");
  }

  // Clean up stale socket file on Unix
  if (process.platform !== "win32") {
    try {
      await fs.rm(ipcPath);
    } catch {
      // No stale socket to clean up
    }
  }

  // Try to acquire the lock
  const lock = await tryAcquireLock(lockPath);

  if (lock) {
    try {
      // Double-check after acquiring lock (another process may have started daemon)
      const recheckReg = await readRegistry(registryPath);
      if (recheckReg && (await healthCheck(recheckReg.ipcPath))) {
        return recheckReg;
      }

      // We are responsible for starting the daemon
      const token = randomToken();
      const daemonEntry = getDaemonEntryPath();

      const child = spawn(
        process.execPath,
        [daemonEntry, "daemon", "--project-root", projectRoot, "--token", token],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            MOCK_MCP_CACHE_DIR: opts.cacheDir ?? "",
          },
        }
      );

      // Capture daemon output for debugging on failure
      let daemonStderr = "";
      let daemonStdout = "";

      child.stdout?.on("data", (data) => {
        const str = data.toString();
        debugLog(`Daemon stdout: ${str}`);
      });

      child.stderr?.on("data", (data) => {
        daemonStderr += data.toString();
        debugLog(`Daemon stderr: ${data.toString()}`);
      });

      child.on("error", (err) => {
        console.error(`[mock-mcp] Daemon spawn error: ${err.message}`);
      });

      child.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          console.error(`[mock-mcp] Daemon exited with code: ${code}`);
          if (daemonStderr) {
            console.error(`[mock-mcp] Daemon stderr: ${daemonStderr.slice(0, 500)}`);
          }
        } else if (signal) {
          console.error(`[mock-mcp] Daemon killed by signal: ${signal}`);
        }
      });

      child.unref();

      // Wait for daemon to become healthy
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const reg = await readRegistry(registryPath);
        if (reg && (await healthCheck(reg.ipcPath))) {
          return reg;
        }
        await sleep(50);
      }

      // Timeout - log debug info
      console.error("[mock-mcp] Daemon failed to start within timeout");
      if (daemonStderr) {
        console.error(`[mock-mcp] Daemon stderr:\n${daemonStderr}`);
      }

      throw new Error(
        `Daemon start timeout after ${timeoutMs}ms. Check logs for details.`
      );
    } finally {
      await releaseLock(lockPath, lock);
    }
  }

  // Did not acquire lock - another process is starting the daemon
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reg = await readRegistry(registryPath);
    if (reg && (await healthCheck(reg.ipcPath))) {
      return reg;
    }
    await sleep(50);
  }

  throw new Error(
    `Waiting for daemon timed out after ${timeoutMs}ms. Another process may have failed to start it.`
  );
}

// =============================================================================
// Utilities
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Exports for CLI commands
// =============================================================================

export { sleep };
