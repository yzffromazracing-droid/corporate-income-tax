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
 * 本文はテーマの説明文（bunrui.js）と関連する通達・記事の題名で、新しく文章を作ることはしない。
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
var ITEMS_IN_POST = 4; // 本文に載せる関連項目の数

// 日本時間の日付を 1970-01-01 からの日数にする
function dayIndex(date) {
  return Math.floor((date.getTime() + JST_OFFSET_MS) / DAY_MS);
}

function pickTopic(date, list) {
  list = list || topics.loadTopics();
  var n = dayIndex(date) % list.length;
  return list[(n + list.length) % list.length];
}

function hashtag(s) {
  return "#" + s.replace(/[\s・（）()／/、%％「」]/g, "");
}

function buildMessage(topic, siteUrl) {
  var lines = [];
  lines.push("【今日の法人税】" + topic.name);
  lines.push("");
  lines.push("▶ 区分：" + topic.label);
  lines.push("");
  lines.push(topic.desc);
  if (topic.items.length) {
    lines.push("");
    lines.push("■ 関連する通達・記事" + (topic.items.length > ITEMS_IN_POST ? "（全" + topic.items.length + "件から抜粋）" : ""));
    topic.items.slice(0, ITEMS_IN_POST).forEach(function (r) {
      lines.push("・" + topics.itemLabel(r));
    });
  }
  if (siteUrl) {
    lines.push("");
    lines.push("ほかのテーマや通達・記事の全文は「法人税区分辞書」で調べられます。");
    lines.push(siteUrl);
  }
  lines.push("");
  lines.push("※ 説明文は辞書による概要です。実際の適用は国税庁の原文でご確認ください。");
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
  var topic = pickTopic(date);
  var message = buildMessage(topic, siteUrl);

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

module.exports = { dayIndex: dayIndex, pickTopic: pickTopic, buildMessage: buildMessage, post: post };
