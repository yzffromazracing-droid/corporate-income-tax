#!/usr/bin/env node
/*
 * 辞書のテーマを1日1件、Facebookページに投稿する。
 *
 *   node scripts/facebook-post.js [--dry-run] [--date=YYYY-MM-DD] [--image=画像.png]
 *
 * 環境変数:
 *   FB_PAGE_ID           : 投稿先のFacebookページID
 *   FB_PAGE_ACCESS_TOKEN : ページアクセストークン（pages_manage_posts 権限）
 *   FB_GRAPH_VERSION     : Graph APIのバージョン（任意。既定 v23.0）
 *
 * テーマは日付（日本時間）から決まるので、テーマの数（約185）の日数で全テーマを一巡する。
 * 毎回、テーマの関連項目から通達・記事を 1 件選んで「今日の通達・記事」として紹介する
 * （一巡するたびに次の項目に替わる）。本文はテーマの説明文（bunrui.js）と、
 * 国税庁の原文の抜粋・題名で、新しく文章を作ったり言い換えたりはしない。
 * --image を指定し、そのファイルがあれば写真付きで投稿する（本文は写真の説明文になる）。
 * --dry-run またはトークン未設定のときは投稿せず本文を表示するだけ。
 * 二重投稿を防ぐため、投稿の前に次のどちらかに当たれば投稿しない（--force で無視できる）：
 *   ・GitHub Actions 上で、このワークフローのその日（日本時間）のほかの実行（dry run を除く）が成功している
 *   ・ページのその日の投稿に、同じ見出し（【今日の法人税】テーマ名）で始まるものがある
 * facebook-overrides.json（任意）で日付ごとに投稿を止めたり、テーマ・通達を差し替えたりできる：
 *   { "2026-11-20": "skip",                       … その日は投稿しない
 *     "2026-11-21": "交際費等の範囲",              … テーマを差し替える（テーマ名）
 *     "2026-11-22": { "topic": "交際費等の範囲", "featured": "tsutatsu:9-2-12" } }  … 紹介する通達・記事も指定
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

// 日本時間の時（0～23）
function jstHour(date) {
  return new Date(date.getTime() + JST_OFFSET_MS).getUTCHours();
}

// 定期実行がこの時刻（日本時間）より前に動いたときは、前日分が遅れて動いたものとみなす
var LATE_SCHEDULE_HOUR = 13;

// 日本時間の日付（YYYY-MM-DD）
function jstDate(date) {
  return new Date(dayIndex(date) * DAY_MS).toISOString().slice(0, 10);
}

function loadOverrides() {
  var file = path.join(__dirname, "..", "facebook-overrides.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// その日に投稿するテーマと紹介する通達・記事。投稿しない日は null
function pickForDate(date, list, overrides) {
  list = list || topics.loadTopics();
  var o = (overrides || loadOverrides())[jstDate(date)];
  if (o === "skip") return null;
  var spec = typeof o === "string" ? { topic: o } : o || {};
  var topic = pickTopic(date, list);
  if (spec.topic) {
    topic = list.filter(function (t) { return t.name === spec.topic; })[0];
    if (!topic) throw new Error("facebook-overrides.json のテーマが見つかりません: " + spec.topic);
  }
  var featured = pickFeatured(date, topic, list);
  if (spec.featured) {
    featured = topic.items.filter(function (r) { return r.id === spec.featured; })[0];
    if (!featured) throw new Error("facebook-overrides.json の通達・記事がテーマの関連項目にありません: " + spec.featured);
  }
  return { topic: topic, featured: featured };
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

// 公開ページ（辞書のサイト）のアドレスは載せない
function buildMessage(topic, featured) {
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
    lines.push("");
    lines.push("🔗 国税庁ホームページの原文はこちら");
    lines.push(featured.url);
  }
  var others = topic.items.filter(function (r) { return r !== featured; });
  if (others.length) {
    lines.push("");
    lines.push("■ " + (featured ? "ほかの" : "") + "関連する通達・記事" + (others.length > OTHER_ITEMS ? "（全" + topic.items.length + "件から）" : ""));
    others.slice(0, OTHER_ITEMS).forEach(function (r) {
      lines.push("・" + topics.itemLabel(r));
    });
  }
  lines.push("");
  lines.push("※ テーマの説明は辞書による概要、抜粋は国税庁ホームページの原文です（取得時点のもの）。実際の適用は必ず原文でご確認ください。");
  lines.push("");
  var tags = ["#法人税"].concat(topic.label.split("／").map(hashtag), ["#経理", "#税務"]);
  lines.push(tags.filter(function (t, i) { return tags.indexOf(t) === i; }).join(" "));
  return lines.join("\n");
}

async function post(pageId, token, message, version, imageFile) {
  var base = "https://graph.facebook.com/" + (version || "v23.0") + "/" + encodeURIComponent(pageId);
  var url;
  var body;
  if (imageFile) {
    // 写真投稿
    url = base + "/photos";
    body = new FormData();
    body.set("caption", message);
    body.set("access_token", token);
    body.set("source", new Blob([fs.readFileSync(imageFile)], { type: "image/png" }), path.basename(imageFile));
  } else {
    url = base + "/feed";
    body = new URLSearchParams({ message: message, access_token: token });
  }
  var res = await fetch(url, { method: "POST", body: body });
  var json = await res.json().catch(function () { return {}; });
  if (!res.ok || json.error) {
    var err = json.error || {};
    throw new Error("Facebook API error " + res.status + ": " + (err.message || JSON.stringify(json)));
  }
  return json;
}

// その日（日本時間）の 0 時の UNIX 時刻（秒）
function jstMidnight(date) {
  return Math.floor((dayIndex(date) * DAY_MS - JST_OFFSET_MS) / 1000);
}

// GitHub Actions 上で、このワークフローのその日のほかの実行（dry run を除く）が成功していれば、その実行番号を返す
async function postedByOtherRun(date) {
  var token = process.env.GITHUB_TOKEN;
  var repo = process.env.GITHUB_REPOSITORY;
  var runId = process.env.GITHUB_RUN_ID;
  var workflowRef = process.env.GITHUB_WORKFLOW_REF || "";
  if (!token || !repo || !runId) return null;
  var file = (workflowRef.split("@")[0].split("/").pop()) || "facebook-daily.yml";
  var since = new Date(jstMidnight(date) * 1000).toISOString();
  var url = "https://api.github.com/repos/" + repo + "/actions/workflows/" + encodeURIComponent(file) +
    "/runs?per_page=50&created=" + encodeURIComponent(">=" + since);
  var res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error("GitHub API " + res.status);
  var json = await res.json();
  var hit = (json.workflow_runs || []).filter(function (r) {
    // 日付をまたいで遅れた定期実行（13 時より前に動いたもの）は投稿せずに終わっているので数えない
    var lateSchedule = r.event === "schedule" && jstHour(new Date(r.created_at)) < LATE_SCHEDULE_HOUR;
    return String(r.id) !== String(runId) && r.conclusion === "success" && !lateSchedule && !/dry run/i.test(r.display_title || "");
  })[0];
  return hit ? hit.run_number : null;
}

// ページのその日の投稿に、同じ見出しで始まるものがあれば true
async function postedOnPage(pageId, token, topic, date, version) {
  var head = "【今日の法人税】" + topic.name;
  var url = "https://graph.facebook.com/" + (version || "v23.0") + "/" + encodeURIComponent(pageId) +
    "/posts?fields=message&limit=25&since=" + jstMidnight(date) + "&access_token=" + encodeURIComponent(token);
  var json = await (await fetch(url)).json();
  if (json.error) throw new Error(json.error.message);
  return (json.data || []).some(function (p) {
    return (p.message || "").indexOf(head) === 0;
  });
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
  var force = args.indexOf("--force") !== -1;
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

  // GitHub の定期実行（13:47 の予定）が大きく遅れて、日付が変わってから動いたときは前日分の遅れとみなし、
  // 投稿しない（前日分は 15:47 の予備起動で投稿済み。そのまま動くと翌日のテーマが深夜に出てしまう）
  if (!dateArg && process.env.GITHUB_EVENT_NAME === "schedule" && jstHour(date) < LATE_SCHEDULE_HOUR) {
    console.log("定期実行が日付をまたいで遅れて動いたため（日本時間 " + jstDate(date) + " " + jstHour(date) + " 時台）、前日分の遅れとみなして投稿しません。");
    return;
  }

  var picked = pickForDate(date);
  if (!picked) {
    console.log(jstDate(date) + " は facebook-overrides.json で投稿しない日に指定されています。");
    return;
  }
  var topic = picked.topic;
  var message = buildMessage(topic, picked.featured);

  var pageId = process.env.FB_PAGE_ID;
  var token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (dryRun || !pageId || !token) {
    if (!dryRun) console.error("FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN が未設定のため投稿せず本文を表示します。");
    console.log(message);
    return;
  }

  token = await resolveToken(pageId, token, process.env.FB_GRAPH_VERSION);

  // 二重投稿の防止（確認できなかったときはログに書いて投稿を続ける）
  if (!force) {
    try {
      var other = await postedByOtherRun(date);
      if (other) {
        console.log(jstDate(date) + " はこのワークフローの実行 #" + other + " で投稿済みのため投稿しません。");
        return;
      }
    } catch (e) {
      console.error("GitHub の実行記録を確認できませんでした：" + e.message);
    }
    try {
      if (await postedOnPage(pageId, token, topic, date, process.env.FB_GRAPH_VERSION)) {
        console.log(jstDate(date) + " はページに同じ見出しの投稿があるため投稿しません。");
        return;
      }
    } catch (e) {
      console.error("ページの投稿を確認できませんでした：" + e.message);
    }
  }
  var result = await post(pageId, token, message, process.env.FB_GRAPH_VERSION, imageFile);
  console.log("posted: " + (result.post_id || result.id) + " (" + topic.label + "／" + topic.name + (imageFile ? "・写真付き" : "") + ")");
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { main: main, dayIndex: dayIndex, jstDate: jstDate, jstMidnight: jstMidnight, pickTopic: pickTopic, pickFeatured: pickFeatured, pickForDate: pickForDate, buildMessage: buildMessage, post: post };
