import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root (the folder holding the Python files and backups/). This file lives at
 * ts/src/util/paths.ts, three levels below it.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}
