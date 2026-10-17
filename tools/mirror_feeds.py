"""Fetch the feeds listed in mirror.json into a directory for the `mirror` branch.

Some sites refuse requests from Cloudflare's IP ranges, so the Worker cannot
proxy them. GitHub Actions runs this script on a schedule and publishes the
result; the page reads index.json and the feed files from raw.githubusercontent.com.

Usage: python tools/mirror_feeds.py mirror.json OUT_DIR

OUT_DIR may already hold the previous run. A feed that fails this time keeps its
previous file and index entry, so one bad fetch does not blank the card.
"""

import datetime
import hashlib
import json
import pathlib
import sys
import urllib.request

UA = "Mozilla/5.0 (compatible; feed-board/1.0; +https://github.com/)"
ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, */*;q=0.8"
MAX_BYTES = 5 * 1024 * 1024
FEED_MARKERS = (b"<rss", b"<rdf:rdf", b"<feed")


def file_name(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12] + ".xml"


def fetch(url: str) -> tuple[bytes, str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": ACCEPT})
    with urllib.request.urlopen(req, timeout=20) as res:
        body = res.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("response too large")
        return body, res.headers.get("Content-Type", ""), res.geturl()


def looks_like_feed(body: bytes) -> bool:
    head = body[:4096].lower()
    return any(m in head for m in FEED_MARKERS)


def main(list_path: str, out_dir: str) -> int:
    urls = json.loads(pathlib.Path(list_path).read_text(encoding="utf-8"))["feeds"]
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    index_path = out / "index.json"
    try:
        previous = json.loads(index_path.read_text(encoding="utf-8")).get("feeds", {})
    except (OSError, ValueError):
        previous = {}

    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    feeds = {}
    fetched = 0
    for url in urls:
        name = file_name(url)
        try:
            body, content_type, final_url = fetch(url)
            if not looks_like_feed(body):
                raise ValueError(f"not a feed ({len(body)} bytes, {content_type or 'no content type'})")
        except Exception as exc:  # keep going; one site being down must not stop the others
            print(f"FAIL {url}: {exc}")
            if url in previous and (out / name).exists():
                feeds[url] = previous[url]
            continue
        (out / name).write_bytes(body)
        feeds[url] = {"file": name, "contentType": content_type, "finalUrl": final_url, "fetched": now}
        fetched += 1
        print(f"OK   {url}: {len(body)} bytes")

    # Drop files of feeds no longer listed.
    keep = {entry["file"] for entry in feeds.values()}
    for f in out.glob("*.xml"):
        if f.name not in keep:
            f.unlink()

    index_path.write_text(json.dumps({"updated": now, "feeds": feeds}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{fetched}/{len(urls)} fetched")
    return 0 if fetched else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
