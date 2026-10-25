#!/usr/bin/env python3
"""読み仮名検索用の読み表（data/yomi.json）を作る。

data/hojin.json の見出し・本文に現れる漢字・カタカナの語について、
IPADIC（mecab-ipadic）の辞書に載っている読みを使って読み仮名（ひらがな）を付ける。
辞書は自分で取得して、そのディレクトリを --ipadic に指定する（CSV ファイルが入ったもの）。

  git clone --depth 1 --filter=blob:none --sparse https://github.com/taku910/mecab.git
  (cd mecab && git sparse-checkout set mecab-ipadic)
  python3 scripts/build_yomi.py --ipadic mecab/mecab-ipadic

語の区切りと読みは、辞書の単語コスト（連接コストは使わない）の合計が最小になる分け方で決める。
法令文で送り仮名を省く複合語（貸倒・支払・取扱 など）は OVERRIDES で読みを補う。
出力は [読み, "表記|表記|…"] を読みの順に並べた配列。アプリは検索語がひらがな・カタカナだけのとき、
読みが検索語で始まる語の表記に置き換えて検索する。
"""

import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 法令文で送り仮名を省く複合語など、辞書にないか読みが分かれるもの
OVERRIDES = {
    "貸倒": "かしだおれ", "引当": "ひきあて", "支払": "しはらい", "取扱": "とりあつかい", "払込": "はらいこみ",
    "借入": "かりいれ", "貸付": "かしつけ", "売上": "うりあげ", "仕入": "しいれ", "見積": "みつもり",
    "割引": "わりびき", "割増": "わりまし", "申込": "もうしこみ", "引渡": "ひきわたし", "取壊": "とりこわし",
    "買換": "かいかえ", "振替": "ふりかえ", "立退": "たちのき", "前払": "まえばらい", "未払": "みばらい",
    "積立": "つみたて", "打切": "うちきり", "切捨": "きりすて", "払戻": "はらいもどし", "差押": "さしおさえ",
    "取崩": "とりくずし", "組入": "くみいれ", "払出": "はらいだし", "繰入": "くりいれ", "戻入": "れいにゅう",
    "受入": "うけいれ", "取替": "とりかえ", "書換": "かきかえ", "借換": "かりかえ", "下請": "したうけ",
    "元請": "もとうけ", "請負": "うけおい", "借地": "しゃくち", "借家": "しゃくや", "受贈": "じゅぞう",
    "繰戻": "くりもどし", "取止": "とりやめ", "取消": "とりけし", "引継": "ひきつぎ", "引受": "ひきうけ",
    "受託": "じゅたく", "預託": "よたく", "払下": "はらいさげ", "譲受": "ゆずりうけ", "買取": "かいとり",
    "売戻": "うりもどし", "買戻": "かいもどし", "取立": "とりたて", "締切": "しめきり", "借受": "かりうけ",
    "貸借": "たいしゃく", "売渡": "うりわたし", "款": "かん", "補塡": "ほてん", "充塡": "じゅうてん",
    "租特": "そとく", "負担分": "ふたんぶん",
}

WORD = re.compile(r"[一-鿿々〆ヵヶァ-ヺー]+")
HAS_WORD_CHAR = re.compile(r"[一-鿿々ァ-ヶー]")
KATA = re.compile(r"[ァ-ヶー]")
MAX_TOKENS = 3  # 連続する語を何語までつなげて登録するか
CONJ = {"及", "又", "並", "若", "其", "且"}  # 「及び」「又は」などの送り仮名が落ちた接続の字は語に含めない


def kata2hira(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def read_csv(path):
    with open(path, encoding="euc_jp", errors="ignore", newline="") as f:
        for row in csv.reader(f):
            if len(row) >= 12 and row[11] and row[11] != "*":
                yield row


def load_dict(ipadic):
    """表記 → (コスト, 読み)。同じ表記はコストの小さいものを採る。"""
    d = {}
    for path in sorted(Path(ipadic).glob("*.csv")):
        for row in read_csv(path):
            surf, cost, reading = row[0], int(row[3]), kata2hira(row[11])
            if not HAS_WORD_CHAR.search(surf):
                continue
            if surf not in d or cost < d[surf][0]:
                d[surf] = (cost, reading)
    # 動詞・形容詞（漢字 1 字＋送り仮名）の語幹から漢字 1 字の読みを補う（受・含・掲 など）
    stems = {}
    for name in ("Verb.csv", "Adj.csv"):
        for row in read_csv(Path(ipadic) / name):
            m = re.match(r"^([一-鿿])([ぁ-ゖ]+)$", row[0])
            reading = kata2hira(row[11])
            if not m or not reading.endswith(m.group(2)) or len(reading) <= len(m.group(2)):
                continue
            cost = int(row[3]) + 8000
            if m.group(1) not in stems or cost < stems[m.group(1)][0]:
                stems[m.group(1)] = (cost, reading[: -len(m.group(2))])
    for k, v in stems.items():
        d.setdefault(k, v)
    for k, v in OVERRIDES.items():
        d[k] = (100, v)
    return d


def segment(s, d, maxlen=8):
    """コストの合計が最小になる分け方で [(表記, 読み or None), …] を返す。"""
    n = len(s)
    best = [(0, [])] + [None] * n
    for i in range(n):
        if best[i] is None:
            continue
        for length in range(1, min(maxlen, n - i) + 1):
            w = s[i : i + length]
            e = d.get(w)
            if e is None:
                if length > 1:
                    continue
                e = (10000, kata2hira(w)) if KATA.match(w) else (30000, None)
            cost = best[i][0] + e[0] + (0 if length > 1 else 2000)
            if best[i + length] is None or cost < best[i + length][0]:
                best[i + length] = (cost, best[i][1] + [(w, e[1])])
    return best[n][1]


def record_text(r):
    parts = [r["title"], " ".join(r["path"])]
    for b in r["blocks"]:
        if b[0] == "t":
            parts += [c["x"] for row in b[1] for c in row]
        else:
            parts.append(b[-1])
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ipadic", required=True, help="mecab-ipadic の CSV が入ったディレクトリ")
    args = ap.parse_args()

    d = load_dict(args.ipadic)
    records = json.loads((ROOT / "data" / "hojin.json").read_text(encoding="utf-8"))["records"]
    words = set()
    for r in records:
        words.update(WORD.findall(record_text(r)))

    yomi = {}
    for w in sorted(words):
        tokens = segment(w, d)
        if len(tokens) > 12:
            continue
        # 語を 1〜MAX_TOKENS 語つなげたものを登録する（読みが分からない語を含むものは除く）
        for i in range(len(tokens)):
            for j in range(i + 1, min(i + MAX_TOKENS, len(tokens)) + 1):
                part = tokens[i:j]
                if any(rd is None or t in CONJ for t, rd in part):
                    break
                surf = "".join(t for t, _ in part)
                yomi.setdefault(surf, "".join(rd for _, rd in part))

    by_reading = {}
    for surf, rd in yomi.items():
        if rd != surf:
            by_reading.setdefault(rd, []).append(surf)
    out = [[rd, "|".join(sorted(s))] for rd, s in sorted(by_reading.items())]
    path = ROOT / "data" / "yomi.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: 読み {len(out)} 件、表記 {len(yomi)} 件")


if __name__ == "__main__":
    main()
