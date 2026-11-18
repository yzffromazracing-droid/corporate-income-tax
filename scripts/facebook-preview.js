#!/usr/bin/env node
/*
 * 翌日（または指定した日）の Facebook 投稿の本文とカード画像を作り、投稿前の確認に使う。
 *
 *   node scripts/facebook-preview.js <出力先ディレクトリ> [--date=YYYY-MM-DD]
 *
 * 出力先に post.txt（本文）と card.png（カード画像）を書く。投稿しない日は post.txt にその旨だけを書く。
 * --date を省くと日本時間の翌日。facebook-overrides.json の指定も反映する。
 * 画像は Playwright（Chromium）で SVG を表示して PNG にする（本番の GitHub Actions は rsvg-convert を使う）。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var post = require("./facebook-post.js");
var image = require("./facebook-image.js");

var DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  var args = process.argv.slice(2);
  var outDir = args.filter(function (a) { return a.indexOf("--") !== 0; })[0];
  var dateArg = args.filter(function (a) { return a.indexOf("--date=") === 0; })[0];
  if (!outDir) {
    console.error("usage: node scripts/facebook-preview.js <outdir> [--date=YYYY-MM-DD]");
    process.exit(2);
  }
  var date = dateArg ? new Date(dateArg.slice(7) + "T12:00:00+09:00") : new Date(Date.now() + DAY_MS);
  var day = post.jstDate(date);
  fs.mkdirSync(outDir, { recursive: true });
  var txt = path.join(outDir, "post.txt");
  var png = path.join(outDir, "card.png");
  if (fs.existsSync(png)) fs.unlinkSync(png);

  var picked = post.pickForDate(date);
  if (!picked) {
    fs.writeFileSync(txt, day + " は投稿しない日に指定されています（facebook-overrides.json）。\n");
    console.log(day + "：投稿しない日");
    return;
  }
  var siteUrl = process.env.SITE_URL || "https://yzffromazracing-droid.github.io/corporate-income-tax/";
  fs.writeFileSync(txt, post.buildMessage(picked.topic, siteUrl, picked.featured) + "\n");

  var svg = path.join(outDir, "card.svg");
  fs.writeFileSync(svg, image.buildSvg(picked.topic, picked.featured));
  var chromium = require("playwright").chromium;
  var browser = await chromium.launch();
  var page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  await page.goto("file://" + path.resolve(svg));
  await page.screenshot({ path: png });
  await browser.close();
  fs.unlinkSync(svg);
  console.log(day + "：" + picked.topic.label + "／" + picked.topic.name + "（" + txt + "、" + png + "）");
}

main().catch(function (e) {
  console.error(e.message);
  process.exit(1);
});
