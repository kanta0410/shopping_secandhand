const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function metric(k, v, cls) {
  return `<div class="metric"><div class="k">${k}</div><div class="v ${cls || ""}">${v}</div></div>`;
}

function renderDeal(d, i) {
  const b = d.book || {};
  const cover = b.coverUrl
    ? `<img src="${esc(b.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="noimg">no cover</div>`;
  const best = d.best;

  const sourceLine = (d.sources || [])
    .map((s) => {
      if (s.skipped) return `${s.sourceLabel}: 無効`;
      if (s.error) return `<span class="err">${esc(s.sourceLabel)}: 失敗</span>`;
      return `${esc(s.sourceLabel)}: ${s.count}件`;
    })
    .join(" ／ ");

  const rows = (d.listings || [])
    .slice(0, 12)
    .map(
      (l) =>
        `<a class="deal-row" href="${esc(l.url)}" target="_blank" rel="noopener">
           <span class="p">${yen(l.effectivePrice)}</span>
           <span class="badge src">${esc(l.sourceLabel)}</span>
           <span class="badge ${l.condition ? "c" + l.condition : ""}">${esc(l.conditionLabel)}</span>
           <span class="t">${esc(l.title)}</span>
           ${l.shippingUnknown ? '<span class="badge" style="color:var(--warn)">送料不明</span>' : ""}
         </a>`,
    )
    .join("");

  return `<div class="deal ${i === 0 ? "top" : ""}">
    <div class="deal-head">
      ${cover}
      <div>
        <h3>${i + 1}. ${esc(b.title || "(書名不明)")}</h3>
        <p class="byline">${esc(b.author || "著者不明")}${b.publisher ? " ／ " + esc(b.publisher) : ""}${
          b.isbn13 ? " ／ ISBN " + esc(b.isbn13) : ""
        }${b.via ? ` <span class="muted">(書誌: ${esc(b.via)})</span>` : ""}</p>
        <div class="deal-metrics">
          ${metric("中古最安（実質）", best ? yen(best.effectivePrice) : "—", "hl")}
          ${metric("定価", b.listPrice ? yen(b.listPrice) : "—")}
          ${metric("割引率", d.discountPct != null ? `-${d.discountPct}%` : "—", d.discountPct >= 50 ? "good" : "")}
          ${metric("中央値", d.median != null ? yen(d.median) : "—")}
          ${metric("相場乖離", d.gapPct != null ? `-${d.gapPct}%` : "—", d.gapPct >= 40 ? "good" : "")}
          ${metric("出品数", String(d.supply ?? 0))}
        </div>
        <div class="srcline">${sourceLine || ""}</div>
      </div>
      <div class="score">
        <div class="n">${d.score != null ? d.score : "—"}</div>
        <div class="l">お得度</div>
      </div>
    </div>
    <button class="toggle" type="button">出品 ${d.supply ?? 0} 件を表示 ▾</button>
    <div class="deal-list">${rows || '<p class="muted">出品が取得できませんでした。</p>'}</div>
  </div>`;
}

async function run(ev) {
  if (ev) ev.preventDefault();
  const raw = $("titles").value.trim();
  if (!raw) return;
  const titles = raw
    .split(/[\n,、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (titles.length === 0) return;

  const params = new URLSearchParams({ q: titles.join("\n"), mode: $("mode").value, limit: $("limit").value });
  $("submit").disabled = true;
  $("submit").textContent = `検索中… (${titles.length}冊)`;
  $("empty").hidden = true;
  $("notice").hidden = true;
  $("ranking").innerHTML = "";

  try {
    const res = await fetch("/api/books?" + params.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const deals = data.deals || [];
    if (deals.length === 0) {
      $("empty").hidden = false;
      $("empty").textContent = "該当する中古在庫が見つかりませんでした。書名を短くするかISBNで指定してください。";
    } else {
      $("ranking").innerHTML = deals.map(renderDeal).join("");
      for (const btn of document.querySelectorAll(".toggle")) {
        btn.addEventListener("click", () => {
          const list = btn.nextElementSibling;
          const open = list.classList.toggle("open");
          btn.textContent = btn.textContent.replace(open ? "▾" : "▴", open ? "▴" : "▾");
        });
      }
    }
    if (data.warnings && data.warnings.length) {
      $("notice").hidden = false;
      $("notice").innerHTML =
        "<h2>⚠ 一部のデータ源で問題が出ています</h2><ul>" +
        data.warnings.map((w) => `<li>${esc(w)}</li>`).join("") +
        "</ul>";
    }
  } catch (e) {
    $("empty").hidden = false;
    $("empty").textContent = "失敗しました: " + e.message;
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "ランキング作成";
  }
}

$("book-form").addEventListener("submit", run);
