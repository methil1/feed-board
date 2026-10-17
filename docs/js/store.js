// Persistent state (localStorage). Every access is guarded: storage can be
// unavailable (private mode, blocked site data) and the app must still run.

import { DEFAULT_PROXY } from './config.js?v=202610171907';

const KEYS = {
  state: 'fb.state.v1',
  read: 'fb.read.v1',
  cache: 'fb.cache.v1',
  og: 'fb.og.v1',
  memo: 'fb.memo.v1',
  widgetsCollapsed: 'fb.widgetsCollapsed.v1',
  sync: 'fb.sync.v1',
};

// Called with 'state' | 'memo' | 'read' after a change the user made, so the
// sync module can push it. Set by sync.js.
let changeListener = () => {};
export const onChange = (fn) => {
  changeListener = fn;
};

const READ_KEEP_MS = 30 * 24 * 3600 * 1000;
const READ_MAX = 8000;
const OG_MAX = 3000;

export const uid = () => Math.random().toString(36).slice(2, 10);

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const feed = (title, url, col, count = 8) => ({ id: uid(), title, url, count, col });

// Default column for the i-th of n feeds when none is stored: fill the first
// column top to bottom, then the next, so the reading order runs down columns.
export const stackedCol = (i, n, columns) => Math.min(columns - 1, Math.floor((i * columns) / Math.max(n, 1)));

export function defaultState() {
  return {
    version: 1,
    currentPage: 0,
    pages: [
      {
        id: uid(),
        name: 'ホーム',
        columns: 3,
        feeds: [
          feed('GIGAZINE', 'https://gigazine.net/news/rss_2.0/', 0),
          feed('4Gamer.net', 'https://www.4gamer.net/rss/index.xml', 0),
          feed('Yahoo!ニュース 主要', 'https://news.yahoo.co.jp/rss/topics/top-picks.xml', 0),
          feed('ITmedia NEWS', 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml', 0),
          feed('INTERNET Watch', 'https://internet.watch.impress.co.jp/data/rss/1.0/iw/feed.rdf', 0),
          feed('ライフハッカー・ジャパン', 'https://www.lifehacker.jp/feed/index.xml', 0),
          feed('痛いニュース(ﾉ∀`)', 'https://itainews.com/index.rdf', 1),
          feed('キニ速', 'http://blog.livedoor.jp/kinisoku/index.rdf', 1),
          feed('VIPPERな俺', 'https://news23vip.livedoor.blog/index.rdf', 1),
          feed('もみあげチャ～シュ～', 'https://michaelsan.livedoor.biz/index.rdf', 1),
          feed('ゴールデンタイムズ', 'https://goldennews.blog.jp/index.rdf', 2),
          feed('やらおん！', 'http://yaraon-blog.com/feed', 2),
          feed('オレ的ゲーム速報＠刃', 'https://jin115.com/index.rdf', 2),
        ],
      },
    ],
    settings: {
      theme: 'system', // system | light | dark
      fontSize: 'm', // s | m | l | xl
      images: 'all', // all | first | none
      ogThumbs: true,
      newTab: true,
      refreshMin: 30, // 0 = off
      proxy: '',
      colors: { bg: '', labelBg: '', labelFg: '', cardBg: '', cardFg: '' },
    },
    widgets: {
      clock: true,
      search: 'google',
      weather: true,
      weatherDays: 7, // 3 | 7
      place: { name: '横浜', lat: 35.4437, lon: 139.638 },
      memo: true,
    },
  };
}

// Fill in any fields missing from an older or hand-edited state.
export function normalizeState(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object' || !Array.isArray(s.pages) || s.pages.length === 0) s = d;
  const out = {
    ...d,
    ...s,
    settings: { ...d.settings, ...(s.settings || {}), colors: { ...d.settings.colors, ...((s.settings || {}).colors || {}) } },
    widgets: { ...d.widgets, ...(s.widgets || {}) },
  };
  out.pages = s.pages.map((p) => {
    const columns = clampInt(p.columns, 1, 6, 3);
    return {
      id: p.id || uid(),
      name: String(p.name || 'ページ'),
      columns,
      feeds: (Array.isArray(p.feeds) ? p.feeds : [])
        .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
        .map((f, i, all) => ({
          id: f.id || uid(),
          title: String(f.title || f.url),
          url: f.url,
          count: clampInt(f.count, 1, 30, 8),
          siteUrl: typeof f.siteUrl === 'string' && /^https?:\/\//i.test(f.siteUrl) ? f.siteUrl : '',
          col: clampInt(f.col, 0, columns - 1, stackedCol(i, all.length, columns)),
          // Off unless turned on per feed. The old hideThumbs flag is dropped,
          // so feeds saved before this change start hidden too.
          showThumbs: f.showThumbs === true,
          collapsed: Boolean(f.collapsed),
        })),
    };
  });
  out.currentPage = clampInt(out.currentPage, 0, out.pages.length - 1, 0);
  return out;
}

export function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const loadState = () => normalizeState(load(KEYS.state, null));
// `touch` = this is a change worth syncing. Switching pages or learning a
// feed's site URL is saved locally but must not count as a newer layout,
// or a device that just opened would overwrite edits made elsewhere.
export function saveState(s, touch = true) {
  save(KEYS.state, s);
  if (touch) changeListener('state');
}
export const proxyOf = (s) => (s.settings.proxy || DEFAULT_PROXY).replace(/\/+$/, '');

// ---- read marks ----
let readMap = load(KEYS.read, {});
export const isRead = (link) => Object.prototype.hasOwnProperty.call(readMap, link);
export function markRead(links) {
  const now = Date.now();
  for (const l of links) readMap[l] = now;
  pruneRead();
  save(KEYS.read, readMap);
  changeListener('read');
}
export const getReadMap = () => readMap;
// Add marks from another device. Returns how many links became read here.
export function mergeRead(remote) {
  if (!remote || typeof remote !== 'object') return 0;
  const cutoff = Date.now() - READ_KEEP_MS;
  let added = 0;
  for (const [link, t] of Object.entries(remote)) {
    if (typeof t !== 'number' || t <= cutoff) continue;
    if (!(link in readMap)) added++;
    if (!(readMap[link] >= t)) readMap[link] = t;
  }
  pruneRead();
  save(KEYS.read, readMap);
  return added;
}
function pruneRead() {
  const cutoff = Date.now() - READ_KEEP_MS;
  let entries = Object.entries(readMap).filter(([, t]) => typeof t === 'number' && t > cutoff);
  if (entries.length > READ_MAX) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, READ_MAX);
  readMap = Object.fromEntries(entries);
}

// ---- feed cache (show last results instantly on open) ----
let feedCache = load(KEYS.cache, {});
export const getCachedFeed = (url) => feedCache[url] || null;
export function setCachedFeed(url, data) {
  feedCache[url] = { at: Date.now(), data: { ...data, items: data.items.slice(0, 30) } };
  if (!save(KEYS.cache, feedCache)) {
    // Quota exceeded: keep only this feed rather than failing silently forever.
    feedCache = { [url]: feedCache[url] };
    save(KEYS.cache, feedCache);
  }
}
export function dropCachedFeedsExcept(urls) {
  const keep = new Set(urls);
  feedCache = Object.fromEntries(Object.entries(feedCache).filter(([u]) => keep.has(u)));
  save(KEYS.cache, feedCache);
}

// ---- og:image cache ----
let ogMap = load(KEYS.og, {});
export const getOg = (link) => (Object.prototype.hasOwnProperty.call(ogMap, link) ? ogMap[link] : undefined);
export function setOg(link, image) {
  ogMap[link] = image || '';
  const keys = Object.keys(ogMap);
  if (keys.length > OG_MAX) {
    for (const k of keys.slice(0, keys.length - OG_MAX)) delete ogMap[k];
  }
  save(KEYS.og, ogMap);
}

// ---- widgets collapsed (per device) ----
export const loadWidgetsCollapsed = () => load(KEYS.widgetsCollapsed, null);
export const saveWidgetsCollapsed = (v) => save(KEYS.widgetsCollapsed, Boolean(v));

// ---- memo ----
export const loadMemo = () => load(KEYS.memo, '');
export function saveMemo(text, touch = true) {
  const ok = save(KEYS.memo, text);
  if (touch) changeListener('memo');
  return ok;
}

// ---- sync settings (per device; never exported or synced) ----
export const loadSyncMeta = () => load(KEYS.sync, {});
export const saveSyncMeta = (m) => save(KEYS.sync, m);

export function resetAll() {
  for (const k of Object.values(KEYS)) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  readMap = {};
  feedCache = {};
  ogMap = {};
}
