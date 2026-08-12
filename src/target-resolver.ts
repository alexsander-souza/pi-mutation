import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedTarget, ResolverError } from "./types";

/** Directories never descended into during symbol search */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
};

const EXTENSION_LANGUAGE: Record<string, ResolvedTarget["language"]> = {
  ".py": "python",
  ".go": "go",
};

/**
 * Resolve a user-supplied target to a concrete source file.
 * A target with a path separator or any file extension is treated as a file
 * path; anything else is treated as a symbol name to locate under cwd.
 */
export function resolveTarget(
  target: string,
  cwd: string,
): ResolvedTarget | ResolverError {
  const isPathLike = target.includes("/") || path.extname(target) !== "";
  if (isPathLike) return resolveFilePath(target, cwd);
  return resolveSymbol(target, cwd);
}

function resolveFilePath(
  target: string,
  cwd: string,
): ResolvedTarget | ResolverError {
  const resolved = path.resolve(cwd, target);
  const rel = path.relative(cwd, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return {
      kind: "escape",
      message: `Target path escapes the working directory: ${resolved}`,
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      kind: "not_found",
      message: `Target file not found: ${resolved}`,
    };
  }
  const ext = path.extname(resolved);
  const language = EXTENSION_LANGUAGE[ext];
  if (language === undefined) {
    return {
      kind: "unsupported",
      message: `Unsupported file extension "${ext}" for target: ${resolved}`,
    };
  }
  return { filePath: resolved, language };
}

function resolveSymbol(
  symbol: string,
  cwd: string,
): ResolvedTarget | ResolverError {
  const found = findSymbol(cwd, symbol);
  if (found === undefined) {
    return {
      kind: "symbol_not_found",
      message: `Symbol not found under ${cwd}: ${symbol}`,
    };
  }
  return found;
}

/**
 * Depth-first walk of dir: files in the current directory (sorted) are
 * checked first, then subdirectories (sorted, minus SKIP_DIRS) are recursed
 * into, so the first match is deterministic.
 */
function findSymbol(dir: string, symbol: string): ResolvedTarget | undefined {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const subdirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS[entry.name] === undefined) subdirs.push(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const language = EXTENSION_LANGUAGE[ext];
    if (language === undefined) continue;
    const needle = language === "python" ? `def ${symbol}(` : `func ${symbol}(`;
    let content: string;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (content.includes(needle)) {
      return { filePath: full, language, symbol };
    }
  }

  for (const subdir of subdirs) {
    const found = findSymbol(subdir, symbol);
    if (found !== undefined) return found;
  }
  return undefined;
}
