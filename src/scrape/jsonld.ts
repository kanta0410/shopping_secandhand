/**
 * JSON-LD（schema.org）から商品情報を取り出す。
 *
 * なぜ JSON-LD を最優先にするか:
 *   CSS クラス名はサイト改修のたびに壊れるが、JSON-LD は SEO のために各社が維持し続ける構造化データで、
 *   壊れる頻度が桁違いに低い。ここが通れば HTML セレクタは一切触らずに済む。
 *
 * 壊れたときに直す場所:
 *   - 新しい @type（例 "Offer" 以外の販売単位）が出てきたら PRODUCT_TYPES / OFFER_TYPES に足す。
 *   - price が別プロパティ名（例 priceSpecification.price）に移ったら readPrice() を直す。
 *   構造は再帰走査なので、入れ子の深さやラッパーの増減では壊れない。
 */

import { extractJsonLdBlocks, parseYen } from "./html";

export interface JsonLdProduct {
  name?: string;
  price?: number;
  url?: string;
  image?: string;
  availability?: string;
  /** schema.org の itemCondition（UsedCondition / NewCondition など）を素の文字列で持つ */
  condition?: string;
  seller?: string;
}

const PRODUCT_TYPES = new Set([
  "product", "book", "individualproduct", "productmodel", "productgroup",
  "vehicle", "softwareapplication", "musicalbum", "movie", "videogame",
]);

const OFFER_TYPES = new Set(["offer", "aggregateoffer", "demand"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @type は文字列にも配列にもなる。小文字化して配列に揃える */
function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"] ?? node.type;
  if (typeof t === "string") return [t.toLowerCase()];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
  return [];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = asString(x);
      if (s) return s;
    }
    return undefined;
  }
  if (isObj(v)) {
    // ImageObject / Thing などは url か name に実体がある
    return asString(v.url) ?? asString(v["@id"]) ?? asString(v.name);
  }
  return undefined;
}

/** "JPY 1,280" のような文字列でも通るよう parseYen を経由する */
function readPrice(v: unknown): number | undefined {
  if (typeof v === "number") return v > 0 ? Math.round(v) : undefined;
  const s = asString(v);
  if (!s) return undefined;
  return parseYen(s) ?? undefined;
}

/** Offer / AggregateOffer から価格・在庫・状態を抜く。配列なら最安を採る（中古は同一商品に複数出品が並ぶため） */
function readOffer(v: unknown, into: JsonLdProduct): void {
  if (Array.isArray(v)) {
    for (const x of v) readOffer(x, into);
    return;
  }
  if (!isObj(v)) return;
  const t = typesOf(v);
  if (t.length > 0 && !t.some((x) => OFFER_TYPES.has(x)) && v.price === undefined && v.lowPrice === undefined) {
    return;
  }
  const price =
    readPrice(v.price) ??
    readPrice(v.lowPrice) ??
    readPrice(isObj(v.priceSpecification) ? v.priceSpecification.price : undefined);
  if (price !== undefined && (into.price === undefined || price < into.price)) into.price = price;

  into.availability = into.availability ?? asString(v.availability);
  into.condition = into.condition ?? asString(v.itemCondition);
  into.url = into.url ?? asString(v.url);
  const seller = isObj(v.seller) ? asString(v.seller.name) : asString(v.seller);
  into.seller = into.seller ?? seller;

  // AggregateOffer は下に個別 Offer をぶら下げる
  if (v.offers !== undefined) readOffer(v.offers, into);
}

function readProduct(node: Record<string, unknown>): JsonLdProduct | null {
  const p: JsonLdProduct = {};
  p.name = asString(node.name) ?? asString(node.title) ?? asString(node.headline);
  p.url = asString(node.url) ?? asString(node["@id"]);
  p.image = asString(node.image) ?? asString(node.thumbnailUrl);
  p.condition = asString(node.itemCondition);
  if (node.offers !== undefined) readOffer(node.offers, p);
  if (p.price === undefined) p.price = readPrice(node.price);
  if (!p.name && p.price === undefined) return null;
  return p;
}

/**
 * HTML 中の JSON-LD を全部走査して商品らしきノードを集める。
 * 配列・@graph・ItemList/ListItem・任意の入れ子に対応し、1ブロック壊れても他は返す。
 */
export function collectProducts(html: string): JsonLdProduct[] {
  const out: JsonLdProduct[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    if (seen.has(node)) return; // 循環参照つきの JSON-LD を吐くサイト対策
    seen.add(node);

    const types = typesOf(node);
    const looksProduct = types.some((t) => PRODUCT_TYPES.has(t)) || (node.offers !== undefined && node.name !== undefined);
    if (looksProduct) {
      const p = readProduct(node);
      if (p) out.push(p);
    }

    // ItemList / @graph / mainEntity など、商品が入り得るコンテナを掘る
    for (const key of ["@graph", "itemListElement", "item", "mainEntity", "mainEntityOfPage", "hasPart", "about", "isPartOf"]) {
      if (node[key] !== undefined) walk(node[key], depth + 1);
    }
    // 上記に載らない独自ラッパーもあるので、商品でなかったノードは全プロパティを掘る
    if (!looksProduct) {
      for (const v of Object.values(node)) {
        if (Array.isArray(v) || isObj(v)) walk(v, depth + 1);
      }
    }
  };

  for (const block of extractJsonLdBlocks(html)) {
    try {
      walk(block, 0);
    } catch {
      /* 1ブロックの異常で全体を落とさない */
    }
  }
  return out;
}

/** itemCondition が明示的に「中古」を意味するか。判定できなければ null（不明のまま扱う） */
export function isUsedCondition(condition: string | undefined): boolean | null {
  if (!condition) return null;
  const c = condition.toLowerCase();
  if (c.includes("usedcondition") || c.includes("refurbished") || c.includes("damaged")) return true;
  if (c.includes("newcondition")) return false;
  if (c.includes("中古") || c.includes("古書")) return true;
  if (c.includes("新品")) return false;
  return null;
}

/** availability が「在庫なし」を明示しているか。不明なら false（＝落とさない） */
export function isOutOfStock(availability: string | undefined): boolean {
  if (!availability) return false;
  const a = availability.toLowerCase();
  return a.includes("outofstock") || a.includes("soldout") || a.includes("discontinued");
}

/**
 * microdata（itemprop）フォールバック。
 * JSON-LD が無いページ向けの二段目で、CSS クラスより壊れにくいのでセレクタより先に試す。
 */
export function readMicrodata(fragment: string): JsonLdProduct {
  const p: JsonLdProduct = {};
  const attrOf = (prop: string): string | null => {
    const re = new RegExp(
      `<[^>]*itemprop\\s*=\\s*["']${prop}["'][^>]*>`,
      "i",
    );
    const m = fragment.match(re);
    if (!m) return null;
    const tag = m[0];
    const content = tag.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
    if (content) return content[1] ?? content[2] ?? null;
    const href = tag.match(/(?:href|src)\s*=\s*"([^"]*)"|(?:href|src)\s*=\s*'([^']*)'/i);
    if (href) return href[1] ?? href[2] ?? null;
    // content 属性が無ければ要素テキストを見る
    const after = fragment.slice((m.index ?? 0) + tag.length);
    const text = after.split("<")[0]?.trim();
    return text || null;
  };
  p.name = attrOf("name") ?? undefined;
  p.price = parseYen(attrOf("price")) ?? undefined;
  p.url = attrOf("url") ?? undefined;
  p.image = attrOf("image") ?? undefined;
  p.availability = attrOf("availability") ?? undefined;
  p.condition = attrOf("itemCondition") ?? undefined;
  return p;
}
