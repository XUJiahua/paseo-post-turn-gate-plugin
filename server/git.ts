import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Every git call is bounded: the plugin runs them in one queue, so a hung call (a stale lock, a slow network file
 * system) would stall every repository's checks. ponytail: one fixed limit; a huge monorepo's first snapshot may need
 * more. Upgrade path: a policy field.
 */
export const GIT_TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout.trim();
}

/** Repository root for cwd, or null when cwd is not inside a git work tree. */
export async function toplevel(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

/**
 * Tree sha of the whole working tree (tracked + untracked, minus ignored),
 * written through a throwaway index so the real index and files stay untouched.
 * The real index is copied first to reuse its stat cache instead of rehashing every file.
 */
export async function snapshotTree(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ptg-index-"));
  const index = path.join(dir, "index");
  try {
    const realIndex = path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
    // Keep the original timestamps: git's racy-entry check compares file mtimes against the index
    // mtime, and a fresh mtime would make same-size edits made in the same second look unchanged.
    await cp(realIndex, index, { preserveTimestamps: true }).catch(() => undefined); // fresh repo: no index yet
    const env = { GIT_INDEX_FILE: index };
    await git(root, ["add", "-A"], env);
    return await git(root, ["write-tree"], env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function diffStat(root: string, fromTree: string, toTree: string): Promise<string> {
  return git(root, ["diff", "--stat", fromTree, toTree]);
}
