export type SourceId = "rakuten" | "yahoo_shopping" | "mercari";

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
