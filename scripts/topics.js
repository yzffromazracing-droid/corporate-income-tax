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
      var items = (byTopic[cls + "|" + t.name] || []).slice().sort(function (a, b) {
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

// 「タックスアンサー No.5265 交際費等の範囲と損金不算入額の計算」のような表記
function itemLabel(r) {
  var num = r.number ? (r.source === "taxanswer" ? "No." + r.number : r.number) + " " : "";
  return SOURCE_LABEL[r.source] + " " + num + r.title;
}

module.exports = { loadTopics: loadTopics, itemLabel: itemLabel };
