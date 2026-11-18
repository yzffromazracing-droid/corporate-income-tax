#!/usr/bin/env node
/*
 * 辞書のテーマを1日1件、Facebookページに投稿する。
 *
 *   node scripts/facebook-post.js [--dry-run] [--date=YYYY-MM-DD] [--image=画像.png]
 *
 * 環境変数:
 *   FB_PAGE_ID           : 投稿先のFacebookページID
 *   FB_PAGE_ACCESS_TOKEN : ページアクセストークン（pages_manage_posts 権限）
 *   SITE_URL             : 投稿に添えるサイトのURL（任意）
 *   FB_GRAPH_VERSION     : Graph APIのバージョン（任意。既定 v23.0）
 *
 * テーマは日付（日本時間）から決まるので、テーマの数（約185）の日数で全テーマを一巡する。
 * 毎回、テーマの関連項目から通達・記事を 1 件選んで「今日の通達・記事」として紹介する
 * （一巡するたびに次の項目に替わる）。本文はテーマの説明文（bunrui.js）と、
 * 国税庁の原文の抜粋・題名で、新しく文章を作ったり言い換えたりはしない。
 * --image を指定し、そのファイルがあれば写真付きで投稿する（本文は写真の説明文になる）。
 * --dry-run またはトークン未設定のときは投稿せず本文を表示するだけ。
 * 投稿とトークンの確認の処理は、消費税区分辞書の scripts/facebook-post.js と同じ。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var topics = require("./topics.js");

var DAY_MS = 24 * 60 * 60 * 1000;
var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
var OTHER_ITEMS = 3; // 「ほかの関連する通達・記事」に載せる数
var EXCERPT_CHARS = 300; // 原文の抜粋の長さ（文字数の目安）

// 日本時間の日付を 1970-01-01 からの日数にする
function dayIndex(date) {
  return Math.floor((date.getTime() + JST_OFFSET_MS) / DAY_MS);
}

function pickTopic(date, list) {
  list = list || topics.loadTopics();
  var n = dayIndex(date) % list.length;
  return list[(n + list.length) % list.length];
}

// 今日紹介する通達・記事。一巡するたびに、テーマの関連項目（抜粋できるもの）の次の 1 件にする
function pickFeatured(date, topic, list) {
  list = list || topics.loadTopics();
  var cands = topic.items.filter(function (r) { return topics.EXCERPT_SOURCES.indexOf(r.source) !== -1; });
  if (!cands.length) return null;
  var round = Math.floor(dayIndex(date) / list.length);
  return cands[((round % cands.length) + cands.length) % cands.length];
}

function hashtag(s) {
  return "#" + s.replace(/[\s・（）()／/、%％「」]/g, "");
}

function buildMessage(topic, siteUrl, featured) {
  var lines = [];
  lines.push("【今日の法人税】" + topic.name);
  lines.push("");
  lines.push("▶ 区分：" + topic.label);
  lines.push("");
  lines.push(topic.desc);
  if (featured) {
    lines.push("");
    lines.push("📘 今日の通達・記事");
    lines.push(topics.itemLabel(featured));
    lines.push("（" + topics.SOURCE_LABEL[featured.source] + "は、" + topics.SOURCE_ABOUT[featured.source] + "です）");
    lines.push("");
    lines.push("〔原文の抜粋〕");
    lines.push(topics.excerpt(featured, EXCERPT_CHARS));
    lines.push("▶ 原文：" + featured.url);
  }
  var others = topic.items.filter(function (r) { return r !== featured; });
  if (others.length) {
    lines.push("");
    lines.push("■ " + (featured ? "ほかの" : "") + "関連する通達・記事" + (others.length > OTHER_ITEMS ? "（全" + topic.items.length + "件から）" : ""));
    others.slice(0, OTHER_ITEMS).forEach(function (r) {
      lines.push("・" + topics.itemLabel(r));
    });
  }
  if (siteUrl) {
    lines.push("");
    lines.push("ほかのテーマや通達・記事の全文は「法人税区分辞書」で調べられます。");
    lines.push(siteUrl);
  }
  lines.push("");
  lines.push("※ テーマの説明は辞書による概要、抜粋は国税庁ホームページの原文です（取得時点のもの）。実際の適用は必ず原文でご確認ください。");
  lines.push("");
  var tags = ["#法人税"].concat(topic.label.split("／").map(hashtag), ["#経理", "#税務"]);
  lines.push(tags.filter(function (t, i) { return tags.indexOf(t) === i; }).join(" "));
  return lines.join("\n");
}

async function post(pageId, token, message, link, version, imageFile) {
  var base = "https://graph.facebook.com/" + (version || "v23.0") + "/" + encodeURIComponent(pageId);
  var url;
  var body;
  if (imageFile) {
    // 写真投稿。リンクは本文中のURLで代える
    url = base + "/photos";
    body = new FormData();
    body.set("caption", message);
    body.set("access_token", token);
    body.set("source", new Blob([fs.readFileSync(imageFile)], { type: "image/png" }), path.basename(imageFile));
  } else {
    url = base + "/feed";
    body = new URLSearchParams({ message: message, access_token: token });
    if (link) body.set("link", link);
  }
  var res = await fetch(url, { method: "POST", body: body });
  var json = await res.json().catch(function () { return {}; });
  if (!res.ok || json.error) {
    var err = json.error || {};
    throw new Error("Facebook API error " + res.status + ": " + (err.message || JSON.stringify(json)));
  }
  return json;
}

// 投稿の前に、トークンの持ち主と FB_PAGE_ID が合っているかをログに出す
// （ログは公開されることがあるので、持ち主の名前やIDは出さない）。
// 個人（ユーザー）のトークンが入っていて、そのユーザーが FB_PAGE_ID のページを管理している場合は、
// そのページのトークンを取り出して使う。戻り値は投稿に使うトークン。
async function resolveToken(pageId, token, version) {
  var base = "https://graph.facebook.com/" + (version || "v23.0");
  try {
    var me = await (await fetch(base + "/me?fields=id&access_token=" + encodeURIComponent(token))).json();
    if (me.error) {
      console.error("トークンの確認：使えません（" + me.error.message + "）");
      return token;
    }
    if (String(me.id) === String(pageId).trim()) {
      console.log("トークンの確認：持ち主と FB_PAGE_ID が一致");
      return token;
    }
    var accounts = await (await fetch(base + "/me/accounts?fields=id,access_token&limit=100&access_token=" + encodeURIComponent(token))).json();
    var page = (accounts.data || []).filter(function (a) { return String(a.id) === String(pageId).trim(); })[0];
    if (page && page.access_token) {
      console.log("トークンの確認：個人（ユーザー）のトークンです。管理しているページのトークンを取り出して投稿します。" +
        "ユーザーのトークンには期限があるので、FB_PAGE_ACCESS_TOKEN を me/accounts の結果にあるページの access_token に入れ替えてください。");
      return page.access_token;
    }
    console.log("トークンの確認：持ち主と FB_PAGE_ID が不一致" +
      (accounts.error ? "（me/accounts を読めません：" + accounts.error.message + "）"
        : "（このトークンで管理できるページ " + (accounts.data || []).length + " 件の中に FB_PAGE_ID のページがありません）"));
  } catch (e) {
    console.error("トークンの確認に失敗：" + e.message);
  }
  return token;
}

async function main() {
  var args = process.argv.slice(2);
  var dryRun = args.indexOf("--dry-run") !== -1;
  var dateArg = args.filter(function (a) { return a.indexOf("--date=") === 0; })[0];
  var imageArg = args.filter(function (a) { return a.indexOf("--image=") === 0; })[0];
  var imageFile = imageArg ? imageArg.slice(8) : "";
  if (imageFile && !fs.existsSync(imageFile)) {
    console.error(imageFile + " がないため写真なしで投稿します。");
    imageFile = "";
  }
  // --date は日本時間のその日の正午として扱う
  var date = dateArg ? new Date(dateArg.slice(7) + "T12:00:00+09:00") : new Date();
  if (isNaN(date.getTime())) {
    console.error("invalid --date");
    process.exit(2);
  }

  var siteUrl = process.env.SITE_URL || "";
  var list = topics.loadTopics();
  var topic = pickTopic(date, list);
  var featured = pickFeatured(date, topic, list);
  var message = buildMessage(topic, siteUrl, featured);

  var pageId = process.env.FB_PAGE_ID;
  var token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (dryRun || !pageId || !token) {
    if (!dryRun) console.error("FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN が未設定のため投稿せず本文を表示します。");
    console.log(message);
    return;
  }

  token = await resolveToken(pageId, token, process.env.FB_GRAPH_VERSION);
  var result = await post(pageId, token, message, siteUrl, process.env.FB_GRAPH_VERSION, imageFile);
  console.log("posted: " + (result.post_id || result.id) + " (" + topic.label + "／" + topic.name + (imageFile ? "・写真付き" : "") + ")");
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { dayIndex: dayIndex, pickTopic: pickTopic, pickFeatured: pickFeatured, buildMessage: buildMessage, post: post };
