// Fetching (through the proxy, or the GitHub mirror for sites that block it)
// and parsing RSS 1.0 / RSS 2.0 / Atom.

import { MIRROR_BASE } from './config.js?v=202610172012';

export class FeedError extends Error {}

export function safeHttpUrl(raw, base) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw).trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const MIRROR_INDEX_TTL = 10 * 60 * 1000;
const MIRROR_FILE = /^[0-9a-f]{12}\.xml$/;
const ARCHIVE_FILE = /^[0-9a-f]{12}\.json$/;
let mirrorIndex = { at: 0, feeds: {}, archives: {}, pending: null };

// The mirror's index.json, shared by every feed loading at the same time.
async function mirrorEntry(url) {
  if (!mirrorIndex.pending || Date.now() - mirrorIndex.at > MIRROR_INDEX_TTL) {
    mirrorIndex.at = Date.now();
    mirrorIndex.pending = fetch(`${MIRROR_BASE}index.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.feeds && typeof data.feeds === 'object') mirrorIndex.feeds = data.feeds;
        if (data && data.archives && typeof data.archives === 'object') mirrorIndex.archives = data.archives;
      })
      .catch(() => {});
  }
  await mirrorIndex.pending;
  const entry = Object.hasOwn(mirrorIndex.feeds, url) ? mirrorIndex.feeds[url] : null;
  return entry && MIRROR_FILE.test(entry.file) ? entry : null;
}

// Items collected over time by the mirror job for feeds that list only a few
// (see "archive" in mirror.json). Missing or broken archives just add nothing.
async function archivedItems(url, fresh) {
  await mirrorEntry(url); // loads the index
  const entry = Object.hasOwn(mirrorIndex.archives, url) ? mirrorIndex.archives[url] : null;
  if (!entry || !ARCHIVE_FILE.test(entry.file)) return [];
  try {
    const res = await fetch(`${MIRROR_BASE}${entry.file}${fresh ? `?t=${Date.now()}` : ''}`, { cache: fresh ? 'no-cache' : 'default' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) return [];
    return data.items
      .filter((i) => i && typeof i === 'object')
      .map((i) => ({
        title: String(i.title || ''),
        link: safeHttpUrl(i.link),
        date: Number.isFinite(i.date) ? i.date : 0,
        excerpt: String(i.excerpt || ''),
        image: safeHttpUrl(i.image),
      }))
      .filter((i) => i.link);
  } catch {
    return [];
  }
}

async function fetchMirror(entry, url, fresh) {
  let res;
  try {
    res = await fetch(`${MIRROR_BASE}${entry.file}${fresh ? `?t=${Date.now()}` : ''}`, { cache: fresh ? 'no-cache' : 'default' });
  } catch {
    throw new FeedError('ミラーに接続できません');
  }
  if (!res.ok) throw new FeedError(`ミラーから取得できませんでした (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = String(entry.contentType || '');
  return { text: decode(bytes, contentType), contentType, finalUrl: safeHttpUrl(entry.finalUrl) || url };
}

async function fetchRaw(proxy, url, fresh) {
  const mirrored = await mirrorEntry(url);
  if (mirrored) return fetchMirror(mirrored, url, fresh);
  let res;
  try {
    res = await fetch(`${proxy}/feed?url=${encodeURIComponent(url)}`, { cache: fresh ? 'no-cache' : 'default' });
  } catch {
    throw new FeedError('中継サーバーに接続できません');
  }
  if (!res.ok) {
    const msg = (await res.text().catch(() => '')).slice(0, 120);
    throw new FeedError(res.status === 403 ? '中継サーバーに許可されていません' : `取得に失敗しました (${msg || res.status})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('X-Upstream-Content-Type') || '';
  const finalUrl = res.headers.get('X-Final-Url') || url;
  return { text: decode(bytes, contentType), contentType, finalUrl };
}

function decode(bytes, contentType) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const charset =
    (contentType.match(/charset=["']?([\w-]+)/i) || [])[1] ||
    (head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i) || [])[1] ||
    (head.match(/<meta[^>]*charset=["']?([\w-]+)/i) || [])[1] ||
    'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Child elements by local name, ignoring namespace prefixes.
const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const txt = (el, name) => {
  const k = kid(el, name);
  return k ? k.textContent.trim() : '';
};

const htmlParser = new DOMParser();
function htmlToText(html) {
  if (!html) return '';
  // DOMParser does not run scripts or load images for text/html documents.
  const doc = htmlParser.parseFromString(html, 'text/html');
  return (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
}
function firstImg(html, base) {
  if (!html || !/<img/i.test(html)) return '';
  const doc = htmlParser.parseFromString(html, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    const w = Number(img.getAttribute('width') || 0);
    if (w && w < 40) continue; // skip tracking pixels / icons
    const u = safeHttpUrl(src, base);
    if (u) return u;
  }
  return '';
}

function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function mediaImage(item) {
  for (const name of ['thumbnail', 'content']) {
    for (const m of kids(item, name)) {
      if (m.namespaceURI && !m.namespaceURI.includes('search.yahoo.com/mrss')) continue;
      const url = m.getAttribute('url');
      const medium = m.getAttribute('medium') || m.getAttribute('type') || 'image';
      if (url && /image/.test(medium)) return url;
    }
  }
  const group = kids(item, 'group').find((g) => g.namespaceURI && g.namespaceURI.includes('mrss'));
  if (group) return mediaImage(group);
  const enc = kids(item, 'enclosure').find((e) => /^image\//.test(e.getAttribute('type') || ''));
  if (enc) return enc.getAttribute('url') || '';
  return '';
}

function parseXmlFeed(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  const name = root.localName;

  if (name === 'feed') {
    const siteLink = kids(root, 'link').find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
    const items = kids(root, 'entry').map((e) => {
      const link = kids(e, 'link').find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || kid(e, 'link');
      const content = txt(e, 'content') || txt(e, 'summary');
      return {
        title: htmlToText(txt(e, 'title')),
        link: safeHttpUrl(link && link.getAttribute('href'), baseUrl),
        date: parseDate(txt(e, 'published') || txt(e, 'updated')),
        excerpt: htmlToText(content || txt(kid(e, 'group'), 'description')),
        image: safeHttpUrl(mediaImage(e), baseUrl) || firstImg(content, baseUrl),
      };
    });
    return { title: htmlToText(txt(root, 'title')), siteUrl: safeHttpUrl(siteLink && siteLink.getAttribute('href'), baseUrl), items };
  }

  if (name === 'rss' || name === 'RDF') {
    const channel = kid(root, 'channel');
    const itemEls = name === 'rss' ? kids(channel, 'item') : kids(root, 'item');
    const items = itemEls.map((it) => {
      const encoded = txt(it, 'encoded');
      const desc = txt(it, 'description');
      return {
        title: htmlToText(txt(it, 'title')),
        link: safeHttpUrl(txt(it, 'link') || (kid(it, 'guid') && kid(it, 'guid').getAttribute('isPermaLink') !== 'false' ? txt(it, 'guid') : ''), baseUrl),
        date: parseDate(txt(it, 'pubDate') || txt(it, 'date') || txt(it, 'updated')),
        excerpt: htmlToText(desc || encoded),
        image: safeHttpUrl(mediaImage(it), baseUrl) || firstImg(encoded, baseUrl) || firstImg(desc, baseUrl),
      };
    });
    return { title: htmlToText(txt(channel, 'title')), siteUrl: safeHttpUrl(txt(channel, 'link'), baseUrl), items };
  }
  return null;
}

function discoverFeeds(html, baseUrl) {
  const doc = htmlParser.parseFromString(html, 'text/html');
  const found = [];
  for (const l of doc.querySelectorAll('link[rel~="alternate"]')) {
    const type = (l.getAttribute('type') || '').toLowerCase();
    if (!/(rss|atom|rdf)\+xml|application\/xml|text\/xml/.test(type)) continue;
    const url = safeHttpUrl(l.getAttribute('href'), baseUrl);
    if (url && !found.some((f) => f.url === url)) found.push({ url, title: l.getAttribute('title') || url });
  }
  return found;
}

// Fetch and parse a feed. Throws FeedError when the URL is not a feed.
export async function fetchFeed(proxy, url, { fresh = false } = {}) {
  const [{ text, finalUrl }, archived] = await Promise.all([fetchRaw(proxy, url, fresh), archivedItems(url, fresh)]);
  const parsed = parseXmlFeed(text, finalUrl);
  if (!parsed) throw new FeedError('RSS/Atomとして読めませんでした');
  parsed.items = parsed.items.filter((i) => i.link || i.title);
  // Live items first (fresher titles), then archived ones the feed no longer lists.
  const seen = new Set(parsed.items.map((i) => i.link));
  for (const i of archived) if (!seen.has(i.link)) parsed.items.push(i);
  return parsed;
}

const GUESS_PATHS = ['index.rdf', 'feed', 'rss', 'atom.xml', 'rss.xml', 'feed.xml', 'index.xml'];

// Resolve whatever the user typed (feed URL or site URL) into candidate feeds.
export async function resolveInput(proxy, input) {
  const url = safeHttpUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!url) throw new FeedError('URLの形式が正しくありません');
  const { text, finalUrl } = await fetchRaw(proxy, url, true);
  const parsed = parseXmlFeed(text, finalUrl);
  if (parsed) return [{ url, title: parsed.title || url, feed: parsed }];

  let candidates = discoverFeeds(text, finalUrl);
  if (candidates.length === 0) {
    const base = finalUrl.endsWith('/') ? finalUrl : `${finalUrl}/`;
    candidates = GUESS_PATHS.map((p) => ({ url: new URL(p, base).toString(), title: '' }));
  }
  const results = await Promise.all(
    candidates.slice(0, 8).map(async (c) => {
      try {
        const feed = await fetchFeed(proxy, c.url);
        return { url: c.url, title: feed.title || c.title || c.url, feed };
      } catch {
        return null;
      }
    }),
  );
  const ok = results.filter(Boolean);
  if (ok.length === 0) throw new FeedError('このページからRSSが見つかりませんでした');
  return ok;
}

export async function fetchOgImage(proxy, link) {
  const res = await fetch(`${proxy}/og?url=${encodeURIComponent(link)}`);
  if (!res.ok) throw new FeedError('og fetch failed');
  const data = await res.json();
  return safeHttpUrl(data.image) || '';
}
