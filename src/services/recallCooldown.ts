import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { SupermemoryError } from "supermemory";

// A depleted balance (402) or a rate limit (429) answers every prompt the same
// way until it resets, so asking again only adds latency and load. Pause
// per-prompt recall for a fixed window instead of retrying on each prompt.
const RECALL_COOLDOWN_MS = 60 * 60 * 1000;
const LIMIT_STATUSES = new Set([402, 429]);

function cooldownFile(): string {
  return join(homedir(), ".codex-supermemory", "recall-cooldown.json");
}

export function limitStatus(error: unknown): number | undefined {
  const status = error instanceof SupermemoryError ? error.statusCode : undefined;
  return typeof status === "number" && LIMIT_STATUSES.has(status) ? status : undefined;
}

export function isLimitStatus(status: number): boolean {
  return LIMIT_STATUSES.has(status);
}

export function recallCoolingDown(now = Date.now()): boolean {
  const file = cooldownFile();
  if (!existsSync(file)) return false;
  try {
    const { until } = JSON.parse(readFileSync(file, "utf-8")) as { until?: number };
    return typeof until === "number" && until > now;
  } catch {
    return false;
  }
}

export function startRecallCooldown(status: number, now = Date.now()): void {
  const file = cooldownFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ status, until: now + RECALL_COOLDOWN_MS }));
  } catch {
    // Best effort: without the marker the next prompt asks once more.
  }
}
