/*
 * 辞書のテーマ（bunrui.js の各区分のテーマ）と、その関連項目（data/hojin.json）をまとめて返す。
 * Facebook への投稿（scripts/facebook-post.js・scripts/facebook-image.js）で使う。
 *
 * テーマの並びは、区分を順に回して 1 テーマずつ取り出したもの（同じ区分が続かないようにする）。
 * 関連項目は app.js と同じ規則（個別指定 ＞ 節 ＞ 分類）で当てる。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.resolve(__dirname, "..");
var TYPE_OF = { tsutatsu: "tsu", sochiho: "so", taxanswer: "ta", shitsugi: "qa", bunsho: "bk" };
var SOURCE_LABEL = { tsutatsu: "法人税基本通達", sochiho: "措置法通達", taxanswer: "タックスアンサー", shitsugi: "質疑応答事例", bunsho: "文書回答事例" };
// 投稿に載せる関連項目の出典の順（読みやすいタックスアンサー・基本通達を先に）
var SOURCE_ORDER = ["taxanswer", "tsutatsu", "sochiho", "shitsugi", "bunsho"];
// 欠番（題名か本文が「削除」だけのもの）
function isDeleted(r) {
  if (r.title.trim() === "削除") return true;
  var first = (r.blocks[0] || [])[1];
  return r.blocks.length === 1 && typeof first === "string" && /^削除[（(]/.test(first.trim());
}

// 内訳の区分の親（益金・損金）。投稿では「損金／交際費等」のように表示する
var PARENT = {
  shueki: "ekin", haito: "ekin", hyokaeki: "ekin", jyuzo: "ekin",
  shushi: "sonkin", kurinobe: "sonkin", hikiate: "sonkin", kashidaore: "sonkin", yakuin: "sonkin", kosai: "sonkin",
  kifu: "sonkin", sozei: "sonkin", hoken: "sonkin", genka: "sonkin", tokusho: "sonkin", asshuku: "sonkin",
  kesson: "sonkin", saihen: "sonkin",
};

function loadBunrui() {
  var ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "bunrui.js"), "utf8") + "\nthis.BUNRUI = BUNRUI;", ctx);
  return ctx.BUNRUI;
}

function loadRecords() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "hojin.json"), "utf8")).records;
}

// 各テーマに当たる項目を集める
function relatedItems(BUNRUI, records) {
  var rule = {};
  Object.keys(BUNRUI).forEach(function (cls) {
    BUNRUI[cls].topics.forEach(function (t) {
      t.rules.forEach(function (r) {
        var key = r.join("|");
        (rule[key] = rule[key] || []).push({ cls: cls, topic: t.name });
      });
    });
  });
  var byTopic = {};
  records.forEach(function (r) {
    var tags = {};
    var base = TYPE_OF[r.source] + "|" + r.category;
    ["id|" + r.id, base + "|" + ((r.path || [])[1] || ""), base].forEach(function (key) {
      (rule[key] || []).forEach(function (hit) {
        if (tags[hit.cls]) return;
        tags[hit.cls] = hit;
        var k = hit.cls + "|" + hit.topic;
        (byTopic[k] = byTopic[k] || []).push(r);
      });
    });
  });
  return byTopic;
}

// 投稿の順に並べたテーマの一覧
function loadTopics() {
  var BUNRUI = loadBunrui();
  var byTopic = relatedItems(BUNRUI, loadRecords());
  var queues = Object.keys(BUNRUI).map(function (cls) {
    return BUNRUI[cls].topics.map(function (t) {
      var parent = PARENT[cls];
      // 「削除」とだけ書かれた欠番の通達は紹介しない
      var items = (byTopic[cls + "|" + t.name] || []).filter(function (r) {
        return !isDeleted(r);
      }).sort(function (a, b) {
        return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
      });
      return {
        cls: cls,
        group: parent || cls,
        label: parent ? BUNRUI[parent].label + "／" + BUNRUI[cls].label : BUNRUI[cls].label,
        name: t.name,
        desc: t.desc,
        items: items,
      };
    });
  });
  var out = [];
  for (var i = 0; queues.some(function (q) { return i < q.length; }); i++) {
    queues.forEach(function (q) {
      if (i < q.length) out.push(q[i]);
    });
  }
  return out;
}

// 出典の種類の説明（投稿で「今日の通達・記事」に添える）
var SOURCE_ABOUT = {
  tsutatsu: "国税庁が法人税法などの解釈や取扱いを示したもの",
  sochiho: "国税庁が租税特別措置法（法人税関係）の解釈や取扱いを示したもの",
  taxanswer: "国税庁がよくある質問について税の仕組みを説明したもの",
  shitsugi: "国税庁に寄せられた照会とその回答の事例",
  bunsho: "事前照会に対して国税局などが文書で回答した事例",
};

// 本文の抜粋に使う出典（文書回答事例は表の形なので使わない）
var EXCERPT_SOURCES = ["taxanswer", "tsutatsu", "sochiho", "shitsugi"];

// 通達の末尾の改正経過「（平19年課法2－3「二十二」により追加、…により改正）」を除く。
// 「昭45年直審（法）58」のように中に括弧を含む改正経過もあるので、末尾の括弧は対応する開き括弧まで数えて外す
function stripHistory(s) {
  s = s.replace(/[（(][^（）()]*?(?:により追加|により改正|により削除)[^（）()]*?[）)]/g, "").trim();
  while (/[）)]$/.test(s)) {
    var depth = 0;
    var open = -1;
    for (var i = s.length - 1; i >= 0; i--) {
      var ch = s.charAt(i);
      if (ch === "）" || ch === ")") depth++;
      else if (ch === "（" || ch === "(") depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
    if (open < 0 || !/により(?:追加|改正|削除)$/.test(s.slice(open + 1, -1).trim())) break;
    s = s.slice(0, open).trim();
  }
  return s;
}

function paragraphs(r) {
  return r.blocks.map(function (b) {
    if (b[0] === "h") return { h: b[2], level: b[1] };
    if (b[0] === "p" || b[0] === "li") return { p: stripHistory(b[b.length - 1]).replace(/\s+/g, " ") };
    return null;
  }).filter(Boolean);
}

// max 文字までで、なるべく文の終わり（。）で切る
function clip(s, max) {
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  var end = cut.lastIndexOf("。");
  return end >= max * 0.5 ? cut.slice(0, end + 1) : cut + "…";
}

// 見出し name の後の段落をつなげる（name がなければ最初から）。
// 次の大見出し（レベル 2）で止め、途中の小見出しは【見出し】として残す
function textAfter(paras, name, max) {
  var on = !name;
  var out = "";
  for (var i = 0; i < paras.length && out.length < max; i++) {
    if (paras[i].h !== undefined) {
      if (on && name && paras[i].level <= 2) break;
      if (paras[i].h === name) on = true;
      else if (on) out += (out ? "\n" : "") + "【" + paras[i].h + "】";
      continue;
    }
    if (on && paras[i].p) out += (out ? "\n" : "") + paras[i].p;
  }
  return out;
}

// 原文の抜粋（国税庁の本文をそのまま使い、言い換えはしない）
function excerpt(r, max) {
  max = max || 260;
  var paras = paragraphs(r);
  if (r.source === "taxanswer") return clip(textAfter(paras, "概要", max * 2) || textAfter(paras, "", max * 2), max);
  if (r.source === "shitsugi") {
    var q = textAfter(paras, "照会要旨", max);
    var a = textAfter(paras, "回答要旨", max);
    return "【照会】" + clip(q, Math.floor(max * 0.45)) + "\n【回答】" + clip(a, Math.floor(max * 0.55));
  }
  return clip(textAfter(paras, "", max * 2), max);
}

// 「タックスアンサー No.5265 交際費等の範囲と損金不算入額の計算」のような表記
function itemLabel(r) {
  var num = r.number ? (r.source === "taxanswer" ? "No." + r.number : r.number) + " " : "";
  return SOURCE_LABEL[r.source] + " " + num + r.title;
}

module.exports = { loadTopics: loadTopics, itemLabel: itemLabel, excerpt: excerpt, SOURCE_LABEL: SOURCE_LABEL, SOURCE_ABOUT: SOURCE_ABOUT, EXCERPT_SOURCES: EXCERPT_SOURCES };
