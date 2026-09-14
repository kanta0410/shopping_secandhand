import type { BookRef, Env } from "../types";
import { normalizeText } from "../normalize";

/* ============================================================
 * 書誌解決（書名/キーワード → ISBN → 定価つき BookRef）
 *
 * 中古横断の精度は「ISBN が引けているか」で決まるので、
 * キー不要で叩ける情報源（openBD / NDLサーチ）を第一候補に置き、
 * 楽天ブックスは定価（新品価格）の分母として補助的に使う。
 * どの情報源も落ちうるので、個別 try/catch で「1つ死んでも他が返る」形にする。
 * ============================================================ */

const TIMEOUT_MS = 8000;
const UA = "chuko-hunter/0.1";

function fetchOpts(): RequestInit {
  // Workers の fetch は AbortSignal.timeout をサポート。ぶら下がりで Worker 時間を食わせない
  return { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) };
}

/* ---------- ISBN ユーティリティ ---------- */

function stripIsbn(s: string): string {
  // ハイフン・空白・全角スペースを除去し、X は大文字に寄せる
  return (s ?? "").replace(/[\s　\-‐‑‒–—―ー−]/g, "").toUpperCase();
}

/** ISBN-10 のチェックディジット（末尾1桁を除く9桁から算出）。10 は "X" */
function isbn10CheckDigit(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(first9[i]);
  const mod = (11 - (sum % 11)) % 11;
  return mod === 10 ? "X" : String(mod);
}

/** ISBN-13(EAN) のチェックディジット（末尾1桁を除く12桁から算出） */
function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function isValidIsbn10(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  return isbn10CheckDigit(s.slice(0, 9)) === s[9];
}

function isValidIsbn13(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  return isbn13CheckDigit(s.slice(0, 12)) === s[12];
}

/**
 * ISBN-10 → ISBN-13。
 * 入力のチェックディジットが合わないものは null を返す。
 * 黙って通すと「打ち間違いのISBN」から実在する別の本のISBN-13を作ってしまい、
 * 見当違いの本の相場を表示することになるため。
 */
export function isbn10to13(s: string): string | null {
  const t = stripIsbn(s);
  if (!isValidIsbn10(t)) return null;
  const body = "978" + t.slice(0, 9);
  return body + isbn13CheckDigit(body);
}

/** ISBN-13 → ISBN-10。979 プレフィックス（ISBN-10 に射影できない）は null */
export function isbn13to10(s: string): string | null {
  const t = stripIsbn(s);
  if (!/^\d{13}$/.test(t)) return null;
  if (!t.startsWith("978")) return null;
  const body = t.slice(3, 12);
  return body + isbn10CheckDigit(body);
}

/**
 * ISBN らしき文字列を ISBN-13 に正規化する。
 * 「10桁でも13桁でも同じ本」として名寄せしたいので、正規形は常に ISBN-13 に寄せる。
 * チェックディジットが合わないものは弾く（書名を ISBN と誤認して検索を壊さないため）。
 */
export function normalizeIsbn(s: string): string | null {
  const t = stripIsbn(s);
  if (isValidIsbn13(t)) return t;
  if (isValidIsbn10(t)) return isbn10to13(t);
  return null;
}

/** チェックディジットまでは見ない緩い判定（入力欄が ISBN かどうかの分岐用） */
export function looksLikeIsbn(s: string): boolean {
  const t = stripIsbn(s);
  return /^(97[89]\d{10}|\d{9}[\dX])$/.test(t);
}

/* ---------- 共通ヘルパ ---------- */

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();
}

/* ---------- openBD ---------- */

/** openBD のレスポンス（必要な枝だけ。要素が null で返ることがあるので全部 optional） */
interface OpenBdRecord {
  summary?: {
    isbn?: string;
    title?: string;
    author?: string;
    publisher?: string;
    pubdate?: string;
    cover?: string;
  } | null;
  onix?: {
    ProductSupply?: {
      SupplyDetail?: {
        Price?: { PriceAmount?: string | number; CurrencyCode?: string }[];
      };
    };
  } | null;
}

function openBdToBookRef(rec: OpenBdRecord | null | undefined): BookRef | null {
  if (!rec || typeof rec !== "object") return null;
  const sum = rec.summary ?? undefined;
  const rawIsbn = str(sum?.isbn);
  const isbn13 = rawIsbn ? normalizeIsbn(rawIsbn) : null;
  const title = str(sum?.title);
  // タイトルも ISBN も無い殻レコードは使い道がない
  if (!title && !isbn13) return null;
  const priceRaw = rec.onix?.ProductSupply?.SupplyDetail?.Price?.[0]?.PriceAmount;
  return {
    isbn13,
    isbn10: isbn13 ? isbn13to10(isbn13) : rawIsbn && /^\d{9}[\dX]$/.test(stripIsbn(rawIsbn)) ? stripIsbn(rawIsbn) : null,
    title: title ?? rawIsbn ?? "",
    author: str(sum?.author),
    publisher: str(sum?.publisher),
    pubdate: str(sum?.pubdate),
    coverUrl: str(sum?.cover),
    listPrice: toInt(priceRaw),
    via: "openbd",
  };
}

/** openBD は ISBN のカンマ区切りで一括取得できるので、定価の穴埋めは1リクエストにまとめる */
async function fetchOpenBd(isbns: string[]): Promise<BookRef[]> {
  const list = isbns.filter(Boolean).slice(0, 20);
  if (list.length === 0) return [];
  const url = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(list.join(","))}`;
  const res = await fetch(url, fetchOpts());
  if (!res.ok) throw new Error(`openBD ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) return [];
  const out: BookRef[] = [];
  for (const rec of json as (OpenBdRecord | null)[]) {
    const b = openBdToBookRef(rec);
    if (b) out.push(b);
  }
  return out;
}

/* ---------- 国立国会図書館サーチ (OpenSearch / XML) ---------- */

function tagContent(xml: string, tag: string): string | null {
  // 属性つきタグ（<dc:title xml:lang="ja">）にも当たるようにする
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1]) : null;
}

function ndlIsbn(itemXml: string): string | null {
  // NDL は版によって <dcndl:ISBN> だったり <dc:identifier xsi:type="dcndl:ISBN"> だったりする
  const direct = tagContent(itemXml, "dcndl:ISBN");
  if (direct) {
    const n = normalizeIsbn(direct);
    if (n) return n;
  }
  const re = /<dc:identifier[^>]*dcndl:ISBN[^>]*>([\s\S]*?)<\/dc:identifier>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(itemXml))) {
    const n = normalizeIsbn(decodeXmlEntities(m[1]));
    if (n) return n;
  }
  return null;
}

/** 書名 → ISBN の逆引き。Workers に XML パーサが無いので正規表現の簡易パーサで済ませる */
async function fetchNdl(keyword: string, cnt: number): Promise<BookRef[]> {
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(keyword)}&cnt=${cnt}`;
  const res = await fetch(url, fetchOpts());
  if (!res.ok) throw new Error(`NDL ${res.status}`);
  const xml = await res.text();
  const out: BookRef[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const item = m[1];
    const title = tagContent(item, "dc:title") ?? tagContent(item, "title");
    if (!title) continue;
    const isbn13 = ndlIsbn(item);
    out.push({
      isbn13,
      isbn10: isbn13 ? isbn13to10(isbn13) : null,
      title,
      author: tagContent(item, "dc:creator"),
      publisher: tagContent(item, "dc:publisher"),
      pubdate: tagContent(item, "dcterms:issued") ?? tagContent(item, "dc:date"),
      coverUrl: isbn13 ? `https://ndlsearch.ndl.go.jp/thumbnail/${isbn13}.jpg` : null,
      // NDL は書誌だけで価格を持たないため、定価は他ソースに任せる
      listPrice: null,
      via: "ndl",
    });
  }
  return out;
}

/* ---------- 楽天ブックス 書籍検索API ---------- */

interface RakutenBookItem {
  title?: string;
  author?: string;
  publisherName?: string;
  salesDate?: string;
  isbn?: string;
  itemPrice?: number | string;
  largeImageUrl?: string;
  mediumImageUrl?: string;
  smallImageUrl?: string;
}

/** 定価の分母として一番当てになる新品価格を取りに行く。キー未設定なら静かにスキップ */
async function fetchRakutenBooks(keyword: string, env: Env, hits: number): Promise<BookRef[]> {
  const appId = env.RAKUTEN_APP_ID;
  if (!appId) return [];
  const url = new URL("https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  url.searchParams.set("applicationId", appId);
  url.searchParams.set("title", keyword);
  url.searchParams.set("hits", String(Math.min(30, Math.max(1, hits))));
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");

  const res = await fetch(url.toString(), fetchOpts());
  if (!res.ok) throw new Error(`楽天ブックス ${res.status}`);
  const json = (await res.json()) as { Items?: (RakutenBookItem | { Item: RakutenBookItem })[] };
  // formatVersion=2 は素の配列だが、1 だと { Item: {...} } で包まれる。両方受ける
  const items = (json?.Items ?? []).map((x) =>
    x && typeof x === "object" && "Item" in x ? (x as { Item: RakutenBookItem }).Item : (x as RakutenBookItem),
  );

  const out: BookRef[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const title = str(it.title);
    if (!title) continue;
    const isbn13 = it.isbn ? normalizeIsbn(String(it.isbn)) : null;
    out.push({
      isbn13,
      isbn10: isbn13 ? isbn13to10(isbn13) : null,
      title,
      author: str(it.author),
      publisher: str(it.publisherName),
      pubdate: str(it.salesDate),
      coverUrl: str(it.largeImageUrl) ?? str(it.mediumImageUrl) ?? str(it.smallImageUrl),
      listPrice: toInt(it.itemPrice),
      via: "rakuten_books",
    });
  }
  return out;
}

/* ---------- 名寄せ ---------- */

const VIA_PRIORITY: Record<string, number> = { rakuten_books: 3, openbd: 2, ndl: 1 };

/** ISBN13 があればそれ、無ければ正規化タイトル+著者を同一性のキーにする */
function mergeKey(b: BookRef): string {
  if (b.isbn13) return `isbn:${b.isbn13}`;
  return `t:${normalizeText(b.title).slice(0, 60)}|${normalizeText(b.author ?? "").slice(0, 24)}`;
}

function mergeBook(base: BookRef, add: BookRef): BookRef {
  const basePrio = VIA_PRIORITY[base.via] ?? 0;
  const addPrio = VIA_PRIORITY[add.via] ?? 0;
  return {
    isbn13: base.isbn13 ?? add.isbn13,
    isbn10: base.isbn10 ?? add.isbn10,
    // タイトルは（NDLの版表記より）短くて素直な方が中古サイト検索に効くので短い方を採る
    title: base.title && add.title ? (base.title.length <= add.title.length ? base.title : add.title) : base.title || add.title,
    author: base.author ?? add.author,
    publisher: base.publisher ?? add.publisher,
    pubdate: base.pubdate ?? add.pubdate,
    coverUrl: base.coverUrl ?? add.coverUrl,
    // 定価は 楽天ブックス > openBD > その他 の優先順。同順位なら先に入った方を残す
    listPrice: addPrio > basePrio ? (add.listPrice ?? base.listPrice) : (base.listPrice ?? add.listPrice),
    via: base.via === add.via ? base.via : `${base.via}+${add.via}`,
  };
}

function mergeAll(groups: BookRef[][]): BookRef[] {
  const map = new Map<string, BookRef>();
  const order: string[] = [];
  for (const group of groups) {
    for (const b of group) {
      if (!b.title && !b.isbn13) continue;
      const key = mergeKey(b);
      const cur = map.get(key);
      if (cur) map.set(key, mergeBook(cur, b));
      else {
        map.set(key, b);
        order.push(key);
      }
    }
  }
  return order.map((k) => map.get(k)!).filter(Boolean);
}

/* ---------- 公開 API ---------- */

/**
 * キーワード（書名 or ISBN）から候補の書誌を返す。
 * ISBN 直指定なら openBD で 1 冊確定、そうでなければ NDL と楽天ブックスを並列で叩いて名寄せする。
 * 全滅しても空配列を返すだけで例外は投げない（検索UI全体を落とさないため）。
 */
export async function resolveBooks(keyword: string, env: Env, limit = 5): Promise<BookRef[]> {
  const kw = (keyword ?? "").trim();
  if (!kw) return [];
  const max = Math.max(1, limit);

  // 1) ISBN 直指定: openBD だけで書誌・書影・定価が揃う
  const direct = looksLikeIsbn(kw) ? normalizeIsbn(kw) : null;
  if (direct) {
    try {
      const books = await fetchOpenBd([direct]);
      if (books.length > 0) return books.slice(0, max);
    } catch {
      // openBD が落ちても ISBN だけは分かっているので、最低限の BookRef を返して中古検索は続行させる
    }
    return [
      {
        isbn13: direct,
        isbn10: isbn13to10(direct),
        title: direct,
        author: null,
        publisher: null,
        pubdate: null,
        coverUrl: null,
        listPrice: null,
        via: "isbn_input",
      },
    ];
  }

  // 2) キーワード: 逆引き(NDL)と定価源(楽天ブックス)を並列で
  const [ndl, rakuten] = await Promise.all([
    fetchNdl(kw, Math.max(10, max * 2)).catch(() => [] as BookRef[]),
    fetchRakutenBooks(kw, env, Math.max(10, max * 2)).catch(() => [] as BookRef[]),
  ]);

  // 楽天を先に置く: 定価と書影が揃っている方をマージの基準にしたい
  let merged = mergeAll([rakuten, ndl]);
  // ISBN が取れた本を優先（中古サイトを正確に叩けるのはこちらだけ）
  merged.sort((a, b) => Number(Boolean(b.isbn13)) - Number(Boolean(a.isbn13)));
  merged = merged.slice(0, max);

  // 3) 定価の穴埋め: ISBN はあるが価格が無い本だけ openBD に1回だけ問い合わせる
  const needPrice = merged.filter((b) => b.isbn13 && b.listPrice == null).map((b) => b.isbn13!);
  if (needPrice.length > 0) {
    try {
      const filled = await fetchOpenBd(needPrice);
      const byIsbn = new Map(filled.filter((b) => b.isbn13).map((b) => [b.isbn13!, b]));
      merged = merged.map((b) => (b.isbn13 && byIsbn.has(b.isbn13) ? mergeBook(b, byIsbn.get(b.isbn13)!) : b));
    } catch {
      // 定価が無くても gap ベースのランキングは動くので、ここは黙って諦める
    }
  }

  return merged;
}
