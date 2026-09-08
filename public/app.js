const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");

const state = { sources: [], selected: new Set(), data: null };

const SETUP_GUIDE = {
  rakuten: {
    name: "楽天市場",
    url: "https://webservice.rakuten.co.jp/",
    steps: [
      "上のリンクから楽天ウェブサービスを開き、楽天会員でログイン",
      "「アプリID発行」→ アプリ名（例: chuko-hunter）とアプリURL（例: http://localhost:8787）を入力して発行（無料・即時）",
      "発行された applicationId をコピー",
      "ターミナルで <code>npx wrangler secret put RAKUTEN_APP_ID</code>（ローカル開発なら .dev.vars に <code>RAKUTEN_APP_ID=xxxx</code>）",
    ],
  },
  yahoo_shopping: {
    name: "Yahoo!ショッピング",
    url: "https://e.developer.yahoo.co.jp/register",
    steps: [
      "上のリンクからYahoo!デベロッパーネットワークでアプリケーションを登録（Yahoo! JAPAN IDが必要・無料）",
      "「サーバーサイド（クライアント・クレデンシャル）」を選び、アプリケーション名とサイトURLを入力",
      "発行された Client ID（アプリケーションID）をコピー",
      "ターミナルで <code>npx wrangler secret put YAHOO_CLIENT_ID</code>（ローカル開発なら .dev.vars に <code>YAHOO_CLIENT_ID=xxxx</code>）",
    ],
  },
  mercari: {
    name: "メルカリ",
    url: null,
    steps: [
      "メルカリに公開APIは存在しません。既定では無効です。",
      "有効化すると Web版の内部エンドポイントを叩きます（利用規約上グレー・自己責任・予告なく壊れます）。",
      "承知の上で使う場合は wrangler.jsonc の <code>ENABLE_MERCARI</code> を <code>\"1\"</code> にして再デプロイ。",
      "無効のままでも、下の「ワンクリック横断」からメルカリの安い順ページは開けます。",
    ],
  },
};

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    state.sources = cfg.sources;
    for (const s of cfg.sources) if (s.available) state.selected.add(s.id);
    renderSourceToggles();
    renderSetup();
  } catch (e) {
    console.error(e);
  }
}

function renderSourceToggles() {
  const box = $("source-toggles");
  box.innerHTML = '<span class="muted" style="font-size:12px">API取得するサイト:</span>';
  for (const s of state.sources) {
    const el = document.createElement("label");
    el.className = "src-toggle" + (state.selected.has(s.id) ? "" : " off") + (s.available ? "" : " unavailable");
    el.innerHTML = `<span class="dot"></span>${s.label}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(s.id);
    cb.disabled = !s.available;
    cb.style.display = "none";
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(s.id);
      else state.selected.delete(s.id);
      el.classList.toggle("off", !cb.checked);
    });
    el.prepend(cb);
    el.addEventListener("click", (ev) => {
      if (ev.target !== cb && !s.available) ev.preventDefault();
    });
    box.appendChild(el);
  }
}

function renderSetup() {
  const missing = state.sources.filter((s) => !s.available);
  const box = $("setup");
  if (missing.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    `<h2>⚙ 未設定のデータ源が ${missing.length} 件あります（無料で取得できます）</h2>` +
    missing
      .map((s) => {
        const g = SETUP_GUIDE[s.id];
        if (!g) return "";
        const link = g.url ? ` — <a href="${g.url}" target="_blank" rel="noopener">${g.url}</a>` : "";
        return `<div style="margin-top:10px"><strong>${g.name}</strong>${link}<ol>${g.steps
          .map((x) => `<li>${x}</li>`)
          .join("")}</ol></div>`;
      })
      .join("");
}

function conditionClass(rank) {
  return rank ? `c${rank}` : "";
}

function renderStats(data) {
  const box = $("stats");
  const s = data.stats;
  box.hidden = false;
  const cards = [
    { k: "取得件数", v: String(s.total), sub: `${data.tookMs}ms${data.cached ? " (cache)" : ""}` },
    { k: "最安（実質）", v: s.min != null ? yen(s.min) : "—", hl: true },
    { k: "25%タイル", v: s.p25 != null ? yen(s.p25) : "—" },
    { k: "中央値", v: s.median != null ? yen(s.median) : "—" },
    { k: "最高", v: s.max != null ? yen(s.max) : "—" },
    {
      k: "最安 vs 中央値",
      v: s.dealGapPct != null ? `-${s.dealGapPct}%` : "—",
      sub: s.dealGapPct != null && s.dealGapPct >= 40 ? "相場より明確に安い" : "相場並み",
    },
  ];
  const lines = data.sources
    .map((src) => {
      let status;
      if (src.skipped) status = `<span class="skip">未設定/無効: ${src.skipped}</span>`;
      else if (src.error) status = `<span class="err">失敗: ${escapeHtml(src.error)}</span>`;
      else {
        const bs = s.bySource[src.source] || {};
        status = `${src.count}件（取得${src.fetched}・${src.tookMs}ms）／最安 ${
          bs.min != null ? yen(bs.min) : "—"
        }・中央値 ${bs.median != null ? yen(bs.median) : "—"}`;
      }
      const link = src.webUrl ? ` <a href="${src.webUrl}" target="_blank" rel="noopener">サイトで見る ↗</a>` : "";
      return `<div class="source-line"><span class="name">${src.sourceLabel}</span><span>${status}</span>${link}</div>`;
    })
    .join("");
  box.innerHTML =
    cards
      .map(
        (c) =>
          `<div class="stat"><div class="k">${c.k}</div><div class="v ${c.hl ? "hl" : ""}">${c.v}</div>${
            c.sub ? `<div class="sub">${c.sub}</div>` : ""
          }</div>`,
      )
      .join("") + `<div class="source-lines">${lines}</div>`;
}

function renderDeepLinks(links) {
  const box = $("deeplinks");
  const list = $("deeplink-list");
  if (!links.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  list.innerHTML = links
    .map(
      (l) =>
        `<a class="chip" href="${l.url}" target="_blank" rel="noopener">${l.label}<span class="note">${
          l.note || ""
        }</span></a>`,
    )
    .join("");
  $("open-all").onclick = () => {
    for (const id of ["mercari", "yahoo_furima", "rakuma", "yahoo_auction"]) {
      const l = links.find((x) => x.id === id);
      if (l) window.open(l.url, "_blank", "noopener");
    }
  };
}

function sortListings(listings, mode) {
  const copy = [...listings];
  const net = (l) => l.effectivePrice - (l.pointBack || 0);
  if (mode === "price") copy.sort((a, b) => a.price - b.price);
  else if (mode === "net") copy.sort((a, b) => net(a) - net(b));
  else if (mode === "condition")
    copy.sort((a, b) => (a.condition || 99) - (b.condition || 99) || a.effectivePrice - b.effectivePrice);
  else copy.sort((a, b) => a.effectivePrice - b.effectivePrice);
  return copy;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderResults() {
  if (!state.data) return;
  const listings = sortListings(state.data.listings, $("sort").value);
  const box = $("results");
  $("results-section").hidden = listings.length === 0;
  $("result-count").textContent = listings.length ? `${listings.length}件` : "";
  box.innerHTML = listings
    .map((l, i) => {
      const img = l.imageUrl
        ? `<img src="${escapeHtml(l.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="noimg">no image</div>`;
      const ship = l.shippingUnknown
        ? `<span class="warnship">送料不明</span>`
        : l.shipping === 0
          ? "送料込み"
          : `送料 ${yen(l.shipping)}`;
      const point = l.pointBack ? ` ・ P${l.pointBack.toLocaleString("ja-JP")}` : "";
      return `<a class="card ${i === 0 ? "best" : ""}" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">
        ${img}
        <div>
          <p class="title">${escapeHtml(l.title)}</p>
          <div class="meta">
            ${i === 0 ? '<span class="badge rank">最安</span>' : ""}
            <span class="badge src">${escapeHtml(l.sourceLabel)}</span>
            <span class="badge ${conditionClass(l.condition)}">${escapeHtml(l.conditionLabel)}</span>
            ${l.seller ? `<span>${escapeHtml(l.seller).slice(0, 28)}</span>` : ""}
          </div>
        </div>
        <div class="price">
          <div class="main">${yen(l.effectivePrice)}</div>
          <div class="sub">本体 ${yen(l.price)} ・ ${ship}${point}</div>
        </div>
      </a>`;
    })
    .join("");
}

async function runSearch(ev) {
  if (ev) ev.preventDefault();
  const keyword = $("q").value.trim();
  if (!keyword) return;

  const params = new URLSearchParams({ q: keyword, limit: $("limit").value, strict: $("strict").checked ? "1" : "0" });
  if ($("exclude").value.trim()) params.set("exclude", $("exclude").value.trim());
  if ($("minPrice").value) params.set("minPrice", $("minPrice").value);
  if ($("maxPrice").value) params.set("maxPrice", $("maxPrice").value);
  if ($("maxCondition").value !== "0") params.set("maxCondition", $("maxCondition").value);
  if (state.selected.size) params.set("sources", [...state.selected].join(","));

  history.replaceState(null, "", "?" + params.toString());
  $("submit").disabled = true;
  $("submit").textContent = "検索中…";
  $("empty").hidden = true;

  try {
    const res = await fetch("/api/search?" + params.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.data = data;
    renderStats(data);
    renderDeepLinks(data.deepLinks);
    renderResults();
    if (data.listings.length === 0) {
      $("results-section").hidden = true;
      $("empty").hidden = false;
      $("empty").innerHTML =
        "API経由の該当は0件でした。<br>「タイトル完全一致フィルタ」を外すか、キーワードを短くしてください。APIの無いフリマ系は上の横断ボタンから確認できます。";
    }
  } catch (e) {
    $("empty").hidden = false;
    $("empty").textContent = "検索に失敗しました: " + e.message;
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "検索";
  }
}

$("search-form").addEventListener("submit", runSearch);
$("sort").addEventListener("change", renderResults);

(async function init() {
  await loadConfig();
  const p = new URLSearchParams(location.search);
  if (p.get("q")) {
    $("q").value = p.get("q");
    if (p.get("exclude")) $("exclude").value = p.get("exclude");
    if (p.get("minPrice")) $("minPrice").value = p.get("minPrice");
    if (p.get("maxPrice")) $("maxPrice").value = p.get("maxPrice");
    if (p.get("maxCondition")) $("maxCondition").value = p.get("maxCondition");
    if (p.get("strict") === "0") $("strict").checked = false;
    runSearch();
  }
})();
