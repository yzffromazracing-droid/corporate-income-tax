#!/usr/bin/env node
/*
 * 整理表（bunrui.js）が data/hojin.json の項目に当たっているかを確かめる。
 * app.js と同じ規則で各項目に区分を付け、区分ごとの件数と、どの項目にも当たらない規則を表示する。
 *
 *   node scripts/check_bunrui.js            # 件数の一覧と、当たらない規則
 *   node scripts/check_bunrui.js --json     # 区分ごとの件数を JSON で出力（更新前後の比較用）
 *
 * 当たらない規則があると終了コード 1 を返す。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "bunrui.js"), "utf8") + "\nthis.BUNRUI = BUNRUI;", ctx);
const BUNRUI = ctx.BUNRUI;
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "hojin.json"), "utf8"));
const TYPE_OF = { tsutatsu: "tsu", sochiho: "so", taxanswer: "ta", shitsugi: "qa", bunsho: "bk" };

const rule = {};
Object.keys(BUNRUI).forEach((cls) => {
  BUNRUI[cls].topics.forEach((t) => {
    t.rules.forEach((r) => {
      const key = r.join("|");
      (rule[key] = rule[key] || []).push({ cls, topic: t.name });
    });
  });
});

const used = {};
const counts = {};
data.records.forEach((r) => {
  const tags = {};
  const base = TYPE_OF[r.source] + "|" + r.category;
  ["id|" + r.id, base + "|" + ((r.path || [])[1] || ""), base].forEach((key) => {
    (rule[key] || []).forEach((hit) => {
      if (tags[hit.cls]) return;
      tags[hit.cls] = hit;
      used[key] = true;
    });
  });
  Object.keys(tags).forEach((cls) => {
    counts[cls] = (counts[cls] || 0) + 1;
  });
});

const unused = Object.keys(rule).filter((k) => !used[k]);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ counts, unused }, null, 1));
} else {
  Object.keys(BUNRUI).forEach((cls) => console.log(`${BUNRUI[cls].label}\t${counts[cls] || 0} 件`));
  console.log(unused.length ? `\n当たらない規則 ${unused.length} 件:` : "\n当たらない規則はありません");
  unused.forEach((k) => console.log("  " + k + "  ← " + rule[k].map((h) => `${BUNRUI[h.cls].label}／${h.topic}`).join("、")));
}
process.exitCode = unused.length ? 1 : 0;
