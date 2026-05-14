/**
 * Post-build script: adds .js extensions to extensionless relative imports
 * in dist/generated/**\/*.js files.
 *
 * Why: Prisma's prisma-client generator emits TypeScript with extensionless
 * imports (e.g. `from "./internal/class"`). TypeScript passes these through
 * unchanged. Node.js ESM requires explicit extensions, so without this fix
 * every import inside the compiled Prisma client would throw ERR_MODULE_NOT_FOUND.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = join(__dirname, "..", "dist", "generated");

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

// Matches any `from "..."` or `from '...'` where the specifier is a relative
// path (starts with ./ or ../) without an existing file extension.
const IMPORT_RE = /\bfrom\s+(["'])(\.{1,2}\/[^"']+)(["'])/g;

let patchedCount = 0;

for (const file of collectJsFiles(TARGET_DIR)) {
  const src = readFileSync(file, "utf8");
  const fixed = src.replace(IMPORT_RE, (match, q1, specifier, q2) => {
    // Skip if specifier already ends with a recognised extension
    if (/\.\w+$/.test(specifier)) return match;
    return `from ${q1}${specifier}.js${q2}`;
  });

  if (fixed !== src) {
    writeFileSync(file, fixed, "utf8");
    patchedCount++;
  }
}

console.log(`[fix-esm-imports] Patched ${patchedCount} file(s) in dist/generated/`);
