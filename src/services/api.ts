import Supermemory, { SupermemoryError, type FilterExpression, type RequestOptions } from "supermemory";
import { getApiKeyValue, getBaseUrl, type RecallSearchMode } from "../config.js";
import type { ProfileWithSearchResult, SearchResultItem, MemoryScope } from "./client.js";
import { memoryText, recallProvenance } from "./resultText.js";

export function createV5Client(fetchImpl?: typeof fetch): Supermemory {
  return new Supermemory({
    apiKey: getApiKeyValue(),
    baseUrl: getBaseUrl(),
    headers: { "x-sm-source": "codex" },
    timeoutInSeconds: 60,
    maxRetries: 2,
    fetch: fetchImpl,
  });
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof SupermemoryError) {
    return typeof error.statusCode === "number"
      ? `API request failed (${error.statusCode})`
      : "API request failed";
  }
  return error instanceof Error ? error.message : String(error);
}

export function scopeFilter(scope?: MemoryScope): FilterExpression | undefined {
  return scope ? { field: "sm_scope", operator: "eq", value: scope } : undefined;
}

export function profileFacts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Malformed Supermemory profile: facts must be an array");
  }

  return value.map((fact, index) => {
    if (typeof fact === "string") {
      if (fact.trim().length === 0) {
        throw new Error(`Malformed Supermemory profile: fact ${index} has no text`);
      }
      return fact;
    }

    if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
      throw new Error(`Malformed Supermemory profile: fact ${index} is not a memory`);
    }

    const text = memoryText(fact);
    if (text.length === 0) {
      throw new Error(`Malformed Supermemory profile: fact ${index} has no text`);
    }
    return text;
  });
}

function profileSections(value: unknown): { static: string[]; dynamic: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Supermemory profile: profile envelope is missing");
  }

  const profile = value as Record<string, unknown>;
  return {
    static: profileFacts(profile.static),
    dynamic: profileFacts(profile.dynamic),
  };
}

export function normalizeSearchItem(item: SearchResultItem): SearchResultItem {
  const provenance = recallProvenance(item);
  return {
    ...item,
    title: provenance.title,
    filepath: provenance.filepath,
    updatedAt: item.updatedAt ?? item.system?.updatedAt,
  };
}

export async function searchV5(
  client: Supermemory,
  namespace: string,
  query: string,
  searchMode: RecallSearchMode,
  filter?: FilterExpression,
  requestOptions?: RequestOptions,
) {
  return client.search(namespace, {
    query,
    filter,
    searchMode,
    threshold: 0.6,
    limit: 10,
    rerank: "none",
    rewriteQuery: false,
    include: { documents: false, related: false, forgotten: false },
  }, requestOptions);
}

export async function readV5Profile(
  client: Supermemory,
  namespace: string,
  query?: string,
  scope?: MemoryScope,
  requestOptions?: RequestOptions,
  searchMode: RecallSearchMode = "memories",
): Promise<ProfileWithSearchResult> {
  const filter = scopeFilter(scope);
  const [profileResponse, search] = await Promise.all([
    client.profile(namespace, { filter }, requestOptions),
    query ? searchV5(client, namespace, query, searchMode, filter, requestOptions) : undefined,
  ]);
  const profile = profileSections(profileResponse?.profile);
  const results = search?.results.map(normalizeSearchItem).map((item) => ({
    ...item,
    memory: memoryText(item),
  })).filter((item) => item.memory.length > 0);
  return {
    success: true,
    profile: {
      static: profile.static,
      dynamic: profile.dynamic,
    },
    searchResults: results ? { results, total: results.length, timing: search?.searchTime } : undefined,
  };
}
