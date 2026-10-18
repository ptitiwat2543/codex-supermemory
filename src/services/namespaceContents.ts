import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type Supermemory from "supermemory";

// Recall reads every legacy and cross-client namespace, and most of them hold
// nothing, so each prompt spent search quota on namespaces with no content.
// A namespace found empty by a list call is skipped until its check is this
// old; then it is searched and listed again, so content added later still
// shows up within this window.
const RECHECK_MS = 6 * 60 * 60 * 1000;

interface Contents {
  empty: boolean;
  checkedAt: number;
}

function stateFile(): string {
  return join(homedir(), ".codex-supermemory", "namespace-contents.json");
}

function readState(): Record<string, Contents> {
  try {
    const value = JSON.parse(readFileSync(stateFile(), "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// A check dated in the future (a clock that ran ahead, or a hand-edited file) is not trusted.
function fresh(entry: Contents | undefined, now: number): entry is Contents {
  return !!entry && typeof entry.checkedAt === "number" && entry.checkedAt <= now && now - entry.checkedAt < RECHECK_MS;
}

/**
 * Namespaces worth searching now, and the ones whose contents need a new check. Namespaces this
 * plugin writes to are always searched, so a session's own new memories are never hidden.
 */
export function planNamespaces(
  tags: string[],
  writeTags: string[] = [],
  now = Date.now(),
): { search: string[]; check: string[] } {
  const state = readState();
  const writes = new Set(writeTags);
  return {
    search: tags.filter((tag) => writes.has(tag) || !(fresh(state[tag], now) && state[tag].empty)),
    check: tags.filter((tag) => !writes.has(tag) && !fresh(state[tag], now)),
  };
}

/**
 * True when both memories and documents report no items; undefined when a list call fails. A 402 or
 * 429 here is swallowed on purpose: the searches meet the same limit and start the recall cooldown.
 */
export async function namespaceIsEmpty(
  client: Supermemory,
  namespace: string,
  requestOptions?: Parameters<Supermemory["list"]>[3],
): Promise<boolean | undefined> {
  try {
    const [memories, documents] = await Promise.all([
      client.list(namespace, "memories", { limit: 1 }, requestOptions),
      client.list(namespace, "documents", { limit: 1 }, requestOptions),
    ]);
    const total = (page: { pagination?: { totalItems?: number } }) => page.pagination?.totalItems;
    const counts = [total(memories), total(documents)];
    if (counts.some((count) => typeof count !== "number")) return undefined;
    return counts.every((count) => count === 0);
  } catch {
    return undefined;
  }
}

/**
 * Saves each check. An unknown result (a failed list) is saved as not empty, so the namespace keeps
 * being searched but is not listed again on every prompt. Two sessions writing at once can drop each
 * other's entries; that only costs one more check.
 */
export function recordContents(results: Map<string, boolean | undefined>, now = Date.now()): void {
  if (!results.size) return;
  const state = readState();
  for (const [tag, empty] of results) state[tag] = { empty: empty === true, checkedAt: now };
  const file = stateFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, file);
  } catch {
    // Best effort: without the file every namespace is searched, as before.
    rmSync(temp, { force: true });
  }
}
