#!/usr/bin/env python3
"""国税庁ホームページから法人税関係の公開情報を取得し、検索用 JSON を生成する。

対象:
  - 法人税基本通達      https://www.nta.go.jp/law/tsutatsu/kihon/hojin/01.htm
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


class BlockParser(HTMLParser):
    """HTML をブロック要素単位のテキスト列に平坦化する。

    各ブロックは {tag, cls, id, text, links} を持つ。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.cur = None
        self.link = None
        self.skip = 0
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

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self.skip += 1
            return
        if tag in BLOCK_TAGS:
            self._flush()
            self._new(tag, a)
        elif tag == "br":
            self.cur["parts"].append("\n")
        elif tag in ("td", "th"):
            if self.cur["parts"]:
                self.cur["parts"].append("　")
        elif tag == "a":
            if a.get("id") or a.get("name"):
                self.cur["id"] = self.cur["id"] or a.get("id") or a.get("name")
            if a.get("href"):
                self.link = {"href": a["href"], "text": ""}

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.skip = max(0, self.skip - 1)
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
        self.cur["parts"].append(data)
        if self.link is not None:
            self.link["text"] += data

    def close(self):
        super().close()
        self._flush()
        return self.blocks


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


TSUTATSU_NO = re.compile(r"^(\d+(?:の\d+)?(?:[－\-‐−]\d+(?:の\d+)*)+)[\s\u3000]+(?=\S)")


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
    print(f"[通達] 目次 {len(pages)} ページ", file=sys.stderr)

    records = []
    for n, pg in enumerate(pages, 1):
        print(f"[通達] {n}/{len(pages)} {pg['url']}", file=sys.stderr)
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
            if b["tag"] in ("h2",) and re.match(r"^[（(].*[)）]$", b["text"]):
                caption = b["text"]
                continue
            if b["tag"] in ("h2", "h3", "h4", "h5"):
                heading = b["text"]
                caption = ""
                continue
            m = TSUTATSU_NO.match(b["text"]) if b["tag"] == "p" else None
            if m:
                number = m.group(1)
                body = b["text"][m.end():]
                items.append({"number": number, "caption": caption, "heading": heading, "lines": [body]})
                caption = ""
            elif items and b["text"]:
                items[-1]["lines"].append(b["text"])
        if not items:
            # 附則など、番号付きの項目で構成されないページはページ単位で収録
            text = "\n".join(b["text"] for b in blocks_of(body_area(doc))
                             if b["text"] and b["tag"] != "h1" and b["cls"] != "page-top-link")
            if text:
                records.append({
                    "id": "tsutatsu:" + urlparse(pg["url"]).path.split("/hojin/")[1],
                    "source": "tsutatsu", "number": "", "title": page_title,
                    "category": pg["chapter"], "path": path, "body": text, "url": pg["url"],
                })
            continue
        for it in items:
            num_ascii = it["number"].replace("－", "-").replace("‐", "-").replace("−", "-")
            title = it["caption"].strip("（）()") if it["caption"] else (it["heading"] or page_title)
            records.append({
                "id": "tsutatsu:" + num_ascii,
                "source": "tsutatsu",
                "number": it["number"],
                "title": title,
                "category": pg["chapter"],
                "path": path + ([it["heading"]] if it["heading"] and it["heading"] not in path else []),
                "body": "\n".join(it["lines"]),
                "url": pg["url"],
            })
    return records


# ---------------------------------------------------------------- 質疑応答事例

SHITSUGI_SECTIONS = ("照会要旨", "回答要旨", "関係法令通達")


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
        sections, cur, note = {}, None, ""
        for b in blocks_of(body_area(doc)):
            if b["tag"] == "h1" or b["cls"] in ("skip", "page-top-link"):
                continue
            if b["tag"].startswith("h"):
                key = b["text"].strip("【】[]")
                cur = key
                sections.setdefault(cur, [])
                continue
            if "red" in b["cls"].split() and b["text"].startswith("注記"):
                note = b["text"]
                continue
            if cur and b["text"]:
                sections[cur].append(b["text"])
        body_parts = []
        for k, v in sections.items():
            if v:
                body_parts.append(f"【{k}】\n" + "\n".join(v))
        m = re.search(r"([令平]和?成?\d+年\d+月\d+日)現在", note)
        rid = urlparse(e["url"]).path.split("/hojin/")[1].removesuffix(".htm")
        records.append({
            "id": "shitsugi:" + rid,
            "source": "shitsugi",
            "number": "",
            "title": title_of(doc) or e["title"],
            "category": e["category"],
            "path": [e["category"]],
            "body": "\n".join(body_parts),
            "laws": "\n".join(sections.get("関係法令通達", [])),
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
        sections, cur, asof, h1 = {}, None, "", ""
        for b in blocks_of(frag):
            if b["tag"] == "h1":
                h1 = b["text"]
                continue
            if b["tag"] == "h2":
                cur = b["text"]
                sections.setdefault(cur, [])
                continue
            if cur is None:
                m = re.match(r"^\[(.+?)現在法令等\]$", b["text"])
                if m:
                    asof = m.group(1)
                continue
            if cur == "お問い合わせ先":
                continue
            if b["text"]:
                sections[cur].append(("■ " if b["tag"] in ("h3", "h4") else "") + b["text"])
        number = ""
        m = re.match(r"^No\.(\d+(?:-\d+)?)\s*(.*)$", h1)
        if m:
            number, title = m.group(1), m.group(2)
        else:
            title = h1 or e["title"]
        body = "\n".join(f"【{k}】\n" + "\n".join(v) for k, v in sections.items()
                         if v and k not in ("お問い合わせ先", "対象税目"))
        records.append({
            "id": "taxanswer:" + (number or urlparse(e["url"]).path.rsplit("/", 1)[1]),
            "source": "taxanswer",
            "number": number,
            "title": title,
            "category": e["category"],
            "path": [e["category"]],
            "body": body,
            "laws": "\n".join(sections.get("根拠法令等", [])),
            "asof": asof,
            "url": e["url"],
        })
    return records


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--delay", type=float, default=1.0, help="ネットワークアクセスの間隔（秒）")
    ap.add_argument("--refresh", action="store_true", help="キャッシュを無視して再取得する")
    ap.add_argument("--only", choices=["tsutatsu", "shitsugi", "taxanswer"], action="append")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    f = Fetcher(args.delay, args.refresh)
    targets = args.only or ["tsutatsu", "shitsugi", "taxanswer"]
    crawlers = {"tsutatsu": crawl_tsutatsu, "shitsugi": crawl_shitsugi, "taxanswer": crawl_taxanswer}
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
