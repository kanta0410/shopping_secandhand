import { percentile } from "../normalize";
import type { BookDeal, BookRef, Listing, SourceResult } from "../types";

/* ============================================================
 * 中古本のお得度計算とランキング（純関数のみ。ここでは fetch しない）
 *
 * 「安い順」だけだと、そもそも定価が安い本ばかりが上に来て役に立たない。
 * 定価比の割引率 / 相場（中央値）からの乖離 / 供給の厚み の3軸を分けて持ち、
 * 用途に応じてモードで並べ替えられるようにしている。
 * ============================================================ */

/**
 * ランキングの観点。
 * - discount: 定価比でどれだけ安いか（王道のお得度）
 * - cheapest: 単純に実質価格が安い順
 * - gap:      相場より外れて安い出品がある本＝掘り出し物・取りこぼし狙い
 * - supply:   出品数が多い本＝値崩れしやすく、待てば下がる
 */
export type RankMode = "discount" | "cheapest" | "gap" | "supply";

/** condition は 1 が最良・6 が最悪で、0 は「不明」。同値比較では不明を最下位に落とす */
function conditionOrder(c: number): number {
  return c === 0 ? 99 : c;
}

/** 実質価格が最安の出品。同値なら状態が良い方を採る（同じ値段なら状態が良い方が明確に得） */
function pickBest(listings: Listing[]): Listing | null {
  let best: Listing | null = null;
  for (const l of listings) {
    if (!l || typeof l.effectivePrice !== "number" || !Number.isFinite(l.effectivePrice)) continue;
    if (best === null) {
      best = l;
      continue;
    }
    if (l.effectivePrice < best.effectivePrice) best = l;
    else if (l.effectivePrice === best.effectivePrice && conditionOrder(l.condition) < conditionOrder(best.condition)) best = l;
  }
  return best;
}

/**
 * 1冊分の横断結果を BookDeal に組み立てる。
 * sources はスクレイパ側の実行結果（成功/失敗）をそのまま渡してもらう想定で、
 * ここでは中身を解釈しない（依存を作らないため）。
 */
export function buildDeal(book: BookRef, listings: Listing[], sources: SourceResult[] = []): BookDeal {
  const valid = (listings ?? []).filter((l) => l && typeof l.effectivePrice === "number" && Number.isFinite(l.effectivePrice));
  const best = pickBest(valid);
  const sorted = valid.map((l) => l.effectivePrice).sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);

  const listPrice = book?.listPrice ?? null;
  const discountPct =
    best && listPrice != null && listPrice > 0 ? Math.round((1 - best.effectivePrice / listPrice) * 100) : null;

  // 中央値が 0 だと乖離率が定義できない（無料出品の混入など）ので null にしておく
  const gapPct = best && median != null && median > 0 ? Math.round((1 - best.effectivePrice / median) * 100) : null;

  return {
    book,
    best,
    listings: valid,
    discountPct,
    supply: valid.length,
    median,
    gapPct,
    sources: sources ?? [],
  };
}

/** null を必ず末尾に落とすための比較補助（降順ソート用） */
function descWithNullsLast(a: number | null | undefined, b: number | null | undefined): number {
  const an = a == null ? Number.NEGATIVE_INFINITY : a;
  const bn = b == null ? Number.NEGATIVE_INFINITY : b;
  return bn - an;
}

/** 出品ゼロの本は何モードでも買えないので最後尾へ */
function emptyLast(a: BookDeal, b: BookDeal): number {
  return Number(a.supply === 0) - Number(b.supply === 0);
}

export function rankDeals(deals: BookDeal[], mode: RankMode): BookDeal[] {
  const out = [...(deals ?? [])];
  out.sort((a, b) => {
    const e = emptyLast(a, b);
    if (e !== 0) return e;
    switch (mode) {
      case "cheapest": {
        const ap = a.best?.effectivePrice ?? Number.POSITIVE_INFINITY;
        const bp = b.best?.effectivePrice ?? Number.POSITIVE_INFINITY;
        if (ap !== bp) return ap - bp;
        return descWithNullsLast(a.discountPct, b.discountPct);
      }
      case "gap": {
        const d = descWithNullsLast(a.gapPct, b.gapPct);
        if (d !== 0) return d;
        // 乖離が同じなら、母数（出品数）が多い方が「相場」の信頼度が高い
        return b.supply - a.supply;
      }
      case "supply": {
        if (a.supply !== b.supply) return b.supply - a.supply;
        return descWithNullsLast(a.discountPct, b.discountPct);
      }
      case "discount":
      default: {
        // 定価不明の本は割引率を比較できないので、この並びでは末尾に置く
        const d = descWithNullsLast(a.discountPct, b.discountPct);
        if (d !== 0) return d;
        return descWithNullsLast(a.gapPct, b.gapPct);
      }
    }
  });
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 総合お得度スコア (0..100)。
 *
 * 配分の根拠:
 *  - 割引率 60%: 「定価いくらの本をいくらで買えるか」が中古購入の主目的なので最重量。
 *    80%オフを満点とする（実務上、状態の良い中古がこれ以上下がることは稀）。
 *  - 乖離率 25%: 同じ本の相場に対して外れて安い出品は「取りこぼし＝今しか無い」ので加点。
 *    中央値比 40%安で満点（それ以上は状態難や巻抜けの疑いが強く、加点しても意味が薄い）。
 *  - 供給の薄さ 15%: 出品が多い本は待てば下がるので今買う価値は低い。
 *    逆に 1〜2 件しか無い本は希少性があるため加点する（6件以上で 0）。
 *
 * 定価が不明な本は割引率パートを算出できないため、その 60% 分も乖離率で代替する
 * （つまり乖離率が実質 85% を占める）。定価不明の本が一律 0 点に沈むのを避けるための措置で、
 * 定価が分かっている本とスコアの意味が完全には揃わない点は許容する。
 */
export function scoreDeal(deal: BookDeal): number {
  if (!deal || deal.supply === 0 || !deal.best) return 0;

  const discountPart = clamp01((deal.discountPct ?? 0) / 80);
  const gapPart = clamp01((deal.gapPct ?? 0) / 40);
  // 出品 1 件 = 1.0、6 件以上 = 0 の線形減衰
  const scarcityPart = clamp01((6 - deal.supply) / 5);

  const hasList = deal.discountPct != null;
  const score = hasList
    ? discountPart * 60 + gapPart * 25 + scarcityPart * 15
    : gapPart * 85 + scarcityPart * 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}
