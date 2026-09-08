import type { SearchQuery } from "./types";

export interface DeepLink {
  id: string;
  label: string;
  url: string;
  note?: string;
}

const enc = encodeURIComponent;

/**
 * APIが無い / 公開されていないサイトへの「価格が安い順・中古」に設定済みリンクを組み立てる。
 * ここが本アプリのもう半分の価値: 検索窓に打ち直す手間とソート設定のクリックを全部潰す。
 */
export function buildDeepLinks(q: SearchQuery): DeepLink[] {
  const k = q.keyword.trim();
  if (!k) return [];
  const kw = enc(k);
  const priceMin = q.minPrice ?? "";
  const priceMax = q.maxPrice ?? "";

  const links: DeepLink[] = [
    {
      id: "mercari",
      label: "メルカリ",
      url: `https://jp.mercari.com/search?keyword=${kw}&sort=price&order=asc&status=on_sale${
        priceMin !== "" ? `&price_min=${priceMin}` : ""
      }${priceMax !== "" ? `&price_max=${priceMax}` : ""}`,
      note: "安い順・販売中のみ",
    },
    {
      id: "yahoo_furima",
      label: "Yahoo!フリマ",
      url: `https://paypayfleamarket.yahoo.co.jp/search/${kw}?open=1&sort=price&order=asc`,
      note: "安い順・売切れ除外",
    },
    {
      id: "rakuma",
      label: "楽天ラクマ",
      url: `https://fril.jp/s?query=${kw}&transaction=selling&order=asc&sort=price`,
      note: "安い順・販売中のみ",
    },
    {
      id: "yahoo_auction",
      label: "ヤフオク!",
      url: `https://auctions.yahoo.co.jp/search/search?p=${kw}&istatus=2&s1=cbids&o1=a&n=100`,
      note: "中古のみ・現在価格の安い順",
    },
    {
      id: "surugaya",
      label: "駿河屋",
      url: `https://www.suruga-ya.jp/search?category=&search_word=${kw}&restrict=0&searchbox=1`,
      note: "本・ゲーム・ホビーの中古在庫が厚い",
    },
    {
      id: "bookoff",
      label: "ブックオフオンライン",
      url: `https://shopping.bookoff.co.jp/search/keyword/${kw}`,
      note: "本・CD・DVDの中古",
    },
    {
      id: "kosho",
      label: "日本の古本屋",
      url: `https://www.kosho.or.jp/products/list.php?mode=search&search_word=${kw}`,
      note: "絶版・専門書はここが最強",
    },
    {
      id: "amazon_used",
      label: "Amazon（中古）",
      url: `https://www.amazon.co.jp/s?k=${kw}&rh=p_n_condition-type%3A2224372051&s=price-asc-rank`,
      note: "中古コンディション・安い順",
    },
    {
      id: "janpara",
      label: "じゃんぱら",
      url: `https://www.janpara.co.jp/sale/search/result/?KEYWORDS=${kw}&SORT=PRICE_ASC`,
      note: "スマホ・PCの中古",
    },
  ];
  return links;
}

/** APIで取得したソースについても「サイト上で続きを見る」導線を出す */
export function sourceWebUrl(source: string, q: SearchQuery): string {
  const kw = enc(q.keyword.trim());
  switch (source) {
    case "rakuten":
      return `https://search.rakuten.co.jp/search/mall/${kw}%20%E4%B8%AD%E5%8F%A4/?s=2`;
    case "yahoo_shopping":
      return `https://shopping.yahoo.co.jp/search?p=${kw}&used=1&sort=%2Bprice`;
    case "mercari":
      return `https://jp.mercari.com/search?keyword=${kw}&sort=price&order=asc&status=on_sale`;
    default:
      return "";
  }
}
