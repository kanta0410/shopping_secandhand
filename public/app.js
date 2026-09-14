/* 中古ハンター — フロントエンド。依存なし。
 *
 * 設計の要点:
 *  - 「継続的に使える」の核はウォッチリスト。検索条件と最安値の履歴を localStorage に持ち、
 *    次に開いた時に前回からの差分を出す。サーバーに個人データを送らないのでキー不要・設定不要で動く。
 *  - 検索結果の絞り込みは全部クライアント側。再検索させない＝待たせないのが一番のUX改善。
 */

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------------- storage ---------------- */
const LS = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* プライベートモード等で書けないことがある。機能を落として続行する */
    }
  },
};
const K_WATCH = "chuko.watch.v1";
const K_RECENT = "chuko.recent.v1";

const state = {
  mode: "goods",
  sources: [],
  enabledSources: new Set(),
  data: null, // 直近の検索レスポンス
  hidden: new Set(), // クライアント側で非表示にしたソース
  lastQuery: null,
};

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------------- tabs ---------------- */
function showTab(name) {
  for (const el of document.querySelectorAll(".tab")) el.classList.toggle("active", el.dataset.tab === name);
  for (const id of ["find", "watch", "setup"]) $("tab-" + id).hidden = id !== name;
  if (name === "watch") renderWatch();
  if (name === "setup") renderSetup();
  location.hash = name === "find" ? "" : name;
}
for (const el of document.querySelectorAll(".tab")) el.addEventListener("click", () => showTab(el.dataset.tab));

/* ---------------- mode ---------------- */
for (const el of document.querySelectorAll(".mode")) {
  el.addEventListener("click", () => {
    state.mode = el.dataset.mode;
    for (const m of document.querySelectorAll(".mode")) m.classList.toggle("active", m === el);
    $("q").placeholder =
      state.mode === "books"
        ? "書名かISBN（例: 金持ち父さん / 9784478004555）"
        : "欲しいものを入力（例: RTX 3060 / iPhone 13）";
    $("advanced").hidden = state.mode === "books";
  });
}

/* ---------------- config ---------------- */
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    state.sources = cfg.sources || [];
    for (const s of state.sources) if (s.available) state.enabledSources.add(s.id);
  } catch {
    state.sources = [];
  }
  const missing = state.sources.filter((s) => !s.available);
  const hint = $("keyhint");
  if (missing.length && state.sources.length) {
    hint.hidden = false;
    hint.className = "callout warn";
    hint.innerHTML = `APIで直接取得できるサイトが <strong>${
      state.sources.length - missing.length
    }/${state.sources.length}</strong> です。キーが無くても<strong>ワンクリック横断は今すぐ使えます</strong>。
      <a href="#setup" id="tosetup">→ 設定で無料キーを取得する</a>`;
    $("tosetup").addEventListener("click", (e) => {
      e.preventDefault();
      showTab("setup");
    });
  } else {
    hint.hidden = true;
  }
}

/* ---------------- recent ---------------- */
function pushRecent(mode, keyword) {
  const list = LS.read(K_RECENT, []).filter((r) => !(r.mode === mode && r.keyword === keyword));
  list.unshift({ mode, keyword, t: Date.now() });
  LS.write(K_RECENT, list.slice(0, 12));
  renderRecent();
}
function renderRecent() {
  const list = LS.read(K_RECENT, []);
  const box = $("recent");
  box.hidden = list.length === 0;
  box.innerHTML = list
    .map(
      (r, i) =>
        `<button type="button" class="chip" data-i="${i}">${r.mode === "books" ? "📚" : "🛒"} ${esc(
          r.keyword,
        )}</button>`,
    )
    .join("");
  for (const b of box.querySelectorAll(".chip")) {
    b.addEventListener("click", () => {
      const r = list[Number(b.dataset.i)];
      $("q").value = r.keyword;
      document.querySelector(`.mode[data-mode="${r.mode}"]`).click();
      runSearch();
    });
  }
}

/* ---------------- watch ---------------- */
/** 画面に出ている検索結果から最安値と件数を取り出す（商品/本で構造が違うのを吸収する） */
function currentMinAndCount() {
  const data = state.data;
  if (!data) return { min: null, count: 0 };
  if (state.mode === "books") {
    const ls = (data.deals || []).flatMap((d) => d.listings || []);
    return { min: ls.length ? Math.min(...ls.map((l) => l.effectivePrice)) : null, count: ls.length };
  }
  return { min: data.stats?.min ?? null, count: (data.listings || []).length };
}

function watchKey(mode, keyword) {
  return `${mode}::${keyword.trim().toLowerCase()}`;
}
function getWatches() {
  return LS.read(K_WATCH, []);
}
function isWatched(mode, keyword) {
  return getWatches().some((w) => w.key === watchKey(mode, keyword));
}
/**
 * 検索するたびに最安値を履歴に足す。
 * 日付単位でまとめると「同じ日に何度も探す」使い方で値動きが見えなくなるので、
 * まとめる条件は「日付」ではなく「価格が前回と同じ」にしてある。
 * 価格が動いた瞬間に必ず新しい点が入るので、何回目の検索でも差分が出る。
 */
function recordPrice(mode, keyword, min, count) {
  const list = getWatches();
  const w = list.find((x) => x.key === watchKey(mode, keyword));
  if (!w || min == null) return;
  const last = w.history[w.history.length - 1];
  if (last && last.min === min) {
    last.t = Date.now();
    last.count = count;
  } else {
    w.history.push({ t: Date.now(), min, count });
    if (w.history.length > 60) w.history.shift();
  }
  w.lastCheck = Date.now();
  LS.write(K_WATCH, list);
}
function toggleWatch(mode, keyword, query) {
  const list = getWatches();
  const key = watchKey(mode, keyword);
  const idx = list.findIndex((w) => w.key === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    LS.write(K_WATCH, list);
    toast("ウォッチを解除しました");
  } else {
    list.unshift({ key, mode, keyword, query: query || {}, history: [], lastCheck: 0 });
    LS.write(K_WATCH, list);
    // 登録した瞬間の最安値を基準として記録する。これが無いと次の次の検索まで値動きが出ない
    const base = currentMinAndCount();
    if (base.min != null) recordPrice(mode, keyword, base.min, base.count);
    toast("★ ウォッチに追加しました");
  }
  updateWatchBadge();
  renderSummary();
}
/** 直近の記録が1つ前より安くなっているウォッチの数。開いた瞬間に「得しそう」が分かるのが狙い */
function countDrops() {
  return getWatches().filter((w) => {
    const h = w.history;
    return h.length > 1 && h[h.length - 1].min < h[h.length - 2].min;
  }).length;
}

function updateWatchBadge() {
  const n = getWatches().length;
  const drops = countDrops();
  const el = $("watch-count");
  el.hidden = n === 0;
  el.textContent = drops > 0 ? `🔥${drops}` : String(n);
}

function sparkline(history) {
  const pts = history.slice(-20).map((h) => h.min);
  if (pts.length < 2) return "";
  const w = 90, h = 22, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const d = pts
    .map((p, i) => `${(i / (pts.length - 1)) * w},${h - ((p - min) / span) * (h - 3) - 1.5}`)
    .join(" ");
  const down = pts[pts.length - 1] <= pts[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${d}" fill="none" stroke="${down ? "#3fb950" : "#f85149"}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function renderWatch() {
  const list = getWatches();
  $("watch-empty").hidden = list.length > 0;
  $("check-all").disabled = list.length === 0;

  const drops = countDrops();
  const banner = $("watch-drops");
  banner.hidden = drops === 0;
  if (drops > 0) banner.innerHTML = `🔥 <strong>${drops}件</strong>が前回より値下がりしています。今が買い時かもしれません。`;
  $("watch-list").innerHTML = list
    .map((w, i) => {
      const h = w.history;
      const cur = h.length ? h[h.length - 1] : null;
      const prev = h.length > 1 ? h[h.length - 2] : null;
      let delta = '<span class="delta flat">初回未取得</span>';
      let cls = "";
      if (cur && prev) {
        const d = cur.min - prev.min;
        const pct = prev.min > 0 ? Math.round((Math.abs(d) / prev.min) * 100) : 0;
        if (d < 0) {
          delta = `<span class="delta down">▼ ${yen(-d)} (-${pct}%)</span>`;
          cls = "down";
        } else if (d > 0) {
          delta = `<span class="delta up">▲ ${yen(d)} (+${pct}%)</span>`;
        } else {
          delta = '<span class="delta flat">変化なし</span>';
        }
      } else if (cur) {
        delta = '<span class="delta flat">基準を記録しました</span>';
      }
      const when = w.lastCheck ? new Date(w.lastCheck).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未チェック";
      return `<div class="witem ${cls}">
        <div class="wtop">
          <div>
            <div class="wname">${w.mode === "books" ? "📚" : "🛒"} ${esc(w.keyword)}<span class="m">${
              cur ? `${cur.count}件` : ""
            }</span></div>
            <div class="wmeta">
              ${sparkline(h)}
              <span>最終チェック ${when}</span>
              ${h.length > 1 ? `<span>記録 ${h.length} 回</span>` : ""}
            </div>
          </div>
          <div class="wprice">
            <span class="n">${cur ? yen(cur.min) : "—"}</span>
            ${delta}
          </div>
          <div class="wact">
            <button class="iconbtn" data-act="check" data-i="${i}">今すぐ確認</button>
            <button class="iconbtn" data-act="open" data-i="${i}">開く</button>
            <button class="iconbtn" data-act="del" data-i="${i}">削除</button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  for (const b of $("watch-list").querySelectorAll(".iconbtn")) {
    b.addEventListener("click", async () => {
      const w = getWatches()[Number(b.dataset.i)];
      if (!w) return;
      if (b.dataset.act === "del") {
        const list2 = getWatches().filter((x) => x.key !== w.key);
        LS.write(K_WATCH, list2);
        updateWatchBadge();
        renderWatch();
        toast("削除しました");
      } else if (b.dataset.act === "open") {
        $("q").value = w.keyword;
        document.querySelector(`.mode[data-mode="${w.mode}"]`).click();
        showTab("find");
        runSearch();
      } else {
        b.disabled = true;
        b.textContent = "確認中…";
        await checkOne(w);
        updateWatchBadge();
        renderWatch();
      }
    });
  }
}

/** ウォッチ1件ぶんを裏で検索して最安値だけ記録する（画面は切り替えない） */
async function checkOne(w) {
  try {
    const url = w.mode === "books" ? buildBooksUrl(w.keyword, w.query) : buildSearchUrl(w.keyword, w.query);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "失敗");
    let min = null, count = 0;
    if (w.mode === "books") {
      const ls = (data.deals || []).flatMap((d) => d.listings || []);
      count = ls.length;
      min = ls.length ? Math.min(...ls.map((l) => l.effectivePrice)) : null;
    } else {
      count = (data.listings || []).length;
      min = data.stats?.min ?? null;
    }
    recordPrice(w.mode, w.keyword, min, count);
    return true;
  } catch {
    return false;
  }
}

$("check-all").addEventListener("click", async () => {
  const list = getWatches();
  if (!list.length) return;
  const box = $("watch-progress");
  const bar = box.querySelector(".bar");
  const txt = box.querySelector(".ptxt");
  box.hidden = false;
  $("check-all").disabled = true;
  let done = 0, drops = 0;
  for (const w of list) {
    txt.textContent = `${done + 1} / ${list.length} 件目: ${w.keyword}`;
    const before = w.history.length ? w.history[w.history.length - 1].min : null;
    await checkOne(w);
    const after = getWatches().find((x) => x.key === w.key);
    const now = after?.history.length ? after.history[after.history.length - 1].min : null;
    if (before != null && now != null && now < before) drops++;
    done++;
    bar.style.width = `${(done / list.length) * 100}%`;
  }
  box.hidden = true;
  bar.style.width = "0";
  $("check-all").disabled = false;
  updateWatchBadge();
  renderWatch();
  toast(drops > 0 ? `🔥 ${drops}件が値下がりしています！` : "全部チェックしました（値下がりなし）");
});

/* ---------------- URL builders ---------------- */
function currentAdvanced() {
  return {
    exclude: $("exclude").value.trim(),
    minPrice: $("minPrice").value,
    maxPrice: $("maxPrice").value,
    maxCondition: $("maxCondition").value,
    limit: $("limit").value,
    strict: $("strict").checked ? "1" : "0",
  };
}
function buildSearchUrl(keyword, adv) {
  const a = adv || {};
  const p = new URLSearchParams({ q: keyword, limit: a.limit || "50", strict: a.strict ?? "1" });
  if (a.exclude) p.set("exclude", a.exclude);
  if (a.minPrice) p.set("minPrice", a.minPrice);
  if (a.maxPrice) p.set("maxPrice", a.maxPrice);
  if (a.maxCondition && a.maxCondition !== "0") p.set("maxCondition", a.maxCondition);
  if (state.enabledSources.size) p.set("sources", [...state.enabledSources].join(","));
  return "/api/search?" + p.toString();
}
function buildBooksUrl(keyword, adv) {
  const p = new URLSearchParams({ q: keyword, mode: "discount", limit: (adv && adv.limit) || "20" });
  return "/api/books?" + p.toString();
}

/* ---------------- search ---------------- */
async function runSearch(ev) {
  if (ev) ev.preventDefault();
  const keyword = $("q").value.trim();
  if (!keyword) return;

  const adv = currentAdvanced();
  state.lastQuery = { mode: state.mode, keyword, adv };
  state.hidden.clear();

  $("submit").disabled = true;
  $("submit").querySelector(".btn-label").textContent = "検索中…";
  $("skeleton").hidden = false;
  $("summary").hidden = true;
  $("refine").hidden = true;
  $("results").innerHTML = "";
  $("deals").innerHTML = "";
  $("empty").hidden = true;
  $("crosslinks").hidden = true;

  try {
    const url = state.mode === "books" ? buildBooksUrl(keyword, adv) : buildSearchUrl(keyword, adv);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.data = data;
    pushRecent(state.mode, keyword);

    if (state.mode === "books") renderBooks(data);
    else renderGoods(data);

    // ウォッチ済みなら今回の最安値を履歴に足す
    if (isWatched(state.mode, keyword)) {
      const { min, count } = currentMinAndCount();
      recordPrice(state.mode, keyword, min, count);
      updateWatchBadge();
    }
  } catch (e) {
    $("empty").hidden = false;
    $("empty").className = "callout warn";
    $("empty").textContent = "検索に失敗しました: " + e.message;
  } finally {
    $("skeleton").hidden = true;
    $("submit").disabled = false;
    $("submit").querySelector(".btn-label").textContent = "さがす";
  }
}

/* ---------------- render: goods ---------------- */
function renderGoods(data) {
  renderSummary();
  renderSourceFilter();
  renderCards();
  renderCrossLinks(data.deepLinks || []);
  if ((data.listings || []).length === 0) {
    $("empty").hidden = false;
    $("empty").className = "callout";
    $("empty").innerHTML =
      "API経由の該当は0件でした。「完全一致で絞る」を外すか、語を短くしてみてください。<br>APIの無いフリマ系は下のワンクリック横断から確認できます。";
  }
}

function renderSummary() {
  const data = state.data;
  if (!data || state.mode === "books") {
    if (state.mode === "books") return;
    return;
  }
  const s = data.stats || {};
  const kw = state.lastQuery?.keyword ?? "";
  const watched = isWatched("goods", kw);
  const hot = (s.dealGapPct ?? 0) >= 40;
  $("summary").hidden = false;
  $("summary").innerHTML = `
    <div class="sumtop">
      <div class="bigprice"><span class="n">${s.min != null ? yen(s.min) : "—"}</span><span class="l">最安（実質）</span></div>
      <div class="mini">
        <div>件数<b>${s.total ?? 0}</b></div>
        <div>25%タイル<b>${s.p25 != null ? yen(s.p25) : "—"}</b></div>
        <div>中央値<b>${s.median != null ? yen(s.median) : "—"}</b></div>
        <div>最高<b>${s.max != null ? yen(s.max) : "—"}</b></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="verdict ${hot ? "hot" : "mid"}">${
          s.dealGapPct != null ? (hot ? `🔥 相場より ${s.dealGapPct}% 安い` : `相場並み（-${s.dealGapPct}%）`) : "相場データ不足"
        }</span>
        <button type="button" class="iconbtn" id="watchbtn">${watched ? "★ ウォッチ中" : "☆ ウォッチする"}</button>
      </div>
    </div>
    <div class="srclines">${(data.sources || [])
      .map((src) => {
        let st;
        if (src.skipped) st = `<span class="skip">未設定 / 無効</span>`;
        else if (src.error) st = `<span class="err">失敗: ${esc(src.error).slice(0, 70)}</span>`;
        else st = `${src.count}件・${src.tookMs}ms`;
        return `<div class="srcline"><span class="nm">${esc(src.sourceLabel)}</span><span>${st}</span>${
          src.webUrl ? `<a href="${esc(src.webUrl)}" target="_blank" rel="noopener">サイトで見る ↗</a>` : ""
        }</div>`;
      })
      .join("")}</div>`;
  $("watchbtn").addEventListener("click", () => toggleWatch("goods", kw, state.lastQuery.adv));
}

function renderSourceFilter() {
  const data = state.data;
  const counts = {};
  for (const l of data.listings || []) counts[l.source] = (counts[l.source] || 0) + 1;
  const labels = {};
  for (const l of data.listings || []) labels[l.source] = l.sourceLabel;
  const ids = Object.keys(counts);
  $("refine").hidden = ids.length === 0;
  $("src-filter").innerHTML = ids
    .map(
      (id) =>
        `<button type="button" class="chip ${state.hidden.has(id) ? "off" : ""}" data-src="${esc(id)}">${esc(
          labels[id],
        )} <span class="sub">${counts[id]}</span></button>`,
    )
    .join("");
  for (const b of $("src-filter").querySelectorAll(".chip")) {
    b.addEventListener("click", () => {
      const id = b.dataset.src;
      if (state.hidden.has(id)) state.hidden.delete(id);
      else state.hidden.add(id);
      b.classList.toggle("off");
      renderCards();
    });
  }
}

function renderCards() {
  const data = state.data;
  if (!data) return;
  let ls = (data.listings || []).filter((l) => !state.hidden.has(l.source));
  if ($("only-shipping-included").checked) ls = ls.filter((l) => l.shipping === 0);

  const mode = $("sort").value;
  const net = (l) => l.effectivePrice - (l.pointBack || 0);
  if (mode === "price") ls.sort((a, b) => a.price - b.price);
  else if (mode === "net") ls.sort((a, b) => net(a) - net(b));
  else if (mode === "condition") ls.sort((a, b) => (a.condition || 99) - (b.condition || 99) || a.effectivePrice - b.effectivePrice);
  else ls.sort((a, b) => a.effectivePrice - b.effectivePrice);

  const median = data.stats?.median ?? null;
  $("results").innerHTML =
    `<div class="cards">` +
    ls
      .map((l, i) => {
        const fire = median && l.effectivePrice <= median * 0.6;
        const img = l.imageUrl
          ? `<img src="${esc(l.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'no image'}))" />`
          : `<div class="noimg">no image</div>`;
        const ship = l.shippingUnknown
          ? `<span class="w">送料不明</span>`
          : l.shipping === 0
            ? "送料込み"
            : `送料 ${yen(l.shipping)}`;
        return `<a class="card-l ${fire ? "fire" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener">
          ${img}
          <div>
            <p class="ttl">${esc(l.title)}</p>
            <div class="meta">
              ${i === 0 ? '<span class="badge rank">最安</span>' : ""}
              ${fire ? '<span class="badge fire">🔥 相場より安い</span>' : ""}
              <span class="badge src">${esc(l.sourceLabel)}</span>
              <span class="badge ${l.condition ? "c" + l.condition : ""}">${esc(l.conditionLabel)}</span>
              ${l.seller ? `<span>${esc(l.seller).slice(0, 24)}</span>` : ""}
            </div>
          </div>
          <div class="price">
            <div class="n">${yen(l.effectivePrice)}</div>
            <div class="s">本体 ${yen(l.price)} ・ ${ship}${l.pointBack ? ` ・ P${l.pointBack}` : ""}</div>
          </div>
        </a>`;
      })
      .join("") +
    `</div>`;
}

/* ---------------- render: books ---------------- */
function renderBooks(data) {
  const deals = data.deals || [];
  const kw = state.lastQuery?.keyword ?? "";
  const watched = isWatched("books", kw);
  const all = deals.flatMap((d) => d.listings || []);
  const min = all.length ? Math.min(...all.map((l) => l.effectivePrice)) : null;

  $("summary").hidden = false;
  $("summary").innerHTML = `<div class="sumtop">
      <div class="bigprice"><span class="n">${min != null ? yen(min) : "—"}</span><span class="l">中古の最安</span></div>
      <div class="mini"><div>冊数<b>${deals.length}</b></div><div>出品合計<b>${all.length}</b></div><div>所要<b>${
        data.tookMs ?? 0
      }ms</b></div></div>
      <button type="button" class="iconbtn" id="watchbtn">${watched ? "★ ウォッチ中" : "☆ ウォッチする"}</button>
    </div>
    ${
      (data.warnings || []).length
        ? `<div class="srclines">${data.warnings.map((w) => `<div class="srcline"><span class="err">${esc(w).slice(0, 110)}</span></div>`).join("")}</div>`
        : ""
    }`;
  $("watchbtn").addEventListener("click", () => toggleWatch("books", kw, state.lastQuery.adv));

  $("deals").innerHTML = deals
    .map((d, i) => {
      const b = d.book || {};
      const cover = b.coverUrl
        ? `<img src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'no cover'}))" />`
        : `<div class="noimg">no cover</div>`;
      const rows = (d.listings || [])
        .slice(0, 12)
        .map(
          (l) => `<a class="drow" href="${esc(l.url)}" target="_blank" rel="noopener">
            <span class="p">${yen(l.effectivePrice)}</span>
            <span class="badge src">${esc(l.sourceLabel)}</span>
            <span class="badge ${l.condition ? "c" + l.condition : ""}">${esc(l.conditionLabel)}</span>
            <span class="t">${esc(l.title)}</span></a>`,
        )
        .join("");
      return `<div class="deal ${i === 0 ? "top" : ""}">
        <div class="deal-head">
          ${cover}
          <div>
            <h3>${i + 1}. ${esc(b.title || "(書名不明)")}</h3>
            <p class="by">${esc(b.author || "著者不明")}${b.publisher ? " ／ " + esc(b.publisher) : ""}${
              b.isbn13 ? " ／ ISBN " + esc(b.isbn13) : ""
            }</p>
            <div class="dmetrics">
              <div><div class="k">中古最安</div><div class="v hl">${d.best ? yen(d.best.effectivePrice) : "—"}</div></div>
              <div><div class="k">新品価格</div><div class="v">${b.listPrice ? yen(b.listPrice) : "—"}</div></div>
              <div><div class="k">新品比</div><div class="v ${d.discountPct >= 50 ? "good" : ""}">${
                d.discountPct != null ? `-${d.discountPct}%` : "—"
              }</div></div>
              <div><div class="k">中央値</div><div class="v">${d.median != null ? yen(d.median) : "—"}</div></div>
              <div><div class="k">相場乖離</div><div class="v ${d.gapPct >= 40 ? "good" : ""}">${
                d.gapPct != null ? `-${d.gapPct}%` : "—"
              }</div></div>
              <div><div class="k">出品数</div><div class="v">${d.supply ?? 0}</div></div>
            </div>
          </div>
          <div class="score"><div class="n">${d.score ?? "—"}</div><div class="l">お得度</div></div>
        </div>
        <button class="toggle" type="button">出品 ${d.supply ?? 0} 件 ▾</button>
        <div class="deal-list">${rows || '<p class="muted">出品が取得できませんでした。</p>'}</div>
      </div>`;
    })
    .join("");

  for (const btn of $("deals").querySelectorAll(".toggle")) {
    btn.addEventListener("click", () => {
      const open = btn.nextElementSibling.classList.toggle("open");
      btn.textContent = btn.textContent.replace(open ? "▾" : "▴", open ? "▴" : "▾");
    });
  }

  if (deals.length === 0) {
    $("empty").hidden = false;
    $("empty").className = "callout";
    $("empty").textContent = "中古在庫が見つかりませんでした。書名を短くするか、ISBNで指定してみてください。";
  }
  // 本モードでも横断リンクは出す（ブックオフ実店舗系はAPIが無いため）
  renderCrossLinks(booksCrossLinks(kw));
}

function booksCrossLinks(kw) {
  const k = encodeURIComponent(kw);
  return [
    { id: "mercari", label: "メルカリ", url: `https://jp.mercari.com/search?keyword=${k}&sort=price&order=asc&status=on_sale`, note: "安い順" },
    { id: "yahoo_furima", label: "Yahoo!フリマ", url: `https://paypayfleamarket.yahoo.co.jp/search/${k}?open=1&sort=price&order=asc`, note: "安い順" },
    { id: "rakuma", label: "楽天ラクマ", url: `https://fril.jp/s?query=${k}&transaction=selling&order=asc&sort=price`, note: "安い順" },
    { id: "yahoo_auction", label: "ヤフオク!", url: `https://auctions.yahoo.co.jp/search/search?p=${k}&istatus=2&s1=cbids&o1=a`, note: "中古・安い順" },
    { id: "kosho", label: "日本の古本屋", url: `https://www.kosho.or.jp/products/list.php?mode=search&search_word=${k}`, note: "絶版に強い" },
    { id: "surugaya", label: "駿河屋", url: `https://www.suruga-ya.jp/search?category=&search_word=${k}&searchbox=1`, note: "在庫が厚い" },
  ];
}

function renderCrossLinks(links) {
  if (!links || !links.length) {
    $("crosslinks").hidden = true;
    return;
  }
  $("crosslinks").hidden = false;
  $("crosslink-list").innerHTML = links
    .map(
      (l) =>
        `<a class="chip link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}<span class="sub">${esc(
          l.note || "",
        )}</span></a>`,
    )
    .join("");
  $("open-all").onclick = () => {
    for (const id of ["mercari", "yahoo_furima", "rakuma", "yahoo_auction"]) {
      const l = links.find((x) => x.id === id);
      if (l) window.open(l.url, "_blank", "noopener");
    }
  };
}

/* ---------------- setup ---------------- */
const GUIDE = {
  rakuten: {
    name: "楽天市場",
    url: "https://webservice.rakuten.co.jp/",
    steps: [
      "上のリンクを開いて楽天会員でログイン",
      "「アプリID発行」→ アプリ名（例: chuko-hunter）とURL（例: http://localhost:8787）を入力して発行（無料・即時）",
      "発行された applicationId をコピー",
      "<code>npx wrangler secret put RAKUTEN_APP_ID</code>（ローカルなら .dev.vars に <code>RAKUTEN_APP_ID=xxxx</code>）",
    ],
  },
  yahoo_shopping: {
    name: "Yahoo!ショッピング",
    url: "https://e.developer.yahoo.co.jp/register",
    steps: [
      "上のリンクからYahoo!デベロッパーネットワークに登録（無料）",
      "「サーバーサイド（クライアント・クレデンシャル）」を選択",
      "発行された Client ID をコピー",
      "<code>npx wrangler secret put YAHOO_CLIENT_ID</code>（ローカルなら .dev.vars に <code>YAHOO_CLIENT_ID=xxxx</code>）",
    ],
  },
  mercari: {
    name: "メルカリ",
    url: null,
    steps: [
      "公開APIが存在しないため、既定では無効です。",
      "有効化するとWeb版の内部エンドポイントを叩きます（規約グレー・自己責任・予告なく壊れます）。",
      "承知の上なら wrangler.jsonc の <code>ENABLE_MERCARI</code> を <code>\"1\"</code> にして再デプロイ。",
      "無効のままでも、ワンクリック横断からメルカリの安い順は開けます。",
    ],
  },
};

function renderSetup() {
  $("source-status").innerHTML = state.sources.length
    ? state.sources
        .map(
          (s) =>
            `<div class="srow"><span class="dot ${s.available ? "on" : "off"}"></span><strong>${esc(
              s.label,
            )}</strong>${s.available ? '<span class="why">利用可</span>' : `<span class="why">${esc(s.reason || "未設定")}</span>`}</div>`,
        )
        .join("")
    : '<p class="muted">状態を取得できませんでした。</p>';

  const missing = state.sources.filter((s) => !s.available);
  $("setup-guide").innerHTML = missing.length
    ? `<h2>無料キーの取り方</h2><div class="guide">${missing
        .map((s) => {
          const g = GUIDE[s.id];
          if (!g) return "";
          return `<h3>${g.name}${g.url ? ` — <a href="${g.url}" target="_blank" rel="noopener">${g.url}</a>` : ""}</h3>
            <ol>${g.steps.map((x) => `<li>${x}</li>`).join("")}</ol>`;
        })
        .join("")}</div>`
    : "<h2>データ源</h2><p class=\"muted\">すべて設定済みです。</p>";
}

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ watch: getWatches(), recent: LS.read(K_RECENT, []) }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chuko-hunter-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("import").addEventListener("click", () => $("importfile").click());
$("importfile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (Array.isArray(j.watch)) LS.write(K_WATCH, j.watch);
    if (Array.isArray(j.recent)) LS.write(K_RECENT, j.recent);
    updateWatchBadge();
    renderRecent();
    toast("インポートしました");
  } catch {
    toast("読み込めませんでした");
  }
  e.target.value = "";
});
$("wipe").addEventListener("click", () => {
  if (!confirm("ウォッチリストと検索履歴を全部消します。よろしいですか？")) return;
  LS.write(K_WATCH, []);
  LS.write(K_RECENT, []);
  updateWatchBadge();
  renderRecent();
  renderWatch();
  toast("消去しました");
});

/* ---------------- events ---------------- */
$("search-form").addEventListener("submit", runSearch);
$("sort").addEventListener("change", renderCards);
$("only-shipping-included").addEventListener("change", renderCards);
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) {
    e.preventDefault();
    $("q").focus();
    $("q").select();
  }
});

/* ---------------- init ---------------- */
(async function init() {
  updateWatchBadge();
  renderRecent();
  await loadConfig();

  if (location.hash === "#watch") showTab("watch");
  else if (location.hash === "#setup") showTab("setup");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
