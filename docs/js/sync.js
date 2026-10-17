// Cross-device sync through the proxy Worker's /sync endpoint.
//
// Every device that holds the same sync key shares one document:
//   { v: 1, stateAt, state, memoAt, memo, read }
// Pages/feeds/settings and the memo are last-writer-wins by their timestamp;
// read marks are merged (union). The key lives only in this device's storage.

import * as store from './store.js?v=202610172012';

const PUSH_DELAY_MS = 5000;
const MIN_PUSH_GAP_MS = 20000;
const PULL_EVERY_MS = 2 * 60 * 1000;
const BUSY_RETRY_MS = 10000;
const TIMEOUT_MS = 15000;

let hooks = null;
let meta = store.loadSyncMeta();
let seq = 0; // bumped on every local change; tells whether a push covered it
let running = false;
let again = false;
let pushTimer = null;
let lastPush = 0;

const saveMeta = () => store.saveSyncMeta(meta);

export const validKey = (k) => /^[A-Za-z0-9_-]{32,128}$/.test(k || '');
export const syncInfo = () => ({ key: meta.key || '', lastSync: meta.lastSync || 0, lastError: meta.lastError || '', running });

// Accepts a bare key or a link containing #sync=<key>.
export function parseKey(text) {
  const s = String(text || '').trim();
  const m = /[#&]sync=([A-Za-z0-9_-]+)/.exec(s);
  const key = m ? m[1] : s;
  return validKey(key) ? key : '';
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// hooks: { proxy(), getState(), applyState(state), applyMemo(text),
//          readChanged(), busy(), status() }
export function initSync(h) {
  hooks = h;
  store.onChange((what) => {
    const now = Date.now();
    if (what === 'state') meta.stateAt = now;
    if (what === 'memo') meta.memoAt = now;
    meta.dirty = true;
    seq++;
    saveMeta();
    schedulePush();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, PULL_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    // Pull when coming back; push what is pending when leaving.
    if (document.visibilityState === 'visible' || meta.dirty) syncNow();
  });
  syncNow();
}

function schedulePush() {
  if (!meta.key) return;
  clearTimeout(pushTimer);
  const wait = Math.max(PUSH_DELAY_MS, lastPush + MIN_PUSH_GAP_MS - Date.now());
  pushTimer = setTimeout(syncNow, wait);
}

// Start a new sync group with this device's current contents.
export async function start() {
  meta = { key: newKey(), rev: '', stateAt: Date.now(), memoAt: Date.now(), dirty: true };
  seq++;
  saveMeta();
  await syncNow();
  return meta.lastError || '';
}

// Join an existing group. This device's layout, settings and memo are
// replaced by the group's; read marks are merged.
// Returns '' on success or an error message.
export async function join(key) {
  const prev = meta;
  meta = { key, rev: '', stateAt: 0, memoAt: 0, dirty: false };
  let res;
  try {
    res = await api('GET');
  } catch (e) {
    meta = prev;
    return errText(e);
  }
  if (res.status === 404) {
    meta = prev;
    return 'この同期キーのデータが見つかりません。キーかリンクを確かめてください。';
  }
  if (!res.ok) {
    meta = prev;
    return errText(res.status);
  }
  meta.dirty = true; // send this device's read marks too
  seq++;
  saveMeta();
  await syncNow();
  return meta.lastError || '';
}

export function stop() {
  clearTimeout(pushTimer);
  meta = {};
  saveMeta();
}

export async function syncNow() {
  if (!meta.key || !hooks) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  clearTimeout(pushTimer);
  hooks.status();
  try {
    await cycle(true);
    meta.lastSync = Date.now();
    meta.lastError = '';
  } catch (e) {
    meta.lastError = errText(e);
  } finally {
    if (meta.key) saveMeta();
    running = false;
    hooks.status();
    if (again) {
      again = false;
      schedulePush();
    }
  }
}

async function cycle(retry) {
  const res = await api('GET', { headers: meta.rev ? { 'X-Have-Rev': meta.rev } : {} });
  if (res.status === 404) {
    // Nothing stored yet (or it was removed): upload ours.
    meta.rev = '';
    meta.dirty = true;
  } else if (!res.ok) {
    throw res.status;
  } else {
    const body = await res.json();
    if (!body.unchanged) {
      const doc = body.doc || {};
      if (wouldReplaceWhileBusy(doc)) {
        // A dialog is open or the memo is being typed in: try again shortly
        // rather than swapping the screen under the user.
        setTimeout(syncNow, BUSY_RETRY_MS);
        return;
      }
      applyRemote(doc);
      meta.rev = body.rev || '';
    }
  }
  if (!meta.dirty) return;

  const sent = seq;
  const put = await api('PUT', { body: JSON.stringify(buildDoc()), headers: { 'X-Base-Rev': meta.rev || '' } });
  if (put.status === 409 && retry) {
    // Another device wrote first: fetch theirs, merge, then write again.
    meta.rev = '';
    return cycle(false);
  }
  if (put.status === 429) {
    schedulePush();
    return;
  }
  if (!put.ok) throw put.status;
  meta.rev = (await put.json()).rev || '';
  lastPush = Date.now();
  if (seq === sent) meta.dirty = false;
}

function wouldReplaceWhileBusy(doc) {
  const stateNewer = doc.state && (Number(doc.stateAt) || 0) > (meta.stateAt || 0);
  const memoNewer = typeof doc.memo === 'string' && (Number(doc.memoAt) || 0) > (meta.memoAt || 0);
  return (stateNewer || memoNewer) && hooks.busy();
}

function applyRemote(doc) {
  const rs = Number(doc.stateAt) || 0;
  const rm = Number(doc.memoAt) || 0;
  let stateChanged = false;

  if (doc.state && typeof doc.state === 'object' && rs > (meta.stateAt || 0)) {
    meta.stateAt = rs;
    hooks.applyState(doc.state);
    stateChanged = true;
  } else if ((meta.stateAt || 0) > rs) {
    meta.dirty = true;
  }

  if (typeof doc.memo === 'string' && rm > (meta.memoAt || 0)) {
    meta.memoAt = rm;
    store.saveMemo(doc.memo, false);
    hooks.applyMemo(doc.memo);
  } else if ((meta.memoAt || 0) > rm) {
    meta.dirty = true;
  }

  const remoteRead = doc.read && typeof doc.read === 'object' ? doc.read : {};
  const added = store.mergeRead(remoteRead);
  if (Object.keys(store.getReadMap()).some((k) => !Object.prototype.hasOwnProperty.call(remoteRead, k))) meta.dirty = true;
  if (added > 0 && !stateChanged) hooks.readChanged();
}

function buildDoc() {
  // The open page is per device.
  const { currentPage, ...state } = hooks.getState();
  return {
    v: 1,
    stateAt: meta.stateAt || 0,
    state,
    memoAt: meta.memoAt || 0,
    memo: store.loadMemo(),
    read: store.getReadMap(),
  };
}

function api(method, { body, headers = {} } = {}) {
  return fetch(`${hooks.proxy()}/sync`, {
    method,
    body,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${meta.key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function errText(e) {
  if (e === 401) return '同期キーが正しくありません';
  if (e === 413) return '同期するデータが大きすぎます';
  if (e === 501) return '中継サーバーが同期に対応していません';
  if (typeof e === 'number') return `同期に失敗しました (${e})`;
  if (e && e.name === 'TimeoutError') return '同期がタイムアウトしました';
  return '同期サーバーに接続できませんでした';
}
