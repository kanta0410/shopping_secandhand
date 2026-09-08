/**
 * 日本の古本屋（全国古書籍商組合連合会）検索結果スクレイパ。
 *
 * HTML 構造が変わったときに直す場所:
 *   1. SELECTORS の各配列の先頭に新しいクラス名を足す（上から順に試す）。
 *   2. 商品のまとまりが取れないときは SELECTORS.card を疑う。EC-CUBE 系のテンプレートなので
 *      `.list_area` / `#result_list` まわりの命名が変わりやすい。
 *   3. JSON-LD が出ていれば SELECTORS は使われない。
 *
 * なぜ shipping を必ず null にするか:
 *   出品は全国の個々の古書店で、送料は店ごと・冊数ごとに違い、検索結果ページには一切出てこない。
 *   0 円と埋めると「実質価格」の比較が丸ごと嘘になるため、不明は不明として返す。
 *
 * なぜ condition をほぼ 0 にするか:
 *   全品が古書＝中古だが、状態表記は店の自由記述（「並」「経年ヤケ」等）で 6 段階へ機械的に落とせない。
 *   タイトルから明確に読み取れる場合だけ guessConditionFromTitle の結果を使う。
 */

import { guessConditionFromTitle } from "../../normalize";
import { absolutize, fetchHtml, findAllByCandidates, findElements, getAttr, parseYen, stripTags } from "../../scrape/html";
import { collectProducts, isOutOfStock, readMicrodata } from "../../scrape/jsonld";
import type { ConditionRank, Env } from "../../types";
import { buildBookListing, type BookListing, type BookProviderLike } from "./index";

const SITE = "日本の古本屋";
const BASE = "https://www.kosho.or.jp/";

/** サイト改修時はここだけ直す。候補は上から順に試される（実HTML未検証の推測を含む） */
const SELECTORS = {
  card: [
    ".list_area",
    ".product_item",
    ".itemlist_item",
    'li[class*="list_item"]',
    'div[class*="product"]',
    'div[class*="item"]',
  ],
  title: [".product_name", ".item_name", ".list_name", 'h3[class*="name"]', 'p[class*="title"]', "a[title]"],
  price: [".price", ".product_price", ".item_price", 'span[class*="price"]', '[class*="price"]'],
  /** 出品店舗名。送料が店ごとに違うので、せめて店名は出したい */
  shop: [".shop_name", ".store_name", '[class*="shop"]', '[class*="store"]'],
  image: ["img.product_image", 'img[class*="product"]', "img"],
} as const;

/** 商品詳細 URL。EC-CUBE 由来の detail.php と、新しめの /products/detail/ の両方を許す */
const DETAIL_HREF = /\/products\/detail|detail\.php|\/product\//i;

function conditionOf(title: string): ConditionRank {
  // 古書は状態表記が自由記述。タイトルから「ジャンク」等が明確に読める時だけ採用する
  const guessed = guessConditionFromTitle(title);
  return guessed === 1 ? 0 : guessed; // 古書に「新品」判定は付けない
}

function fromJsonLd(html: string): BookListing[] {
  const out: BookListing[] = [];
  for (const p of collectProducts(html)) {
    if (!p.name || !p.price || p.price <= 0 || !p.url) continue;
    if (isOutOfStock(p.availability)) continue;
    out.push(
      buildBookListing({
        id: `kosho:${p.url}`,
        source: "kosho",
        sourceLabel: SITE,
        title: p.name,
        url: absolutize(p.url, BASE),
        imageUrl: p.image ? absolutize(p.image, BASE) : null,
        price: p.price,
        shipping: null, // 店舗ごとに異なり取得不能
        condition: conditionOf(p.name),
        seller: p.seller ?? null,
        pointBack: null,
        raw: { via: "jsonld" },
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

      let shop: string | null = null;
      for (const sel of SELECTORS.shop) {
        const el = findElements(card.inner, sel, 1)[0];
        if (!el) continue;
        const t = stripTags(el.inner);
        if (t) {
          shop = t;
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
          id: `kosho:${absolutize(url, BASE)}`,
          source: "kosho",
          sourceLabel: SITE,
          title,
          url: absolutize(url, BASE),
          imageUrl: img ? absolutize(img, BASE) : null,
          price,
          shipping: null,
          condition: conditionOf(title),
          seller: shop,
          pointBack: null,
          raw: { via: "html" },
        }),
      );
    } catch {
      continue; // 1件の異常で全体を落とさない
    }
  }
  return out;
}

function searchUrl(input: { keyword: string; isbn?: string | null }): string {
  // ISBN 検索に対応しない書誌もあるが、絶版本ほど ISBN で引いた方が精度が高い
  const kw = (input.isbn ?? "").replace(/[-\s]/g, "") || input.keyword;
  const u = new URL("products/list.php", BASE);
  u.searchParams.set("mode", "search");
  u.searchParams.set("search_word", kw);
  return u.toString();
}

export const koshoProvider: BookProviderLike = {
  id: "kosho",
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
