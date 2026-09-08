/**
 * 駿河屋 検索結果スクレイパ。
 *
 * HTML 構造が変わったときに直す場所:
 *   1. まず SELECTORS の各配列に「新しいクラス名」を先頭へ足すだけで直ることが多い。
 *      （配列は上から順に試し、最初にヒットしたものを採用する）
 *   2. 商品カード自体が取れなくなった場合は SELECTORS.card を疑う。
 *   3. JSON-LD が出ていれば SELECTORS は一切使われない（collectProducts が先に通る）。
 *
 * なぜ condition を安易に埋めないか:
 *   駿河屋は「中古／新品」の別しか出さず、状態のランクは無い。
 *   ランクを推測して 3 や 4 を入れると価格比較の前提が嘘になるため、中古は 0（不明）のままにする。
 */

import { guessConditionFromTitle } from "../../normalize";
import { absolutize, fetchHtml, findAllByCandidates, findElements, getAttr, parseYen, stripTags } from "../../scrape/html";
import { collectProducts, isOutOfStock, isUsedCondition, readMicrodata } from "../../scrape/jsonld";
import type { ConditionRank, Env } from "../../types";
import { buildBookListing, type BookListing, type BookProviderLike } from "./index";

const SITE = "駿河屋";
const BASE = "https://www.suruga-ya.jp/";

/** サイト改修時はここだけ直す。候補は上から順に試される（実HTML未検証の推測を含む） */
const SELECTORS = {
  /** 検索結果の1商品ぶんのまとまり */
  card: [
    ".item",
    ".item_box",
    ".search_result_item",
    'div[class*="item_box"]',
    'div[class*="product"]',
    'li[class*="item"]',
  ],
  /** 商品名＋詳細リンク */
  title: [".title", ".item_title", ".product_title", 'p[class*="title"]', 'h2[class*="title"]', "a[title]"],
  /** 価格。中古価格と新品価格が別要素で並ぶことがある */
  price: [".price", ".item_price", ".product_price", 'p[class*="price"]', 'span[class*="price"]', '[class*="price"]'],
  /** 中古／新品の別が書かれた要素 */
  condition: [".text_bold", ".item_condition", '[class*="condition"]', '[class*="used"]'],
  image: ["img.itemphoto", 'img[class*="item"]', "img"],
} as const;

/** 商品詳細ページの URL パターン。カード内の余計なリンク（カテゴリ等）を弾くために使う */
const DETAIL_HREF = /\/product\/detail\/|\/product\//i;

function conditionOf(text: string, title: string): { rank: ConditionRank; used: boolean | null } {
  const t = text.replace(/\s+/g, "");
  if (t.includes("中古")) return { rank: 0, used: true }; // 中古はランク表記が無いので不明のまま
  if (t.includes("新品") || t.includes("未使用")) return { rank: 1, used: false };
  const guessed = guessConditionFromTitle(title);
  if (guessed === 1) return { rank: 1, used: false };
  return { rank: 0, used: null };
}

/** JSON-LD（最優先）で拾えた商品を Listing 化する */
function fromJsonLd(html: string): BookListing[] {
  const out: BookListing[] = [];
  for (const p of collectProducts(html)) {
    if (!p.name || !p.price || p.price <= 0 || !p.url) continue;
    if (isOutOfStock(p.availability)) continue;
    const used = isUsedCondition(p.condition);
    out.push(
      buildBookListing({
        id: `surugaya:${p.url}`,
        source: "surugaya",
        sourceLabel: SITE,
        title: p.name,
        url: absolutize(p.url, BASE),
        imageUrl: p.image ? absolutize(p.image, BASE) : null,
        price: p.price,
        // 駿河屋は送料が注文全体の合算（一定額以上で無料）で、明細ページまで行かないと確定しない
        shipping: null,
        condition: used === false ? 1 : 0,
        seller: p.seller ?? SITE,
        pointBack: null,
        raw: { via: "jsonld", used },
      }),
    );
  }
  return out;
}

/** カード単位の HTML から microdata → CSS セレクタの順で拾う（JSON-LD が無いときだけ通る） */
function fromCards(html: string): BookListing[] {
  const out: BookListing[] = [];
  for (const card of findAllByCandidates(html, SELECTORS.card, 120)) {
    try {
      const md = readMicrodata(card.outer);

      // 詳細リンク（=商品URL）。カード内の最初の「商品っぽい」リンクを採る
      let href: string | null = null;
      let anchorText = "";
      for (const a of findElements(card.inner, "a", 20)) {
        const h = getAttr(a.attrs, "href");
        if (!h) continue;
        if (!DETAIL_HREF.test(h)) continue;
        href = h;
        anchorText = stripTags(a.inner) || (getAttr(a.attrs, "title") ?? "");
        break;
      }
      const url = md.url ?? href;
      if (!url) continue;

      const titleText =
        md.name ??
        (() => {
          for (const sel of SELECTORS.title) {
            const el = findElements(card.inner, sel, 1)[0];
            if (!el) continue;
            const t = stripTags(el.inner) || (getAttr(el.attrs, "title") ?? "");
            if (t) return t;
          }
          return anchorText;
        })();
      if (!titleText) continue;

      let price = md.price ?? null;
      if (!price) {
        for (const sel of SELECTORS.price) {
          const el = findElements(card.inner, sel, 4).find((e) => parseYen(stripTags(e.inner)) !== null);
          if (!el) continue;
          price = parseYen(stripTags(el.inner));
          if (price) break;
        }
      }
      if (!price || price <= 0) continue; // 価格が取れない行は捨てる（0円と嘘をつかない）

      const cardText = stripTags(card.outer);
      const cond = conditionOf(cardText, titleText);

      const img =
        md.image ??
        (() => {
          for (const sel of SELECTORS.image) {
            const el = findElements(card.inner, sel, 3)[0];
            if (!el) continue;
            const src = getAttr(el.attrs, "src") ?? getAttr(el.attrs, "data-src") ?? getAttr(el.attrs, "data-original");
            if (src) return src;
          }
          return undefined;
        })();

      out.push(
        buildBookListing({
          id: `surugaya:${absolutize(url, BASE)}`,
          source: "surugaya",
          sourceLabel: SITE,
          title: titleText,
          url: absolutize(url, BASE),
          imageUrl: img ? absolutize(img, BASE) : null,
          price,
          shipping: null,
          condition: cond.rank,
          seller: SITE,
          pointBack: null,
          raw: { via: "html", used: cond.used },
        }),
      );
    } catch {
      // 1件の異常で検索結果全体を落とさない
      continue;
    }
  }
  return out;
}

function searchUrl(input: { keyword: string; isbn?: string | null }): string {
  // ISBN があればキーワードより精度が高いので優先する
  const kw = (input.isbn ?? "").replace(/[-\s]/g, "") || input.keyword;
  const u = new URL("search", BASE);
  u.searchParams.set("category", "");
  u.searchParams.set("search_word", kw);
  u.searchParams.set("searchbox", "1");
  return u.toString();
}

export const surugayaProvider: BookProviderLike = {
  id: "surugaya",
  label: SITE,
  skipReason: () => null,
  probeUrl: (input) => searchUrl(input),
  async search(input, _env: Env): Promise<BookListing[]> {
    const html = await fetchHtml(searchUrl(input), SITE);
    const viaJson = fromJsonLd(html);
    const listings = viaJson.length > 0 ? viaJson : fromCards(html);
    // 中古を優先して limit 枠を埋める（新品は参考値であり、このアプリの主目的ではない）
    const used = listings.filter((l) => (l.raw as { used?: boolean | null } | undefined)?.used !== false);
    const rest = listings.filter((l) => (l.raw as { used?: boolean | null } | undefined)?.used === false);
    return [...used, ...rest].slice(0, Math.max(1, input.limit));
  },
};
