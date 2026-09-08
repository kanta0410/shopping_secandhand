/**
 * HTML から情報を取り出すための最小限のユーティリティ群。
 *
 * なぜ DOM パーサを使わないか:
 *   Cloudflare Workers には document / DOMParser が無く jsdom も動かない。
 *   HTMLRewriter はストリーム変換専用で「取得済み文字列への問い合わせ」には向かないため、
 *   正規表現ベースの軽量スキャナを自前で持つ。
 *
 * なぜ自前のミニセレクタか:
 *   中古サイトの DOM は予告なく変わる。改修時に「セレクタ定数へ候補を1行足すだけ」で復旧できるよう、
 *   CSS ライクな文字列（.foo / #bar / div.foo / [class*="price"] / [itemprop="price"]）を
 *   そのまま渡せる形にしてある。完全な CSS 実装ではない（子孫結合子・擬似クラスは非対応）。
 */

/** 内容を持たないタグ。閉じタグを深さ数えで探す際にズレる原因になるので除外する */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  yen: "¥", middot: "・", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
};

/** HTML エンティティ（名前つき／10進／16進）をデコードする */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit ?? whole;
  });
}

/** タグ・script・style を落として本文テキストだけにする。エンティティもデコード済み */
export function stripTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/　/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 全角英数記号を半角へ。価格を全角で書くサイトがあるため必須 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

/**
 * "￥1,280" / "1,280円" / "1280 円(税込)" / "中古：￥1,280" などから金額を取り出す。
 * ポイント数やレビュー件数を価格と誤認しないよう、価格要素に絞ってから渡すこと。
 */
export function parseYen(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = toHalfWidth(decodeEntities(s)).replace(/\s/g, "");
  // 日本円に小数は無いので、桁区切りつき整数だけを見る
  const m = t.match(/(\d{1,3}(?:,\d{3})+|\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** 相対URL・プロトコル相対URLを絶対URLにする。失敗しても例外は投げない */
export function absolutize(href: string, base: string): string {
  const h = decodeEntities((href ?? "").trim());
  if (!h) return "";
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

/** 候補パターンを順に試し、最初にヒットしたキャプチャ1（無ければマッチ全体）を返す */
export function pickFirst(html: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    // /g 付き正規表現は lastIndex を持ち回って取りこぼすので、毎回作り直す
    const re = new RegExp(p.source, p.flags.replace(/g/g, ""));
    const m = html.match(re);
    if (m) {
      const v = m[1] ?? m[0];
      if (v && v.trim()) return v;
    }
  }
  return null;
}

/** 開始タグの属性文字列から属性値を取り出す */
export function getAttr(attrs: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)${esc}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrs.match(re);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

interface SelectorParts {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; op: string; value: string }[];
}

function parseSelector(sel: string): SelectorParts {
  const parts: SelectorParts = { tag: null, id: null, classes: [], attrs: [] };
  let rest = sel.trim();
  const tagM = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagM) {
    parts.tag = tagM[0].toLowerCase();
    rest = rest.slice(tagM[0].length);
  }
  const tokenRe =
    /\.([\w-]+)|#([\w-]+)|\[\s*([\w:-]+)\s*(?:([*^$~]?=)\s*"([^"]*)"|([*^$~]?=)\s*'([^']*)'|([*^$~]?=)\s*([^\]\s]+))?\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(rest)) !== null) {
    if (m[1]) parts.classes.push(m[1]);
    else if (m[2]) parts.id = m[2];
    else if (m[3]) {
      parts.attrs.push({ name: m[3], op: m[4] ?? m[6] ?? m[8] ?? "", value: m[5] ?? m[7] ?? m[9] ?? "" });
    }
  }
  return parts;
}

function attrMatches(actual: string | null, op: string, expected: string): boolean {
  if (actual === null) return false;
  if (op === "") return true;
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  switch (op) {
    case "=":
      return a === e;
    case "*=":
      return a.includes(e);
    case "^=":
      return a.startsWith(e);
    case "$=":
      return a.endsWith(e);
    case "~=":
      return a.split(/\s+/).includes(e);
    default:
      return false;
  }
}

export interface FoundElement {
  tag: string;
  /** 開始タグの属性部分 */
  attrs: string;
  /** 開始タグと終了タグの間 */
  inner: string;
  /** 開始タグを含む要素全体 */
  outer: string;
  index: number;
}

const OPEN_TAG_SRC = '<([a-zA-Z][\\w:-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>';

/** 開始タグ位置から、同名タグの入れ子を数えつつ閉じ位置を探す */
function findInner(html: string, tag: string, afterOpen: number): { inner: string; end: number } {
  if (VOID_TAGS.has(tag)) return { inner: "", end: afterOpen };
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<(/?)${esc}\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, "gi");
  re.lastIndex = afterOpen;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === "/") {
      depth -= 1;
      if (depth === 0) return { inner: html.slice(afterOpen, m.index), end: re.lastIndex };
    } else if (!/\/\s*$/.test(m[2] ?? "")) {
      depth += 1;
    }
  }
  // 閉じタグが無い壊れた HTML でも、そこまでの内容は使いたいので末尾までを返す
  return { inner: html.slice(afterOpen), end: html.length };
}

/** CSS ライクなセレクタ1本にマッチする要素を列挙する（子孫結合子は非対応） */
export function findElements(html: string, selector: string, limit = 200): FoundElement[] {
  const p = parseSelector(selector);
  const out: FoundElement[] = [];
  const re = new RegExp(OPEN_TAG_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    if (p.tag && p.tag !== tag) continue;
    if (p.id && getAttr(attrs, "id") !== p.id) continue;
    if (p.classes.length > 0) {
      const cls = (getAttr(attrs, "class") ?? "").split(/\s+/);
      if (!p.classes.every((c) => cls.includes(c))) continue;
    }
    if (!p.attrs.every((a) => attrMatches(getAttr(attrs, a.name), a.op, a.value))) continue;
    const afterOpen = m.index + m[0].length;
    const { inner, end } = findInner(html, tag, afterOpen);
    out.push({ tag, attrs, inner, outer: html.slice(m.index, end), index: m.index });
  }
  return out;
}

/** 候補セレクタを順に試し、最初に要素が取れたものを返す。改修時はここに候補を足すだけで直る */
export function findAllByCandidates(html: string, selectors: readonly string[], limit = 200): FoundElement[] {
  for (const sel of selectors) {
    const hits = findElements(html, sel, limit);
    if (hits.length > 0) return hits;
  }
  return [];
}

/** 候補セレクタのどれかで最初に取れたテキスト */
export function queryText(html: string, selectors: readonly string[]): string | null {
  for (const sel of selectors) {
    for (const el of findElements(html, sel, 5)) {
      const t = stripTags(el.inner);
      if (t) return t;
    }
  }
  return null;
}

/** 候補セレクタのどれかで最初に取れた属性値 */
export function queryAttr(html: string, selectors: readonly string[], attrName: string): string | null {
  for (const sel of selectors) {
    for (const el of findElements(html, sel, 5)) {
      const v = getAttr(el.attrs, attrName);
      if (v && v.trim()) return v.trim();
    }
  }
  return null;
}

/** <script type="application/ld+json"> を全部拾って JSON.parse する。壊れたブロックは黙って捨てる */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const type = getAttr(m[1] ?? "", "type") ?? "";
    if (!/ld\+json/i.test(type)) continue;
    let body = (m[2] ?? "").trim();
    body = body
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "")
      .replace(/^<!--/, "")
      .replace(/-->$/, "")
      .trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
      continue;
    } catch {
      /* 下の修復に進む */
    }
    // 生の制御文字や末尾カンマを混ぜてくるサイトがあるので、軽い修復を1回だけ試す
    try {
      out.push(JSON.parse(body.replace(/,\s*([}\]])/g, "$1").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")));
    } catch {
      /* 1ブロック壊れても他は使いたいので握り潰す */
    }
  }
  return out;
}

export const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; chuko-hunter/0.1; +https://github.com/kanta0410/shopping_secandhand)",
  "Accept-Language": "ja,en;q=0.8",
  Accept: "text/html,application/xhtml+xml",
};

/**
 * スクレイパ共通の取得処理。
 * エラーにサイト名とステータスを必ず含めるのは、部分成功時に「どこがコケたか」を利用者へ正直に見せるため。
 */
export async function fetchHtml(url: string, siteLabel: string, timeoutMs = 8000): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${siteLabel} 取得失敗: ${msg}`);
  }
  if (!res.ok) throw new Error(`${siteLabel} HTTP ${res.status}`);
  return await res.text();
}
