import { buildListing } from "../normalize";
import type { ConditionRank, Env, Listing, SearchQuery } from "../types";

/**
 * メルカリには公開APIが存在しない。ここで叩いているのは Web 版が使っている内部エンドポイントで、
 * DPoP(RFC 9449) 署名付きリクエストを要求する。
 *
 *  - 利用規約上グレー。ENABLE_MERCARI=1 にした人の自己責任で動く（既定は無効）。
 *  - 予告なく仕様変更で壊れる。壊れたら UI 側は自動でディープリンクに退避する設計にしてある。
 *  - 連打はしない。5分キャッシュ + 1リクエスト/検索 に抑えている。
 */
const ENDPOINT = "https://api.mercari.jp/v2/entities:search";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

async function buildDpopToken(method: string, uri: string): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y },
  };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    htu: uri,
    htm: method,
  };
  const signingInput = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}

interface MercariItem {
  id?: string;
  name?: string;
  price?: string | number;
  thumbnails?: string[];
  itemConditionId?: string | number;
  shippingPayerId?: string | number;
  status?: string;
  shopName?: string;
}

/** メルカリの itemConditionId は 1..6 で、そのまま正規化ランクに一致する */
function toCondition(id: unknown): ConditionRank {
  const n = Number(id);
  return n >= 1 && n <= 6 ? (n as ConditionRank) : 0;
}

export async function searchMercari(q: SearchQuery, env: Env): Promise<Listing[]> {
  if (env.ENABLE_MERCARI !== "1") throw new Error("ENABLE_MERCARI=0 のため無効（規約リスクを理解した上で有効化してください）");

  const dpop = await buildDpopToken("POST", ENDPOINT);
  const body = {
    userId: "",
    pageSize: Math.min(120, q.limitPerSource),
    pageToken: "",
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED",
    thumbnailTypes: [],
    searchCondition: {
      keyword: q.keyword,
      excludeKeyword: q.excludeKeyword,
      sort: "SORT_PRICE",
      order: "ORDER_ASC",
      status: ["STATUS_ON_SALE"],
      sizeId: [],
      categoryId: [],
      brandId: [],
      sellerId: [],
      priceMin: q.minPrice ?? 0,
      priceMax: q.maxPrice ?? 0,
      itemConditionId: [],
      shippingPayerId: [],
      shippingFromArea: [],
      shippingMethod: [],
      colorId: [],
      hasCoupon: false,
      attributes: [],
      itemTypes: [],
      skuIds: [],
      shopIds: [],
      excludeShippingMethodIds: [],
    },
    defaultDatasets: [],
    serviceFrom: "suruga",
    withItemBrand: true,
    withItemSize: false,
    withItemPromotions: true,
    withItemSizes: true,
    withShopname: false,
    useDynamicAttribute: true,
    withSuggestedItems: false,
    withOfferPricePromotion: true,
    withProductSuggest: false,
    withParentProducts: false,
    withProductArticles: false,
    withSearchConditionId: false,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      DPoP: dpop,
      "X-Platform": "web",
      Accept: "*/*",
      "Accept-Language": "ja-JP",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`メルカリ内部API ${res.status}: ${text.slice(0, 160)}`);
  }
  const json = (await res.json()) as { items?: MercariItem[] };

  const out: Listing[] = [];
  for (const item of json.items ?? []) {
    const title = item.name ?? "";
    const price = Number(item.price ?? 0);
    if (!title || !item.id || !Number.isFinite(price) || price <= 0) continue;
    out.push(
      buildListing({
        id: `mercari:${item.id}`,
        source: "mercari",
        sourceLabel: "メルカリ",
        title,
        url: `https://jp.mercari.com/item/${item.id}`,
        imageUrl: item.thumbnails?.[0] ?? null,
        price,
        // shippingPayerId: 1=着払い(購入者負担・金額不明) / 2=送料込み
        shipping: String(item.shippingPayerId) === "2" ? 0 : null,
        condition: toCondition(item.itemConditionId),
        seller: item.shopName || null,
        pointBack: null,
      }),
    );
  }
  return out;
}
