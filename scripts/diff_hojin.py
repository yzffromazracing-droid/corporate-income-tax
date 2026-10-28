#!/usr/bin/env python3
"""2 つの data/hojin.json を比べ、追加・削除・内容が変わった項目を表示する。

  python3 scripts/diff_hojin.py 旧.json 新.json            # 一覧（Markdown）
  python3 scripts/diff_hojin.py 旧.json 新.json --quiet    # 件数だけ

取得日時（generated_at）の違いは無視する。変更があれば終了コード 0、なければ 2 を返す。
"""

import argparse
import json
import sys

LABEL = {"tsutatsu": "法人税基本通達", "sochiho": "措置法通達", "taxanswer": "タックスアンサー",
         "shitsugi": "質疑応答事例", "bunsho": "文書回答事例"}
FIELDS = ("number", "title", "category", "path", "blocks", "url", "asof", "laws", "date", "dept")


def load(p):
    with open(p, encoding="utf-8") as f:
        return {r["id"]: r for r in json.load(f)["records"]}


def name(r):
    return f"{LABEL.get(r['source'], r['source'])} {r.get('number') or ''} {r['title']}".replace("  ", " ")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    old, new = load(args.old), load(args.new)
    added = [new[i] for i in new if i not in old]
    removed = [old[i] for i in old if i not in new]
    changed = []
    for i in new:
        if i in old:
            diff = [f for f in FIELDS if old[i].get(f) != new[i].get(f)]
            if diff:
                changed.append((new[i], diff))

    print(f"追加 {len(added)} 件・削除 {len(removed)} 件・内容の変更 {len(changed)} 件")
    if not args.quiet:
        for title, rows in (("追加", added), ("削除", removed)):
            if rows:
                print(f"\n### {title}")
                for r in rows:
                    print(f"- {name(r)}（{r['url']}）")
        if changed:
            print("\n### 内容の変更")
            for r, diff in changed:
                print(f"- {name(r)}（変わった欄: {', '.join(diff)}）")
    sys.exit(0 if added or removed or changed else 2)


if __name__ == "__main__":
    main()
