/**
 * 中古本スクレイパの共通レイヤ。
 *
 * 本の中古はAPIが存在しないサイトが主戦場（駿河屋・日本の古本屋・ブックオフ）なので、
 * ここだけはHTML取得に頼る。相手サイトへの負荷を避けるため、1検索につき各サイト1リクエストに限定し、
 * 上位で5分キャッシュしている。robots.txt と各サイトの利用規約は利用者の責任で確認すること。
 *
 * サイトを追加する時は BookProviderLike を実装して BOOK_PROVIDERS に足すだけでよい。
 */

import { buildListing, dedupe } from "../../normalize";
import type { Env, Listing, SourceResult } from "../../types";
import { bookoffProvider } from "./bookoff";
import { koshoProvider } from "./kosho";
import { surugayaProvider } from "./surugaya";

/** SourceId を書籍サイトまで広げてあるので、書籍側も共通の Listing をそのまま使える */
export type BookListing = Listing;

export type BuildBookListingInput = Omit<Listing, "effectivePrice" | "conditionLabel" | "shippingUnknown">;

/** 各スクレイパはこれ経由で Listing を作る（実質価格と状態ラベルの計算を一箇所に閉じ込めるため） */
export function buildBookListing(input: BuildBookListingInput): BookListing {
  return buildListing(input);
}

export interface BookSearchInput {
  keyword: string;
  isbn?: string | null;
  limit: number;
}

export interface BookProviderLike {
  id: string;
  label: string;
  /** 使えない理由。null なら利用可 */
  skipReason(env: Env): string | null;
  /** 診断用: 実際に叩くURL */
  probeUrl(input: BookSearchInput): string;
  search(input: BookSearchInput, env: Env): Promise<BookListing[]>;
}

export const BOOK_PROVIDERS: BookProviderLike[] = [surugayaProvider, koshoProvider, bookoffProvider];

/**
 * 全サイトを並列に叩く。1サイトがコケても他は返す（部分成功）。
 * スクレイピングは相手側の改修で必ず壊れるので、全体を落とさないことが最優先。
 */
export async function fanOutBooks(
  input: BookSearchInput,
  env: Env,
): Promise<{ listings: BookListing[]; sources: SourceResult[] }> {
  const settled = await Promise.all(
    BOOK_PROVIDERS.map(async (p): Promise<{ result: SourceResult; listings: BookListing[] }> => {
      const base: SourceResult = {
        source: p.id as SourceResult["source"],
        sourceLabel: p.label,
        ok: false,
        fetched: 0,
        count: 0,
        tookMs: 0,
        webUrl: p.probeUrl(input),
      };
      const skip = p.skipReason(env);
      if (skip) return { result: { ...base, skipped: skip }, listings: [] };

      const t0 = Date.now();
      try {
        const raw = await p.search(input, env);
        const filtered = raw.filter((l) => l.price > 0);
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
    return (a.condition === 0 ? 99 : a.condition) - (b.condition === 0 ? 99 : b.condition);
  });

  return { listings, sources: settled.map((s) => s.result) };
}
