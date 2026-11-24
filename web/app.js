// DM Card DB — frontend (no build step). Talks to /api/*.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const thumb = (url) => (url ? url.replace("/cardimage/", "/cardthumb/") : null);

const state = { page: 1, view: "grid", meta: null, kw: [], lastResult: null };

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
  return body;
}

// ---------------------------------------------------------------- tabs
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "quality") loadQuality();
    if (b.dataset.tab === "help") renderHelp();
  }),
);

// ---------------------------------------------------------------- meta / form setup
async function loadMeta() {
  const meta = await api("/api/meta");
  state.meta = meta;
  $("#db-stats").textContent = `${meta.counts.cards.toLocaleString()} 種 / ${meta.counts.printings.toLocaleString()} 収録 / ${meta.counts.sets} 商品`;
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label ?? v)}</option>`;
  $("#dl-keywords").innerHTML =
    meta.families.map((f) => opt(f.name, `${f.name}（系統・${f.members}種）`)).join("") +
    meta.keywords.map((k) => opt(k.name, `${k.name}（${k.cardCount}）`)).join("");
  $("#dl-races").innerHTML = meta.races
    .slice(0, 2000)
    .map((r) => opt(r.race, `${r.race}（${r.cardCount}）`))
    .join("");
  $("#dl-sets").innerHTML = meta.sets.map((s) => opt(s.displayCode || s.code, s.label)).join("");
  $("#dl-illust").innerHTML = meta.illustrators.map((i) => opt(i.name, `${i.name}（${i.printingCount}）`)).join("");
  $("#f-type").innerHTML += meta.types
    .filter((t) => t.cardCount >= 3)
    .map((t) => opt(t.type, `${t.type}（${t.cardCount}）`))
    .join("");
  $("#f-rarity").innerHTML += meta.rarities.map((r) => opt(r.rarity, `${r.rarity}（${r.n}）`)).join("");
  $("#f-tags").innerHTML = meta.tags
    .map(
      (t) =>
        `<label title="${esc(t.description)}"><input type="checkbox" value="${esc(t.tag)}" />${esc(t.label)} <span class="muted">${t.cardCount}</span></label>`,
    )
    .join("");
  $$("#filters input, #filters select").forEach((el) => el.addEventListener("change", () => formToQuery(true)));
  $$("#filters input[type=text], #filters input[type=number]").forEach((el) =>
    el.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), formToQuery(true))),
  );
}

// ---------------------------------------------------------------- keyword chips
function renderKwChips() {
  $("#f-kw-chips").innerHTML = state.kw
    .map((k, i) => `<span class="chip">${esc(k)}<button type="button" data-i="${i}" aria-label="削除">×</button></span>`)
    .join("");
  $$("#f-kw-chips button").forEach((b) => b.addEventListener("click", () => (state.kw.splice(Number(b.dataset.i), 1), renderKwChips(), formToQuery(true))));
}
function addKw() {
  const v = $("#f-kw-input").value.trim();
  if (!v) return;
  state.kw.push(v);
  $("#f-kw-input").value = "";
  renderKwChips();
  formToQuery(true);
}
$("#f-kw-add").addEventListener("click", addKw);
$("#f-kw-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addKw();
  }
});

// ---------------------------------------------------------------- form -> query
const quote = (v) => (/[\s()"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
function group(parts, mode) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return mode === "or" ? `(${parts.join(" or ")})` : parts.join(" ");
}

function formToQuery(run) {
  const q = [];
  const val = (id) => $(id).value.trim();
  if (val("#f-name")) q.push(quote(val("#f-name")));
  if (val("#f-text")) q.push(`text:${quote(val("#f-text"))}`);

  const civs = $$("#f-civs input:checked").map((i) => i.value);
  const colorless = civs.includes("無色");
  const colored = civs.filter((c) => c !== "無色");
  const mode = $("#f-civ-mode").value;
  if (colored.length) {
    if (mode === "any")
      q.push(
        group(
          colored.map((c) => `c:${c}`),
          "or",
        ),
      );
    else q.push(`c${mode}${colored.join("")}`);
  }
  if (colorless && !(mode === "<=" && colored.length)) q.push("c:無色");
  if (val("#f-civ-count")) q.push(`c:${val("#f-civ-count")}`);

  const num = (field, min, max) => {
    const a = val(min),
      b = val(max);
    if (a && b && a === b) q.push(`${field}=${a}`);
    else {
      if (a) q.push(`${field}>=${a}`);
      if (b) q.push(`${field}<=${b}`);
    }
  };
  num("cost", "#f-cost-min", "#f-cost-max");
  num("pow", "#f-pow-min", "#f-pow-max");
  if (val("#f-type")) q.push(`type=${quote(val("#f-type"))}`);
  if (val("#f-race")) q.push(`race:${quote(val("#f-race"))}`);

  const kwField = $("#f-kw-always").checked ? "kwa" : "kw";
  const kwMode = $("input[name=f-kw-mode]:checked").value;
  q.push(
    group(
      state.kw.map((k) => `${kwField}:${quote(k)}`),
      kwMode,
    ),
  );

  const tags = $$("#f-tags input:checked").map((i) => `tag:${i.value}`);
  q.push(group(tags, $("input[name=f-tag-mode]:checked").value));

  if (val("#f-set")) q.push(`${$("#f-set-first").checked ? "first" : "set"}:${quote(val("#f-set"))}`);
  if (val("#f-illust")) q.push(`illust:${quote(val("#f-illust"))}`);
  if (val("#f-rarity")) q.push(`rarity:${val("#f-rarity")}`);
  if (val("#f-format")) q.push(`f:${val("#f-format")}`);
  if (val("#f-reg")) q.push(`reg:${val("#f-reg")}`);
  if (val("#f-is")) q.push(`is:${val("#f-is")}`);

  $("#q").value = q.filter(Boolean).join(" ");
  if (run) {
    state.page = 1;
    search();
  }
}

$("#reset").addEventListener("click", () => {
  $$("#filters input[type=text], #filters input[type=number]").forEach((i) => (i.value = ""));
  $$("#filters input[type=checkbox]").forEach((i) => (i.checked = false));
  $$("#filters select").forEach((s) => (s.selectedIndex = 0));
  state.kw = [];
  renderKwChips();
  formToQuery(true);
});

// ---------------------------------------------------------------- search
$("#query-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.page = 1;
  search();
});
["#unique", "#order", "#dir"].forEach((id) => $(id).addEventListener("change", () => ((state.page = 1), search())));
$$(".view-toggle button").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    $$(".view-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    if (state.lastResult) renderResults(state.lastResult);
  }),
);

async function search() {
  const params = new URLSearchParams({
    q: $("#q").value,
    page: String(state.page),
    pageSize: "60",
    unique: $("#unique").value,
    order: $("#order").value,
  });
  if ($("#dir").value) params.set("dir", $("#dir").value);
  history.replaceState(null, "", `?${params}`);
  $("#query-error").classList.add("hidden");
  try {
    const r = await api(`/api/search?${params}`);
    state.lastResult = r;
    renderResults(r);
  } catch (e) {
    $("#query-error").textContent = e.message;
    $("#query-error").classList.remove("hidden");
  }
}

function civBar(civs) {
  const list = civs.length ? civs : ["無色"];
  return `<div class="civbar">${list.map((c) => `<span class="cb-${esc(c)}"></span>`).join("")}</div>`;
}
function regBadge(c) {
  if (c.regulation === "premium") return `<span class="badge premium">プレ殿</span>`;
  if (c.regulation === "restricted") return `<span class="badge restricted">殿堂</span>`;
  return "";
}
function statLine(c) {
  return c.faces
    .map((f) => [f.type, f.costText && `コスト${f.costText}`, f.powerText && `パワー${f.powerText}`, f.races.join("/")].filter(Boolean).join(" · "))
    .join("  ／  ");
}

function renderResults(r) {
  $("#result-count").textContent = `${r.total.toLocaleString()} 件${r.unique === "prints" ? "（絵柄単位）" : ""}`;
  const box = $("#results");
  box.className = state.view === "grid" ? "grid" : "list";
  if (!r.items.length) {
    box.innerHTML = `<p class="muted">該当するカードはありません。</p>`;
  } else if (state.view === "grid") {
    box.innerHTML = r.items
      .map((c, i) => {
        const img = thumb(c.printing?.image ?? c.image);
        const sub = c.printing
          ? `${c.printing.setLabel?.split(" ")[0] ?? ""} ${c.printing.rarity ?? ""}`
          : `${c.civs.join("/") || "無色"} · ${c.minCost ?? "-"}`;
        return `<div class="card-tile ${c.layout === "twinpact" ? "" : ""}" data-i="${i}">
          <div class="img">${img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(c.name)}" />` : `<div class="noimg">${esc(c.name)}</div>`}</div>
          ${civBar(c.civs)}
          <div class="cap"><div class="nm">${esc(c.name)}</div><div class="muted">${esc(sub)} ${regBadge(c)}</div></div>
        </div>`;
      })
      .join("");
  } else {
    box.innerHTML = r.items
      .map((c, i) => {
        const img = thumb(c.printing?.image ?? c.image);
        const text = c.faces.map((f) => (c.faces.length > 1 ? `【${f.name}】\n` : "") + f.abilities.join("\n")).join("\n");
        return `<div class="list-item" data-i="${i}">
          <div>${img ? `<img loading="lazy" src="${esc(img)}" alt="" />` : ""}</div>
          <div><div class="nm">${esc(c.name)} ${regBadge(c)}</div>
          <div class="meta">${esc(c.civs.join("/") || "無色")} · ${esc(statLine(c))}${c.printing ? ` · ${esc(c.printing.setLabel ?? "")} ${esc(c.printing.number ?? "")} · ${esc(c.printing.illustrator ?? "")}` : ""}</div>
          <div class="txt">${esc(text)}</div></div>
        </div>`;
      })
      .join("");
  }
  $$("[data-i]", box).forEach((el) =>
    el.addEventListener("click", () => openCard(r.items[Number(el.dataset.i)].id, r.items[Number(el.dataset.i)].printing?.id)),
  );
  renderPager(r);
}

function renderPager(r) {
  const pages = Math.ceil(r.total / r.pageSize);
  if (pages <= 1) return ($("#pager").innerHTML = "");
  const cur = r.page;
  const nums = new Set([1, pages, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((p) => p >= 1 && p <= pages));
  const sorted = [...nums].sort((a, b) => a - b);
  let html = "";
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span class="muted">…</span>`;
    html += `<button data-p="${p}" class="${p === cur ? "active" : ""}">${p}</button>`;
    prev = p;
  }
  $("#pager").innerHTML = html;
  $$("#pager button").forEach((b) =>
    b.addEventListener("click", () => {
      state.page = Number(b.dataset.p);
      search();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }),
  );
}

// ---------------------------------------------------------------- card detail
const SCOPE_LABEL = { self: "", others: "付与" };
async function openCard(id, printingId) {
  const c = await api(`/api/card/${id}`);
  const sel = c.printings.find((p) => p.id === printingId) ?? c.printings[0];
  const tagLabel = Object.fromEntries((state.meta?.tags ?? []).map((t) => [t.tag, t.label]));
  const kwHtml = c.keywords
    .map((k) => {
      const v = k.value != null ? (k.value === null ? "" : k.value >= 1e9 || k.value === Infinity ? "∞" : `${k.value}`) : "";
      const cls = k.scope === "others" ? "others" : k.conditional ? "cond" : "";
      const title = k.scope === "others" ? "他のカードに与える" : k.conditional ? "条件付きで得る" : "常に持つ";
      return `<span class="kw ${cls}" title="${title}${k.valueText ? "：" + esc(k.valueText) : ""}" data-q="${esc(`${k.scope === "others" ? "grant" : "kw"}:${k.keyword}`)}">${esc(k.keyword)}${v ? ` ${esc(v)}` : ""}${k.scope === "others" ? "（付与）" : k.conditional ? "（条件）" : ""}</span>`;
    })
    .join("");
  const legal = (ok, label) => `<span class="badge ${ok ? "ok" : "no"}">${label}${ok ? "可" : "不可"}</span>`;
  const premium = c.regulation === "premium";
  $("#card-detail").innerHTML = `
    <div class="detail">
      <div>
        <div class="main-img">${sel?.image ? `<img id="main-img" src="${esc(sel.image)}" alt="${esc(c.name)}" />` : ""}</div>
        <div class="muted small" id="main-meta">${sel ? printingMeta(sel) : ""}</div>
      </div>
      <div>
        <h2>${esc(c.name)}</h2>
        <div>${regBadge(c)}${legal(c.legalOriginal && !premium, "オリジナル")}${legal(c.legalAdvance && !premium, "アドバンス")}
          <span class="badge">${esc({ main: "メインデッキ", hyperspatial: "超次元ゾーン", gr: "超GRゾーン" }[c.zone])}</span>
          ${c.deckLimit === null ? `<span class="badge">枚数制限なし</span>` : ""}
        </div>
        ${c.faces
          .map(
            (f) => `<div class="face">
            <h3>${esc(f.name)}</h3>
            <div class="stats">
              <div><b>種類</b>${esc(f.type)}</div><div><b>文明</b>${esc(f.civs.join("/") || "-")}</div>
              <div><b>コスト</b>${esc(f.costText || "-")}</div><div><b>パワー</b>${esc(f.powerText || "-")}</div>
              <div style="grid-column: 1 / -1"><b>種族</b>${esc(f.races.join(" / ") || "-")}</div>
            </div>
            <ul class="abilities">${f.abilities.map((a) => `<li>${esc(a)}</li>`).join("") || "<li class='muted'>（能力なし）</li>"}</ul>
          </div>`,
          )
          .join("")}
        <div class="section-title">キーワード能力（抽出）</div>
        <div class="kw-list">${kwHtml || `<span class="muted small">なし</span>`}</div>
        ${c.officialKeywords.length ? `<div class="muted small" style="margin-top:4px">公式の特殊能力分類: ${esc(c.officialKeywords.join(" / "))}</div>` : ""}
        <div class="section-title">効果タグ（推定）</div>
        <div class="kw-list">${c.tags.map((t) => `<span class="tagpill" data-q="tag:${esc(t)}">${esc(tagLabel[t] ?? t)}</span>`).join("") || `<span class="muted small">なし</span>`}</div>
        <div class="section-title">収録・絵柄（${c.printings.length}）</div>
        <div class="printings">${c.printings
          .map(
            (p) => `<div class="printing ${p.id === sel?.id ? "sel" : ""}" data-pid="${esc(p.id)}">
              ${p.image ? `<img loading="lazy" src="${esc(thumb(p.image))}" alt="" />` : ""}
              <div>${esc(p.setLabel?.split(" ")[0] ?? p.setCode ?? "")} ${esc(p.number ?? "")} <span class="muted">${esc(yearText(p))}</span></div>
              <div>${esc(p.rarity ?? "")} · ${esc(p.illustrator ?? "")}</div></div>`,
          )
          .join("")}</div>
        <div class="section-title">リンク</div>
        <div class="small">
          ${sel ? `<a href="https://dm.takaratomy.co.jp/card/detail/?id=${encodeURIComponent(sel.id)}" target="_blank" rel="noopener">公式カードページ</a>` : ""}
          ${c.qaUrl ? ` · <a href="${esc(c.qaUrl)}" target="_blank" rel="noopener">公式Q&amp;A</a>` : ""}
          · <a href="https://dmwiki.net/${encodeURIComponent(`《${c.name.replace(" / ", "／")}》`)}" target="_blank" rel="noopener">DMwiki</a>
        </div>
      </div>
    </div>`;
  $$("#card-detail .printing").forEach((el) =>
    el.addEventListener("click", () => {
      const p = c.printings.find((x) => x.id === el.dataset.pid);
      if (!p) return;
      $$("#card-detail .printing").forEach((x) => x.classList.toggle("sel", x === el));
      if ($("#main-img") && p.image) $("#main-img").src = p.image;
      $("#main-meta").innerHTML = printingMeta(p);
    }),
  );
  $$("#card-detail [data-q]").forEach((el) =>
    el.addEventListener("click", () => {
      $("#q").value = el.dataset.q;
      $("#card-dialog").close();
      state.page = 1;
      search();
    }),
  );
  $("#card-dialog").showModal();
}

const yearText = (p) => (p.releaseYear ? `${p.releaseYear}年${p.releaseEstimated ? "頃" : ""}` : "");
function printingMeta(p) {
  return `${esc(p.setLabel ?? p.setCode ?? "")} ${esc(yearText(p))}<br>${esc(p.number ?? "")} · ${esc(p.rarity ?? "")} · illust. ${esc(p.illustrator ?? "-")}${p.flavor ? `<br><i>${esc(p.flavor)}</i>` : ""}`;
}

// ---------------------------------------------------------------- deck
$("#deck-validate").addEventListener("click", async () => {
  const r = await api("/api/deck/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: $("#deck-format").value, text: $("#deck-text").value }),
  });
  const curve = Object.entries(r.costCurve).sort((a, b) => (parseInt(a[0]) || 99) - (parseInt(b[0]) || 99));
  const max = Math.max(1, ...curve.map((x) => x[1]));
  $("#deck-result").innerHTML = `
    <div class="panel">
      <div class="verdict ${r.valid ? "ok" : "ng"}">${r.valid ? "✓ 構築ルールOK" : "✗ 構築ルール違反あり"}（${r.format === "original" ? "オリジナル" : "アドバンス"}）</div>
      <div class="muted">メイン ${r.counts.main} / 超次元 ${r.counts.hyperspatial} / 超GR ${r.counts.gr}</div>
      ${r.problems.map((p) => `<div class="problem ${p.severity}">${esc(p.message)}</div>`).join("")}
    </div>
    <div class="panel"><strong>文明（メイン枚数）</strong><div>${
      Object.entries(r.civs)
        .map(([c, n]) => `<span class="badge">${esc(c)} ${n}</span>`)
        .join("") || "-"
    }</div></div>
    <div class="panel"><strong>コストカーブ</strong>
      <table class="data">${curve.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td><td><span class="bar" style="width:${(n / max) * 200}px"></span></td></tr>`).join("")}</table>
    </div>`;
});

// ---------------------------------------------------------------- quality
async function loadQuality() {
  const q = await api("/api/quality");
  const rows = q.keywordAgreement.filter((k) => k.official + k.parsed > 0).sort((a, b) => b.official - a.official);
  const tp = rows.reduce((s, k) => s + k.both, 0),
    o = rows.reduce((s, k) => s + k.official, 0),
    p = rows.reduce((s, k) => s + k.parsed, 0);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  $("#quality").innerHTML = `
    <div class="panel">
      <strong>キーワード抽出の精度（公式「特殊能力」検索との一致）</strong>
      <p class="muted small">公式サイトの特殊能力フィルタの結果を正解として、テキストから抽出したキーワード（自身が持つもの）と比較しています。</p>
      <p>適合率 <b>${o ? pct(tp / p) : "-"}</b> ／ 再現率 <b>${o ? pct(tp / o) : "-"}</b>（公式 ${o.toLocaleString()} 件・抽出 ${p.toLocaleString()} 件・一致 ${tp.toLocaleString()} 件）</p>
      <table class="data"><tr><th>キーワード</th><th class="num">公式</th><th class="num">抽出</th><th class="num">一致</th><th class="num">適合率</th><th class="num">再現率</th></tr>
      ${rows.map((k) => `<tr><td><a href="#" data-q="${esc(`okw:${k.keyword} -kw:${k.keyword}`)}" title="公式にあり抽出漏れのカードを検索">${esc(k.keyword)}</a></td><td class="num">${k.official}</td><td class="num">${k.parsed}</td><td class="num">${k.both}</td><td class="num">${pct(k.precision)}</td><td class="num">${pct(k.recall)}</td></tr>`).join("")}</table>
    </div>
    <div class="panel"><strong>データ品質の記録</strong>
      <table class="data">${q.issues.map((i) => `<tr><td>${esc(i.kind)}</td><td class="num">${i.n}</td></tr>`).join("")}</table>
    </div>`;
  $$("#quality [data-q]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      $("#q").value = a.dataset.q;
      $$(".tabs button")[0].click();
      search();
    }),
  );
}

// ---------------------------------------------------------------- help
function renderHelp() {
  const fields = state.meta?.fields ?? {};
  $("#help").innerHTML = `
    <div class="panel">
      <strong>クエリ構文</strong>
      <ul>
        <li>スペース区切りは AND。<code>or</code>（または <code>|</code>）で OR、<code>-</code> または <code>not</code> で否定、<code>( )</code> でグループ化。</li>
        <li>演算子: <code>:</code>（含む/一致） <code>=</code>（完全一致） <code>!=</code> <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code></li>
        <li>フィールドなしの語はカード名検索。空白を含む値は <code>"…"</code>、正規表現は <code>/…/</code>（name, text）。</li>
        <li>並び・単位: <code>order:cost</code> <code>dir:asc</code> <code>unique:prints</code></li>
      </ul>
      <strong>例</strong>
      <ul>
        <li><code>kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000</code></li>
        <li><code>kw:パワーアタッカー>=2000 -kw:スレイヤー</code></li>
        <li><code>kw:ジャストダイバー kw:S・トリガー</code>（AND） / <code>(kw:ジャストダイバー or kw:マッハファイター) c<=水闇</code></li>
        <li><code>kw:ブレイカー breaks>=3 cost<=6</code>（系統検索 + ブレイク数）</li>
        <li><code>grant:スピードアタッカー race:ドラゴン</code>（他に与える）</li>
        <li><code>tag:removal_destroy is:spell cost<=4 kw:S・トリガー f:original</code></li>
        <li><code>illust:Shishizaru unique:prints</code>（イラストレーターの全絵柄）</li>
        <li><code>set:DM26-RP1 rarity:SR</code></li>
      </ul>
    </div>
    <div class="panel"><table class="data help-table">
      <tr><th>フィールド</th><th>説明</th><th>例</th></tr>
      ${Object.entries(fields)
        .map(([, f]) => `<tr><td>${esc(f.names.join(", "))}</td><td>${esc(f.description)}</td><td><code>${esc(f.example)}</code></td></tr>`)
        .join("")}
    </table></div>`;
}

// ---------------------------------------------------------------- boot
(async function boot() {
  await loadMeta();
  const params = new URLSearchParams(location.search);
  if (params.has("q")) $("#q").value = params.get("q");
  if (params.get("unique")) $("#unique").value = params.get("unique");
  if (params.get("order")) $("#order").value = params.get("order");
  if (params.get("page")) state.page = Number(params.get("page")) || 1;
  search();
})();
