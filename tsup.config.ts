import { defineConfig } from "tsup";

// Custom CJS shim that properly handles import.meta.url
// tsup's default shim uses `new URL(\`file:\${__filename}\`)` which creates invalid URLs
// We use `pathToFileURL(__filename).href` instead, with fallbacks for re-bundled scenarios
const cjsShimBanner = `
var __importMetaUrl = (function() {
  if (typeof document !== 'undefined') {
    return document.currentScript && document.currentScript.src || new URL('main.js', document.baseURI).href;
  }
  // Node.js CJS context
  // When this bundle is re-bundled by another tool (e.g., esbuild, webpack),
  // __filename may not be defined or may not be a valid file path.
  // We need to handle these cases gracefully.
  try {
    if (typeof __filename !== 'undefined' && __filename) {
      var url = require('url');
      var path = require('path');
      // Check if __filename looks like a valid file path
      if (path.isAbsolute(__filename) || __filename.startsWith('./') || __filename.startsWith('../')) {
        return url.pathToFileURL(__filename).href;
      }
    }
  } catch (e) {
    // Fallback if pathToFileURL fails
  }
  // Fallback: use process.cwd() as the base URL
  // This is not perfect but allows the code to continue working
  try {
    var url = require('url');
    return url.pathToFileURL(require('path').join(process.cwd(), 'index.cjs')).href;
  } catch (e) {
    return 'file:///unknown';
  }
})();
`;


export default defineConfig([
  // Main CLI entry point - with shebang
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: true,
    shims: false, // Disable default shims, we use custom one
    treeshake: true,
    target: "node18",
    outDir: "dist",
    banner: ({ format }) => ({
      js: format === "cjs" 
        ? `#!/usr/bin/env node\n${cjsShimBanner}` 
        : "#!/usr/bin/env node",
    }),
    define: {
      "import.meta.url": "import.meta.url", // Keep as-is for ESM
    },
    esbuildOptions(options, context) {
      if (context.format === "cjs") {
        options.define = {
          ...options.define,
          "import.meta.url": "__importMetaUrl",
        };
      }
    },
  },
  // Library entry points - no shebang
  {
    entry: {
      "client/index": "src/client/index.ts",
      "client/connect": "src/client/connect.ts",
      "adapter/index": "src/adapter/index.ts",
      "daemon/index": "src/daemon/index.ts",
      "shared/index": "src/shared/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: false, // Don't clean, first config already did
    shims: false,
    treeshake: true,
    target: "node18",
    outDir: "dist",
    banner: ({ format }) => ({
      js: format === "cjs" ? cjsShimBanner : "",
    }),
    esbuildOptions(options, context) {
      if (context.format === "cjs") {
        options.define = {
          ...options.define,
          "import.meta.url": "__importMetaUrl",
        };
      }
    },
  },
]);
