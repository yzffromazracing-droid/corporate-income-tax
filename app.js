(function () {
  "use strict";

  var PAGE_SIZE = 50;
  // 出典の内部名 → 画面上の種別コード・表示名
  var TYPES = {
    tsu: { source: "tsutatsu", label: "法人税基本通達", short: "基本通達" },
    so: { source: "sochiho", label: "措置法通達", short: "措置法通達" },
    ta: { source: "taxanswer", label: "タックスアンサー", short: "タックスアンサー" },
    qa: { source: "shitsugi", label: "質疑応答事例", short: "質疑応答事例" },
    bk: { source: "bunsho", label: "文書回答事例", short: "文書回答事例" },
  };
  var TYPE_OF = { tsutatsu: "tsu", sochiho: "so", taxanswer: "ta", shitsugi: "qa", bunsho: "bk" };
  var TABS = ["dict", "tsu", "nta"];
  // サブタブのあるタブ（先頭が既定）
  var SUBS = { tsu: ["kihon", "so"], nta: ["ta", "qa", "bk"] };

  var ARTICLES = [];

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "html") node.innerHTML = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- 検索 ---------- */

  // 全角英数・全角ハイフン等を半角に寄せ、大文字小文字を同一視する
  function norm(s) {
    return (s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‐‑‒–—―−]/g, "-");
  }

  function parseQuery(q) {
    var inc = [];
    var exc = [];
    norm(q)
      .split(/\s+/)
      .filter(Boolean)
      .forEach(function (t) {
        if (t.length > 1 && t.charAt(0) === "-" && !/^-\d/.test(t)) exc.push(t.slice(1));
        else inc.push(t);
      });
    return { inc: inc, exc: exc };
  }

  function blocksText(blocks) {
    return blocks
      .map(function (b) {
        if (b[0] === "t") {
          return b[1]
            .map(function (row) {
              return row
                .map(function (c) {
                  return c.x;
                })
                .join(" ");
            })
            .join("\n");
        }
        return b[b.length - 1];
      })
      .join("\n");
  }

  function searchArticles(list, q, filter) {
    var query = parseQuery(q);
    var out = [];
    list.forEach(function (a) {
      if (filter.type && a.type !== filter.type) return;
      if (filter.category && a.category !== filter.category) return;
      if (filter.cls && a.cls !== filter.cls) return;
      if (filter.topic && a.topic !== filter.topic) return;
      var score = 0;
      for (var i = 0; i < query.exc.length; i++) if (a.norm.indexOf(query.exc[i]) !== -1) return;
      for (var j = 0; j < query.inc.length; j++) {
        var t = query.inc[j];
        if (a.norm.indexOf(t) === -1) return;
        if (a.noNorm === t) score += 1000;
        else if (a.noNorm.indexOf(t) === 0) score += 200;
        if (a.titleNorm.indexOf(t) !== -1) score += 50;
        if (a.pathNorm.indexOf(t) !== -1) score += 10;
        var p = -1;
        var c = 0;
        while ((p = a.bodyNorm.indexOf(t, p + 1)) !== -1 && c < 20) c++;
        score += c;
      }
      out.push({ a: a, score: score });
    });
    if (query.inc.length) {
      out.sort(function (x, y) {
        return y.score - x.score || x.a.order - y.a.order;
      });
    }
    return out.map(function (x) {
      return x.a;
    });
  }

  // 検索語を <mark> で強調した HTML を返す（正規化前後の文字位置を対応付けて強調する）
  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    var map = [];
    var normed = "";
    for (var i = 0; i < text.length; i++) {
      var ch = norm(text.charAt(i));
      for (var k = 0; k < ch.length; k++) map.push(i);
      normed += ch;
    }
    var marks = new Array(text.length + 1).fill(0);
    terms.forEach(function (t) {
      var p = -1;
      while ((p = normed.indexOf(t, p + 1)) !== -1) {
        marks[map[p]] += 1;
        marks[map[p + t.length - 1] + 1] -= 1;
      }
    });
    var html = "";
    var depth = 0;
    var open = false;
    for (var j = 0; j < text.length; j++) {
      depth += marks[j];
      if (depth > 0 && !open) {
        html += "<mark>";
        open = true;
      }
      if (depth <= 0 && open) {
        html += "</mark>";
        open = false;
      }
      html += esc(text.charAt(j));
    }
    return html + (open ? "</mark>" : "");
  }

  // 検索語が本文にだけ一致したとき、一致箇所の前後を見出しの下に出す
  function snippet(a, terms) {
    var flat = a.bodyText.replace(/\s+/g, " ");
    var nf = norm(flat);
    var pos = -1;
    terms.forEach(function (t) {
      var p = nf.indexOf(t);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    });
    if (pos === -1) return "";
    var start = Math.max(0, pos - 40);
    return (start > 0 ? "…" : "") + flat.slice(start, start + 120) + (start + 120 < flat.length ? "…" : "");
  }

  /* ---------- 全文の表示 ---------- */

  function renderArticleBlocks(blocks, terms) {
    var box = el("div", { class: "article-body" });
    var list = null;
    blocks.forEach(function (b) {
      if (b[0] !== "li") list = null;
      if (b[0] === "h") {
        box.appendChild(el(b[1] <= 2 ? "h4" : "h5", { class: "article-h", html: highlight(b[2], terms) }));
      } else if (b[0] === "p") {
        box.appendChild(el("p", { class: "article-p", html: highlight(b[1], terms) }));
      } else if (b[0] === "li") {
        if (!list) {
          list = el("ul", { class: "article-ul" });
          box.appendChild(list);
        }
        list.appendChild(el("li", { class: "article-p", html: highlight(b[1], terms) }));
      } else if (b[0] === "t") {
        var table = el("table", { class: "article-table" });
        b[1].forEach(function (row) {
          var tr = el("tr");
          row.forEach(function (c) {
            var attrs = { html: highlight(c.x, terms) };
            if (c.r > 1) attrs.rowspan = String(c.r);
            if (c.c > 1) attrs.colspan = String(c.c);
            tr.appendChild(el(c.h ? "th" : "td", attrs));
          });
          table.appendChild(tr);
        });
        box.appendChild(el("div", { class: "article-table-wrap" }, [table]));
      }
    });
    return box;
  }

  function sourceUrl(a) {
    // 通達はページ内の該当番号へテキストフラグメントで移動（対応ブラウザのみ）
    if ((a.type === "tsu" || a.type === "so") && a.number) return a.url + "#:~:text=" + encodeURIComponent(a.number).replace(/-/g, "%2D");
    return a.url;
  }

  function noLabel(a) {
    if (a.type === "ta") return "No." + a.number;
    if (a.type === "bk") return [a.date, a.dept].filter(Boolean).join("　");
    return a.number;
  }

  function renderOne(a, terms, opts) {
    var titleParts = [];
    var no = noLabel(a);
    var isTsutatsu = a.type === "tsu" || a.type === "so";
    var path = isTsutatsu ? a.path.slice(1).join(" › ") : opts.showType ? a.category : "";
    if (no || path) {
      titleParts.push(
        el("span", { class: "article-no" }, [
          no ? el("span", { html: highlight(no, terms) }) : null,
          path ? el("span", { class: "article-path", text: (no ? "　" : "") + path }) : null,
        ])
      );
    }
    titleParts.push(el("span", { class: "item-name", html: highlight(a.title, terms) }));
    var snip = terms.length && a.titleNorm.indexOf(terms[0]) === -1 ? snippet(a, terms) : "";
    if (snip) titleParts.push(el("span", { class: "article-snippet", html: highlight(snip, terms) }));

    var head = [];
    if (opts.showType) head.push(el("span", { class: "badge article-type badge-" + a.type, text: TYPES[a.type].short }));
    head.push(el("span", { class: "article-title" }, titleParts));
    var summary = el("summary", { class: "item-head article-head" }, head);

    var body = el("div", { class: "item-body" });
    var details = el("details", {}, [summary, body]);
    // 全文は開いたときに描画する（通達は合わせて 2,000 件を超えるため）
    details.addEventListener("toggle", function () {
      if (!details.open || body.childNodes.length) return;
      if (a.asof) body.appendChild(el("p", { class: "article-asof", text: a.asof + "現在の法令・通達等に基づく内容" }));
      body.appendChild(renderArticleBlocks(a.blocks, terms));
      body.appendChild(
        el("p", {}, [
          el("a", { class: "article-link", href: sourceUrl(a), target: "_blank", rel: "noopener", text: "国税庁の原文を開く ↗" }),
        ])
      );
    });
    return el("li", { class: "item article item-" + a.type }, [details]);
  }

  /*
   * 検索・絞り込み・一覧の 1 セットを作る。
   * prefix : 要素IDの接頭辞（例：tsu → #tsu-q, #tsu-results …）
   * opts.types    : 種別ボタンを出す種別コードの配列（省略時は出さない）
   * opts.only     : この種別の記事だけを扱う
   * opts.showType : 各項目に種別バッジを出す
   * opts.allLabel : 分類の選択肢の「すべて」の表記
   */
  function setupDocTab(prefix, opts) {
    var st = { q: "", type: "", category: "", limit: PAGE_SIZE };
    var list = ARTICLES.filter(function (a) {
      return !opts.only || a.type === opts.only;
    });
    var chips = $(prefix + "-type-filters");
    var select = $(prefix + "-category-filter");

    if (opts.types && chips) {
      [""].concat(opts.classes || [], opts.types).forEach(function (code) {
        var btn = el("button", {
          class: "chip" + (code ? " chip-" + code : "") + (code === st.type ? " is-active" : ""),
          type: "button",
          "data-type": code,
          "aria-pressed": String(code === st.type),
          text: !code ? "すべて" : BUNRUI[code] ? BUNRUI[code].label : TYPES[code].label,
        });
        btn.addEventListener("click", function () {
          st.type = code;
          Array.prototype.forEach.call(chips.children, function (b) {
            var active = b.getAttribute("data-type") === st.type;
            b.classList.toggle("is-active", active);
            b.setAttribute("aria-pressed", String(active));
          });
          fillCategories();
          renderList(true);
        });
        chips.appendChild(btn);
      });
    }

    select.addEventListener("change", function (e) {
      st.category = e.target.value;
      renderList(true);
    });
    $(prefix + "-q").addEventListener("input", function (e) {
      st.q = e.target.value;
      renderList(true);
    });

    // 種別に応じて分類の選択肢を作り直す（国税庁の目次順）。益金・損金ではテーマの一覧にする
    function fillCategories() {
      var seen = {};
      select.textContent = "";
      var found = false;
      if (BUNRUI[st.type]) {
        select.appendChild(el("option", { value: "", text: "すべてのテーマ" }));
        BUNRUI[st.type].topics.forEach(function (t) {
          var key = "topic|" + t.name;
          if (key === st.category) found = true;
          select.appendChild(el("option", { value: key, text: t.name }));
        });
        if (!found) st.category = "";
        select.value = st.category;
        return;
      }
      select.appendChild(el("option", { value: "", text: opts.allLabel || "すべての分類" }));
      list.forEach(function (a) {
        if (st.type && a.type !== st.type) return;
        var key = a.type + "|" + a.category;
        if (seen[key]) return;
        seen[key] = true;
        if (key === st.category) found = true;
        var label = opts.showType && !st.type ? TYPES[a.type].short + "：" + a.category : a.category;
        select.appendChild(el("option", { value: key, text: label }));
      });
      if (!found) st.category = "";
      select.value = st.category;
    }

    function renderList(resetLimit) {
      if (resetLimit) st.limit = PAGE_SIZE;
      // 分類の値は「種別|分類」（種別をまたいで同名の分類があるため）、益金・損金のテーマは「topic|テーマ」
      var cls = BUNRUI[st.type] ? st.type : "";
      var sep = st.category.indexOf("|");
      var isTopic = st.category.indexOf("topic|") === 0;
      var results = searchArticles(list, st.q, {
        type: cls ? "" : sep >= 0 ? st.category.slice(0, sep) : st.type,
        category: !isTopic && sep >= 0 ? st.category.slice(sep + 1) : "",
        cls: cls,
        topic: isTopic ? st.category.slice(6) : "",
      });
      // 益金・損金はテーマ順に並べ、テーマごとに見出しを付ける（テーマ内は検索の一致順・目次順）
      if (cls) {
        results = results
          .map(function (a, i) {
            return { a: a, i: i };
          })
          .sort(function (x, y) {
            return x.a.topicOrder - y.a.topicOrder || x.i - y.i;
          })
          .map(function (x) {
            return x.a;
          });
      }
      var counts = {};
      results.forEach(function (a) {
        counts[a.topic] = (counts[a.topic] || 0) + 1;
      });
      var terms = parseQuery(st.q).inc;
      var ul = $(prefix + "-results");
      ul.textContent = "";
      var lastTopic = null;
      results.slice(0, st.limit).forEach(function (a) {
        if (cls && a.topic !== lastTopic) {
          lastTopic = a.topic;
          ul.appendChild(
            el("li", { class: "group-head group-" + cls }, [
              el("span", { text: BUNRUI[cls].label + "　" + a.topic }),
              el("span", { class: "group-count", text: counts[a.topic] + " 件" }),
            ])
          );
        }
        ul.appendChild(renderOne(a, terms, opts));
      });
      if (!results.length) {
        ul.appendChild(el("li", { class: "empty" }, [el("p", { text: "該当する項目が見つかりませんでした。" })]));
      }
      if (results.length > st.limit) {
        var more = el("button", {
          class: "btn btn-ghost more",
          type: "button",
          text: "さらに表示（残り " + (results.length - st.limit) + " 件）",
        });
        more.addEventListener("click", function () {
          st.limit += PAGE_SIZE;
          renderList(false);
        });
        ul.appendChild(el("li", { class: "empty" }, [more]));
      }
      if (results.length === 1) ul.querySelector("details").open = true;
      $(prefix + "-count").textContent =
        st.q.trim() || st.category || st.type ? results.length + " 件" : "全 " + results.length + " 件";
    }

    fillCategories();
    renderList(true);
  }

  /* ---------- タブ ---------- */

  var view = { tab: "dict", sub: { tsu: "kihon", nta: "ta" } };

  function showView() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      var active = b.getAttribute("data-tab") === view.tab;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
    TABS.forEach(function (t) {
      $("tab-" + t).hidden = t !== view.tab;
    });
    Object.keys(SUBS).forEach(function (t) {
      SUBS[t].forEach(function (s) {
        var active = s === view.sub[t];
        var b = document.querySelector('.subtab[data-sub="' + s + '"]');
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", String(active));
        $("sub-" + s).hidden = !active;
      });
    });
  }

  // タブは URL（#tab=tsu&sub=so、#tab=nta&sub=qa）でも開ける
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    view.tab = TABS.indexOf(p.get("tab")) !== -1 ? p.get("tab") : "dict";
    Object.keys(SUBS).forEach(function (t) {
      view.sub[t] = view.tab === t && SUBS[t].indexOf(p.get("sub")) !== -1 ? p.get("sub") : SUBS[t][0];
    });
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (view.tab !== "dict") p.set("tab", view.tab);
    if (SUBS[view.tab] && view.sub[view.tab] !== SUBS[view.tab][0]) p.set("sub", view.sub[view.tab]);
    var h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  function setupTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        view.tab = b.getAttribute("data-tab");
        writeHash();
        showView();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".subtab"), function (b) {
      b.addEventListener("click", function () {
        var s = b.getAttribute("data-sub");
        Object.keys(SUBS).forEach(function (t) {
          if (SUBS[t].indexOf(s) !== -1) view.sub[t] = s;
        });
        writeHash();
        showView();
      });
    });
    window.addEventListener("hashchange", function () {
      readHash();
      showView();
    });
    readHash();
    showView();
  }

  /* ---------- 起動 ---------- */

  function init(data) {
    ARTICLES = data.records.map(function (r, i) {
      var bodyText = blocksText(r.blocks);
      var path = r.path || [];
      return {
        type: TYPE_OF[r.source],
        order: i,
        number: r.number,
        title: r.title,
        category: r.category,
        path: path,
        blocks: r.blocks,
        asof: r.asof || "",
        date: r.date || "",
        dept: r.dept || "",
        url: r.url,
        bodyText: bodyText,
        noNorm: norm(r.number),
        titleNorm: norm(r.title),
        pathNorm: norm(path.join(" ")),
        bodyNorm: norm(bodyText),
        norm: norm([r.number, r.date, r.dept, r.title, path.join(" ")].join(" ")) + "\n" + norm(bodyText),
      };
    });

    // 益金・損金の整理表（bunrui.js）を各項目に当てはめる
    var rule = {};
    var order = 0;
    Object.keys(BUNRUI).forEach(function (cls) {
      BUNRUI[cls].topics.forEach(function (t) {
        order++;
        t.rules.forEach(function (r) {
          rule[r.join("|")] = { cls: cls, topic: t.name, order: order };
        });
      });
    });
    var used = {};
    ARTICLES.forEach(function (a) {
      var key = a.type + "|" + a.category;
      var hit = rule[key + "|" + (a.path[1] || "")] || rule[key];
      if (!hit) return;
      used[hit === rule[key] ? key : key + "|" + a.path[1]] = true;
      a.cls = hit.cls;
      a.topic = hit.topic;
      a.topicOrder = hit.order;
    });
    Object.keys(rule).forEach(function (k) {
      if (!used[k]) console.warn("bunrui.js: 該当する項目がない見出し", k);
    });

    var fetched = data.generated_at.slice(0, 10);
    Array.prototype.forEach.call(document.querySelectorAll(".fetched"), function (n) {
      n.textContent = fetched;
    });
    $("item-total").textContent = "収録 " + ARTICLES.length.toLocaleString() + " 件（取得日：" + fetched + "）";

    setupDocTab("dict", { classes: ["ekin", "sonkin"], types: ["tsu", "so", "ta", "qa", "bk"], showType: true });
    setupDocTab("kihon", { only: "tsu", allLabel: "すべての章" });
    setupDocTab("so", { only: "so", allLabel: "すべての章" });
    setupDocTab("ta", { only: "ta" });
    setupDocTab("qa", { only: "qa" });
    setupDocTab("bk", { only: "bk" });
  }

  setupTabs();
  fetch("data/hojin.json")
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(init)
    .catch(function () {
      $("dict-count").textContent =
        "data/hojin.json を読み込めませんでした。scripts/fetch_nta.py でデータを生成し、HTTP サーバー経由で開いてください。";
    });
})();
