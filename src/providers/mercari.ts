import { buildListing } from "../normalize";
import type { ConditionRank, Env, Listing, SearchQuery } from "../types";

/**
 * メルカリには公開APIが存在しない。ここで叩いているのは Web 版が使っている内部エンドポイントで、
 * DPoP(RFC 9449) 署名付きリクエストを要求する。
 *
 *  - 利用規約上グレー。ENABLE_MERCARI=1 にした人の自己責任で動く（既定は無効）。
 *  - 予告なく仕様変更で壊れる。壊れたら UI は自動でディープリンクに退避する。
 *  - 連打しない。検索1回＝1リクエスト、同一条件は5分キャッシュ。リトライも最大1回だけ。
 *
 * レスポンス形状が変わった時は、まず `npm run probe:mercari -- "検索語"` で生JSONを取ること。
 * 直すのは pickItems() と toListing() の2箇所だけで済むようにしてある。
 */
const ENDPOINT = "https://api.mercari.jp/v2/entities:search";

/** Workers 既定のUAだと弾かれる可能性があるため、Web版に近いUAを送る */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

/**
 * DPoP proof JWT を作る。
 * WebCrypto の ECDSA 署名は raw(r||s) 形式で、これは JWS ES256 がそのまま要求する形式。
 * DER 変換は不要（ここを間違えると 401 になる）。
 */
export async function buildDpopToken(method: string, uri: string): Promise<string> {
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
    uuid: crypto.randomUUID(),
  };
  const signingInput = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}

export interface MercariSearchInput {
  keyword: string;
  excludeKeyword?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  /** 1..6。指定するとメルカリ側で状態フィルタをかけるので、無駄な取得が減る */
  maxCondition?: number;
  limit?: number;
}

export function buildSearchBody(input: MercariSearchInput): Record<string, unknown> {
  // maxCondition=3 なら [1,2,3] を渡してサーバ側で絞る。クライアント側フィルタより取得効率が良い
  const conditionIds =
    input.maxCondition && input.maxCondition >= 1 && input.maxCondition <= 6
      ? Array.from({ length: input.maxCondition }, (_, i) => String(i + 1))
      : [];

  return {
    userId: "",
    pageSize: Math.min(120, Math.max(1, input.limit ?? 30)),
    pageToken: "",
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED",
    thumbnailTypes: [],
    searchCondition: {
      keyword: input.keyword,
      excludeKeyword: input.excludeKeyword ?? "",
      sort: "SORT_PRICE",
      order: "ORDER_ASC",
      status: ["STATUS_ON_SALE"],
      sizeId: [],
      categoryId: [],
      brandId: [],
      sellerId: [],
      priceMin: input.minPrice ?? 0,
      priceMax: input.maxPrice ?? 0,
      itemConditionId: conditionIds,
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
}

/** 生レスポンスをそのまま返す。診断エンドポイントと probe スクリプトが使う */
export async function mercariRawSearch(input: MercariSearchInput): Promise<{ status: number; body: string }> {
  const attempt = async (): Promise<{ status: number; body: string }> => {
    const dpop = await buildDpopToken("POST", ENDPOINT);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        DPoP: dpop,
        "X-Platform": "web",
        Accept: "*/*",
        "Accept-Language": "ja-JP,ja;q=0.9",
        "User-Agent": UA,
      },
      body: JSON.stringify(buildSearchBody(input)),
      signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, body: await res.text() };
  };

  const first = await attempt();
  // 429/5xx は一時的な可能性があるので1回だけ、間を空けて再試行する（連打はしない）
  if (first.status === 429 || first.status >= 500) {
    await new Promise((r) => setTimeout(r, 1200));
    return attempt();
  }
  return first;
}

interface MercariItem {
  id?: string;
  name?: string;
  price?: string | number;
  thumbnails?: string[];
  itemConditionId?: string | number;
  itemCondition?: { id?: string | number };
  shippingPayerId?: string | number;
  status?: string;
  shopName?: string;
}

/** レスポンスのトップレベルキーは変わりうるので、配列が入っていそうな場所を順に見る */
function pickItems(json: unknown): MercariItem[] {
  if (!json || typeof json !== "object") return [];
  const o = json as Record<string, unknown>;
  for (const key of ["items", "data", "results"]) {
    const v = o[key];
    if (Array.isArray(v)) return v as MercariItem[];
  }
  return [];
}

/** メルカリの itemConditionId は 1..6 で、そのまま正規化ランクに一致する */
function toCondition(item: MercariItem): ConditionRank {
  const n = Number(item.itemConditionId ?? item.itemCondition?.id);
  return n >= 1 && n <= 6 ? (n as ConditionRank) : 0;
}

function toListing(item: MercariItem): Listing | null {
  const title = item.name ?? "";
  const price = Number(item.price ?? 0);
  if (!title || !item.id || !Number.isFinite(price) || price <= 0) return null;
  return buildListing({
    id: `mercari:${item.id}`,
    source: "mercari",
    sourceLabel: "メルカリ",
    title,
    url: `https://jp.mercari.com/item/${item.id}`,
    imageUrl: item.thumbnails?.[0] ?? null,
    price,
    // shippingPayerId: 1=着払い(購入者負担・金額不明) / 2=送料込み。1 を 0 円と嘘をつかない
    shipping: String(item.shippingPayerId) === "2" ? 0 : null,
    condition: toCondition(item),
    seller: item.shopName || null,
    pointBack: null,
  });
}

export async function searchMercari(q: SearchQuery, env: Env): Promise<Listing[]> {
  if (env.ENABLE_MERCARI !== "1") {
    throw new Error("ENABLE_MERCARI=0 のため無効（規約リスクを理解した上で有効化してください）");
  }

  const { status, body } = await mercariRawSearch({
    keyword: q.keyword,
    excludeKeyword: q.excludeKeyword,
    minPrice: q.minPrice,
    maxPrice: q.maxPrice,
    maxCondition: q.maxCondition,
    limit: q.limitPerSource,
  });

  if (status !== 200) {
    throw new Error(`メルカリ内部API ${status}: ${body.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`メルカリ内部API: JSONとして解釈できないレスポンス: ${body.slice(0, 160)}`);
  }

  const items = pickItems(json);
  if (items.length === 0 && body.length > 2) {
    // 200 なのに件数0＝ヒット無しか、レスポンス形状が変わったかの切り分けができないので鍵情報を残す
    const keys = json && typeof json === "object" ? Object.keys(json as object).join(",") : "";
    if (keys && !keys.includes("items")) {
      throw new Error(`メルカリ内部API: items配列が見つかりません（topキー: ${keys}）。probe:mercari で生JSONを確認してください`);
    }
  }

  const out: Listing[] = [];
  for (const item of items) {
    const l = toListing(item);
    if (l) out.push(l);
  }
  return out;
}
