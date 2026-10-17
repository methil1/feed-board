"""Fetch the feeds listed in mirror.json into a directory for the `mirror` branch.

Two lists in mirror.json:

- "feeds": sites that refuse requests from Cloudflare's IP ranges, so the
  Worker cannot proxy them. The raw feed is saved and the page reads it from
  here instead of the proxy.
- "archive": feeds that carry only a few items (e.g. 15). Each run parses the
  feed and merges its items into a JSON archive (newest ARCHIVE_MAX kept), so
  the page can show more items than the feed itself has. The page still loads
  these feeds live through the proxy and adds the archived items it lacks.

GitHub Actions runs this script on a schedule and publishes the result; the
page reads index.json and the files from raw.githubusercontent.com.

Usage: python tools/mirror_feeds.py mirror.json OUT_DIR

OUT_DIR may already hold the previous run. A feed that fails this time keeps its
previous file and index entry, so one bad fetch does not blank the card.
"""

import datetime
import email.utils
import hashlib
import html
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (compatible; feed-board/1.0; +https://github.com/)"
ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, */*;q=0.8"
MAX_BYTES = 5 * 1024 * 1024
FEED_MARKERS = (b"<rss", b"<rdf:rdf", b"<feed")
ARCHIVE_MAX = 60
EXCERPT_MAX = 300


def file_name(url: str, ext: str = ".xml") -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12] + ext


def fetch(url: str) -> tuple[bytes, str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": ACCEPT})
    with urllib.request.urlopen(req, timeout=20) as res:
        body = res.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("response too large")
        return body, res.headers.get("Content-Type", ""), res.geturl()


def fetch_feed(url: str) -> tuple[bytes, str, str]:
    body, content_type, final_url = fetch(url)
    head = body[:4096].lower()
    if not any(m in head for m in FEED_MARKERS):
        raise ValueError(f"not a feed ({len(body)} bytes, {content_type or 'no content type'})")
    return body, content_type, final_url


# ---- parsing (for the archive) ----

def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child(el, name):
    for c in el:
        if local(c.tag) == name:
            return c
    return None


def text_of(el, name) -> str:
    c = child(el, name)
    return (c.text or "").strip() if c is not None else ""


def http_url(raw: str, base: str) -> str:
    if not raw:
        return ""
    u = urllib.parse.urljoin(base, raw.strip())
    return u if urllib.parse.urlsplit(u).scheme in ("http", "https") else ""


def strip_html(s: str) -> str:
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def first_img(s: str, base: str) -> str:
    for m in re.finditer(r"<img\b[^>]*?\s(?:data-)?src=[\"']([^\"']+)", s or "", flags=re.I):
        u = http_url(html.unescape(m.group(1)), base)
        if u:
            return u
    return ""


def parse_date(s: str) -> int:
    """Epoch milliseconds, or 0."""
    if not s:
        return 0
    try:
        d = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return 0
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return int(d.timestamp() * 1000)


def parse_items(body: bytes, base: str) -> list[dict]:
    root = ET.fromstring(body)
    kind = local(root.tag)
    items = []
    if kind == "feed":
        for e in (c for c in root if local(c.tag) == "entry"):
            link = ""
            for l in (c for c in e if local(c.tag) == "link"):
                if l.get("rel", "alternate") == "alternate":
                    link = l.get("href", "")
                    break
            content = text_of(e, "content") or text_of(e, "summary")
            items.append({
                "title": strip_html(text_of(e, "title")),
                "link": http_url(link, base),
                "date": parse_date(text_of(e, "published") or text_of(e, "updated")),
                "excerpt": strip_html(content)[:EXCERPT_MAX],
                "image": first_img(content, base),
            })
    elif kind in ("rss", "RDF"):
        parent = child(root, "channel") if kind == "rss" else root
        for it in (c for c in (parent if parent is not None else []) if local(c.tag) == "item"):
            encoded = text_of(it, "encoded")
            desc = text_of(it, "description")
            items.append({
                "title": strip_html(text_of(it, "title")),
                "link": http_url(text_of(it, "link") or text_of(it, "guid"), base),
                "date": parse_date(text_of(it, "pubDate") or text_of(it, "date") or text_of(it, "updated")),
                "excerpt": strip_html(desc or encoded)[:EXCERPT_MAX],
                "image": first_img(encoded, base) or first_img(desc, base),
            })
    else:
        raise ValueError(f"unknown feed root <{kind}>")
    return [i for i in items if i["link"]]


def merge_archive(old: list[dict], new: list[dict]) -> list[dict]:
    by_link = {i["link"]: i for i in old if isinstance(i, dict) and i.get("link")}
    for i in new:  # newer copy wins (title edits, etc.)
        by_link[i["link"]] = i
    merged = sorted(by_link.values(), key=lambda i: i.get("date") or 0, reverse=True)
    return merged[:ARCHIVE_MAX]


# ---- main ----

def load_json(path: pathlib.Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def main(list_path: str, out_dir: str) -> int:
    conf = json.loads(pathlib.Path(list_path).read_text(encoding="utf-8"))
    mirror_urls = conf.get("feeds", [])
    archive_urls = conf.get("archive", [])
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    index_path = out / "index.json"
    prev_index = load_json(index_path, {})
    prev_feeds = prev_index.get("feeds", {})
    prev_archives = prev_index.get("archives", {})

    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    feeds, archives = {}, {}
    ok = 0
    total = len(mirror_urls) + len(archive_urls)

    for url in mirror_urls:
        name = file_name(url)
        try:
            body, content_type, final_url = fetch_feed(url)
        except Exception as exc:  # keep going; one site being down must not stop the others
            print(f"FAIL {url}: {exc}")
            if url in prev_feeds and (out / name).exists():
                feeds[url] = prev_feeds[url]
            continue
        (out / name).write_bytes(body)
        feeds[url] = {"file": name, "contentType": content_type, "finalUrl": final_url, "fetched": now}
        ok += 1
        print(f"OK   {url}: {len(body)} bytes")

    for url in archive_urls:
        name = file_name(url, ".json")
        old = load_json(out / name, {}).get("items", [])
        try:
            body, _, final_url = fetch_feed(url)
            items = merge_archive(old, parse_items(body, final_url))
        except Exception as exc:
            print(f"FAIL {url}: {exc}")
            if url in prev_archives and (out / name).exists():
                archives[url] = prev_archives[url]
            continue
        (out / name).write_text(json.dumps({"url": url, "items": items}, ensure_ascii=False) + "\n", encoding="utf-8")
        archives[url] = {"file": name, "count": len(items), "fetched": now}
        ok += 1
        print(f"OK   {url}: {len(items)} archived")

    # Drop files of feeds no longer listed.
    keep = {e["file"] for e in feeds.values()} | {e["file"] for e in archives.values()}
    for f in list(out.glob("*.xml")) + [p for p in out.glob("*.json") if p.name != "index.json"]:
        if f.name not in keep:
            f.unlink()

    index = {"updated": now, "feeds": feeds, "archives": archives}
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{ok}/{total} fetched")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
