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
  // 種別ごとの掲載先（タブ・サブタブ・一覧の要素ID接頭辞）
  var HOME = {
    tsu: { tab: "tsu", sub: "kihon" },
    so: { tab: "tsu", sub: "so" },
    ta: { tab: "nta", sub: "ta" },
    qa: { tab: "nta", sub: "qa" },
    bk: { tab: "nta", sub: "bk" },
  };
  var REF_PREVIEW = 8; // 益金・損金などのテーマで出典ごとに最初に表示する件数
  var INSTANCES = {};

  var ARTICLES = [];
  var ARTICLES_BY_ID = {};

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
      if (filter.cls && !a.tags[filter.cls]) return;
      if (filter.topic && a.tags[filter.cls].topic !== filter.topic) return;
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
   * opts.classes  : 「すべて」の右に出す整理区分（bunrui.js）のボタンの配列（省略時はボタンを出さない）
   * opts.types    : 整理区分の右に出す種別ボタンの種別コードの配列（省略可）
   * opts.subClasses : { 親の区分: [内訳の区分, …] }。内訳は親を選んだときに 2 段目に表示する
   * opts.only     : この種別の記事だけを扱う
   * opts.showType : 各項目に種別バッジを出す
   * opts.allLabel : 分類の選択肢の「すべて」の表記
   */
  function setupDocTab(prefix, opts) {
    var st = { q: "", type: "", category: "", limit: PAGE_SIZE, focus: "" };
    var list = ARTICLES.filter(function (a) {
      return !opts.only || a.type === opts.only;
    });
    var chips = $(prefix + "-type-filters");
    var select = $(prefix + "-category-filter");

    // 2 段目に置く区分（「益金」「損金」を選ぶと、その下に内訳のボタンを出す）
    var subOf = opts.subClasses || {};
    var parentOf = {};
    Object.keys(subOf).forEach(function (p) {
      subOf[p].forEach(function (c) {
        parentOf[c] = p;
      });
    });
    var subChips = $(prefix + "-sub-filters");

    function chipButton(code, label) {
      var btn = el("button", {
        class: "chip" + (code ? " chip-" + code : ""),
        type: "button",
        "data-type": code,
        "aria-pressed": "false",
        text: label,
      });
      btn.addEventListener("click", function () {
        choose(code);
      });
      return btn;
    }

    function setActive(box, code) {
      Array.prototype.forEach.call(box.children, function (b) {
        var active = b.getAttribute("data-type") === code;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      });
    }

    // 1 段目は親の区分を選択状態にし、親に内訳があれば 2 段目を表示する
    function refreshChips() {
      var top = parentOf[st.type] || st.type;
      setActive(chips, top);
      if (!subChips) return;
      var parent = subOf[top] ? top : "";
      subChips.hidden = !parent;
      subChips.textContent = "";
      if (!parent) return;
      [parent].concat(subOf[parent]).forEach(function (code) {
        subChips.appendChild(chipButton(code, code === parent ? BUNRUI[parent].label + "（全体）" : BUNRUI[code].label));
      });
      setActive(subChips, st.type);
    }

    function choose(code) {
      st.type = code;
      refreshChips();
      // 横スクロールの列で、押したボタンが見える位置に来るようにする
      [chips, subChips].forEach(function (box) {
        var b = box && box.querySelector('.is-active[data-type="' + code + '"]');
        if (b && b.scrollIntoView) b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      });
      fillCategories();
      renderList(true);
    }

    if ((opts.classes || opts.types) && chips) {
      [""].concat(opts.classes || [], opts.types || []).forEach(function (code) {
        if (parentOf[code]) return;
        chips.appendChild(chipButton(code, !code ? "すべて" : BUNRUI[code] ? BUNRUI[code].label : TYPES[code].label));
      });
      refreshChips();
    }


    select.addEventListener("change", function (e) {
      st.category = e.target.value;
      if (st.focus) clearFocus();
      renderList(true);
    });
    $(prefix + "-q").addEventListener("input", function (e) {
      st.q = e.target.value;
      if (st.focus) clearFocus();
      renderList(true);
    });

    // 辞書（益金・損金など）から移動してきた項目だけを開いて表示する
    function clearFocus() {
      st.focus = "";
      if (view.id) {
        view.id = "";
        writeHash();
      }
    }
    INSTANCES[prefix] = {
      focus: function (id) {
        if (st.focus === id) return;
        st.focus = id;
        if (id) {
          st.q = "";
          $(prefix + "-q").value = "";
          st.category = "";
          select.value = "";
        }
        renderList(true);
      },
    };

    // 種別に応じて分類の選択肢を作り直す（国税庁の目次順）。益金・損金などではテーマの一覧にする
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
      // 分類の値は「種別|分類」（種別をまたいで同名の分類があるため）、益金・損金などのテーマは「topic|テーマ」
      var cls = BUNRUI[st.type] ? st.type : "";
      if (st.focus) return renderFocus();
      var sep = st.category.indexOf("|");
      var isTopic = st.category.indexOf("topic|") === 0;
      var results = searchArticles(list, st.q, {
        type: cls ? "" : sep >= 0 ? st.category.slice(0, sep) : st.type,
        category: !isTopic && sep >= 0 ? st.category.slice(sep + 1) : "",
        cls: cls,
        topic: isTopic ? st.category.slice(6) : "",
      });
      var terms = parseQuery(st.q).inc;
      var ul = $(prefix + "-results");
      ul.textContent = "";
      $(prefix + "-count").textContent =
        st.q.trim() || st.category || st.type ? results.length + " 件" : "全 " + results.length + " 件";
      if (cls) return renderTopics(ul, cls, results, terms);
      results.slice(0, st.limit).forEach(function (a) {
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
    }

    function renderFocus() {
      var ul = $(prefix + "-results");
      ul.textContent = "";
      var hit = list.filter(function (a) {
        return a.id === st.focus;
      });
      var fromDict = history.state && history.state.fromDict;
      var back = el("button", { class: "btn btn-ghost", type: "button", text: fromDict ? "← 辞書の一覧に戻る" : "← 辞書へ" });
      back.addEventListener("click", function () {
        if (fromDict) history.back();
        else location.hash = "";
      });
      var all = el("button", { class: "btn btn-ghost", type: "button", text: "この一覧をすべて表示" });
      all.addEventListener("click", function () {
        clearFocus();
        renderList(true);
      });
      ul.appendChild(el("li", { class: "focus-bar" }, [back, all]));
      hit.forEach(function (a) {
        ul.appendChild(renderOne(a, [], opts));
      });
      if (hit.length) ul.querySelector("details").open = true;
      $(prefix + "-count").textContent = hit.length ? "選択した項目を表示しています" : "該当する項目が見つかりませんでした。";
    }

    // 益金・損金・資本的支出と修繕費・繰延資産・引当金・役員報酬と給与・交際費等・寄附金・租税公課・貸倒損失・保険料・減価償却・特別償却・圧縮記帳・繰越欠損金・組織再編成：テーマごとにタイトル・説明文と、関連する通達・記事のタイトル（番号）の一覧を出す。
    // 項目を押すと、その項目が掲載されているタブに移動して全文を開く
    function renderTopics(ul, cls, results, terms) {
      var c = BUNRUI[cls];
      ul.appendChild(
        el("li", { class: "class-intro" }, [
          el("h2", { class: "class-title", text: c.label }),
          el("p", { class: "class-desc", text: c.desc }),
          el("p", { class: "class-note", text: "説明は本辞書による概要です。項目を押すと、掲載先のタブで全文と国税庁の原文リンクを表示します。" }),
        ])
      );
      var topicFilter = st.category.indexOf("topic|") === 0 ? st.category.slice(6) : "";
      c.topics.forEach(function (t) {
        if (topicFilter && t.name !== topicFilter) return;
        var items = results.filter(function (a) {
          return a.tags[cls].topic === t.name;
        });
        if (!items.length && st.q.trim()) return;
        var groups = [];
        Object.keys(TYPES).forEach(function (code) {
          var g = items.filter(function (a) {
            return a.type === code;
          });
          if (g.length) groups.push(renderRefGroup(code, g, terms));
        });
        ul.appendChild(
          el("li", { class: "topic-card" }, [
            el("h3", { class: "topic-title" }, [
              el("span", { text: t.name }),
              el("span", { class: "topic-count", text: items.length + " 件" }),
            ]),
            el("p", { class: "topic-desc", text: t.desc }),
          ].concat(groups))
        );
      });
      if (!results.length) {
        ul.appendChild(el("li", { class: "empty" }, [el("p", { text: "該当する項目が見つかりませんでした。" })]));
      }
    }

    function renderRefGroup(code, items, terms) {
      var box = el("div", { class: "ref-group" });
      box.appendChild(
        el("h4", { class: "ref-head" }, [
          el("span", { class: "badge badge-" + code, text: TYPES[code].label }),
          el("span", { class: "topic-count", text: items.length + " 件" }),
        ])
      );
      var listEl = el("ul", { class: "ref-list" });
      function fill(n) {
        listEl.textContent = "";
        items.slice(0, n).forEach(function (a) {
          var no = noLabel(a);
          var btn = el("button", { class: "ref-link", type: "button" }, [
            no ? el("span", { class: "ref-no", html: highlight(no, terms) }) : null,
            el("span", { class: "ref-title", html: highlight(a.title, terms) }),
          ]);
          btn.addEventListener("click", function () {
            openArticle(a);
          });
          listEl.appendChild(el("li", {}, [btn]));
        });
      }
      fill(REF_PREVIEW);
      box.appendChild(listEl);
      if (items.length > REF_PREVIEW) {
        var more = el("button", { class: "ref-more", type: "button", text: "すべて表示（" + items.length + " 件）" });
        more.addEventListener("click", function () {
          fill(items.length);
          more.remove();
        });
        box.appendChild(more);
      }
      return box;
    }

    fillCategories();
    renderList(true);
  }

  /* ---------- タブ ---------- */

  var view = { tab: "dict", sub: { tsu: "kihon", nta: "ta" }, id: "" };

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
    view.id = p.get("id") || "";
  }

  // URL の id（例：#tab=tsu&id=tsutatsu:9-2-12）の項目を、掲載先の一覧で開く
  function applyFocus() {
    if (!ARTICLES.length) return;
    var target = view.id ? HOME[(ARTICLES_BY_ID[view.id] || {}).type] : null;
    Object.keys(HOME).forEach(function (code) {
      var h = HOME[code];
      var inst = INSTANCES[h.sub];
      if (!inst) return;
      var on = target && target.sub === h.sub && view.tab === h.tab && view.sub[h.tab] === h.sub;
      inst.focus(on ? view.id : "");
    });
  }

  function openArticle(a) {
    var h = HOME[a.type];
    view.tab = h.tab;
    view.sub[h.tab] = h.sub;
    view.id = a.id;
    var p = new URLSearchParams();
    p.set("tab", h.tab);
    if (h.sub !== SUBS[h.tab][0]) p.set("sub", h.sub);
    p.set("id", a.id);
    history.pushState({ fromDict: true }, "", "#" + p.toString());
    showView();
    applyFocus();
    window.scrollTo(0, 0);
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (view.tab !== "dict") p.set("tab", view.tab);
    if (SUBS[view.tab] && view.sub[view.tab] !== SUBS[view.tab][0]) p.set("sub", view.sub[view.tab]);
    if (view.id) p.set("id", view.id);
    var h = p.toString();
    history.replaceState(history.state, "", h ? "#" + h : location.pathname + location.search);
  }

  function setupTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        view.tab = b.getAttribute("data-tab");
        view.id = "";
        writeHash();
        showView();
        applyFocus();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".subtab"), function (b) {
      b.addEventListener("click", function () {
        var s = b.getAttribute("data-sub");
        Object.keys(SUBS).forEach(function (t) {
          if (SUBS[t].indexOf(s) !== -1) view.sub[t] = s;
        });
        view.id = "";
        writeHash();
        showView();
        applyFocus();
      });
    });
    function onNavigate() {
      readHash();
      showView();
      applyFocus();
    }
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    readHash();
    showView();
  }

  /* ---------- 起動 ---------- */

  function init(data) {
    ARTICLES = data.records.map(function (r, i) {
      var bodyText = blocksText(r.blocks);
      var path = r.path || [];
      return {
        id: r.id,
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

    // 整理表（bunrui.js）を各項目に当てはめる。項目は複数の区分（例：損金と資本的支出と修繕費）に属しうる
    var rule = {};
    var order = 0;
    Object.keys(BUNRUI).forEach(function (cls) {
      BUNRUI[cls].topics.forEach(function (t) {
        order++;
        t.rules.forEach(function (r) {
          var key = r.join("|");
          (rule[key] = rule[key] || []).push({ cls: cls, topic: t.name, order: order });
        });
      });
    });
    var used = {};
    ARTICLES.forEach(function (a) {
      a.tags = {};
      var base = a.type + "|" + a.category;
      // 個別指定（id）＞ 節まで一致 ＞ 分類（目次の見出し）の順に、区分ごとに最初に当たったものを採る
      ["id|" + a.id, base + "|" + (a.path[1] || ""), base].forEach(function (key) {
        (rule[key] || []).forEach(function (hit) {
          if (a.tags[hit.cls]) return;
          a.tags[hit.cls] = hit;
          used[key] = true;
        });
      });
    });
    Object.keys(rule).forEach(function (k) {
      if (!used[k]) console.warn("bunrui.js: 該当する項目がない見出し・ID", k);
    });

    ARTICLES.forEach(function (a) {
      ARTICLES_BY_ID[a.id] = a;
    });

    var fetched = data.generated_at.slice(0, 10);
    Array.prototype.forEach.call(document.querySelectorAll(".fetched"), function (n) {
      n.textContent = fetched;
    });
    $("item-total").textContent = "収録 " + ARTICLES.length.toLocaleString() + " 件（取得日：" + fetched + "）";

    setupDocTab("dict", { classes: ["ekin", "sonkin", "zeiritsu", "zeigaku", "shinkoku", "dozoku", "tsusan", "koeki", "gaikoku", "shueki", "haito", "hyokaeki", "jyuzo", "shushi", "kurinobe", "hikiate", "kashidaore", "yakuin", "kosai", "kifu", "sozei", "hoken", "genka", "tokusho", "asshuku", "kesson", "saihen"],
      subClasses: {
        ekin: ["shueki", "haito", "hyokaeki", "jyuzo"],
        sonkin: ["shushi", "kurinobe", "hikiate", "kashidaore", "yakuin", "kosai", "kifu", "sozei", "hoken", "genka", "tokusho", "asshuku", "kesson", "saihen"],
      },
      showType: true,
    });
    setupDocTab("kihon", { only: "tsu", allLabel: "すべての章" });
    setupDocTab("so", { only: "so", allLabel: "すべての章" });
    setupDocTab("ta", { only: "ta" });
    setupDocTab("qa", { only: "qa" });
    setupDocTab("bk", { only: "bk" });
    applyFocus();
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
