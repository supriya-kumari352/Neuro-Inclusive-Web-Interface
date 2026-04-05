/**
 * Service worker: proxies AI requests to the local/backend API so keys never ship in the extension.
 */
import type { BackgroundRequest, BackgroundResponse } from "../shared/messages.js";
import { fnv1aHash, LruCache } from "./lruCache.js";

const DEFAULT_API_BASE = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 12000;
const CACHE_SIZE = 280;

const responseCache = new LruCache<BackgroundResponse>(CACHE_SIZE);

function cacheTtl(message: BackgroundRequest): number {
  if (message.type === "API_SIMPLIFY") return 15 * 60 * 1000;
  if (message.type === "API_SUMMARIZE") return 10 * 60 * 1000;
  if (message.type === "API_DEFINE") return 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function cacheKeyFor(message: BackgroundRequest, base: string): string {
  if (message.type === "API_SIMPLIFY") {
    return `simplify:${fnv1aHash(base)}:${fnv1aHash(message.text)}`;
  }
  if (message.type === "API_SUMMARIZE") {
    return `summarize:${message.mode}:${fnv1aHash(base)}:${fnv1aHash(message.text)}`;
  }
  if (message.type === "API_DEFINE") {
    return `define:${fnv1aHash(base)}:${fnv1aHash(message.text)}`;
  }
  return `cognitive:${fnv1aHash(base)}:${fnv1aHash(message.text)}:${fnv1aHash(
    JSON.stringify(message.domStats)
  )}`;
}

function readCached(key: string): BackgroundResponse | null {
  const hit = responseCache.get(key);
  return hit ?? null;
}

function writeCached(
  key: string,
  message: BackgroundRequest,
  response: BackgroundResponse
): BackgroundResponse {
  if (response.ok) {
    responseCache.set(key, response, cacheTtl(message));
  }
  return response;
}

function normalizeApiBase(v: string): string {
  const trimmed = v.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_API_BASE;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return trimmed;
    }
  } catch {
    // Fall through to default.
  }
  return DEFAULT_API_BASE;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

async function readHttpError(res: Response): Promise<string> {
  const parsed = await res
    .clone()
    .json()
    .catch(() => null);
  const body = asObject(parsed);
  if (body && typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  const text = await res.text().catch(() => "");
  return text.trim() || res.statusText || `HTTP ${res.status}`;
}

async function postJson(
  url: string,
  payload: unknown
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: await readHttpError(res) };
    }
    const parsed = await res.json().catch(() => null);
    const data = asObject(parsed);
    if (!data) {
      return { ok: false, error: "Invalid JSON response" };
    }
    return { ok: true, data };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, error: "Request timed out" };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    _sender,
    sendResponse: (r: BackgroundResponse) => void
  ) => {
    void handle(message).then(sendResponse);
    return true;
  }
);

async function handle(message: BackgroundRequest): Promise<BackgroundResponse> {
  const base = normalizeApiBase(message.apiBase);
  const cacheKey = cacheKeyFor(message, base);
  const cached = readCached(cacheKey);
  if (cached) return cached;

  try {
    if (message.type === "API_SIMPLIFY") {
      const r = await postJson(`${base}/api/simplify`, { text: message.text });
      if (!r.ok) return { ok: false, error: r.error };
      if (typeof r.data.simplified !== "string") {
        return { ok: false, error: "Invalid simplify response" };
      }
      return writeCached(cacheKey, message, {
        ok: true,
        simplified: r.data.simplified,
      });
    }
    if (message.type === "API_SUMMARIZE") {
      const r = await postJson(`${base}/api/summarize`, {
        text: message.text,
        mode: message.mode,
      });
      if (!r.ok) return { ok: false, error: r.error };
      if (typeof r.data.summary !== "string") {
        return { ok: false, error: "Invalid summarize response" };
      }
      return writeCached(cacheKey, message, {
        ok: true,
        summary: r.data.summary,
      });
    }
    if (message.type === "API_COGNITIVE_LOAD") {
      const r = await postJson(`${base}/api/cognitive-load`, {
        text: message.text,
        domStats: message.domStats,
      });
      if (!r.ok) return { ok: false, error: r.error };
      const score =
        typeof r.data.score === "number"
          ? Math.max(0, Math.min(100, Math.round(r.data.score)))
          : undefined;
      const reason = typeof r.data.reason === "string" ? r.data.reason : undefined;
      if (score == null && reason == null) {
        return { ok: false, error: "Invalid cognitive-load response" };
      }
      return writeCached(cacheKey, message, {
        ok: true,
        score,
        reason,
      });
    }
    if (message.type === "API_DEFINE") {
      const r = await postJson(`${base}/api/define`, { text: message.text });
      if (!r.ok) return { ok: false, error: r.error };
      if (typeof r.data.definition !== "string") {
        return { ok: false, error: "Invalid define response" };
      }
      return writeCached(cacheKey, message, {
        ok: true,
        definition: r.data.definition,
      });
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error",
    };
  }
  return { ok: false, error: "Unknown message" };
}
