#!/usr/bin/env python3
"""国税庁の「主な減価償却資産の耐用年数表」（PDF）を取得し、data/taiyo.json を生成する。

出典:
  タックスアンサー No.2100 減価償却のあらまし
    https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm
  主な減価償却資産の耐用年数表（同ページの PDF）
    https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/pdf/2100_01.pdf

使い方:
  python3 scripts/fetch_taiyo.py            # 取得して data/taiyo.json を出力
  python3 scripts/fetch_taiyo.py --pdf x.pdf  # 手元の PDF から生成

PDF の文字と位置は pdftotext -bbox（poppler-utils）で読み取る。表の文字をそのまま使い、
内容の補完・要約は一切行わない。表の配置が変わって読み取れないときは、推測で埋めずに
エラーで止まる（列の位置 COLUMNS を PDF に合わせて直すこと）。
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
import urllib.request
from pathlib import Path

PDF_URL = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/pdf/2100_01.pdf"
PAGE_URL = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm"
EGOV_URL = "https://elaws.e-gov.go.jp/search/elawsSearch/elaws_search/lsg0500/detail?lawId=340M50000040015"
USER_AGENT = "hojin-jiten-fetcher/1.0 (+https://github.com/yzffromazracing-droid/corporate-income-tax)"
ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "taiyo.json"

# ページごとの左右 2 つの表の列の位置（pt）：(表の左端, 表の右端, 構造・用途｜細目の境, 細目｜耐用年数の境)
COLUMNS = [
    [(40, 300, 120, 265), (300, 560, 370, 515)],
    [(40, 300, 130, 275), (300, 560, 380, 525)],
]
SECTIONS = ["建物", "建物附属設備", "車両・運搬具", "工具", "器具・備品", "機械・装置"]

WORD_RE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')


def read_lines(bbox_html):
    """表ごとに、同じ高さの語を 1 行にまとめ、列（構造・用途／細目／耐用年数）に分ける。"""
    pages = bbox_html.split("<page ")[1:]
    if len(pages) != len(COLUMNS):
        raise SystemExit("PDF のページ数が %d です（%d ページを想定）。" % (len(pages), len(COLUMNS)))
    out = []
    for pi, pg in enumerate(pages):
        words = [(float(a), float(b), w) for a, b, _c, _d, w in WORD_RE.findall(pg)]
        for ti, (x0, x1, sb, yb) in enumerate(COLUMNS[pi]):
            lines = []
            for w in sorted((w for w in words if x0 <= w[0] < x1), key=lambda w: (w[1], w[0])):
                if lines and abs(lines[-1]["y"] - w[1]) < 3:
                    lines[-1]["w"].append(w)
                else:
                    lines.append({"y": w[1], "w": [w]})
            for line in lines:
                ws = sorted(line["w"])
                detail = [w for w in ws if sb <= w[0] < yb]
                out.append({
                    "key": (pi, ti),
                    "y": line["y"],
                    "s": "".join(w[2] for w in ws if w[0] < sb),
                    "d": "".join(w[2] for w in detail),
                    "dx": detail[0][0] if detail else None,
                    "yr": "".join(w[2] for w in ws if w[0] >= yb),
                })
    return out


def build_rows(lines):
    rows = []
    years_total = 0
    for key in sorted({l["key"] for l in lines}):
        section = None
        groups = []
        prev_y = None
        for l in (l for l in lines if l["key"] == key):
            m = re.match(r"＜(.+?)＞", l["s"])
            if m:
                section = re.sub(r"\s", "", m.group(1).replace("のつづき", ""))
                prev_y = None
                continue
            if l["s"] in ("構造・用途", "設備の種類", "主な減価償却資産の耐用年数表") or l["yr"] in ("耐用", "年数", "年"):
                prev_y = None
                continue
            # 罫線で区切られた行（構造・用途）のまとまり：前の行と 10pt 以上離れたら新しいまとまり
            if prev_y is None or l["y"] - prev_y > 10:
                groups.append({"section": section, "struct": "", "lines": []})
            groups[-1]["struct"] += l["s"]
            groups[-1]["lines"].append(l)
            prev_y = l["y"]
        for g in groups:
            if g["section"] not in SECTIONS:
                raise SystemExit("想定外の区分: %r" % g["section"])
            items, years = [], []
            for l in g["lines"]:
                extra = ""
                if l["yr"]:
                    m = re.match(r"^(\D*)([0-9０-９]+)$", l["yr"])
                    if not m:
                        raise SystemExit("耐用年数を読めません: %r（%s）" % (l["yr"], g["struct"]))
                    extra = m.group(1)
                    years.append((l["y"], int(unicodedata.normalize("NFKC", m.group(2)))))
                last = items[-1] if items else None
                if l["d"]:
                    text = l["d"] + extra
                    # 年数のない行に続く、同じ字下げ（または大きく字下げした）行は折り返しとしてつなげる。
                    # 2 行にまたがる項目の年数は 2 行の間に置かれるので、その場合は次の 1 行だけつなげる
                    if last and not last["closed"] and (abs(l["dx"] - last["dx"]) < 1 or l["dx"] - last["dx"] > 15):
                        last["text"] += text
                        last["ys"].append(l["y"])
                        last["closed"] = bool(l["yr"]) or last["pending"]
                    else:
                        items.append({"dx": l["dx"], "text": text, "ys": [l["y"]], "closed": bool(l["yr"]), "pending": False})
                else:
                    g["struct"] += extra
                    if l["yr"] and last and not last["closed"]:
                        last["pending"] = True
            years_total += len(years)
            if not items:
                if len(years) != 1:
                    raise SystemExit("耐用年数の数が合いません: %s %r" % (g["struct"], years))
                rows.append({"section": g["section"], "struct": g["struct"], "path": [], "detail": "", "years": years[0][1]})
                continue
            for it in items:
                it["year"] = None
                it["c"] = (min(it["ys"]) + max(it["ys"])) / 2
            # 耐用年数は、高さが重なる（±4.5pt）細目のうち最も近いものに当てる
            for y, v in years:
                cand = [it for it in items if min(it["ys"]) - 4.5 <= y <= max(it["ys"]) + 4.5]
                if not cand:
                    raise SystemExit("耐用年数 %d に当たる細目がありません: %s" % (v, g["struct"]))
                it = min(cand, key=lambda it: abs(it["c"] - y))
                if it["year"] is not None:
                    raise SystemExit("細目に耐用年数が 2 つ当たりました: %s %s" % (g["struct"], it["text"]))
                it["year"] = v
            # 字下げの深さで親子関係をたどり、年数のある細目ごとに 1 行にする
            stack = []
            for it in items:
                while stack and stack[-1]["dx"] >= it["dx"] - 1:
                    stack.pop()
                if it["year"] is not None:
                    rows.append({"section": g["section"], "struct": g["struct"], "path": [p["text"] for p in stack],
                                 "detail": it["text"], "years": it["year"]})
                stack.append(it)
    if years_total != len(rows):
        raise SystemExit("耐用年数 %d 個のうち %d 個しか細目に当たりませんでした。" % (years_total, len(rows)))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pdf", help="取得済みの PDF を使う")
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        pdf = Path(args.pdf) if args.pdf else Path(tmp) / "2100_01.pdf"
        if not args.pdf:
            req = urllib.request.Request(PDF_URL, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as res:
                pdf.write_bytes(res.read())
        bbox = Path(tmp) / "bbox.html"
        subprocess.run(["pdftotext", "-bbox", str(pdf), str(bbox)], check=True)
        rows = build_rows(read_lines(bbox.read_text(encoding="utf-8")))

    sections = []
    for name in SECTIONS:
        rs = [{k: r[k] for k in ("struct", "path", "detail", "years")} for r in rows if r["section"] == name]
        if not rs:
            raise SystemExit("区分「%s」の行がありません。" % name)
        sections.append({"name": name, "rows": rs})
    data = {
        "title": "主な減価償却資産の耐用年数表",
        "source_url": PDF_URL,
        "page_url": PAGE_URL,
        "egov_url": EGOV_URL,
        "generated_at": datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(timespec="seconds"),
        "sections": sections,
    }
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("%s: %d 行（%s）" % (args.out, len(rows), "、".join("%s %d" % (s["name"], len(s["rows"])) for s in sections)))


if __name__ == "__main__":
    main()
