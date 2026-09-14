import { describe, expect, it } from "vitest";
import { isbn10to13, isbn13to10, looksLikeIsbn, normalizeIsbn } from "../src/books/isbn";

describe("ISBN-10 → ISBN-13", () => {
  it("実在する書籍のISBNを正しく変換する", () => {
    // 『金持ち父さん貧乏父さん』筑摩書房
    expect(isbn10to13("4478004552")).toBe("9784478004555");
    // 末尾が X のチェックディジット
    expect(isbn10to13("080442957X")).toBe("9780804429573");
  });
  it("チェックディジットが壊れていれば null", () => {
    expect(isbn10to13("4478004551")).toBeNull();
  });
});

describe("ISBN-13 → ISBN-10", () => {
  it("978 プレフィックスは変換できる", () => {
    expect(isbn13to10("9784478004555")).toBe("4478004552");
  });
  it("979 プレフィックスは ISBN-10 に射影できないので null", () => {
    expect(isbn13to10("9791234567896")).toBeNull();
  });
});

describe("normalizeIsbn", () => {
  it("ハイフン・空白つきでも読める", () => {
    expect(normalizeIsbn("978-4-478-00455-5")).toBe("9784478004555");
    expect(normalizeIsbn(" 4478004552 ")).toBe("9784478004555");
  });
  it("10桁でも13桁に正規化して名寄せ可能にする", () => {
    expect(normalizeIsbn("4478004552")).toBe(normalizeIsbn("9784478004555"));
  });
  it("書名をISBNと誤認しない", () => {
    expect(normalizeIsbn("金持ち父さん")).toBeNull();
    expect(normalizeIsbn("1234567890")).toBeNull(); // 桁数は合うがチェックディジット不正
  });
});

describe("looksLikeIsbn", () => {
  it("桁形状で判定する（チェックディジットは見ない）", () => {
    expect(looksLikeIsbn("9784478004555")).toBe(true);
    expect(looksLikeIsbn("978-4-478-00455-5")).toBe(true);
    expect(looksLikeIsbn("金持ち父さん貧乏父さん")).toBe(false);
    expect(looksLikeIsbn("RTX 3060")).toBe(false);
  });
});
