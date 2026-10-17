// Persistent state (localStorage). Every access is guarded: storage can be
// unavailable (private mode, blocked site data) and the app must still run.

import { DEFAULT_PROXY } from './config.js';

const KEYS = {
  state: 'fb.state.v1',
  read: 'fb.read.v1',
  cache: 'fb.cache.v1',
  og: 'fb.og.v1',
  memo: 'fb.memo.v1',
  widgetsCollapsed: 'fb.widgetsCollapsed.v1',
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

const feed = (title, url, count = 8) => ({ id: uid(), title, url, count });

export function defaultState() {
  return {
    version: 1,
    currentPage: 0,
    pages: [
      {
        id: uid(),
        name: 'ニュース・IT',
        columns: 3,
        feeds: [
          feed('Yahoo!ニュース 主要', 'https://news.yahoo.co.jp/rss/topics/top-picks.xml'),
          feed('ITmedia NEWS', 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml'),
          feed('GIGAZINE', 'https://gigazine.net/news/rss_2.0/'),
          feed('Publickey', 'https://www.publickey1.jp/atom.xml'),
          feed('窓の杜', 'https://forest.watch.impress.co.jp/data/rss/1.0/wf/feed.rdf'),
        ],
      },
      {
        id: uid(),
        name: 'まとめ',
        columns: 3,
        feeds: [
          feed('痛いニュース(ﾉ∀`)', 'http://blog.livedoor.jp/dqnplus/index.rdf'),
          feed('ハムスター速報', 'http://hamusoku.com/index.rdf'),
          feed('VIPPER速報', 'http://vippers.jp/index.rdf'),
          feed('アルファルファモザイク', 'https://alfalfalfa.com/index.rdf'),
          feed('哲学ニュースnwk', 'http://blog.livedoor.jp/nwknews/index.rdf'),
          feed('ニュー速クオリティ', 'http://news4vip.livedoor.biz/index.rdf'),
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
        .filter((f) => f && typeof f.url === 'string')
        .map((f, i) => ({
          id: f.id || uid(),
          title: String(f.title || f.url),
          url: f.url,
          count: clampInt(f.count, 1, 30, 8),
          siteUrl: f.siteUrl || '',
          col: clampInt(f.col, 0, columns - 1, i % columns),
          hideThumbs: Boolean(f.hideThumbs),
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
export const saveState = (s) => save(KEYS.state, s);
export const proxyOf = (s) => (s.settings.proxy || DEFAULT_PROXY).replace(/\/+$/, '');

// ---- read marks ----
let readMap = load(KEYS.read, {});
export const isRead = (link) => Object.prototype.hasOwnProperty.call(readMap, link);
export function markRead(links) {
  const now = Date.now();
  for (const l of links) readMap[l] = now;
  pruneRead();
  save(KEYS.read, readMap);
}
function pruneRead() {
  const cutoff = Date.now() - READ_KEEP_MS;
  let entries = Object.entries(readMap).filter(([, t]) => t > cutoff);
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
export const saveMemo = (text) => save(KEYS.memo, text);

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
