#!/usr/bin/env python3
"""国税庁ホームページから法人税関係の公開情報を取得し、検索用 JSON を生成する。

対象:
  - 法人税基本通達      https://www.nta.go.jp/law/tsutatsu/kihon/hojin/01.htm
  - 租税特別措置法関係通達（法人税編）
                        https://www.nta.go.jp/law/tsutatsu/kobetsu/hojin/sochiho/750214/01.htm
  - 質疑応答事例（法人税） https://www.nta.go.jp/law/shitsugi/hojin/01.htm
  - タックスアンサー（法人税） https://www.nta.go.jp/taxes/shiraberu/taxanswer/code/index.htm#code07

使い方:
  python3 scripts/fetch_nta.py                 # 取得して data/hojin.json を出力
  python3 scripts/fetch_nta.py --delay 2       # アクセス間隔（秒）を変更
  python3 scripts/fetch_nta.py --refresh       # キャッシュを使わず再取得

標準ライブラリのみで動作する。取得した HTML は .cache/ に保存し、再実行時は再利用する。
本文は取得した HTML からそのまま抽出しており、内容の補完・要約は一切行わない。
"""

import argparse
import datetime
import html
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

BASE = "https://www.nta.go.jp"
TSUTATSU_INDEX = BASE + "/law/tsutatsu/kihon/hojin/01.htm"
SOCHIHO_INDEX = BASE + "/law/tsutatsu/kobetsu/hojin/sochiho/750214/01.htm"
SHITSUGI_INDEX = BASE + "/law/shitsugi/hojin/01.htm"
TAXANSWER_INDEX = BASE + "/taxes/shiraberu/taxanswer/code/index.htm"

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "nta"
OUT_PATH = ROOT / "data" / "hojin.json"

USER_AGENT = "hojin-jiten-fetcher/1.0 (+https://github.com/yzffromazracing-droid/corporate-income-tax)"

BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "tr", "dt", "dd", "div", "ul", "ol", "table"}


# ---------------------------------------------------------------- HTTP

class Fetcher:
    def __init__(self, delay, refresh):
        self.delay = delay
        self.refresh = refresh
        self._last = 0.0
        self.network_count = 0

    def get(self, url):
        """URL の HTML を文字列で返す。リダイレクトで 404 ページへ飛んだ場合は None。"""
        path = urlparse(url).path.lstrip("/")
        cache = CACHE_DIR / path
        if cache.exists() and not self.refresh:
            raw = cache.read_bytes()
        else:
            wait = self.delay - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(req, timeout=60) as res:
                        final = res.geturl()
                        raw = res.read()
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 3:
                        raise
                    print(f"  retry {url}: {e}", file=sys.stderr)
                    time.sleep(2 ** (attempt + 1))
            self._last = time.time()
            self.network_count += 1
            if "/error/" in urlparse(final).path:
                print(f"  404: {url}", file=sys.stderr)
                return None
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(raw)
        return decode(raw)


def decode(raw):
    head = raw[:2048].decode("ascii", "ignore").lower()
    m = re.search(r"charset=[\"']?([a-z0-9_\-]+)", head)
    enc = (m.group(1) if m else "utf-8").replace("shift_jis", "cp932").replace("x-sjis", "cp932")
    return raw.decode(enc, "replace")


# ---------------------------------------------------------------- HTML helpers

def norm_space(s):
    s = s.replace("\r", "").replace(" ", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return s.strip()


def title_of(doc):
    m = re.search(r"<title>(.*?)</title>", doc, re.S)
    t = html.unescape(m.group(1)) if m else ""
    return norm_space(t.split("｜")[0])


def body_area(doc):
    """通達・質疑応答事例ページの本文領域（h1 から左カラム末尾まで）を切り出す。"""
    i = doc.find("<h1")
    if i < 0:
        return ""
    ends = [k for k in (doc.find("<!--/left-menu-->", i), doc.find('<div class="right-menu"', i)) if k > 0]
    return doc[i:min(ends)] if ends else doc[i:]


def circled(n):
    if 1 <= n <= 20:
        return chr(0x2460 + n - 1)
    if 21 <= n <= 35:
        return chr(0x3251 + n - 21)
    if 36 <= n <= 50:
        return chr(0x32B1 + n - 36)
    return f"({n})"


# 国税庁ページで文字の代わりに使われている画像（画像の内容を確認して対応付けた）
MARK_IMAGES = {"m2": "㎡", "mm": "㎜", "cc": "㏄", "t": "t", "kara": "〜"}


def img_text(src, alt):
    """本文中の画像を文字に置き換える。丸数字・単位記号は文字に、図は［図：…（原文を参照）］とする。"""
    path = urlparse(src or "").path
    m = re.search(r"/(?:shared/images/decimal|category/icon_img/no_img)/0*(\d+)\.gif$", path)
    if m:
        return circled(int(m.group(1)))
    m = re.search(r"/category/icon_img/roman/0*(\d+)(s?)\.gif$", path)
    if m and 1 <= int(m.group(1)) <= 12:
        return chr((0x2170 if m.group(2) else 0x2160) + int(m.group(1)) - 1)
    m = re.search(r"/shared/images/mark/([a-z0-9]+)\.gif$", path)
    if m and m.group(1) in MARK_IMAGES:
        return MARK_IMAGES[m.group(1)]
    if "/template/" in path or path.startswith("/img/"):
        return ""
    alt = norm_space(alt or "")
    return f"［図：{alt}（原文を参照）］" if alt else "［図（原文を参照）］"


class BlockParser(HTMLParser):
    """HTML をブロック要素単位のテキスト列に平坦化する。

    各ブロックは {tag, cls, id, text, links} を持つ。表は tag="table" で、rows に
    セル {x: 文字列, h: 見出しセルか, r: rowspan, c: colspan} の二次元配列を持つ。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.cur = None
        self.link = None
        self.skip = 0
        self.table = None   # 表の読み取り中: {"rows": [...], "depth": 入れ子の深さ}
        self.cell = None
        self._new("text", {})

    def _new(self, tag, attrs):
        self.cur = {"tag": tag, "cls": attrs.get("class", "") or "", "id": attrs.get("id", "") or "",
                    "parts": [], "links": []}

    def _flush(self):
        c = self.cur
        text = norm_space("".join(c["parts"]))
        if text or c["links"] or c["id"]:
            self.blocks.append({"tag": c["tag"], "cls": c["cls"], "id": c["id"], "text": text,
                                "links": c["links"]})

    def _emit(self, s):
        if self.cell is not None:
            self.cell["parts"].append(s)
        elif self.table is None:
            self.cur["parts"].append(s)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self.skip += 1
            return
        if self.table is not None:
            if tag == "table":
                self.table["depth"] += 1
            elif self.table["depth"] == 1 and tag == "tr":
                self.table["rows"].append([])
            elif self.table["depth"] == 1 and tag in ("td", "th"):
                if not self.table["rows"]:
                    self.table["rows"].append([])
                self.cell = {"parts": [], "h": tag == "th",
                             "r": int(a.get("rowspan") or 1), "c": int(a.get("colspan") or 1)}
            elif tag in ("br", "p", "li", "div", "tr") and self.cell is not None:
                self.cell["parts"].append("\n")
            elif tag == "img":
                self._emit(img_text(a.get("src"), a.get("alt")))
            return
        if tag == "table":
            self._flush()
            self.table = {"rows": [], "depth": 1}
            return
        if tag in BLOCK_TAGS:
            self._flush()
            self._new(tag, a)
        elif tag == "br":
            self.cur["parts"].append("\n")
        elif tag == "img":
            self._emit(img_text(a.get("src"), a.get("alt")))
        elif tag == "a":
            if a.get("id") or a.get("name"):
                self.cur["id"] = self.cur["id"] or a.get("id") or a.get("name")
            if a.get("href"):
                self.link = {"href": a["href"], "text": ""}

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.skip = max(0, self.skip - 1)
            return
        if self.table is not None:
            if tag == "table":
                self.table["depth"] -= 1
                if self.table["depth"] == 0:
                    rows = [r for r in self.table["rows"] if r]
                    if rows:
                        self.blocks.append({"tag": "table", "cls": "", "id": "", "links": [], "rows": rows,
                                            "text": "\n".join("　".join(c["x"] for c in r) for r in rows)})
                    self.table = None
                    self._new("text", {})
            elif self.table["depth"] == 1 and tag in ("td", "th") and self.cell is not None:
                cell = self.cell
                self.cell = None
                self.table["rows"][-1].append({"x": norm_space("".join(cell["parts"])), "h": cell["h"],
                                               "r": cell["r"], "c": cell["c"]})
            return
        if tag in BLOCK_TAGS:
            self._flush()
            self._new("text", {})
        elif tag == "a" and self.link is not None:
            self.link["text"] = norm_space(self.link["text"])
            self.cur["links"].append(self.link)
            self.link = None

    def handle_data(self, data):
        if self.skip:
            return
        self._emit(data)
        if self.link is not None and self.table is None:
            self.link["text"] += data

    def close(self):
        super().close()
        self._flush()
        return self.blocks


def to_block(b):
    """表示用の本文ブロック（JSON の blocks の要素）に変換する。

    ["h", 見出しレベル, 文字列] / ["p", 文字列] / ["li", 文字列] /
    ["t", 行の配列]（セルは {"x": 文字列, "h": 1（見出しセル）, "r": rowspan, "c": colspan}）
    """
    if b["tag"] == "table":
        rows = []
        for r in b["rows"]:
            row = []
            for c in r:
                cell = {"x": c["x"]}
                if c["h"]:
                    cell["h"] = 1
                if c["r"] > 1:
                    cell["r"] = c["r"]
                if c["c"] > 1:
                    cell["c"] = c["c"]
                row.append(cell)
            rows.append(row)
        return ["t", rows]
    if b["tag"] == "h2":
        return ["h", 2, b["text"]]
    if b["tag"] in ("h3", "h4", "h5", "h6"):
        return ["h", 3, b["text"]]
    if b["tag"] == "li":
        return ["li", b["text"]]
    return ["p", b["text"]]


def blocks_of(fragment):
    p = BlockParser()
    p.feed(fragment)
    return p.close()


# ---------------------------------------------------------------- 法人税基本通達

class TsutatsuIndexParser(HTMLParser):
    """目次から (章, 上位の節, リンク文字列, URL) を順に取り出す。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chapter = ""
        self.in_h2 = False
        self.h2buf = ""
        self.li_stack = []
        self.link = None
        self.entries = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "h2":
            self.in_h2, self.h2buf = True, ""
        elif tag == "li":
            self.li_stack.append("")
        elif tag == "a" and a.get("href"):
            self.link = {"href": a["href"], "text": ""}

    def handle_endtag(self, tag):
        if tag == "h2":
            self.in_h2 = False
            self.chapter = norm_space(self.h2buf)
        elif tag == "li" and self.li_stack:
            self.li_stack.pop()
        elif tag == "a" and self.link is not None:
            parents = [norm_space(t) for t in self.li_stack[:-1] if norm_space(t)]
            self.entries.append({"chapter": self.chapter, "parents": parents,
                                 "text": norm_space(self.link["text"]), "href": self.link["href"]})
            self.link = None

    def handle_data(self, data):
        if self.in_h2:
            self.h2buf += data
        if self.link is not None:
            self.link["text"] += data
        elif self.li_stack:
            self.li_stack[-1] += data


# 通達番号（例: 9－2－12、12の5－3－3、42の3の2-1、61の4(1)－15の2、42の6～47（共）－1）
TSUTATSU_NO = re.compile(r"^(\d+(?:の\d+)*(?:～\d+(?:の\d+)*)?(?:[(（](?:\d+|共)[)）])?(?:[－\-‐−]\d+(?:の\d+)*)+)[\s\u3000]+(?=\S)")


def crawl_tsutatsu(f):
    doc = f.get(TSUTATSU_INDEX)
    ip = TsutatsuIndexParser()
    ip.feed(body_area(doc) or doc)
    pages, seen = [], set()
    for e in ip.entries:
        url = urljoin(TSUTATSU_INDEX, e["href"]).split("#")[0]
        p = urlparse(url).path
        if not p.startswith("/law/tsutatsu/kihon/hojin/") or "/zenbun/" in p or url == TSUTATSU_INDEX:
            continue
        if url in seen:
            continue
        seen.add(url)
        pages.append({**e, "url": url})
    return parse_tsutatsu_pages(f, pages, "tsutatsu", "/law/tsutatsu/kihon/hojin/", "通達")


def crawl_sochiho(f):
    """租税特別措置法関係通達（法人税編）。目次は 章（indent1）› 条関係（indent2）› 款（indent3）の段落で並ぶ。"""
    doc = f.get(SOCHIHO_INDEX)
    base = "/law/tsutatsu/kobetsu/hojin/sochiho/750214/"
    chapter, article, pages, seen = "", "", [], set()
    for b in blocks_of(body_area(doc)):
        if b["cls"] == "indent1":
            chapter, article = b["text"], ""
        elif b["cls"] == "indent2":
            article = b["text"]
        for l in b["links"]:
            url = urljoin(SOCHIHO_INDEX, l["href"]).split("#")[0]
            p = urlparse(url).path
            if not p.startswith(base) or "/zenbun/" in p or url == SOCHIHO_INDEX or url in seen:
                continue
            seen.add(url)
            parents = [article] if b["cls"] == "indent3" and article else []
            pages.append({"chapter": chapter, "parents": parents, "text": l["text"], "url": url})
    return parse_tsutatsu_pages(f, pages, "sochiho", base, "措置法")


def parse_tsutatsu_pages(f, pages, source, base, label):
    """通達の各ページを通達番号ごとの項目に分ける。pages は {chapter, parents, text, url} の目次順の列。"""
    print(f"[{label}] 目次 {len(pages)} ページ", file=sys.stderr)
    records = []
    for n, pg in enumerate(pages, 1):
        print(f"[{label}] {n}/{len(pages)} {pg['url']}", file=sys.stderr)
        doc = f.get(pg["url"])
        if doc is None:
            continue
        page_title = title_of(doc)
        path = [pg["chapter"]] + pg["parents"] + [pg["text"] or page_title]
        path = [x for x in path if x]
        items, caption, heading = [], "", ""
        for b in blocks_of(body_area(doc)):
            if b["tag"] == "h1" or b["cls"] in ("skip", "page-top-link"):
                continue
            # 見出し「（…）」。閉じ括弧が欠けているページもあるため開き括弧だけで判定する
            if b["tag"] in ("h2",) and re.match(r"^[（(]", b["text"]):
                caption = b["text"]
                continue
            if b["tag"] in ("h2", "h3", "h4", "h5"):
                heading = b["text"]
                # 括弧なしで書かれた見出しもある（例: 12の5－3－3）。直後が通達ならその見出しとして使う
                caption = "" if re.match(r"^第[0-9０-９一二三四五六七八九十]", b["text"]) else b["text"]
                continue
            # 番号の途中に改行が入っているページがある（例: 「63<br>(4)－18」）
            text = re.sub(r"^(\d+(?:の\d+)*)\s+(?=[(（])", r"\1", b["text"]) if b["tag"] == "p" else ""
            m = TSUTATSU_NO.match(text)
            if m:
                number = m.group(1)
                body = text[m.end():]
                if caption == heading:
                    heading = ""
                items.append({"number": number, "caption": caption, "heading": heading, "blocks": [["p", body]]})
                caption = ""
            elif items and b["text"]:
                items[-1]["blocks"].append(to_block(b))
        if not items:
            # 附則など、番号付きの項目で構成されないページはページ単位で収録
            blocks = [to_block(b) for b in blocks_of(body_area(doc))
                      if b["text"] and b["tag"] != "h1" and b["cls"] not in ("skip", "page-top-link")]
            if blocks:
                records.append({
                    "id": f"{source}:" + urlparse(pg["url"]).path[len(base):],
                    "source": source, "number": "", "title": page_title,
                    "category": pg["chapter"], "path": path, "blocks": blocks, "url": pg["url"],
                })
            continue
        for it in items:
            num_ascii = it["number"].replace("－", "-").replace("‐", "-").replace("−", "-")
            if it["caption"]:
                title = it["caption"].strip("（）() ")
            elif re.match(r"^削除|^[（(].*削除[)）]$", it["blocks"][0][1]):
                title = "削除"
            else:
                title = "（見出しなし）"
            records.append({
                "id": f"{source}:" + num_ascii,
                "source": source,
                "number": it["number"],
                "title": title,
                "category": pg["chapter"],
                "path": path + ([it["heading"]] if it["heading"] and it["heading"] not in path else []),
                "blocks": it["blocks"],
                "url": pg["url"],
            })
    return records


# ---------------------------------------------------------------- 質疑応答事例

def crawl_shitsugi(f):
    doc = f.get(SHITSUGI_INDEX)
    cat, entries, seen = "", [], set()
    for b in blocks_of(body_area(doc) or doc):
        if b["id"].startswith("a-") and b["text"]:
            cat = b["text"].strip("（）()")
        for l in b["links"]:
            url = urljoin(SHITSUGI_INDEX, l["href"]).split("#")[0]
            if not urlparse(url).path.startswith("/law/shitsugi/hojin/") or url == SHITSUGI_INDEX:
                continue
            if url in seen or not cat:
                continue
            seen.add(url)
            entries.append({"category": cat, "title": l["text"], "url": url})
    print(f"[質疑] 目次 {len(entries)} 件", file=sys.stderr)

    records = []
    for n, e in enumerate(entries, 1):
        print(f"[質疑] {n}/{len(entries)} {e['url']}", file=sys.stderr)
        doc = f.get(e["url"])
        if doc is None:
            continue
        blocks, laws, cur, note = [], [], None, ""
        for b in blocks_of(body_area(doc)):
            if b["tag"] == "h1" or b["cls"] in ("skip", "page-top-link") or not b["text"]:
                continue
            if b["tag"].startswith("h"):
                cur = b["text"].strip("【】[]")
                blocks.append(["h", 2, cur])
                continue
            if "red" in b["cls"].split() and b["text"].startswith("注記"):
                note = b["text"]
            elif cur == "関係法令通達":
                laws.append(b["text"])
            if cur:
                blocks.append(to_block(b))
        m = re.search(r"([令平]和?成?\d+年\d+月\d+日)現在", note)
        rid = urlparse(e["url"]).path.split("/hojin/")[1].removesuffix(".htm")
        records.append({
            "id": "shitsugi:" + rid,
            "source": "shitsugi",
            "number": "",
            "title": title_of(doc) or e["title"],
            "category": e["category"],
            "path": [e["category"]],
            "blocks": blocks,
            "laws": "\n".join(laws),
            "asof": m.group(1) if m else "",
            "url": e["url"],
        })
    return records


# ---------------------------------------------------------------- タックスアンサー

def crawl_taxanswer(f):
    doc = f.get(TAXANSWER_INDEX)
    i = doc.find('<h2 id="code07"')
    j = doc.find("<h2", i + 10)
    cat, entries, seen = "", [], set()
    for b in blocks_of(doc[i:j]):
        if b["tag"] == "h3":
            cat = b["text"]
        for l in b["links"]:
            url = urljoin(TAXANSWER_INDEX, l["href"]).split("#")[0]
            if not urlparse(url).path.startswith("/taxes/shiraberu/taxanswer/hojin/") or url in seen:
                continue
            seen.add(url)
            entries.append({"category": cat, "title": l["text"], "url": url})
    print(f"[TA] 目次 {len(entries)} 件", file=sys.stderr)

    records = []
    for n, e in enumerate(entries, 1):
        print(f"[TA] {n}/{len(entries)} {e['url']}", file=sys.stderr)
        doc = f.get(e["url"])
        if doc is None:
            continue
        a = doc.find("<h1")
        z = doc.find('<div class="contents-feedback"', a)
        frag = doc[a:z if z > a else None]
        blocks, laws, cur, asof, h1 = [], [], None, "", ""
        for b in blocks_of(frag):
            if b["tag"] == "h1":
                h1 = b["text"]
                continue
            if not b["text"]:
                continue
            if b["tag"] == "h2":
                cur = b["text"]
                if cur != "お問い合わせ先":
                    blocks.append(["h", 2, cur])
                continue
            if cur is None:
                m = re.match(r"^\[(.+?)現在法令等\]$", b["text"])
                if m:
                    asof = m.group(1)
                continue
            if cur == "お問い合わせ先":
                continue
            if cur == "根拠法令等":
                laws.append(b["text"])
            blocks.append(to_block(b))
        number = ""
        m = re.match(r"^No\.(\d+(?:-\d+)?)\s*(.*)$", h1)
        if m:
            number, title = m.group(1), m.group(2)
        else:
            title = h1 or e["title"]
        records.append({
            "id": "taxanswer:" + (number or urlparse(e["url"]).path.rsplit("/", 1)[1]),
            "source": "taxanswer",
            "number": number,
            "title": title,
            "category": e["category"],
            "path": [e["category"]],
            "blocks": blocks,
            "laws": "\n".join(laws),
            "asof": asof,
            "url": e["url"],
        })
    return records


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--delay", type=float, default=1.0, help="ネットワークアクセスの間隔（秒）")
    ap.add_argument("--refresh", action="store_true", help="キャッシュを無視して再取得する")
    ap.add_argument("--only", choices=["tsutatsu", "sochiho", "shitsugi", "taxanswer"], action="append")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    f = Fetcher(args.delay, args.refresh)
    targets = args.only or ["tsutatsu", "sochiho", "shitsugi", "taxanswer"]
    crawlers = {"tsutatsu": crawl_tsutatsu, "sochiho": crawl_sochiho, "shitsugi": crawl_shitsugi,
                "taxanswer": crawl_taxanswer}
    records = []
    for t in targets:
        records += crawlers[t](f)

    # id 重複（同一通達番号が複数ページに現れる等）を避ける
    counts = {}
    for r in records:
        counts[r["id"]] = counts.get(r["id"], 0) + 1
        if counts[r["id"]] > 1:
            r["id"] += f"#{counts[r['id']]}"

    out = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "tsutatsu": {"label": "法人税基本通達", "index": TSUTATSU_INDEX},
            "sochiho": {"label": "租税特別措置法関係通達（法人税編）", "index": SOCHIHO_INDEX},
            "shitsugi": {"label": "質疑応答事例", "index": SHITSUGI_INDEX},
            "taxanswer": {"label": "タックスアンサー", "index": TAXANSWER_INDEX + "#code07"},
        },
        "records": records,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    by = {}
    for r in records:
        by[r["source"]] = by.get(r["source"], 0) + 1
    print(f"wrote {args.out} : {len(records)} records {by} (network fetches: {f.network_count})", file=sys.stderr)


if __name__ == "__main__":
    main()
