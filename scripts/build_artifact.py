#!/usr/bin/env python3
"""Claude の Artifact で公開するためのファイル一式を作る。

  python3 scripts/build_artifact.py 出力先ディレクトリ

GitHub Pages 版と同じ app.js・bunrui.js・data/ をコピーし、次の 2 点だけ Artifact 向けに直す。
  - index.html … Artifact が外枠（doctype・head・body）を付けるので、中身だけにする
  - style.css  … 表示設定（ライト／ダーク）の切り替えに従うよう色を変数にし、スマホの画面端の余白をとる
style.css の書き換え対象が見つからないときは止まる（元の CSS が変わったら、この置き換えも直す）。
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def replace_once(text, old, new, label):
    if old not in text:
        sys.exit(f"style.css に「{label}」が見つかりません。scripts/build_artifact.py の置き換えを直してください")
    return text.replace(old, new, 1)


def sub_once(pattern, repl, text, label, flags=0):
    text, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1:
        sys.exit(f"style.css に「{label}」が見つかりません。scripts/build_artifact.py の置き換えを直してください")
    return text


def build_css(css):
    # 暗い表示の色：OS の設定に加え、Artifact の data-theme の指定にも従う
    m = re.search(r"@media \(prefers-color-scheme: dark\) \{\n  :root \{\n(.*?)\n  \}\n\}\n", css, re.S)
    if not m:
        sys.exit("style.css に暗い表示の色の定義が見つかりません")
    css = replace_once(css, "  --men-bg: #f4eafd;\n}", "  --men-bg: #f4eafd;\n  --on-accent: #ffffff;\n  --mark: #fff3a3;\n}", "明るい表示の色の定義")
    dark = m.group(1) + "\n    --on-accent: #12151b;\n    --mark: #5c4d12;\n    color-scheme: dark;"
    css = css.replace(
        m.group(0),
        '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n' + dark + "\n  }\n}\n"
        ':root[data-theme="dark"] {\n' + "\n".join(("  " + line.strip()).rstrip() for line in dark.splitlines()) + "\n}\n",
    )
    # 表示設定ごとに書き分けていた文字色・強調色を変数にする
    css = replace_once(
        css,
        ".chip.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }",
        ".chip.is-active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }",
        "選択中のボタンの文字色",
    )
    css = sub_once(r"@media \(prefers-color-scheme: dark\) \{\n  \.chip\.is-active \{ color: #12151b; \}\n\}\n", "", css, "暗い表示のボタンの文字色")
    css = sub_once(r"@media \(prefers-color-scheme: dark\) \{\n  \.btn \{ color: #12151b; \}\n\}\n", "", css, "暗い表示の .btn の文字色")
    css = sub_once(r"@media \(prefers-color-scheme: dark\) \{\n  mark \{ background: #5c4d12; \}\n\}\n", "", css, "暗い表示の強調色")
    css = replace_once(css, "mark { background: #fff3a3;", "mark { background: var(--mark);", "強調色")
    css = sub_once(r"(\.btn \{[^}]*?)color: #fff;", r"\1color: var(--on-accent);", css, ".btn の文字色", re.S)
    # スマホの画面端（セーフエリア）の余白
    css = replace_once(
        css,
        "  padding-left: 16px;\n  padding-right: 16px;\n}",
        "  padding-left: max(16px, env(safe-area-inset-left, 0px));\n  padding-right: max(16px, env(safe-area-inset-right, 0px));\n}",
        "左右の余白",
    )
    css = replace_once(css, ".site-header {\n  position: sticky;\n  top: 0;", ".site-header {\n  position: sticky;\n  top: env(safe-area-inset-top, 0px);", "上部に固定する見出し")
    css += '\nbody::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--surface); }\n'
    return css


def build_html(html):
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    head = re.sub(r'\s*<meta charset[^>]*>|\s*<meta name="viewport"[^>]*>', "", head)
    head = head.replace("<title>法人税区分辞書</title>", '<title>法人税区分辞書</title>\n  <meta name="claude:viewport-fit-sides" content="cover">')
    return head.strip() + "\n" + body.strip() + "\n"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    (out / "data").mkdir(parents=True, exist_ok=True)
    for name in ("app.js", "bunrui.js", "data/hojin.json", "data/yomi.json"):
        shutil.copy(ROOT / name, out / name)
    (out / "style.css").write_text(build_css((ROOT / "style.css").read_text(encoding="utf-8")), encoding="utf-8")
    (out / "index.html").write_text(build_html((ROOT / "index.html").read_text(encoding="utf-8")), encoding="utf-8")
    print(f"{out}: index.html, style.css, app.js, bunrui.js, data/hojin.json, data/yomi.json")


if __name__ == "__main__":
    main()
