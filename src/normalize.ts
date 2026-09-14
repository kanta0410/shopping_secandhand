import { CONDITION_LABEL, type ConditionRank, type Listing } from "./types";

/** 全角英数→半角、全角空白→半角、各種ダッシュ→ハイフン、小文字化。日本語ECのタイトル揺れを吸収する */
export function normalizeText(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[　]/g, " ")
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .toLowerCase()
    .trim();
}

export function tokenize(keyword: string): string[] {
  return normalizeText(keyword)
    .split(/[\s,、]+/)
    .filter((t) => t.length > 0);
}

/**
 * タイトルに全トークンが含まれるか（AND マッチ）。ノイズ出品を落とすための関連度フィルタ。
 *
 * 空白を除いた形でも突き合わせる理由:
 *   利用者は「rtx3060」「iphone13」のように詰めて打つが、出品タイトルは「RTX 3060」と割れている。
 *   素の包含判定だけだと正しい出品を黙って捨ててしまい、0件の理由が利用者に分からなくなる。
 */
export function matchesAllTokens(title: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const t = normalizeText(title);
  const packed = t.replace(/\s+/g, "");
  return tokens.every((tok) => t.includes(tok) || packed.includes(tok.replace(/\s+/g, "")));
}

const NEW_HINTS = ["新品", "未使用", "未開封", "新品同様"];
const USED_HINTS = ["中古", "used", "ユーズド", "リユース", "古本", "訳あり", "ジャンク"];

/** 状態フラグを持たないサイト（楽天など）向けのタイトル推定 */
export function guessConditionFromTitle(title: string): ConditionRank {
  const t = normalizeText(title);
  if (t.includes("ジャンク") || t.includes("難あり")) return 5;
  if (USED_HINTS.some((h) => t.includes(normalizeText(h)))) return 4;
  if (NEW_HINTS.some((h) => t.includes(normalizeText(h)))) return 1;
  return 0;
}

export function looksNew(title: string): boolean {
  const t = normalizeText(title);
  if (USED_HINTS.some((h) => t.includes(normalizeText(h)))) return false;
  return NEW_HINTS.some((h) => t.includes(normalizeText(h)));
}

export function conditionLabel(rank: ConditionRank): string {
  return CONDITION_LABEL[rank] ?? "不明";
}

export function buildListing(input: Omit<Listing, "effectivePrice" | "conditionLabel" | "shippingUnknown">): Listing {
  const shippingUnknown = input.shipping === null;
  const shipping = input.shipping ?? 0;
  return {
    ...input,
    shipping: input.shipping,
    shippingUnknown,
    effectivePrice: input.price + shipping,
    conditionLabel: conditionLabel(input.condition),
  };
}

/** 同一サイト内の完全重複（同一URL）と、サイトをまたいだ「同一タイトル×同一価格」を除去 */
export function dedupe(listings: Listing[]): Listing[] {
  const seenUrl = new Set<string>();
  const seenKey = new Set<string>();
  const out: Listing[] = [];
  for (const l of listings) {
    const urlKey = l.url.split("?")[0];
    const key = `${l.source}:${normalizeText(l.title).slice(0, 40)}:${l.price}`;
    if (seenUrl.has(urlKey) || seenKey.has(key)) continue;
    seenUrl.add(urlKey);
    seenKey.add(key);
    out.push(l);
  }
  return out;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}
