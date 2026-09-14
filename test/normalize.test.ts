import { describe, expect, it } from "vitest";
import {
  buildListing,
  dedupe,
  guessConditionFromTitle,
  looksNew,
  matchesAllTokens,
  normalizeText,
  percentile,
  tokenize,
} from "../src/normalize";
import type { Listing } from "../src/types";

describe("normalizeText", () => {
  it("全角英数を半角に揃える（同じ商品が別物に見えるのを防ぐ）", () => {
    expect(normalizeText("ＲＴＸ３０６０")).toBe("rtx3060");
  });
  it("全角スペースと各種ダッシュを揃える", () => {
    expect(normalizeText("iPhone　13")).toBe("iphone 13");
    expect(normalizeText("A−B")).toBe("a-b");
    expect(normalizeText("A–B")).toBe("a-b");
  });
});

describe("matchesAllTokens", () => {
  const t = tokenize("金持ち父さん 改訂版");
  it("全トークンを含むタイトルだけ残す", () => {
    expect(matchesAllTokens("金持ち父さん貧乏父さん 改訂版", t)).toBe(true);
    expect(matchesAllTokens("金持ち父さん貧乏父さん 初版", t)).toBe(false);
  });
  it("トークンが空なら素通し", () => {
    expect(matchesAllTokens("なんでも", [])).toBe(true);
  });
  it("全角半角の違いを吸収する", () => {
    expect(matchesAllTokens("ＲＴＸ 3060 搭載PC", tokenize("rtx3060"))).toBe(true);
  });
});

describe("guessConditionFromTitle / looksNew", () => {
  it("ジャンク・難ありは最悪寄りに倒す", () => {
    expect(guessConditionFromTitle("ジャンク品 動作未確認")).toBe(5);
  });
  it("中古表記があれば中古扱い", () => {
    expect(guessConditionFromTitle("【中古】金持ち父さん")).toBe(4);
  });
  it("新品表記は新品", () => {
    expect(guessConditionFromTitle("新品未開封 iPhone")).toBe(1);
  });
  it("判定材料が無ければ不明(0)。推測で埋めない", () => {
    expect(guessConditionFromTitle("金持ち父さん貧乏父さん")).toBe(0);
  });
  it("中古語と新品語が両方あるときは中古を優先する（『新品同様の中古』を弾かない）", () => {
    expect(looksNew("中古 新品同様 美品")).toBe(false);
    expect(looksNew("新品 未使用")).toBe(true);
  });
});

const base = {
  id: "x",
  source: "mercari" as const,
  sourceLabel: "メルカリ",
  title: "テスト商品",
  url: "https://example.com/a",
  imageUrl: null,
  condition: 3 as const,
  seller: null,
  pointBack: null,
};

describe("buildListing", () => {
  it("送料が分かるなら実質価格に足す", () => {
    const l = buildListing({ ...base, price: 1000, shipping: 300 });
    expect(l.effectivePrice).toBe(1300);
    expect(l.shippingUnknown).toBe(false);
  });
  it("送料不明は0円として足すが、必ずフラグを立てる（並び順の前提が崩れていることを隠さない）", () => {
    const l = buildListing({ ...base, price: 1000, shipping: null });
    expect(l.effectivePrice).toBe(1000);
    expect(l.shippingUnknown).toBe(true);
  });
  it("状態ラベルを付ける", () => {
    expect(buildListing({ ...base, price: 100, shipping: 0 }).conditionLabel).toBe("目立った傷や汚れなし");
  });
});

describe("dedupe", () => {
  it("クエリ違いの同一URLを1件にまとめる", () => {
    const ls = [
      buildListing({ ...base, url: "https://a.com/i?ref=1", price: 100, shipping: 0 }),
      buildListing({ ...base, id: "y", url: "https://a.com/i?ref=2", price: 100, shipping: 0 }),
    ];
    expect(dedupe(ls)).toHaveLength(1);
  });
  it("同一サイトの同タイトル同価格を1件にまとめる", () => {
    const ls = [
      buildListing({ ...base, url: "https://a.com/1", price: 500, shipping: 0 }),
      buildListing({ ...base, id: "y", url: "https://a.com/2", price: 500, shipping: 0 }),
    ];
    expect(dedupe(ls)).toHaveLength(1);
  });
  it("サイトが違えば同タイトル同価格でも残す（比較対象として意味があるため）", () => {
    const ls: Listing[] = [
      buildListing({ ...base, url: "https://a.com/1", price: 500, shipping: 0 }),
      buildListing({ ...base, id: "y", source: "rakuten", sourceLabel: "楽天", url: "https://b.com/1", price: 500, shipping: 0 }),
    ];
    expect(dedupe(ls)).toHaveLength(2);
  });
});

describe("percentile", () => {
  it("空配列は null", () => expect(percentile([], 0.5)).toBeNull());
  it("奇数個の中央値", () => expect(percentile([100, 200, 300], 0.5)).toBe(200));
  it("偶数個は補間する", () => expect(percentile([100, 200], 0.5)).toBe(150));
  it("25%タイル", () => expect(percentile([100, 200, 300, 400], 0.25)).toBe(175));
  it("1件なら最小も中央値も同じ", () => expect(percentile([777], 0.5)).toBe(777));
});
