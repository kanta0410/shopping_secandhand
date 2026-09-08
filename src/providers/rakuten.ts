import { buildListing, guessConditionFromTitle, looksNew } from "../normalize";
import type { Env, Listing, SearchQuery } from "../types";

const ENDPOINT = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";

interface RakutenItem {
  itemName?: string;
  itemPrice?: number;
  itemUrl?: string;
  itemCode?: string;
  shopName?: string;
  postageFlag?: number; // 0=送料込み, 1=送料別
  pointRate?: number;
  mediumImageUrls?: ({ imageUrl?: string } | string)[];
  smallImageUrls?: ({ imageUrl?: string } | string)[];
}

function pickImage(item: RakutenItem): string | null {
  const arr = item.mediumImageUrls ?? item.smallImageUrls ?? [];
  const first = arr[0];
  if (!first) return null;
  const url = typeof first === "string" ? first : first.imageUrl;
  if (!url) return null;
  // 楽天のサムネURLは末尾に ?_ex=128x128 が付く。少し大きめに差し替える
  return url.replace(/\?_ex=\d+x\d+$/, "?_ex=200x200");
}

/**
 * 楽天市場 商品検索API。
 * 注意: 楽天市場APIには「中古のみ」の公式フラグが存在しない。
 * そのため keyword に中古語を足し、NGKeyword で新品語を弾く「ヒューリスティック中古検索」になる。
 * 取りこぼし/誤検出はここが原因なので、判定は必ず title 由来の condition と併記して表示する。
 */
export async function searchRakuten(q: SearchQuery, env: Env): Promise<Listing[]> {
  const appId = env.RAKUTEN_APP_ID;
  if (!appId) throw new Error("RAKUTEN_APP_ID 未設定");

  const url = new URL(ENDPOINT);
  url.searchParams.set("applicationId", appId);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("keyword", `${q.keyword} 中古`);
  url.searchParams.set("hits", String(Math.min(30, q.limitPerSource)));
  url.searchParams.set("sort", "+itemPrice");
  url.searchParams.set("availability", "1");
  const ng = [q.excludeKeyword, "新品 未開封"].filter(Boolean).join(" ").trim();
  if (ng) url.searchParams.set("NGKeyword", ng);
  if (q.minPrice != null) url.searchParams.set("minPrice", String(q.minPrice));
  if (q.maxPrice != null) url.searchParams.set("maxPrice", String(q.maxPrice));

  const res = await fetch(url.toString(), { headers: { "User-Agent": "chuko-hunter/0.1" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`楽天API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { Items?: (RakutenItem | { Item: RakutenItem })[] };
  const items = (json.Items ?? []).map((x) => ("Item" in (x as object) ? (x as { Item: RakutenItem }).Item : (x as RakutenItem)));

  const out: Listing[] = [];
  for (const item of items) {
    const title = item.itemName ?? "";
    const price = item.itemPrice ?? 0;
    if (!title || !item.itemUrl || price <= 0) continue;
    // 中古を探しているのに明らかな新品出品は落とす
    if (looksNew(title)) continue;
    const pointRate = item.pointRate ?? 1;
    out.push(
      buildListing({
        id: `rakuten:${item.itemCode ?? item.itemUrl}`,
        source: "rakuten",
        sourceLabel: "楽天市場",
        title,
        url: item.itemUrl,
        imageUrl: pickImage(item),
        price,
        // postageFlag 0 = 送料込み。1 は「送料別」だが金額はAPIで取れない → 不明扱い
        shipping: item.postageFlag === 0 ? 0 : null,
        condition: guessConditionFromTitle(title),
        seller: item.shopName ?? null,
        pointBack: Math.floor(price * 0.01 * pointRate),
      }),
    );
  }
  return out;
}
