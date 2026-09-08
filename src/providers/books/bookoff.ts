/**
 * ブックオフオンライン 検索結果スクレイパ。
 *
 * HTML 構造が変わったときに直す場所:
 *   1. SELECTORS の各配列の先頭に新しいクラス名を足す（上から順に試す）。
 *      ブックオフは BEM 風（productItem__title 等）の命名なので、接頭辞ごと変わることがある。
 *   2. 商品のまとまりが取れないときは SELECTORS.card。
 *   3. JSON-LD が出ていれば SELECTORS は使われない。
 *   4. 状態表記の語彙が変わったら CONDITION_MAP に行を足す。
 *
 * なぜ guessConditionFromTitle を使わないか:
 *   ブックオフはタイトルではなく専用の状態ラベル（「非常に良い」等）を持つ。
 *   タイトル推測は「中古」の語だけで一律 4 を付けてしまい実態より悪く見せるので、サイト表記を優先する。
 */

import { absolutize, fetchHtml, findAllByCandidates, findElements, getAttr, parseYen, stripTags } from "../../scrape/html";
import { collectProducts, isOutOfStock, isUsedCondition, readMicrodata } from "../../scrape/jsonld";
import type { ConditionRank, Env } from "../../types";
import { buildBookListing, type BookListing, type BookProviderLike } from "./index";

const SITE = "ブックオフオンライン";
const BASE = "https://shopping.bookoff.co.jp/";

/** サイト改修時はここだけ直す。候補は上から順に試される（実HTML未検証の推測を含む） */
const SELECTORS = {
  card: [
    ".productItem",
    ".itemList__item",
    ".productList__item",
    'li[class*="productItem"]',
    'div[class*="productItem"]',
    'li[class*="item"]',
  ],
  title: [".productItem__title", ".productItem__name", ".itemName", 'p[class*="title"]', 'h3[class*="name"]', "a[title]"],
  price: [".productItem__price", ".itemPrice", ".price", 'span[class*="price"]', '[class*="price"]'],
  /** 「非常に良い」「良い」などの状態ラベル */
  condition: [
    ".productItem__condition",
    ".itemCondition",
    ".productItem__rank",
    '[class*="condition"]',
    '[class*="rank"]',
    '[class*="quality"]',
  ],
  image: [".productItem__image img", "img.productItem__img", 'img[class*="product"]', "img"],
} as const;

const DETAIL_HREF = /\/used\/|\/goods\/|\/item\/|\/product\//i;

/**
 * サイトの状態表記 → 6段階。
 * 上から順に部分一致で判定するので、長い語（「非常に良い」）を「良い」より前に置くこと。
 */
const CONDITION_MAP: { hint: string; rank: ConditionRank }[] = [
  { hint: "新品", rank: 1 },
  { hint: "未使用", rank: 1 },
  { hint: "未開封", rank: 1 },
  { hint: "ほぼ新品", rank: 2 },
  { hint: "非常に良い", rank: 2 },
  { hint: "とても良い", rank: 2 },
  { hint: "良い", rank: 3 },
  { hint: "良好", rank: 3 },
  { hint: "やや傷", rank: 4 },
  { hint: "可", rank: 4 },
  { hint: "傷や汚れ", rank: 5 },
  { hint: "難あり", rank: 5 },
  { hint: "ジャンク", rank: 6 },
];

/** サイト表記から状態を推定。読み取れなければ 0（不明）。推測でランクを盛らない */
function conditionFromLabel(text: string | null | undefined): ConditionRank {
  if (!text) return 0;
  const t = text.replace(/\s+/g, "");
  // 「ほぼ新品」は「新品」を含むので、長い語を先に見る
  for (const { hint, rank } of [...CONDITION_MAP].sort((a, b) => b.hint.length - a.hint.length)) {
    if (t.includes(hint)) return rank;
  }
  return 0;
}

function fromJsonLd(html: string): BookListing[] {
  const out: BookListing[] = [];
  for (const p of collectProducts(html)) {
    if (!p.name || !p.price || p.price <= 0 || !p.url) continue;
    if (isOutOfStock(p.availability)) continue;
    const used = isUsedCondition(p.condition);
    // JSON-LD の itemCondition は新品／中古の別しか無いので、細分は付けずに 0 のまま
    const rank: ConditionRank = used === false ? 1 : conditionFromLabel(p.condition);
    out.push(
      buildBookListing({
        id: `bookoff:${p.url}`,
        source: "bookoff",
        sourceLabel: SITE,
        title: p.name,
        url: absolutize(p.url, BASE),
        imageUrl: p.image ? absolutize(p.image, BASE) : null,
        price: p.price,
        // 一定金額以上で無料など条件が複雑で、検索結果ページからは確定できない
        shipping: null,
        condition: rank,
        seller: p.seller ?? SITE,
        pointBack: null,
        raw: { via: "jsonld", used },
      }),
    );
  }
  return out;
}

function fromCards(html: string): BookListing[] {
  const out: BookListing[] = [];
  for (const card of findAllByCandidates(html, SELECTORS.card, 120)) {
    try {
      const md = readMicrodata(card.outer);

      let href: string | null = null;
      let anchorText = "";
      for (const a of findElements(card.inner, "a", 20)) {
        const h = getAttr(a.attrs, "href");
        if (!h || !DETAIL_HREF.test(h)) continue;
        href = h;
        anchorText = stripTags(a.inner) || (getAttr(a.attrs, "title") ?? "");
        break;
      }
      const url = md.url ?? href;
      if (!url) continue;

      let title = md.name ?? "";
      if (!title) {
        for (const sel of SELECTORS.title) {
          const el = findElements(card.inner, sel, 1)[0];
          if (!el) continue;
          const t = stripTags(el.inner) || (getAttr(el.attrs, "title") ?? "");
          if (t) {
            title = t;
            break;
          }
        }
      }
      if (!title) title = anchorText;
      if (!title) continue;

      let price = md.price ?? null;
      if (!price) {
        for (const sel of SELECTORS.price) {
          const el = findElements(card.inner, sel, 4).find((e) => parseYen(stripTags(e.inner)) !== null);
          if (!el) continue;
          price = parseYen(stripTags(el.inner));
          if (price) break;
        }
      }
      if (!price || price <= 0) continue;

      let condText: string | null = null;
      for (const sel of SELECTORS.condition) {
        const el = findElements(card.inner, sel, 2)[0];
        if (!el) continue;
        const t = stripTags(el.inner);
        if (t) {
          condText = t;
          break;
        }
      }

      let img: string | null = md.image ?? null;
      if (!img) {
        for (const sel of SELECTORS.image) {
          const el = findElements(card.inner, sel, 3)[0];
          if (!el) continue;
          img = getAttr(el.attrs, "src") ?? getAttr(el.attrs, "data-src") ?? getAttr(el.attrs, "data-original");
          if (img) break;
        }
      }

      out.push(
        buildBookListing({
          id: `bookoff:${absolutize(url, BASE)}`,
          source: "bookoff",
          sourceLabel: SITE,
          title,
          url: absolutize(url, BASE),
          imageUrl: img ? absolutize(img, BASE) : null,
          price,
          shipping: null,
          condition: conditionFromLabel(condText),
          seller: SITE,
          pointBack: null,
          raw: { via: "html", conditionText: condText },
        }),
      );
    } catch {
      continue; // 1件の異常で全体を落とさない
    }
  }
  return out;
}

function searchUrl(input: { keyword: string; isbn?: string | null }): string {
  // パスにキーワードを埋める形式なので、encodeURIComponent が必須（スラッシュ等でパスが壊れる）
  const kw = (input.isbn ?? "").replace(/[-\s]/g, "") || input.keyword;
  return `${BASE}search/keyword/${encodeURIComponent(kw)}`;
}

export const bookoffProvider: BookProviderLike = {
  id: "bookoff",
  label: SITE,
  skipReason: () => null,
  probeUrl: (input) => searchUrl(input),
  async search(input, _env: Env): Promise<BookListing[]> {
    const html = await fetchHtml(searchUrl(input), SITE);
    const viaJson = fromJsonLd(html);
    const listings = viaJson.length > 0 ? viaJson : fromCards(html);
    return listings.slice(0, Math.max(1, input.limit));
  },
};
