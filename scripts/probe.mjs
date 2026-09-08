#!/usr/bin/env node
/**
 * 中古ハンター 診断ツール。
 *
 * 開発環境（Cloudflare のビルド環境や CI サンドボックス）は外部への通信が塞がれていることがあり、
 * その状態では各サイトのレスポンス実物を確認できない。このスクリプトは「あなたの手元の回線」で
 * 生レスポンスを取ってきて、パーサの前提が合っているかを一発で判定するためにある。
 *
 *   node scripts/probe.mjs mercari "金持ち父さん"     メルカリ内部APIの生JSONを確認
 *   node scripts/probe.mjs sites   "金持ち父さん"     中古本3サイトのHTMLとJSON-LDの有無を確認
 *   node scripts/probe.mjs html    <URL>              任意URLのHTML構造を診断
 *   node scripts/probe.mjs books   "金持ち父さん"     NDLサーチ / openBD の書誌APIを確認
 *
 * DPoP 生成は src/providers/mercari.ts と同じロジック。片方を直したらもう片方も直すこと。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MERCARI_ENDPOINT = "https://api.mercari.jp/v2/entities:search";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function buildDpopToken(method, uri) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    htu: uri,
    htm: method,
    uuid: crypto.randomUUID(),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, Buffer.from(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function probeMercari(keyword) {
  console.log(`\n=== メルカリ内部API ===\nkeyword: ${keyword}`);
  const dpop = await buildDpopToken("POST", MERCARI_ENDPOINT);
  const body = {
    userId: "",
    pageSize: 5,
    pageToken: "",
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED",
    thumbnailTypes: [],
    searchCondition: {
      keyword,
      excludeKeyword: "",
      sort: "SORT_PRICE",
      order: "ORDER_ASC",
      status: ["STATUS_ON_SALE"],
      sizeId: [], categoryId: [], brandId: [], sellerId: [],
      priceMin: 0, priceMax: 0,
      itemConditionId: [], shippingPayerId: [], shippingFromArea: [],
      shippingMethod: [], colorId: [], hasCoupon: false,
      attributes: [], itemTypes: [], skuIds: [], shopIds: [], excludeShippingMethodIds: [],
    },
    defaultDatasets: [],
    serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true,
    withShopname: false, useDynamicAttribute: true, withSuggestedItems: false,
    withOfferPricePromotion: true, withProductSuggest: false, withParentProducts: false,
    withProductArticles: false, withSearchConditionId: false,
  };

  const res = await fetch(MERCARI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      DPoP: dpop,
      "X-Platform": "web",
      Accept: "*/*",
      "Accept-Language": "ja-JP,ja;q=0.9",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  if (res.status !== 200) {
    console.log("BODY:", text.slice(0, 600));
    console.log("\n→ 401/403 なら DPoP署名かヘッダの問題。src/providers/mercari.ts の buildDpopToken を疑う。");
    return;
  }
  let json;
  try { json = JSON.parse(text); } catch { console.log("JSONではない:", text.slice(0, 300)); return; }
  console.log("top-level keys:", Object.keys(json).join(", "));
  const items = json.items ?? json.data ?? json.results ?? [];
  console.log("items count:", Array.isArray(items) ? items.length : "(配列でない)");
  if (Array.isArray(items) && items[0]) {
    console.log("1件目のキー:", Object.keys(items[0]).join(", "));
    console.log("1件目:", JSON.stringify(items[0], null, 1).slice(0, 1200));
    console.log("\n→ id / name / price / thumbnails / itemConditionId / shippingPayerId が揃っていれば実装は正しい。");
    console.log("→ 名前が違うキーがあれば src/providers/mercari.ts の toListing() を直す。");
  }
}

/** JSON-LD が埋まっているかがスクレイパの生死を分けるので、そこを重点的に見る */
async function probeHtml(url) {
  console.log(`\n=== HTML診断 ===\n${url}`);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" },
      redirect: "follow",
    });
  } catch (e) {
    console.log("取得失敗:", e.message);
    return;
  }
  const html = await res.text();
  console.log(`HTTP ${res.status} / ${html.length.toLocaleString()} bytes / final: ${res.url}`);

  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1],
  );
  console.log(`JSON-LD ブロック: ${blocks.length} 個`);
  const types = new Set();
  let sampleOffer = null;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n["@type"]) [].concat(n["@type"]).forEach((t) => types.add(t));
    if (!sampleOffer && (n.offers || n.price)) sampleOffer = n;
    Object.values(n).forEach(walk);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b)); } catch { /* 壊れたJSON-LDは無視 */ }
  }
  console.log("@type 一覧:", [...types].join(", ") || "(なし)");
  if (sampleOffer) console.log("価格を含むノードの例:", JSON.stringify(sampleOffer).slice(0, 700));

  const priceHits = [...html.matchAll(/class="([^"]*price[^"]*)"/gi)].map((m) => m[1]);
  console.log("class名に price を含む上位:", [...new Set(priceHits)].slice(0, 12).join(" | ") || "(なし)");
  const yen = [...html.matchAll(/[¥￥]\s?[\d,]{3,}/g)].slice(0, 8).map((m) => m[0]);
  console.log("円表記の例:", yen.join(", ") || "(なし)");
  console.log("itemprop 属性:", html.includes("itemprop") ? "あり" : "なし");
  console.log("__NEXT_DATA__:", html.includes("__NEXT_DATA__") ? "あり（JSから抜くのが最短）" : "なし");
  if (html.length < 20000 && /noscript|JavaScript を有効/i.test(html)) {
    console.log("⚠ JS必須のSPAの可能性が高い。fetchでは中身が取れない → 別ルートを検討する。");
  }
}

async function probeSites(keyword) {
  const kw = encodeURIComponent(keyword);
  const targets = [
    ["駿河屋", `https://www.suruga-ya.jp/search?category=&search_word=${kw}&searchbox=1`],
    ["日本の古本屋", `https://www.kosho.or.jp/products/list.php?mode=search&search_word=${kw}`],
    ["ブックオフオンライン", `https://shopping.bookoff.co.jp/search/keyword/${kw}`],
  ];
  for (const [name, url] of targets) {
    console.log(`\n\n########## ${name} ##########`);
    await probeHtml(url);
  }
  console.log("\n\n→ JSON-LD に Product/Offer があるサイトは実装済みパーサでそのまま動く。");
  console.log("→ 無いサイトは、上に出た class名/円表記を src/providers/books/<site>.ts のセレクタ定数に反映する。");
}

async function probeBooks(keyword) {
  console.log(`\n=== NDLサーチ OpenSearch ===`);
  const ndl = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(keyword)}&cnt=3`;
  try {
    const res = await fetch(ndl, { headers: { "User-Agent": UA } });
    const xml = await res.text();
    console.log(`HTTP ${res.status} / ${xml.length} bytes`);
    console.log(xml.slice(0, 1500));
  } catch (e) {
    console.log("失敗:", e.message);
  }

  console.log(`\n=== openBD (ISBN 9784478004555 で形状確認) ===`);
  try {
    const res = await fetch("https://api.openbd.jp/v1/get?isbn=9784478004555", { headers: { "User-Agent": UA } });
    const j = await res.json();
    console.log(`HTTP ${res.status}`);
    console.log("summary:", JSON.stringify(j?.[0]?.summary ?? null, null, 1));
    const price = j?.[0]?.onix?.ProductSupply?.SupplyDetail?.Price?.[0];
    console.log("定価ノード:", JSON.stringify(price ?? null));
  } catch (e) {
    console.log("失敗:", e.message);
  }
}

const [mode, arg] = process.argv.slice(2);
if (!mode) {
  console.log("使い方: node scripts/probe.mjs <mercari|sites|html|books> <キーワードまたはURL>");
  process.exit(1);
}
const run = { mercari: probeMercari, sites: probeSites, html: probeHtml, books: probeBooks }[mode];
if (!run) { console.log(`不明なモード: ${mode}`); process.exit(1); }
await run(arg ?? "金持ち父さん貧乏父さん");
