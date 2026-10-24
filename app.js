"use strict";

const SOURCE_ORDER = ["tsutatsu", "shitsugi", "taxanswer"];
const PAGE = 50;

const $ = (id) => document.getElementById(id);
const state = { q: "", sources: new Set(SOURCE_ORDER), category: "", scope: "all", shown: PAGE, open: new Set() };
let DB = null;
let records = [];
let results = [];

// 全角英数・全角ハイフン等を半角に寄せ、大文字小文字を同一視する
function norm(s) {
  return (s || "").normalize("NFKC").toLowerCase().replace(/[‐‑‒–—―−]/g, "-");
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function parseQuery(q) {
  const inc = [], exc = [];
  for (const t of norm(q).split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith("-") && !/^-\d/.test(t)) exc.push(t.slice(1));
    else inc.push(t);
  }
  return { inc, exc };
}

function catKey(r) { return r.source + "\u0000" + r.category; }

function search() {
  const { inc, exc } = parseQuery(state.q);
  const out = [];
  for (const r of records) {
    const hay = state.scope === "title" ? r._head : r._all;
    let ok = true, score = 0;
    for (const t of exc) if (r._all.includes(t)) { ok = false; break; }
    if (!ok) continue;
    for (const t of inc) {
      if (!hay.includes(t)) { ok = false; break; }
      if (r._num === t) score += 1000;
      else if (r._num.startsWith(t)) score += 200;
      if (r._title.includes(t)) score += 50;
      if (r._cat.includes(t)) score += 10;
      let i = -1, c = 0;
      while ((i = r._body.indexOf(t, i + 1)) !== -1 && c < 20) c++;
      score += c;
    }
    if (ok) out.push({ r, score });
  }
  if (inc.length) out.sort((a, b) => b.score - a.score || a.r._order - b.r._order);
  return out.map((x) => x.r);
}

function highlight(text, terms) {
  if (!terms.length) return esc(text);
  // norm() は長さを変えうるので、元の文字ごとに正規化して位置を対応付ける
  const map = [];
  let normed = "";
  for (let i = 0; i < text.length; i++) {
    const ch = norm(text[i]);
    for (let k = 0; k < ch.length; k++) map.push(i);
    normed += ch;
  }
  const marks = new Array(text.length + 1).fill(0);
  for (const t of terms) {
    let i = -1;
    while ((i = normed.indexOf(t, i + 1)) !== -1) {
      marks[map[i]] += 1;
      marks[map[i + t.length - 1] + 1] -= 1;
    }
  }
  let html = "", depth = 0, open = false;
  for (let i = 0; i < text.length; i++) {
    depth += marks[i];
    if (depth > 0 && !open) { html += "<mark>"; open = true; }
    if (depth <= 0 && open) { html += "</mark>"; open = false; }
    html += esc(text[i]);
  }
  if (open) html += "</mark>";
  return html;
}

function snippet(body, terms) {
  const flat = body.replace(/\n+/g, " ");
  if (!terms.length) return flat.slice(0, 140) + (flat.length > 140 ? "…" : "");
  const nf = norm(flat);
  let pos = -1;
  for (const t of terms) { const p = nf.indexOf(t); if (p !== -1 && (pos === -1 || p < pos)) pos = p; }
  if (pos === -1) return flat.slice(0, 140) + (flat.length > 140 ? "…" : "");
  const start = Math.max(0, pos - 50);
  return (start > 0 ? "…" : "") + flat.slice(start, start + 160) + (start + 160 < flat.length ? "…" : "");
}

function sourceUrl(r) {
  // 通達はページ内の該当番号へテキストフラグメントで移動（対応ブラウザのみ）
  if (r.source === "tsutatsu" && r.number) return r.url + "#:~:text=" + encodeURIComponent(r.number);
  return r.url;
}

function render() {
  const base = search();
  const { inc } = parseQuery(state.q);

  // 件数集計（出典は分野以外の条件、分野は出典条件込みで集計）
  const srcCount = {}, catCount = new Map();
  for (const r of base) {
    if (!state.category || catKey(r) === state.category) srcCount[r.source] = (srcCount[r.source] || 0) + 1;
    if (state.sources.has(r.source)) catCount.set(catKey(r), (catCount.get(catKey(r)) || 0) + 1);
  }
  results = base.filter((r) => state.sources.has(r.source) && (!state.category || catKey(r) === state.category));

  for (const s of SOURCE_ORDER) $("n-" + s).textContent = srcCount[s] || 0;

  const cl = $("catlist");
  cl.innerHTML = "";
  for (const [k, c] of DB.cats) {
    if (!state.sources.has(k.split("\u0000")[0])) continue;
    const n = catCount.get(k) || 0;
    if (!n && k !== state.category) continue;
    const li = document.createElement("li");
    li.className = k === state.category ? "on" : "";
    li.innerHTML = `<span class="badge ${c.source}">${esc(DB.sources[c.source].short)}</span><span>${esc(c.category)}</span><span class="n">${n}</span>`;
    li.onclick = () => { state.category = state.category === k ? "" : k; state.shown = PAGE; sync(); };
    cl.appendChild(li);
  }
  $("category").value = state.category;

  const total = results.length;
  $("status").textContent = state.q || state.category || state.sources.size < 3
    ? `${total.toLocaleString()} 件` + (state.q ? `（「${state.q}」）` : "")
    : `全 ${total.toLocaleString()} 件を収録`;

  const list = $("list");
  list.innerHTML = "";
  for (const r of results.slice(0, state.shown)) list.appendChild(card(r, inc));
  $("more").hidden = total <= state.shown;
  $("more").textContent = `さらに表示（残り ${(total - state.shown).toLocaleString()} 件）`;
}

function card(r, terms) {
  const li = document.createElement("li");
  li.className = "item";
  const open = state.open.has(r.id);
  const label = DB.sources[r.source].label;
  const num = r.source === "taxanswer" && r.number ? "No." + r.number : r.number;
  li.innerHTML = `
    <header>
      <span class="badge ${r.source}">${esc(label)}</span>
      ${num ? `<span class="num">${highlight(num, terms)}</span>` : ""}
      <span class="ttl">${highlight(r.title, terms)}</span>
      <span class="crumb">${esc(r.path.join(" › "))}</span>
    </header>
    ${open ? `<div class="full">${highlight(r.body, terms)}</div>` : `<p class="snip">${highlight(snippet(r.body, terms), terms)}</p>`}
    <div class="meta">
      <button type="button" class="toggle">${open ? "閉じる" : "全文を表示"}</button>
      <a href="${esc(sourceUrl(r))}" target="_blank" rel="noopener">原文（国税庁）↗</a>
      ${r.asof ? `<span class="asof">${esc(r.asof)}現在</span>` : ""}
    </div>`;
  const toggle = () => { open ? state.open.delete(r.id) : state.open.add(r.id); li.replaceWith(card(r, terms)); };
  li.querySelector("header").onclick = toggle;
  li.querySelector(".toggle").onclick = toggle;
  return li;
}

// ---- URL ハッシュとの同期（検索条件の共有用）
function sync() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.sources.size < 3) p.set("src", [...state.sources].join(","));
  if (state.category) p.set("cat", state.category.replace("\u0000", ":"));
  if (state.scope !== "all") p.set("scope", state.scope);
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  render();
}

function load() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get("q") || "";
  state.sources = new Set(p.get("src") ? p.get("src").split(",").filter((s) => SOURCE_ORDER.includes(s)) : SOURCE_ORDER);
  state.category = (p.get("cat") || "").replace(":", "\u0000");
  state.scope = p.get("scope") === "title" ? "title" : "all";
  $("q").value = state.q;
  document.querySelector(`input[name=scope][value=${state.scope}]`).checked = true;
  for (const s of SOURCE_ORDER) $("src-" + s).checked = state.sources.has(s);
}

async function init() {
  let data;
  try {
    const res = await fetch("data/hojin.json");
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (e) {
    $("status").textContent = "data/hojin.json を読み込めませんでした。scripts/fetch_nta.py でデータを生成し、HTTP サーバー経由で開いてください。";
    return;
  }
  const short = { tsutatsu: "通達", shitsugi: "質疑", taxanswer: "TA" };
  DB = { sources: {}, cats: new Map() };
  for (const s of SOURCE_ORDER) DB.sources[s] = { ...data.sources[s], short: short[s] };

  records = data.records.map((r, i) => {
    const head = [r.number, r.title, r.category, ...(r.path || [])].join(" ");
    const o = {
      ...r,
      path: r.path || [],
      _order: SOURCE_ORDER.indexOf(r.source) * 1e6 + i,
      _num: norm(r.number),
      _title: norm(r.title),
      _cat: norm((r.path || []).join(" ")),
      _body: norm(r.body),
      _head: norm(head),
    };
    o._all = o._head + "\n" + o._body;
    return o;
  });
  records.sort((a, b) => a._order - b._order);
  for (const r of records) if (!DB.cats.has(catKey(r))) DB.cats.set(catKey(r), { source: r.source, category: r.category });

  // 出典チェックボックス
  const box = $("sources");
  for (const s of SOURCE_ORDER) {
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" id="src-${s}" checked> <span class="badge ${s}">${esc(DB.sources[s].label)}</span><span class="n" id="n-${s}">0</span>`;
    box.appendChild(lab);
    lab.querySelector("input").onchange = (e) => {
      e.target.checked ? state.sources.add(s) : state.sources.delete(s);
      if (state.category && !state.sources.has(state.category.split("\u0000")[0])) state.category = "";
      state.shown = PAGE; sync();
    };
  }
  // 分野セレクト（出典ごとにグループ化）
  const sel = $("category");
  for (const s of SOURCE_ORDER) {
    const g = document.createElement("optgroup");
    g.label = DB.sources[s].label;
    for (const [k, c] of DB.cats) if (c.source === s) g.appendChild(new Option(c.category, k));
    sel.appendChild(g);
  }
  sel.onchange = () => {
    state.category = sel.value;
    if (state.category) state.sources.add(state.category.split("\u0000")[0]);
    for (const s of SOURCE_ORDER) $("src-" + s).checked = state.sources.has(s);
    state.shown = PAGE; sync();
  };

  let timer;
  $("q").oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $("q").value.trim(); state.shown = PAGE; sync(); }, 150); };
  $("clear").onclick = () => { $("q").value = ""; state.q = ""; state.shown = PAGE; sync(); $("q").focus(); };
  for (const el of document.querySelectorAll("input[name=scope]")) el.onchange = () => { state.scope = el.value; state.shown = PAGE; sync(); };
  $("more").onclick = () => { state.shown += PAGE; render(); };
  window.addEventListener("hashchange", () => { load(); render(); });

  const g = new Date(data.generated_at);
  $("generated").textContent = `データ取得日時：${g.toLocaleString("ja-JP")}`;
  load();
  render();
}

init();
