/**
 * Fail the build if code references removed upstream helpers or calls
 * non-existent methods on namespace-imported service modules.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Symbols that must never appear as call targets (removed APIs). */
const REMOVED_CALLS: Array<{ symbol: string; replacement: string }> = [
  {
    symbol: "waitForSearchCompletion",
    replacement: "slskd.collectSearchResults",
  },
];

/** `import * as alias from ".../services/module"` — validate alias.method(). */
const NAMESPACE_MODULES: Array<{ alias: string; file: string }> = [
  { alias: "slskd", file: "src/services/slskd.ts" },
  { alias: "navidrome", file: "src/services/navidrome.ts" },
  { alias: "musicbrainz", file: "src/services/musicbrainz.ts" },
  { alias: "lastfm", file: "src/services/lastfm.ts" },
  { alias: "listenbrainz", file: "src/services/listenbrainz.ts" },
  { alias: "lrclib", file: "src/services/lrclib.ts" },
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

function readExports(modulePath: string): Set<string> {
  const source = readFileSync(join(ROOT, modulePath), "utf8");
  const exports = new Set<string>();
  const patterns = [
    /export\s+async\s+function\s+(\w+)/g,
    /export\s+function\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+enum\s+(\w+)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      exports.add(match[1]!);
    }
  }
  return exports;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const srcAndTestFiles = walkTsFiles(join(ROOT, "src"));
const testsDir = join(ROOT, "tests");
if (dirExists(testsDir)) {
  srcAndTestFiles.push(...walkTsFiles(testsDir));
}

const violations: string[] = [];

// 1. Removed symbol calls
for (const file of srcAndTestFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripLineComment(lines[i]!);
    for (const { symbol, replacement } of REMOVED_CALLS) {
      const callPattern = new RegExp(`\\b${symbol}\\s*\\(`);
      if (callPattern.test(line)) {
        violations.push(
          `${rel(file)}:${i + 1}: calls removed ${symbol}() — use ${replacement}`
        );
      }
    }
  }
}

// 2. Namespace import method validation
const exportCache = new Map<string, Set<string>>();
for (const { file } of NAMESPACE_MODULES) {
  exportCache.set(file, readExports(file));
}

for (const file of srcAndTestFiles) {
  const source = readFileSync(file, "utf8");
  for (const { alias, file: moduleFile } of NAMESPACE_MODULES) {
    if (rel(file) === moduleFile) continue;
    const exports = exportCache.get(moduleFile)!;
    const callPattern = new RegExp(`\\b${alias}\\.(\\w+)\\s*\\(`, "g");
    const typePattern = new RegExp(`\\b${alias}\\.([A-Z]\\w*)`, "g");
    const seen = new Set<string>();

    for (const match of source.matchAll(callPattern)) {
      const method = match[1]!;
      const key = `call:${method}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!exports.has(method)) {
        violations.push(
          `${rel(file)}: ${alias}.${method}() is not exported from ${moduleFile}`
        );
      }
    }

    for (const match of source.matchAll(typePattern)) {
      const typeName = match[1]!;
      const key = `type:${typeName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!exports.has(typeName)) {
        violations.push(
          `${rel(file)}: ${alias}.${typeName} is not exported from ${moduleFile}`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Stale / invalid service references:\n");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  `Service refs OK: ${REMOVED_CALLS.length} removed symbols blocked, ${NAMESPACE_MODULES.length} namespace modules validated`
);
