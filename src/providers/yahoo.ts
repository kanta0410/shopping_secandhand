import { buildListing } from "../normalize";
import type { ConditionRank, Env, Listing, SearchQuery } from "../types";

const ENDPOINT = "https://shopping.yahooapis.co.jp/ShoppingWebService/V3/itemSearch";

interface YahooHit {
  name?: string;
  url?: string;
  code?: string;
  condition?: string; // "new" | "used"
  price?: number;
  image?: { medium?: string; small?: string };
  point?: { amount?: number };
  shipping?: { code?: number; name?: string };
  seller?: { name?: string; sellerId?: string };
  inStock?: boolean;
}

/**
 * Yahoo!ショッピング 商品検索API v3。
 * ここは公式に condition=used が用意されている数少ないルート＝一番信頼できる中古データ源。
 */
export async function searchYahoo(q: SearchQuery, env: Env): Promise<Listing[]> {
  const appid = env.YAHOO_CLIENT_ID;
  if (!appid) throw new Error("YAHOO_CLIENT_ID 未設定");

  const url = new URL(ENDPOINT);
  url.searchParams.set("appid", appid);
  url.searchParams.set("query", q.keyword);
  url.searchParams.set("condition", "used");
  url.searchParams.set("sort", "+price");
  url.searchParams.set("results", String(Math.min(50, q.limitPerSource)));
  url.searchParams.set("in_stock", "true");
  if (q.minPrice != null) url.searchParams.set("price_from", String(q.minPrice));
  if (q.maxPrice != null) url.searchParams.set("price_to", String(q.maxPrice));

  const res = await fetch(url.toString(), { headers: { "User-Agent": "chuko-hunter/0.1" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo!ショッピングAPI ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { hits?: YahooHit[] };

  const out: Listing[] = [];
  for (const hit of json.hits ?? []) {
    const title = hit.name ?? "";
    const price = hit.price ?? 0;
    if (!title || !hit.url || price <= 0) continue;
    // 送料は API から金額が取れない。code=2 は「送料無料」扱いのケースがあるが確証がないので不明のまま扱う
    const shipping = hit.shipping?.name === "送料無料" ? 0 : null;
    // condition=used で絞っているので、状態の細分はサイト側に無い。3(=目立った傷や汚れなし相当)を既定にせず「不明」で正直に出す
    const condition: ConditionRank = hit.condition === "new" ? 1 : 0;
    out.push(
      buildListing({
        id: `yahoo:${hit.code ?? hit.url}`,
        source: "yahoo_shopping",
        sourceLabel: "Yahoo!ショッピング",
        title,
        url: hit.url,
        imageUrl: hit.image?.medium ?? hit.image?.small ?? null,
        price,
        shipping,
        condition,
        seller: hit.seller?.name ?? null,
        pointBack: hit.point?.amount ?? null,
      }),
    );
  }
  return out;
}
