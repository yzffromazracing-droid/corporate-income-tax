#!/usr/bin/env python3
"""e-Gov 法令 API から「減価償却資産の耐用年数等に関する省令」の別表（第一〜第十一）を取得し、
data/beppyo.json を生成する。

出典:
  減価償却資産の耐用年数等に関する省令（昭和四十年大蔵省令第十五号）
    https://laws.e-gov.go.jp/law/340M50000040015
  本文 XML  : https://laws.e-gov.go.jp/api/1/lawdata/340M50000040015
  改正の情報: https://laws.e-gov.go.jp/api/2/laws?law_id=340M50000040015

使い方:
  python3 scripts/fetch_beppyo.py

標準ライブラリのみで動作する。表の行・セル（行の結合・罫線）は XML のとおりに写し、
細目の親子関係などは推測で補わない。変える点は、年数・率だけのセルの漢数字を算用数字に
置き換えること（「五〇」→「50」、「〇・三三四」→「0.334」）と、ルビの読みを除くことだけ。
"""

import argparse
import datetime
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

LAW_ID = "340M50000040015"
XML_URL = "https://laws.e-gov.go.jp/api/1/lawdata/" + LAW_ID
INFO_URL = "https://laws.e-gov.go.jp/api/2/laws?law_id=" + LAW_ID
LAW_URL = "https://laws.e-gov.go.jp/law/" + LAW_ID
USER_AGENT = "hojin-jiten-fetcher/1.0 (+https://github.com/yzffromazracing-droid/corporate-income-tax)"
ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "beppyo.json"

KANJI_DIGITS = str.maketrans("〇一二三四五六七八九・", "0123456789.")
NUMERIC = re.compile(r"^[〇一二三四五六七八九]+(?:・[〇一二三四五六七八九]+)?$")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def text(e):
    """要素の文字（ルビの読み Rt は除く）。"""
    out = e.text or ""
    for c in e:
        if c.tag != "Rt":
            out += text(c)
        out += c.tail or ""
    return out


def cell(col):
    t = "\n".join(text(s).strip() for s in col.findall("Sentence")).strip()
    if t == "　":
        t = ""
    if NUMERIC.match(t):
        t = t.translate(KANJI_DIGITS)
        if "." not in t:
            t = str(int(t))
    c = {"t": t}
    if col.get("rowspan"):
        c["r"] = int(col.get("rowspan"))
    if col.get("colspan"):
        c["c"] = int(col.get("colspan"))
    # 罫線：上・下の線がないセル（細目が続いていることを表す）
    nb = ("t" if col.get("BorderTop") == "none" else "") + ("b" if col.get("BorderBottom") == "none" else "")
    if nb:
        c["nb"] = nb
    return c


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    root = ET.fromstring(get(XML_URL))
    if root.findtext("Result/Code") != "0":
        raise SystemExit("e-Gov API のエラー: " + (root.findtext("Result/Message") or ""))
    body = root.find(".//LawBody")
    title = text(body.find("LawTitle")).strip()
    info = json.loads(get(INFO_URL))["laws"][0]
    rev = info["revision_info"]

    tables = []
    for a in body.findall("AppdxTable"):
        no = text(a.find("AppdxTableTitle")).strip()
        name = text(a.find("RelatedArticleNum")).strip() if a.find("RelatedArticleNum") is not None else ""
        rows = [[cell(c) for c in tr.findall("TableColumn")] for tr in a.iter("TableRow")]
        # 表の頭：「種類｜…｜耐用年数」の行と、単位（年）の行
        head = 1
        while head < len(rows) and all(c["t"] in ("", "年") for c in rows[head]) and any(c["t"] == "年" for c in rows[head]):
            head += 1
        if len(rows) <= head:
            raise SystemExit("%s の行がありません。" % no)
        tables.append({"no": no, "name": name, "head": rows[:head], "rows": rows[head:]})
    if len(tables) < 6 or not tables[0]["no"].startswith("別表第一"):
        raise SystemExit("別表を読み取れませんでした（%d 表）。" % len(tables))

    data = {
        "law_title": title,
        "law_num": info["law_info"]["law_num"],
        "law_url": LAW_URL,
        "amendment_law_num": rev.get("amendment_law_num"),
        "amendment_enforcement_date": rev.get("amendment_enforcement_date"),
        "egov_updated": rev.get("updated"),
        "generated_at": datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat(timespec="seconds"),
        "tables": tables,
    }
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("%s: %s（最終改正 %s、施行 %s）" % (args.out, title, data["amendment_law_num"], data["amendment_enforcement_date"]))
    for t in tables:
        print("  %s %s：%d 行" % (t["no"], t["name"], len(t["rows"])))


if __name__ == "__main__":
    main()
