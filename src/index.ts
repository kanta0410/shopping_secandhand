import { Hono } from "hono";
import { buildDeepLinks } from "./deeplinks";
import { dedupe, percentile } from "./normalize";
import { ALL_SOURCE_IDS, PROVIDERS, fanOut } from "./providers";
import { mercariRawSearch } from "./providers/mercari";
import { looksLikeIsbn, resolveBooks } from "./books/isbn";
import { buildDeal, rankDeals, scoreDeal, type RankMode } from "./books/rank";
import { fanOutBooks } from "./providers/books";
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

/**
 * メルカリ内部APIの生レスポンスをそのまま覗く診断用。
 * 仕様変更で壊れた時に「署名で落ちているのか / 形状が変わったのか」を切り分けるためにある。
 * ENABLE_MERCARI=1 の時だけ有効。
 */
app.get("/api/debug/mercari", async (c) => {
  if (c.env.ENABLE_MERCARI !== "1") return c.json({ error: "ENABLE_MERCARI=0 のため無効" }, 403);
  const keyword = (c.req.query("q") ?? "").trim();
  if (!keyword) return c.json({ error: "q は必須です" }, 400);
  try {
    const { status, body } = await mercariRawSearch({ keyword, limit: 3 });
    let topKeys: string[] = [];
    let firstItemKeys: string[] = [];
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      topKeys = Object.keys(j);
      const items = (j.items ?? j.data ?? j.results) as unknown;
      if (Array.isArray(items) && items[0] && typeof items[0] === "object") {
        firstItemKeys = Object.keys(items[0] as object);
      }
    } catch {
      /* JSONでないなら生body側で判断する */
    }
    return c.json({ status, topKeys, firstItemKeys, bodyHead: body.slice(0, 2000) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * 中古本ランキング。書名/ISBN → 書誌解決 → 中古サイト横断 → お得度順に並べる。
 *
 * 1冊ごとに複数サイトを叩くので、冊数 × サイト数のリクエストになる。
 * 相手サイトに迷惑をかけないよう、冊数は10冊、同時実行は3冊ずつに制限している。
 */
app.get("/api/books", async (c) => {
  const t0 = Date.now();
  const raw = (c.req.query("q") ?? "").trim();
  if (!raw) return c.json({ error: "q（書名またはISBN）は必須です" }, 400);

  const titles = raw
    .split(/[\n,、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (titles.length === 0) return c.json({ error: "有効な書名がありません" }, 400);

  const modeParam = c.req.query("mode") ?? "discount";
  const mode: RankMode = (["discount", "cheapest", "gap", "supply"] as const).includes(modeParam as RankMode)
    ? (modeParam as RankMode)
    : "discount";
  const limit = Math.min(60, Math.max(1, Number.parseInt(c.req.query("limit") ?? "20", 10) || 20));

  // スクレイピング先に同じリクエストを繰り返さないためのキャッシュ。
  // 検索1回で「冊数 × 6サイト」叩くので、ここが無いと相手サイトへの負荷が跳ねる。
  const ttl = Math.max(0, Number.parseInt(c.env.CACHE_TTL_SECONDS ?? "300", 10) || 0);
  const cache = caches.default;
  const cacheKey = new Request(
    `https://chuko-hunter.internal/books?q=${encodeURIComponent(titles.join("\n"))}&mode=${mode}&limit=${limit}`,
  );
  if (ttl > 0 && c.req.query("nocache") !== "1") {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = (await hit.json()) as Record<string, unknown>;
      return c.json({ ...body, cached: true, tookMs: Date.now() - t0 });
    }
  }

  const warnings: string[] = [];

  const handleTitle = async (title: string) => {
    const books = await resolveBooks(title, c.env, 1);
    // 書誌が引けなくても中古検索自体は続行する（絶版・同人・洋書など書誌APIに無い本があるため）
    const book = books[0] ?? {
      isbn13: null,
      isbn10: null,
      title,
      author: null,
      publisher: null,
      pubdate: null,
      coverUrl: null,
      listPrice: null,
      via: "未解決",
    };
    // 本の中古在庫はフリマ系（メルカリ等）に最も厚く積まれている。
    // 書店系スクレイパだけを見ると母数の大半を取り落とすので、商品APIの3ソースも同時に叩く。
    //
    // キーワードの選び方:
    //   - 書店系はISBNで正確に引ける（ISBNがあればそれを渡す）
    //   - フリマ系はISBNで引くと空振りするため、書名で引く
    //     ユーザーがISBNを直接入力した場合だけ、解決した書名に差し替える
    const typedIsbn = looksLikeIsbn(title);
    const goodsKeyword = typedIsbn ? book.title || title : title;
    const goodsQuery: SearchQuery = {
      keyword: goodsKeyword,
      excludeKeyword: "",
      minPrice: null,
      maxPrice: null,
      maxCondition: 0,
      sources: ALL_SOURCE_IDS,
      limitPerSource: limit,
      // ユーザーが打った語ならタイトル一致で絞る。書誌から補完した長い書名で絞ると全部落ちるので緩める
      strict: !typedIsbn,
    };

    const [shops, goods] = await Promise.all([
      fanOutBooks({ keyword: title, isbn: book.isbn13, limit }, c.env),
      fanOut(goodsQuery, c.env),
    ]);

    const sources = [...shops.sources, ...goods.sources];
    for (const s of sources) {
      if (s.error) warnings.push(`${s.sourceLabel}: ${s.error}`);
    }
    // 両系統をまたいだ重複を落としてから実質価格で並べ直す
    const listings = dedupe([...shops.listings, ...goods.listings]).sort(
      (a, b) => a.effectivePrice - b.effectivePrice,
    );

    const deal = buildDeal(book, listings, sources);
    return { ...deal, score: scoreDeal(deal) };
  };

  // 3冊ずつ処理して同時接続数を抑える
  const results: Awaited<ReturnType<typeof handleTitle>>[] = [];
  for (let i = 0; i < titles.length; i += 3) {
    const chunk = titles.slice(i, i + 3);
    const settled = await Promise.allSettled(chunk.map(handleTitle));
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(r.value);
      else warnings.push(`検索失敗: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }

  const ranked = rankDeals(results, mode).map((d) => ({ ...d, score: scoreDeal(d) }));

  const payload = {
    mode,
    deals: ranked,
    warnings: [...new Set(warnings)].slice(0, 10),
    tookMs: Date.now() - t0,
    cached: false,
  };

  // 1件も取れなかった結果をキャッシュすると、相手サイトの一時障害が5分間固定されてしまう
  const gotSomething = ranked.some((d) => d.supply > 0);
  if (ttl > 0 && gotSomething) {
    const cacheable = new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, cacheable));
  }

  return c.json(payload);
});

app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

export default app;
