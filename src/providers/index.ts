import { sourceWebUrl } from "../deeplinks";
import { dedupe, matchesAllTokens, tokenize } from "../normalize";
import type { Env, Listing, SearchQuery, SourceId, SourceResult } from "../types";
import { searchMercari } from "./mercari";
import { searchRakuten } from "./rakuten";
import { searchYahoo } from "./yahoo";

type Provider = {
  id: SourceId;
  label: string;
  run: (q: SearchQuery, env: Env) => Promise<Listing[]>;
  /** 設定が足りない場合に返すスキップ理由 */
  skipReason: (env: Env) => string | null;
};

export const PROVIDERS: Provider[] = [
  {
    id: "yahoo_shopping",
    label: "Yahoo!ショッピング",
    run: searchYahoo,
    skipReason: (env) => (env.YAHOO_CLIENT_ID ? null : "YAHOO_CLIENT_ID 未設定"),
  },
  {
    id: "rakuten",
    label: "楽天市場",
    run: searchRakuten,
    skipReason: (env) => (env.RAKUTEN_APP_ID ? null : "RAKUTEN_APP_ID 未設定"),
  },
  {
    id: "mercari",
    label: "メルカリ",
    run: searchMercari,
    skipReason: (env) => (env.ENABLE_MERCARI === "1" ? null : "ENABLE_MERCARI=0（既定で無効）"),
  },
];

export const ALL_SOURCE_IDS: SourceId[] = PROVIDERS.map((p) => p.id);

export interface FanOutResult {
  listings: Listing[];
  sources: SourceResult[];
}

/** 全ソースを並列に叩く。1つコケても全体は返す（部分成功を許容する） */
export async function fanOut(q: SearchQuery, env: Env): Promise<FanOutResult> {
  const tokens = q.strict ? tokenize(q.keyword) : [];
  const targets = PROVIDERS.filter((p) => q.sources.includes(p.id));

  const settled = await Promise.all(
    targets.map(async (p): Promise<{ result: SourceResult; listings: Listing[] }> => {
      const base: SourceResult = {
        source: p.id,
        sourceLabel: p.label,
        ok: false,
        fetched: 0,
        count: 0,
        tookMs: 0,
        webUrl: sourceWebUrl(p.id, q),
      };
      const skip = p.skipReason(env);
      if (skip) return { result: { ...base, skipped: skip }, listings: [] };

      const t0 = Date.now();
      try {
        const raw = await p.run(q, env);
        const filtered = raw.filter((l) => {
          if (!matchesAllTokens(l.title, tokens)) return false;
          if (q.maxCondition > 0 && l.condition > q.maxCondition) return false;
          if (q.minPrice != null && l.effectivePrice < q.minPrice) return false;
          if (q.maxPrice != null && l.effectivePrice > q.maxPrice) return false;
          return true;
        });
        return {
          result: { ...base, ok: true, fetched: raw.length, count: filtered.length, tookMs: Date.now() - t0 },
          listings: filtered,
        };
      } catch (e) {
        return {
          result: { ...base, error: e instanceof Error ? e.message : String(e), tookMs: Date.now() - t0 },
          listings: [],
        };
      }
    }),
  );

  const listings = dedupe(settled.flatMap((s) => s.listings)).sort((a, b) => {
    if (a.effectivePrice !== b.effectivePrice) return a.effectivePrice - b.effectivePrice;
    // 同値なら状態が良い方を上に（不明=0 は最後）
    const ca = a.condition === 0 ? 99 : a.condition;
    const cb = b.condition === 0 ? 99 : b.condition;
    return ca - cb;
  });

  // 設定不足のソースは一覧の下に来るよう、ok を優先して並べる
  const sources = settled.map((s) => s.result).sort((a, b) => Number(b.ok) - Number(a.ok));
  return { listings, sources };
}
