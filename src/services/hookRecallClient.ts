import { CONFIG, getApiKeyValue, getBaseUrl, getApiVersion } from "../config.js";
import type { ProfileWithSearchResult, SearchResultItem } from "./client.js";
import { mergeProfileResults } from "./resultMerge.js";
import { memoryText, recallProvenance } from "./resultText.js";
import { createV5Client, readV5Search, apiErrorMessage } from "./api.js";
import { isLimitStatus, limitStatus, recallCoolingDown, startRecallCooldown } from "./recallCooldown.js";
import { namespaceIsEmpty, planNamespaces, recordContents } from "./namespaceContents.js";

export const HOOK_RECALL_TIMEOUT_MS = 3000;
// Self-hosted backends need a longer cap than hosted; see #61.
export const SELF_HOSTED_HOOK_RECALL_TIMEOUT_MS = 60_000;
const HOSTED_API_HOSTNAME = "api.supermemory.ai";

export function hookRecallTimeoutMs(baseUrl = getBaseUrl()): number {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === HOSTED_API_HOSTNAME
      ? HOOK_RECALL_TIMEOUT_MS
      : SELF_HOSTED_HOOK_RECALL_TIMEOUT_MS;
  } catch {
    return HOOK_RECALL_TIMEOUT_MS;
  }
}

interface HookRecallOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Namespaces this plugin writes to; they are searched even when a check found them empty. */
  writeTags?: string[];
}

function stringFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (fact): fact is string => typeof fact === "string" && fact.trim().length > 0,
  );
}

function normalizeProfileResponse(raw: unknown): ProfileWithSearchResult {
  const value = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const profile = value.profile && typeof value.profile === "object"
    ? value.profile as Record<string, unknown>
    : {};
  const searchResults = value.searchResults && typeof value.searchResults === "object"
    ? value.searchResults as Record<string, unknown>
    : null;
  const rawResults = Array.isArray(searchResults?.results)
    ? searchResults.results as SearchResultItem[]
    : [];
  const results = rawResults
    .map((result) => {
      const provenance = recallProvenance(result);
      return {
        id: result.id,
        memory: memoryText(result),
        score: result.score,
        similarity: result.similarity,
        title: provenance.title,
        filepath: provenance.filepath,
        updatedAt: result.updatedAt,
      };
    })
    .filter((result) => result.memory.length > 0);

  return {
    success: true,
    profile: {
      static: stringFacts(profile.static),
      dynamic: stringFacts(profile.dynamic),
    },
    searchResults: searchResults
      ? {
          results,
          total: typeof searchResults.total === "number" ? searchResults.total : results.length,
          timing: typeof searchResults.timing === "number" ? searchResults.timing : undefined,
        }
      : undefined,
  };
}

async function fetchProfile(
  containerTag: string,
  query: string,
  options: Required<Pick<HookRecallOptions, "timeoutMs" | "fetchImpl">>,
): Promise<ProfileWithSearchResult> {
  const apiKey = getApiKeyValue();
  if (!apiKey) return { success: false, error: "Missing API key", profile: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    if (getApiVersion() === "v5") {
      return await readV5Search(createV5Client(options.fetchImpl), containerTag, query, {
        timeoutInSeconds: options.timeoutMs / 1000,
        maxRetries: 0,
        abortSignal: controller.signal,
      }, CONFIG.recallSearchMode);
    }
    const response = await options.fetchImpl(`${getBaseUrl().replace(/\/+$/, "")}/v4/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-sm-source": "codex",
      },
      body: JSON.stringify({ containerTag, q: query }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (isLimitStatus(response.status)) startRecallCooldown(response.status);
      return { success: false, error: `Profile request failed (${response.status})`, profile: null };
    }
    return normalizeProfileResponse(await response.json());
  } catch (error) {
    const status = limitStatus(error);
    if (status) startRecallCooldown(status);
    return {
      success: false,
      error: apiErrorMessage(error),
      profile: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getHookProfileWithSearchMany(
  containerTags: string[],
  query: string,
  options: HookRecallOptions = {},
): Promise<ProfileWithSearchResult> {
  if (recallCoolingDown()) {
    return { success: false, error: "Recall paused after a usage limit", profile: null };
  }
  const resolved = {
    timeoutMs: options.timeoutMs ?? hookRecallTimeoutMs(),
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const uniqueTags = [...new Set(containerTags.filter(Boolean))];
  if (getApiVersion() !== "v5") {
    const results = await Promise.all(uniqueTags.map((containerTag) => fetchProfile(containerTag, query, resolved)));
    return mergeProfileResults(results, CONFIG.maxMemories);
  }
  const plan = planNamespaces(uniqueTags, options.writeTags);
  // Content checks run beside the searches and stop at the same budget, so the prompt never waits longer.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, resolved.timeoutMs);
  });
  const client = createV5Client(resolved.fetchImpl);
  const checkOptions = { timeoutInSeconds: resolved.timeoutMs / 1000, maxRetries: 0, abortSignal: controller.signal };
  try {
    const [results, checks] = await Promise.all([
      Promise.all(plan.search.map((containerTag) => fetchProfile(containerTag, query, resolved))),
      Promise.all(plan.check.map(async (tag) =>
        [tag, await Promise.race([namespaceIsEmpty(client, tag, checkOptions), late])] as const)),
    ]);
    recordContents(new Map(checks));
    if (!plan.search.length) {
      return { success: true, profile: { static: [], dynamic: [] }, searchResults: { results: [], total: 0 } };
    }
    return mergeProfileResults(results, CONFIG.maxMemories);
  } finally {
    clearTimeout(timer);
  }
}
