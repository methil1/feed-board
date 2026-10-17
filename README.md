# Feed Board

A personal RSS dashboard in the spirit of feedwatcher.net: multiple pages of
feed cards in columns, thumbnails, relative times, read marks, auto refresh,
and a few widgets (clock + search, weather, memo).

- **Front end** (`docs/`): plain HTML/CSS/ES modules, no build step. Served by GitHub Pages.
- **Proxy** (`worker/`): a Cloudflare Worker that fetches feeds and og:image on
  behalf of the page (browsers cannot read other sites' RSS because of CORS).
  Only origins listed in `ALLOWED_ORIGINS` may use it.

## Features

- Pages (tabs) with 1–6 columns; drag a card by its header to reorder, drop it
  on a tab to move it to another page. Feeds read down each column, left to
  right; narrower screens (phones: one column) keep that order.
- Add a feed by RSS URL **or** a site URL (RSS is auto-discovered).
- Thumbnails from the feed, falling back to the article's og:image.
- Hover an item for its excerpt. Read items are dimmed; per-feed unread badge.
- Auto refresh (15/30/45/60 min), theme (system/light/dark), font size, custom colors.
- OPML import/export, settings JSON export/import for moving between devices.
- Widgets: clock + search box, weather (Open-Meteo), memo.

Settings, read marks and the memo live in the browser's localStorage. To share
them between devices, use **sync** (settings → 同期): the first device presses
*同期を始める* and gets a link (`…/#sync=<key>`); opening that link on another
device joins it. Pages/feeds/settings and the memo are last-writer-wins; read
marks are merged. The open page and the widgets-collapsed state stay per device.
Without sync, *設定を書き出す / 設定を読み込む* copies the settings by file.

## Local development

```sh
# proxy (http://127.0.0.1:8787, allows http://localhost:8080 via worker/.dev.vars)
cd worker
npm install
npx wrangler dev --port 8787 --ip 127.0.0.1

# front end
cd docs
python -m http.server 8080 --bind 127.0.0.1
# open http://localhost:8080/
```

`worker/.dev.vars` (not committed):

```
ALLOWED_ORIGINS="http://localhost:8080,http://127.0.0.1:8080"
```

When served from `localhost`, the page talks to the local proxy automatically.

## Releasing front-end changes

GitHub Pages caches files for 10 minutes and browsers may keep stale ES
modules across reloads. Before committing changes under `docs/`, run

```sh
python tools/bump_version.py
```

which stamps a new `?v=<timestamp>` onto every CSS/JS reference.

## Deploy

1. `cd worker && npx wrangler login && npx wrangler deploy`
2. Put the printed `https://feed-board-proxy.<subdomain>.workers.dev` URL into
   `PRODUCTION_PROXY` in `docs/js/config.js`.
3. GitHub Pages: deploy from branch `main`, folder `/docs`.
4. If the Pages origin differs from `https://methil1.github.io`, update
   `ALLOWED_ORIGINS` in `worker/wrangler.toml` and redeploy the worker.

## Mirrored feeds

Some sites refuse requests from Cloudflare's IP ranges (for example
`yaraon-blog.com` answers the Worker with an empty page). List those feed URLs
in `mirror.json`. The *Mirror feeds* workflow fetches them every 30 minutes with
`tools/mirror_feeds.py` and force-pushes the result to the single-commit
`mirror` branch. The page reads `index.json` from
`https://raw.githubusercontent.com/methil1/feed-board/mirror/` and loads any feed
listed there from GitHub instead of the proxy. A feed that fails on one run
keeps its previous copy.

Feeds that list only a few items (livedoor blogs often carry 15) go under
`archive` in `mirror.json`. Each run parses them and merges the items into
`<hash>.json` on the `mirror` branch (newest 60 kept). The page still loads
these feeds live through the proxy and appends archived items the live feed no
longer lists, so a card can show up to 30 items.

## Proxy API

| Endpoint | Returns |
|---|---|
| `GET /feed?url=<url>` | Upstream body as bytes (the page decodes the charset). Headers `X-Upstream-Content-Type`, `X-Final-Url`. Cached 10 min. |
| `GET /og?url=<url>` | `{"image": "<og:image or null>"}`. Cached 1 day. |
| `GET /sync` | `{"rev", "doc"}` for the `Authorization: Bearer <key>` group, or `{"rev", "unchanged": true}` when `X-Have-Rev` matches. 404 if none. |
| `PUT /sync` | Stores the JSON document (`v: 1`, max 2 MB) and returns `{"rev"}`. `X-Base-Rev` must equal the stored rev (409 otherwise, so the client merges first). |

Sync documents live in the `SYNC` KV namespace under `sync:<sha256(key)>`; the
key itself is not stored. Writes closer than 2 s apart get 429.

The proxy rejects non-http(s) URLs, IP literals, `localhost`/`.local` hosts,
non-standard ports, and responses over 5 MB.
