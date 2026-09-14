import { describe, expect, it } from "vitest";
import { buildDeal, rankDeals, scoreDeal } from "../src/books/rank";
import { buildListing } from "../src/normalize";
import type { BookRef, Listing } from "../src/types";

const book = (title: string, listPrice: number | null): BookRef => ({
  isbn13: null, isbn10: null, title, author: null, publisher: null,
  pubdate: null, coverUrl: null, listPrice, via: "test",
});

const L = (price: number, condition = 3, shipping: number | null = 0): Listing =>
  buildListing({
    id: `${price}-${condition}`, source: "mercari", sourceLabel: "メルカリ",
    title: "本", url: `https://example.com/${price}-${condition}`, imageUrl: null,
    price, shipping, condition: condition as 1 | 2 | 3 | 4 | 5 | 6 | 0, seller: null, pointBack: null,
  });

describe("buildDeal", () => {
  it("最安は実質価格で決まり、同値なら状態が良い方を採る", () => {
    const d = buildDeal(book("A", 1000), [L(500, 5), L(500, 2), L(800, 1)]);
    expect(d.best?.effectivePrice).toBe(500);
    expect(d.best?.condition).toBe(2);
  });
  it("送料込みで比較する（本体が安くても送料で逆転する）", () => {
    const d = buildDeal(book("A", null), [L(500, 3, 400), L(700, 3, 0)]);
    expect(d.best?.price).toBe(700);
  });
  it("定価が分かれば割引率を出す", () => {
    expect(buildDeal(book("A", 2000), [L(500)]).discountPct).toBe(75);
  });
  it("定価不明なら割引率は null（推測で埋めない）", () => {
    expect(buildDeal(book("A", null), [L(500)]).discountPct).toBeNull();
  });
  it("相場乖離は中央値基準", () => {
    const d = buildDeal(book("A", null), [L(300), L(1000), L(1100)]);
    expect(d.median).toBe(1000);
    expect(d.gapPct).toBe(70);
  });
  it("出品ゼロなら best も中央値も null", () => {
    const d = buildDeal(book("A", 1000), []);
    expect(d.best).toBeNull();
    expect(d.median).toBeNull();
    expect(d.supply).toBe(0);
  });
});

describe("rankDeals", () => {
  const cheapNoList = buildDeal(book("定価不明・激安", null), [L(100)]);
  const bigDiscount = buildDeal(book("大幅割引", 5000), [L(500), L(4000), L(4500)]);
  const smallDiscount = buildDeal(book("小幅割引", 1000), [L(900), L(950)]);
  const manySupply = buildDeal(book("大量出品", 1000), [L(800), L(810), L(820), L(830)]);
  const empty = buildDeal(book("在庫なし", 1000), []);

  it("discount: 割引率が大きい順。定価不明は末尾", () => {
    const r = rankDeals([smallDiscount, cheapNoList, bigDiscount], "discount");
    expect(r.map((d) => d.book.title)).toEqual(["大幅割引", "小幅割引", "定価不明・激安"]);
  });
  it("cheapest: 絶対額が安い順", () => {
    const r = rankDeals([bigDiscount, cheapNoList, smallDiscount], "cheapest");
    expect(r[0].book.title).toBe("定価不明・激安");
  });
  it("gap: 相場から外れて安い出品がある本＝掘り出し物を上に", () => {
    const r = rankDeals([smallDiscount, bigDiscount], "gap");
    expect(r[0].book.title).toBe("大幅割引");
  });
  it("supply: 出品数が多い順", () => {
    const r = rankDeals([bigDiscount, manySupply], "supply");
    expect(r[0].book.title).toBe("大量出品");
  });
  it("出品ゼロはどのモードでも最後尾（買えないものを上に出さない）", () => {
    for (const m of ["discount", "cheapest", "gap", "supply"] as const) {
      expect(rankDeals([empty, smallDiscount], m).at(-1)!.book.title).toBe("在庫なし");
    }
  });
  it("元の配列を壊さない", () => {
    const src = [smallDiscount, bigDiscount];
    rankDeals(src, "discount");
    expect(src[0].book.title).toBe("小幅割引");
  });
});

describe("scoreDeal", () => {
  it("出品ゼロは0点", () => {
    expect(scoreDeal(buildDeal(book("A", 1000), []))).toBe(0);
  });
  it("0..100 に収まる", () => {
    const d = buildDeal(book("A", 100000), [L(100)]);
    const s = scoreDeal(d);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
  it("割引率が大きいほど高得点", () => {
    const a = scoreDeal(buildDeal(book("A", 5000), [L(500), L(4000)]));
    const b = scoreDeal(buildDeal(book("B", 5000), [L(4000), L(4500)]));
    expect(a).toBeGreaterThan(b);
  });
  it("定価不明でも乖離で代替評価され、0点に沈まない", () => {
    const s = scoreDeal(buildDeal(book("A", null), [L(300), L(1000), L(1100)]));
    expect(s).toBeGreaterThan(0);
  });
});
