#!/usr/bin/env node
/*
 * Facebook投稿に添えるカード（1080×1080）をSVGで作り、PNGに変換する。
 * その日のテーマ名・区分と、今日紹介する通達・記事（題名と原文の抜粋）を載せる。
 * 紹介する通達・記事がない日は、テーマの説明文の冒頭を載せる。
 *
 *   node scripts/facebook-image.js <出力.png|出力.svg> [--date=YYYY-MM-DD]
 *
 * PNGへの変換には rsvg-convert（librsvg2-bin）と日本語フォント
 * （fonts-noto-cjk）が必要。GitHub Actions ではワークフローでインストールする。
 */
"use strict";

var fs = require("fs");
var childProcess = require("child_process");
var topics = require("./topics.js");

var SIZE = 1080;
var FONT = "'Noto Sans CJK JP', 'Noto Sans JP', 'WenQuanYi Zen Hei', sans-serif";

// style.css の出典の色に合わせ、区分のまとまりごとに色を分ける
var PALETTE = {
  green: { main: "#15803d", bg: "#e9f8ee", soft: "#bfe8cc" },
  orange: { main: "#c2410c", bg: "#fff1e8", soft: "#fdd9c2" },
  blue: { main: "#1d4ed8", bg: "#e8effe", soft: "#c3d4fb" },
  purple: { main: "#7e22ce", bg: "#f4eafd", soft: "#e0c7f8" },
};
var GROUP_COLOR = {
  ekin: "green", sonkin: "orange",
  zeiritsu: "blue", zeigaku: "blue", aoiro: "blue", shinkoku: "blue", gaikoku: "blue", kokusai: "blue",
  dozoku: "purple", tsusan: "purple", koeki: "purple", setsuritsu: "purple", haigyo: "purple",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 全角を1、半角を0.55として幅を数える
function charWidth(ch) {
  return /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.55 : 1;
}

function textWidth(s) {
  var w = 0;
  for (var ch of s) w += charWidth(ch);
  return w;
}

// 行頭に来てはいけない文字
var NO_START = "、。，．・：；？！）」』】〕ー～ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ";

// 1行あたり max（全角文字数）で折り返し、maxLines を超えたら「…」で切る
function wrap(s, max, maxLines) {
  var lines = [];
  var cur = "";
  var w = 0;
  for (var ch of s) {
    var cw = charWidth(ch);
    if (w + cw > max && cur && NO_START.indexOf(ch) === -1) {
      lines.push(cur);
      cur = "";
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    var last = lines[maxLines - 1];
    while (textWidth(last) > max - 1) last = Array.from(last).slice(0, -1).join("");
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

function buildSvg(topic, featured) {
  var c = PALETTE[GROUP_COLOR[topic.group] || "blue"];
  var out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + " " + SIZE + '" font-family="' + FONT + '">');
  out.push('<rect width="100%" height="100%" fill="' + c.bg + '"/>');
  out.push('<rect x="40" y="40" width="1000" height="1000" rx="36" fill="#fff"/>');
  out.push('<rect x="40" y="40" width="1000" height="16" rx="8" fill="' + c.main + '"/>');

  // 見出しと区分のバッジ
  out.push('<text x="96" y="132" font-size="36" font-weight="700" fill="' + c.main + '">今日の法人税</text>');
  var badgeW = Math.round(textWidth(topic.label) * 36 + 56);
  out.push('<rect x="96" y="166" width="' + badgeW + '" height="66" rx="33" fill="' + c.main + '"/>');
  out.push('<text x="' + (96 + badgeW / 2) + '" y="211" text-anchor="middle" font-size="36" font-weight="700" fill="#fff">' + esc(topic.label) + "</text>");

  // テーマ名（長い名前は文字を小さくして3行まで）
  var long = textWidth(topic.name) > 28;
  var nameSize = long ? 52 : 64;
  var nameLines = long ? wrap(topic.name, 16, 3) : wrap(topic.name, 14, 2);
  var y = 320;
  nameLines.forEach(function (line) {
    out.push('<text x="96" y="' + y + '" font-size="' + nameSize + '" font-weight="700" fill="#1f2937">' + esc(line) + "</text>");
    y += nameSize + 18;
  });

  // 区切り線から下：今日の通達・記事（題名と原文の抜粋）。ない日はテーマの説明文の冒頭
  var dy = y + 30;
  out.push('<rect x="96" y="' + (dy - 50) + '" width="888" height="2" fill="' + c.soft + '"/>');
  if (featured) {
    out.push('<text x="96" y="' + dy + '" font-size="30" font-weight="700" fill="' + c.main + '">今日の通達・記事</text>');
    dy += 54;
    wrap(topics.itemLabel(featured), 22, 2).forEach(function (line) {
      out.push('<text x="96" y="' + dy + '" font-size="38" font-weight="700" fill="#1f2937">' + esc(line) + "</text>");
      dy += 50;
    });
    dy += 14;
    var exLines = Math.max(2, Math.floor((900 - dy) / 44));
    out.push('<rect x="96" y="' + (dy - 34) + '" width="6" height="' + (exLines * 44 - 6) + '" rx="3" fill="' + c.soft + '"/>');
    // 段落（【照会】【回答】や小見出し）ごとに行を改める。入りきらない分は最後の行を「…」で切る
    var exText = [];
    topics.excerpt(featured, 200).split("\n").forEach(function (para) {
      var room = exLines - exText.length;
      if (room <= 0) {
        exText[exLines - 1] = exText[exLines - 1].replace(/…?$/, "…");
        return;
      }
      exText = exText.concat(wrap(para, 27, room));
    });
    exText.slice(0, exLines).forEach(function (line, i) {
      out.push('<text x="124" y="' + (dy + i * 44) + '" font-size="31" fill="#374151">' + esc(line) + "</text>");
    });
  } else {
    var maxLines = Math.max(3, Math.floor((880 - dy) / 52));
    wrap(topic.desc, 24, maxLines).forEach(function (line, i) {
      out.push('<text x="96" y="' + (dy + i * 52) + '" font-size="36" fill="#374151">' + esc(line) + "</text>");
    });
  }

  // 関連する通達・記事の件数
  if (topic.items.length) {
    var note = "関連する通達・記事 " + topic.items.length + " 件";
    var noteW = Math.round(textWidth(note) * 30 + 48);
    out.push('<rect x="96" y="930" width="' + noteW + '" height="60" rx="30" fill="' + c.bg + '" stroke="' + c.main + '" stroke-width="3"/>');
    out.push('<text x="' + (96 + noteW / 2) + '" y="971" text-anchor="middle" font-size="30" font-weight="700" fill="' + c.main + '">' + esc(note) + "</text>");
  }

  // フッター
  out.push('<text x="984" y="1010" text-anchor="end" font-size="28" font-weight="700" fill="' + c.main + '">法人税区分辞書</text>');
  out.push("</svg>");
  return out.join("\n");
}

function renderPng(svg, outFile) {
  var tmp = outFile.replace(/\.png$/, "") + ".svg";
  fs.writeFileSync(tmp, svg);
  childProcess.execFileSync("rsvg-convert", ["-w", String(SIZE), "-h", String(SIZE), "-o", outFile, tmp]);
  fs.unlinkSync(tmp);
}

function main() {
  var post = require("./facebook-post.js");
  var args = process.argv.slice(2);
  var outFile = args.filter(function (a) { return a.indexOf("--") !== 0; })[0];
  var dateArg = args.filter(function (a) { return a.indexOf("--date=") === 0; })[0];
  if (!outFile) {
    console.error("usage: node scripts/facebook-image.js <out.png|out.svg> [--date=YYYY-MM-DD]");
    process.exit(2);
  }
  var date = dateArg ? new Date(dateArg.slice(7) + "T12:00:00+09:00") : new Date();
  var list = topics.loadTopics();
  var topic = post.pickTopic(date, list);
  var svg = buildSvg(topic, post.pickFeatured(date, topic, list));
  if (/\.svg$/.test(outFile)) fs.writeFileSync(outFile, svg);
  else renderPng(svg, outFile);
  console.log(outFile + " (" + topic.label + "／" + topic.name + ")");
}

if (require.main === module) main();

module.exports = { buildSvg: buildSvg, renderPng: renderPng, wrap: wrap };
