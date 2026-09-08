import { Hono } from "hono";
import { buildDeepLinks } from "./deeplinks";
import { percentile } from "./normalize";
import { ALL_SOURCE_IDS, PROVIDERS, fanOut } from "./providers";
import type { ConditionRank, Env, SearchQuery, SearchResponse, SourceId } from "./types";

const app = new Hono<{ Bindings: Env }>();

function parseIntOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseQuery(url: URL): SearchQuery {
  const sourcesParam = url.searchParams.get("sources");
  const requested = sourcesParam
    ? (sourcesParam.split(",").filter((s) => (ALL_SOURCE_IDS as string[]).includes(s)) as SourceId[])
    : ALL_SOURCE_IDS;
  const maxCondition = Number.parseInt(url.searchParams.get("maxCondition") ?? "0", 10);
  return {
    keyword: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    excludeKeyword: (url.searchParams.get("exclude") ?? "").trim().slice(0, 120),
    minPrice: parseIntOrNull(url.searchParams.get("minPrice") ?? undefined),
    maxPrice: parseIntOrNull(url.searchParams.get("maxPrice") ?? undefined),
    maxCondition: (Number.isFinite(maxCondition) && maxCondition >= 0 && maxCondition <= 6 ? maxCondition : 0) as ConditionRank,
    sources: requested.length ? requested : ALL_SOURCE_IDS,
    limitPerSource: Math.min(120, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30)),
    strict: url.searchParams.get("strict") !== "0",
  };
}

/** キャッシュキーを検索条件だけで決める（順不同のパラメータで別キーにならないように正規化する） */
function cacheKeyFor(q: SearchQuery): Request {
  const u = new URL("https://chuko-hunter.internal/cache");
  u.searchParams.set("q", q.keyword);
  u.searchParams.set("exclude", q.excludeKeyword);
  u.searchParams.set("min", String(q.minPrice ?? ""));
  u.searchParams.set("max", String(q.maxPrice ?? ""));
  u.searchParams.set("cond", String(q.maxCondition));
  u.searchParams.set("src", [...q.sources].sort().join(","));
  u.searchParams.set("limit", String(q.limitPerSource));
  u.searchParams.set("strict", q.strict ? "1" : "0");
  return new Request(u.toString());
}

app.get("/api/config", (c) => {
  const env = c.env;
  return c.json({
    sources: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      available: p.skipReason(env) === null,
      reason: p.skipReason(env),
    })),
  });
});

app.get("/api/search", async (c) => {
  const t0 = Date.now();
  const url = new URL(c.req.url);
  const q = parseQuery(url);
  if (!q.keyword) return c.json({ error: "q（検索キーワード）は必須です" }, 400);

  const ttl = Math.max(0, Number.parseInt(c.env.CACHE_TTL_SECONDS ?? "300", 10) || 0);
  const cache = caches.default;
  const key = cacheKeyFor(q);

  if (ttl > 0 && url.searchParams.get("nocache") !== "1") {
    const hit = await cache.match(key);
    if (hit) {
      const body = (await hit.json()) as SearchResponse;
      return c.json({ ...body, cached: true, tookMs: Date.now() - t0 });
    }
  }

  const { listings, sources } = await fanOut(q, c.env);

  const prices = listings.map((l) => l.effectivePrice).sort((a, b) => a - b);
  const median = percentile(prices, 0.5);
  const min = prices.length ? prices[0] : null;

  const bySource: SearchResponse["stats"]["bySource"] = {};
  for (const s of sources) {
    const p = listings
      .filter((l) => l.source === s.source)
      .map((l) => l.effectivePrice)
      .sort((a, b) => a - b);
    bySource[s.source] = { count: p.length, min: p.length ? p[0] : null, median: percentile(p, 0.5) };
  }

  const payload: SearchResponse = {
    query: q,
    listings,
    sources,
    stats: {
      total: listings.length,
      min,
      median,
      p25: percentile(prices, 0.25),
      max: prices.length ? prices[prices.length - 1] : null,
      // 最安が中央値からどれだけ乖離しているか＝「買う価値のある安さか」の一次指標
      dealGapPct: min != null && median != null && median > 0 ? Math.round((1 - min / median) * 100) : null,
      bySource,
    },
    deepLinks: buildDeepLinks(q),
    tookMs: Date.now() - t0,
    cached: false,
  };

  if (ttl > 0) {
    const cacheable = new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
    });
    c.executionCtx.waitUntil(cache.put(key, cacheable));
  }

  return c.json(payload);
});

app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

export default app;
