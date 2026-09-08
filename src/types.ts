export type SourceId =
  | "rakuten"
  | "yahoo_shopping"
  | "mercari"
  // 書籍モードのスクレイピング系。Listing を共通で扱えるよう SourceId 側を広げている
  | "surugaya"
  | "kosho"
  | "bookoff"
  | "rakuten_books";

/** 各サイトのコンディション表記を 6 段階に正規化したもの（数字が小さいほど良い） */
export type ConditionRank = 1 | 2 | 3 | 4 | 5 | 6 | 0;

export const CONDITION_LABEL: Record<ConditionRank, string> = {
  0: "不明",
  1: "新品・未使用",
  2: "未使用に近い",
  3: "目立った傷や汚れなし",
  4: "やや傷や汚れあり",
  5: "傷や汚れあり",
  6: "全体的に状態が悪い",
};

export interface Listing {
  id: string;
  source: SourceId;
  sourceLabel: string;
  title: string;
  url: string;
  imageUrl: string | null;
  /** 商品価格（円・税込） */
  price: number;
  /** 送料（円）。不明なら null */
  shipping: number | null;
  /** price + shipping。送料不明なら price と同値だが shippingUnknown が立つ */
  effectivePrice: number;
  shippingUnknown: boolean;
  condition: ConditionRank;
  conditionLabel: string;
  /** 出品者/ショップ名 */
  seller: string | null;
  /** ポイント還元など、実質価格を下げる情報（円換算） */
  pointBack: number | null;
  raw?: unknown;
}

export interface SourceResult {
  source: SourceId;
  sourceLabel: string;
  ok: boolean;
  /** 取得件数（フィルタ前） */
  fetched: number;
  /** 返却件数（フィルタ後） */
  count: number;
  tookMs: number;
  error?: string;
  /** 設定不足などで実行しなかった理由 */
  skipped?: string;
  /** そのサイトの検索結果ページ（価格昇順・中古）へのリンク */
  webUrl: string;
}

export interface SearchQuery {
  keyword: string;
  excludeKeyword: string;
  minPrice: number | null;
  maxPrice: number | null;
  /** これより状態が悪いものを除外（1..6）。0/未指定でフィルタなし */
  maxCondition: ConditionRank;
  sources: SourceId[];
  limitPerSource: number;
  /** タイトルに検索語が全部含まれるものだけ残す */
  strict: boolean;
}

export interface SearchResponse {
  query: SearchQuery;
  listings: Listing[];
  sources: SourceResult[];
  stats: {
    total: number;
    min: number | null;
    median: number | null;
    p25: number | null;
    max: number | null;
    /** 最安値が中央値より何%安いか */
    dealGapPct: number | null;
    bySource: Record<string, { count: number; min: number | null; median: number | null }>;
  };
  deepLinks: { id: string; label: string; url: string; note?: string }[];
  tookMs: number;
  cached: boolean;
}

export interface Env {
  ASSETS: Fetcher;
  RAKUTEN_APP_ID?: string;
  YAHOO_CLIENT_ID?: string;
  ENABLE_MERCARI?: string;
  CACHE_TTL_SECONDS?: string;
}

/* ===== 書籍モード（中古本の横断リサーチ／ランキング用） ===== */

/** 書名から解決した1冊の書誌。ISBNが取れると各中古サイトを正確に叩けるようになる */
export interface BookRef {
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  pubdate: string | null;
  coverUrl: string | null;
  /** 定価（円）。取れない場合 null。中古の「お得度」の分母になる */
  listPrice: number | null;
  /** 書誌の取得元（ndl / rakuten_books / openbd） */
  via: string;
}

/** 中古本1冊についての横断結果＋お得度スコア */
export interface BookDeal {
  book: BookRef;
  /** 実質価格が最安の出品 */
  best: Listing | null;
  listings: Listing[];
  /** 定価比の割引率(%)。定価不明なら null */
  discountPct: number | null;
  /** 出品数。供給の厚み＝値崩れしやすさの指標 */
  supply: number;
  /** 実質価格の中央値 */
  median: number | null;
  /** 最安が中央値からどれだけ乖離しているか(%)。取りこぼし出品を見つける指標 */
  gapPct: number | null;
  sources: SourceResult[];
}

/** 書籍系スクレイパ／APIが実装すべきインターフェース */
export interface BookProvider {
  id: string;
  label: string;
  /** ISBN もしくはキーワードで中古在庫を引く */
  search(input: { keyword: string; isbn?: string | null; limit: number }, env: Env): Promise<Listing[]>;
  /** 設定不足などで使えない理由。null なら利用可 */
  skipReason(env: Env): string | null;
  /** 診断用: 実際に叩くURL（probe が生HTMLを取るのに使う） */
  probeUrl(input: { keyword: string; isbn?: string | null }): string;
}
