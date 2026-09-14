import { describe, expect, it } from "vitest";
import { collectProducts, isOutOfStock, isUsedCondition } from "../src/scrape/jsonld";
import { absolutize, decodeEntities, extractJsonLdBlocks, parseYen, stripTags } from "../src/scrape/html";

describe("parseYen", () => {
  it("日本のECで出てくる各種の円表記を読む", () => {
    expect(parseYen("￥1,280")).toBe(1280);
    expect(parseYen("¥1,280")).toBe(1280);
    expect(parseYen("1,280円")).toBe(1280);
    expect(parseYen("価格 1,280 円(税込)")).toBe(1280);
    expect(parseYen("１，２８０円")).toBe(1280); // 全角
    expect(parseYen("1234567")).toBe(1234567);
  });
  it("価格でないものは null（0円や空を価格として通さない）", () => {
    expect(parseYen("")).toBeNull();
    expect(parseYen(null)).toBeNull();
    expect(parseYen("price")).toBeNull();
    expect(parseYen("0円")).toBeNull();
  });
});

describe("stripTags / decodeEntities", () => {
  it("タグを外して実体参照を戻す", () => {
    expect(stripTags("<span>金持ち&amp;貧乏</span>")).toBe("金持ち&貧乏");
    expect(decodeEntities("&lt;中古&gt;&nbsp;美品&#39;s")).toBe("<中古> 美品's");
  });
});

describe("absolutize", () => {
  it("相対・ルート相対・プロトコル相対を絶対URLにする", () => {
    expect(absolutize("/item/1", "https://a.com/search")).toBe("https://a.com/item/1");
    expect(absolutize("//cdn.a.com/x.jpg", "https://a.com/")).toBe("https://cdn.a.com/x.jpg");
    expect(absolutize("https://b.com/1", "https://a.com/")).toBe("https://b.com/1");
  });
});

describe("extractJsonLdBlocks", () => {
  it("壊れたブロックがあっても他は拾う", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Product","name":"A"}</script>
      <script type="application/ld+json">{ this is broken }</script>
      <script type="application/ld+json">{"@type":"Product","name":"B"}</script>`;
    expect(extractJsonLdBlocks(html)).toHaveLength(2);
  });
});

describe("collectProducts", () => {
  it("素の Product/Offer を読む", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "金持ち父さん貧乏父さん 改訂版",
      image: "https://a.com/1.jpg",
      url: "https://a.com/item/1",
      offers: { "@type": "Offer", price: "480", priceCurrency: "JPY", availability: "https://schema.org/InStock", itemCondition: "https://schema.org/UsedCondition" },
    })}</script>`;
    const [p] = collectProducts(html);
    expect(p.name).toBe("金持ち父さん貧乏父さん 改訂版");
    expect(p.price).toBe(480);
    expect(p.url).toBe("https://a.com/item/1");
    expect(isUsedCondition(p.condition)).toBe(true);
    expect(isOutOfStock(p.availability)).toBe(false);
  });

  it("ItemList に入った検索結果ページ（EC検索の一般形）を全件拾う", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "本A", offers: { price: 300 }, url: "/a" } },
        { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "本B", offers: { price: 900 }, url: "/b" } },
      ],
    })}</script>`;
    const ps = collectProducts(html);
    expect(ps.map((p) => p.name)).toEqual(["本A", "本B"]);
    expect(ps.map((p) => p.price)).toEqual([300, 900]);
  });

  it("@graph 形式も掘る", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [{ "@type": "WebSite", name: "サイト" }, { "@type": "Book", name: "本C", offers: { price: "1,200" } }],
    })}</script>`;
    const ps = collectProducts(html);
    expect(ps.find((p) => p.name === "本C")?.price).toBe(1200);
  });

  it("offers が配列（複数店舗の出品）なら最安を採る", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "本D",
      offers: [{ "@type": "Offer", price: 1500 }, { "@type": "Offer", price: 800 }],
    })}</script>`;
    expect(collectProducts(html)[0].price).toBe(800);
  });

  it("AggregateOffer の lowPrice を読む", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "本E",
      offers: { "@type": "AggregateOffer", lowPrice: "650", highPrice: "2400", offerCount: 12 },
    })}</script>`;
    expect(collectProducts(html)[0].price).toBe(650);
  });

  it("JSON-LD が無いページでは空配列（例外を投げない）", () => {
    expect(collectProducts("<html><body>なにもなし</body></html>")).toEqual([]);
  });

  it("循環参照を含む JSON-LD でも停止する", () => {
    // JSON.parse 経由では循環は作れないが、深い入れ子で無限に潜らないことを確認する
    let deep: Record<string, unknown> = { "@type": "Product", name: "深", offers: { price: 100 } };
    for (let i = 0; i < 40; i++) deep = { wrapper: deep };
    const html = `<script type="application/ld+json">${JSON.stringify(deep)}</script>`;
    expect(() => collectProducts(html)).not.toThrow();
  });
});

describe("在庫・状態の判定", () => {
  it("売り切れを検出する", () => {
    expect(isOutOfStock("https://schema.org/OutOfStock")).toBe(true);
    expect(isOutOfStock("https://schema.org/SoldOut")).toBe(true);
    expect(isOutOfStock("InStock")).toBe(false);
  });
  it("中古判定が付かないものは null（不明のまま扱い、推測で埋めない）", () => {
    expect(isUsedCondition(undefined)).toBeNull();
    expect(isUsedCondition("https://schema.org/NewCondition")).toBe(false);
  });
});
