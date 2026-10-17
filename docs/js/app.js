import { h, relTime, download, pickFile, toast } from './dom.js?v=202610171853';
import { fetchFeed, resolveInput, fetchOgImage, safeHttpUrl, FeedError } from './feed.js?v=202610171853';
import * as store from './store.js?v=202610171853';
import { clockWidget, weatherWidget, memoWidget, searchPlace, SEARCH_ENGINES } from './widgets.js?v=202610171853';

const MAX_CONCURRENT_FEEDS = 6;
const MAX_CONCURRENT_OG = 4;
const NEW_WINDOW_MS = 60 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

let state = store.loadState();
const cards = new Map(); // feed.id -> { el, list, badge, feed }
let lastRefresh = 0;
let refreshTimer = null;

const $ = (sel) => document.querySelector(sel);
const currentPage = () => state.pages[state.currentPage];
const persist = () => store.saveState(state);
const proxy = () => store.proxyOf(state);
const target = () => (state.settings.newTab ? '_blank' : '_self');

// ---------------------------------------------------------------- limits

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const feedLimit = limiter(MAX_CONCURRENT_FEEDS);
const ogLimit = limiter(MAX_CONCURRENT_OG);

// ---------------------------------------------------------------- appearance

function applyAppearance() {
  const root = document.documentElement;
  const s = state.settings;
  if (s.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
  root.setAttribute('data-font', s.fontSize);
  const map = { bg: '--bg', labelBg: '--label-bg', labelFg: '--label-fg', cardBg: '--card-bg', cardFg: '--card-fg' };
  for (const [k, v] of Object.entries(map)) {
    const val = s.colors[k];
    if (val && /^#[0-9a-f]{3,8}$/i.test(val)) root.style.setProperty(v, val);
    else root.style.removeProperty(v);
  }
}

// ---------------------------------------------------------------- tabs

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...state.pages.map((p, i) => {
      const btn = h(
        'button',
        {
          class: `tab${i === state.currentPage ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': String(i === state.currentPage),
          'data-page': String(i), // drop target for moving a card to this page
          onclick: () => switchPage(i),
        },
        p.name,
        h('span', { class: 'tab-count' }, String(p.feeds.length)),
      );
      return btn;
    }),
    h('button', { class: 'tab tab-add', title: 'ページを追加', 'aria-label': 'ページを追加', onclick: addPage }, '＋'),
  );
}

function switchPage(i) {
  if (i === state.currentPage) return;
  state.currentPage = i;
  persist();
  renderTabs();
  renderBoard();
  window.scrollTo({ top: 0 });
}

function addPage() {
  const name = prompt('新しいページの名前', `ページ${state.pages.length + 1}`);
  if (!name) return;
  state.pages.push({ id: store.uid(), name: name.trim() || 'ページ', columns: 3, feeds: [] });
  state.currentPage = state.pages.length - 1;
  persist();
  renderTabs();
  renderBoard();
}

// ---------------------------------------------------------------- widgets

function renderWidgets() {
  const w = state.widgets;
  const box = $('#widgets');
  const parts = [];
  if (w.clock) parts.push(clockWidget(state));
  if (w.weather) parts.push(weatherWidget(state));
  if (w.memo) parts.push(memoWidget());
  box.replaceChildren(...parts);
  box.hidden = parts.length === 0;
}

// ---------------------------------------------------------------- board

function effectiveColumns(pageCols) {
  const fit = Math.max(1, Math.floor(document.documentElement.clientWidth / 300));
  return Math.max(1, Math.min(pageCols, fit));
}

let renderedCols = 0;

function renderBoard() {
  const page = currentPage();
  const board = $('#board');
  cards.clear();
  ogObserver.disconnect();
  metaObserver.disconnect();
  const n = effectiveColumns(page.columns);
  renderedCols = n;
  board.style.setProperty('--cols', String(n));

  if (page.feeds.length === 0) {
    board.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, 'このページにはまだフィードがありません。'),
        h('button', { class: 'btn primary', onclick: openAddDialog }, '＋ フィードを追加'),
      ),
    );
    return;
  }

  const cols = layout(page, n).map((feeds, c) => {
    const col = h('div', { class: 'col' });
    setupColumnDrop(col, c, n === page.columns);
    for (const feed of feeds) {
      const card = buildCard(feed);
      col.append(card.el);
      const cached = store.getCachedFeed(feed.url);
      if (cached) renderItems(card, cached.data);
    }
    return col;
  });
  board.replaceChildren(...cols);
  refreshPage(false);
}

// Split feeds into columns by their `col`. When the screen is too narrow for
// the page's column count, read the full layout column by column (left column
// top to bottom, then the next) and re-flow it into n columns the same way.
function layout(page, n) {
  const full = Array.from({ length: page.columns }, () => []);
  for (const f of page.feeds) full[Math.min(f.col || 0, page.columns - 1)].push(f);
  if (n >= page.columns) return full;
  const flat = full.flat();
  const out = Array.from({ length: n }, () => []);
  flat.forEach((f, i) => out[store.stackedCol(i, flat.length, n)].push(f));
  return out;
}

function shortestCol(page) {
  const counts = Array(page.columns).fill(0);
  for (const f of page.feeds) counts[Math.min(f.col || 0, page.columns - 1)]++;
  return counts.indexOf(Math.min(...counts));
}

function buildCard(feed) {
  const site = feed.siteUrl || originOf(feed.url);
  const favicon = h('img', {
    class: 'favicon',
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    src: `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(hostOf(site))}`,
  });
  favicon.addEventListener('error', () => favicon.remove());
  // The title is plain text so the whole header (except buttons) is a grip.
  const title = h('span', { class: 'feed-title' }, feed.title);
  const badge = h('span', { class: 'badge', hidden: true });
  const status = h('span', { class: 'feed-status' });
  const stale = h('span', { class: 'feed-stale', hidden: true }, '💤');
  const head = h(
    'header',
    { class: 'feed-head', title: 'ドラッグで並べ替え' },
    favicon,
    title,
    stale,
    badge,
    status,
    h(
      'div',
      { class: 'feed-actions' },
      h('button', { class: 'icon-btn', title: 'すべて既読にする', 'aria-label': 'すべて既読にする', onclick: () => markAllRead(feed.id) }, '✓'),
      h('button', { class: 'icon-btn reload', title: '再読み込み', 'aria-label': '再読み込み', onclick: () => loadFeed(feed, true) }, '⟳'),
      h('button', { class: 'icon-btn', title: '編集', 'aria-label': '編集', 'aria-haspopup': 'dialog', onclick: () => openEditDialog(feed.id) }, '⋯'),
      h(
        'button',
        {
          class: 'icon-btn collapse-btn',
          title: feed.collapsed ? '開く' : '折りたたむ',
          'aria-label': feed.collapsed ? '開く' : '折りたたむ',
          'aria-expanded': String(!feed.collapsed),
          onclick: () => toggleCollapse(feed.id),
        },
        '▾',
      ),
    ),
  );
  const list = h('ul', { class: 'items' }, h('li', { class: 'placeholder' }, '読み込み中…'));
  metaObserver.observe(list);
  const el = h('article', { class: `feed${feed.collapsed ? ' collapsed' : ''}`, 'data-id': feed.id }, head, list);
  setupDrag(head, el, feed.id);
  const card = { el, list, badge, status, stale, feed };
  cards.set(feed.id, card);
  return card;
}

function renderItems(card, data) {
  const { feed, list } = card;
  const mode = feed.showThumbs ? state.settings.images : 'none';
  const items = sortByDate(data.items).slice(0, feed.count);
  card.items = items;
  markStale(card, items);
  if (items.length === 0) {
    list.replaceChildren(h('li', { class: 'placeholder' }, '記事がありません'));
    updateBadge(card);
    return;
  }
  const now = Date.now();
  list.replaceChildren(
    ...items.map((item, idx) => {
      const showThumb = mode === 'all' || (mode === 'first' && idx === 0);
      const read = item.link && store.isRead(item.link);
      const link = h(
        'a',
        { class: 'item-title', href: item.link || card.feed.siteUrl || '#', target: target(), rel: 'noopener noreferrer' },
        item.title || '(無題)',
      );
      const meta = h(
        'div',
        { class: 'item-meta' },
        item.date && now - item.date < NEW_WINDOW_MS && !read ? h('span', { class: 'new' }, 'NEW') : null,
        item.date ? h('time', { datetime: new Date(item.date).toISOString() }, relTime(item.date)) : null,
      );
      const li = h('li', { class: `item${read ? ' read' : ''}${showThumb ? ' with-thumb' : ''}${mode === 'first' && idx === 0 ? ' lead' : ''}` });
      if (showThumb) {
        const thumb = makeThumb(item);
        if (thumb) li.append(thumb);
        else li.classList.remove('with-thumb');
      }
      li.append(h('div', { class: 'item-text' }, link, meta));
      const onOpen = () => {
        if (!item.link) return;
        store.markRead([item.link]);
        li.classList.add('read');
        const nb = li.querySelector('.new');
        if (nb) nb.remove();
        updateBadge(card);
        layoutMeta(list);
      };
      link.addEventListener('click', onOpen);
      link.addEventListener('auxclick', (e) => {
        if (e.button === 1) onOpen();
      });
      if (item.excerpt) {
        li.addEventListener('mouseenter', (e) => showTip(e, item));
        li.addEventListener('mousemove', moveTip);
        li.addEventListener('mouseleave', hideTip);
      }
      return li;
    }),
  );
  updateBadge(card);
  requestAnimationFrame(() => layoutMeta(list));
}

// Put "NEW · 5分前" at the right end of the title's last line when it fits
// there, otherwise right-aligned on the line below. The title is clamped to
// two lines, so this has to be measured rather than done in CSS.
const META_GAP = 12;
const metaObserver = new ResizeObserver((entries) => {
  for (const e of entries) layoutMeta(e.target);
});

function layoutMeta(list) {
  // Measure everything first, then write, to avoid a layout per item.
  const results = [...list.querySelectorAll('.item-text')].map((text) => {
    const link = text.querySelector('.item-title');
    const meta = text.querySelector('.item-meta');
    if (!link || !meta || !meta.firstChild) return [text, false];
    const box = link.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(link);
    // Lines cut off by the clamp sit below the box; ignore them.
    const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.bottom <= box.bottom + 1);
    const last = lines[lines.length - 1];
    return [text, Boolean(last) && box.right - last.right >= meta.offsetWidth + META_GAP];
  });
  for (const [text, inline] of results) text.classList.toggle('meta-inline', inline);
}

// Newest first. Some blogs pin old posts at the top of their RSS; undated
// items keep their feed order after the dated ones.
function sortByDate(items) {
  const dated = items.filter((i) => i.date);
  const undated = items.filter((i) => !i.date);
  return [...dated.sort((a, b) => b.date - a.date), ...undated];
}

// Flag feeds whose newest item is old, so a dead site is noticeable.
function markStale(card, items) {
  const newest = Math.max(0, ...items.map((i) => i.date || 0));
  const stale = newest > 0 && Date.now() - newest > STALE_MS;
  card.el.classList.toggle('stale', stale);
  card.stale.hidden = !stale;
  if (stale) {
    const d = new Date(newest);
    card.stale.title = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} から更新がありません`;
  }
}

function toggleCollapse(feedId) {
  const feed = currentPage().feeds.find((f) => f.id === feedId);
  const card = cards.get(feedId);
  if (!feed || !card) return;
  feed.collapsed = !feed.collapsed;
  persist();
  card.el.classList.toggle('collapsed', feed.collapsed);
  const btn = card.el.querySelector('.collapse-btn');
  const label = feed.collapsed ? '開く' : '折りたたむ';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!feed.collapsed));
}

function makeThumb(item) {
  const img = h('img', { class: 'thumb', alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => {
    img.closest('li')?.classList.remove('with-thumb');
    img.remove();
  });
  if (item.image) {
    img.src = item.image;
    return img;
  }
  if (!state.settings.ogThumbs || !item.link) return null;
  const known = store.getOg(item.link);
  if (known === '') return null;
  if (known) {
    img.src = known;
    return img;
  }
  img.dataset.link = item.link;
  img.classList.add('pending');
  ogObserver.observe(img);
  return img;
}

const ogObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      ogObserver.unobserve(img);
      const link = img.dataset.link;
      ogLimit(() => fetchOgImage(proxy(), link))
        .then((src) => {
          store.setOg(link, src);
          if (src) {
            img.src = src;
            img.classList.remove('pending');
          } else {
            img.closest('li')?.classList.remove('with-thumb');
            img.remove();
          }
        })
        .catch(() => {
          img.closest('li')?.classList.remove('with-thumb');
          img.remove();
        });
    }
  },
  { rootMargin: '200px' },
);

function updateBadge(card) {
  const unread = (card.items || []).filter((i) => i.link && !store.isRead(i.link)).length;
  card.badge.hidden = unread === 0;
  card.badge.textContent = String(unread);
}

function markAllRead(feedId) {
  const card = cards.get(feedId);
  if (!card || !card.items) return;
  store.markRead(card.items.map((i) => i.link).filter(Boolean));
  card.list.querySelectorAll('.item').forEach((li) => li.classList.add('read'));
  card.list.querySelectorAll('.new').forEach((n) => n.remove());
  updateBadge(card);
}

async function loadFeed(feed, fresh) {
  const card = cards.get(feed.id);
  if (!card) return;
  card.el.classList.add('loading');
  card.status.textContent = '';
  card.status.title = '';
  try {
    const data = await feedLimit(() => fetchFeed(proxy(), feed.url, { fresh }));
    store.setCachedFeed(feed.url, data);
    if (data.siteUrl && data.siteUrl !== feed.siteUrl) {
      feed.siteUrl = data.siteUrl;
      persist();
    }
    if (cards.get(feed.id) === card) renderItems(card, data);
  } catch (err) {
    card.status.textContent = '⚠';
    card.status.title = err instanceof FeedError ? err.message : '読み込みに失敗しました';
    if (!card.items) card.list.replaceChildren(h('li', { class: 'placeholder error' }, card.status.title));
  } finally {
    card.el.classList.remove('loading');
  }
}

function refreshPage(fresh) {
  lastRefresh = Date.now();
  for (const feed of currentPage().feeds) loadFeed(feed, fresh);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  const min = state.settings.refreshMin;
  if (min > 0) refreshTimer = setInterval(() => refreshPage(true), min * 60 * 1000);
}

// ---------------------------------------------------------------- tooltip

const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
function showTip(e, item) {
  if (window.matchMedia('(hover: none)').matches) return;
  tip.replaceChildren(h('strong', {}, item.title || ''), h('p', {}, item.excerpt.slice(0, 220) + (item.excerpt.length > 220 ? '…' : '')));
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  if (tip.hidden) return;
  const pad = 16;
  const rect = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  tip.hidden = true;
}

// ---------------------------------------------------------------- drag & drop

// Pointer-based dragging instead of HTML5 drag-and-drop. preventDefault() on
// pointerdown suppresses the compatibility mouse events and native dragstart,
// so mouse-gesture / super-drag extensions never see the grab.
const DRAG_THRESHOLD = 5;
const EDGE_SCROLL = 70;
let drag = null;

function setupDrag(handle, cardEl, feedId) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (e.target.closest('button, a')) return;
    e.preventDefault();
    const r = cardEl.getBoundingClientRect();
    drag = {
      feedId,
      cardEl,
      handle,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      width: r.width,
      active: false,
      ghost: null,
      drop: null,
      raf: 0,
    };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
      beginDrag();
    }
    placeGhost();
    updateDropTarget();
  });
  handle.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finishDrag(true);
  });
  handle.addEventListener('pointercancel', () => finishDrag(false));
}

// Columns carry data-col only when they map 1:1 to the page's columns.
function setupColumnDrop(colEl, c, exact) {
  if (exact) colEl.dataset.col = String(c);
}

function beginDrag() {
  drag.active = true;
  hideTip();
  const ghost = drag.cardEl.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.removeAttribute('data-id');
  ghost.style.width = `${drag.width}px`;
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.cardEl.classList.add('dragging');
  document.body.classList.add('is-dragging');
  const tick = () => {
    if (!drag || !drag.active) return;
    // Scroll while the pointer rests near the top/bottom edge.
    let dy = 0;
    if (drag.y < EDGE_SCROLL) dy = -Math.ceil((EDGE_SCROLL - drag.y) / 4);
    else if (drag.y > window.innerHeight - EDGE_SCROLL) dy = Math.ceil((drag.y - (window.innerHeight - EDGE_SCROLL)) / 4);
    if (dy) {
      window.scrollBy(0, dy);
      updateDropTarget();
    }
    drag.raf = requestAnimationFrame(tick);
  };
  drag.raf = requestAnimationFrame(tick);
}

function placeGhost() {
  drag.ghost.style.left = `${drag.x - drag.offX}px`;
  drag.ghost.style.top = `${drag.y - Math.min(drag.offY, 40)}px`;
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-col, .tab.drop').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-col', 'drop'));
}

function updateDropTarget() {
  clearDropMarks();
  drag.drop = null;
  const el = document.elementFromPoint(drag.x, drag.y);
  if (!el) return;
  const tab = el.closest('.tab[data-page]');
  if (tab) {
    const page = Number(tab.dataset.page);
    if (page !== state.currentPage) {
      tab.classList.add('drop');
      drag.drop = { type: 'tab', page };
    }
    return;
  }
  const card = el.closest('.feed[data-id]');
  if (card) {
    if (card === drag.cardEl) return;
    const r = card.getBoundingClientRect();
    const after = drag.y > r.top + r.height / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
    drag.drop = { type: 'card', id: card.dataset.id, after };
    return;
  }
  const col = el.closest('.col[data-col]');
  if (col) {
    col.classList.add('drop-col');
    drag.drop = { type: 'col', col: Number(col.dataset.col) };
  }
}

function finishDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  if (d.handle.hasPointerCapture(d.pointerId)) d.handle.releasePointerCapture(d.pointerId);
  if (!d.active) return;
  d.ghost.remove();
  d.cardEl.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  clearDropMarks();
  if (!commit || !d.drop) return;
  if (d.drop.type === 'card') reorderFeed(d.feedId, d.drop.id, d.drop.after);
  else if (d.drop.type === 'col') moveToColumn(d.feedId, d.drop.col);
  else if (d.drop.type === 'tab') moveFeedToPage(d.feedId, d.drop.page);
}

function moveToColumn(feedId, c) {
  const feeds = currentPage().feeds;
  const from = feeds.findIndex((f) => f.id === feedId);
  if (from < 0) return;
  const [moving] = feeds.splice(from, 1);
  moving.col = c;
  feeds.push(moving);
  persist();
  renderBoard();
}

function reorderFeed(movingId, targetId, after) {
  const feeds = currentPage().feeds;
  const from = feeds.findIndex((f) => f.id === movingId);
  if (from < 0) return;
  const [moving] = feeds.splice(from, 1);
  const to = feeds.findIndex((f) => f.id === targetId);
  if (to < 0) {
    feeds.splice(from, 0, moving);
    return;
  }
  moving.col = feeds[to].col;
  feeds.splice(after ? to + 1 : to, 0, moving);
  persist();
  renderBoard();
}

function moveFeedToPage(feedId, pageIndex) {
  if (pageIndex === state.currentPage) return;
  const feeds = currentPage().feeds;
  const idx = feeds.findIndex((f) => f.id === feedId);
  if (idx < 0) return;
  const [f] = feeds.splice(idx, 1);
  f.col = shortestCol(state.pages[pageIndex]);
  state.pages[pageIndex].feeds.push(f);
  persist();
  renderTabs();
  renderBoard();
  toast(`「${f.title}」を「${state.pages[pageIndex].name}」に移動しました`);
}

// ---------------------------------------------------------------- dialogs

function dialog(title, body, actions) {
  const dlg = h('dialog', { class: 'dlg' });
  const close = () => dlg.close();
  dlg.append(
    h('header', { class: 'dlg-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: close }, '✕')),
    h('div', { class: 'dlg-body' }, body),
    actions ? h('footer', { class: 'dlg-foot' }, actions) : null,
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', { class: 'muted' }, hint) : null);

function pageSelect(selected) {
  return h('select', {}, ...state.pages.map((p, i) => h('option', { value: String(i), selected: i === selected }, p.name)));
}

function countSelect(selected) {
  return h('select', {}, ...Array.from({ length: 30 }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === selected }, `${i + 1}件`)));
}

function openAddDialog() {
  const input = h('input', { type: 'url', placeholder: 'RSSのURL、またはサイトのURL', required: true, autocomplete: 'off', inputmode: 'url' });
  const findBtn = h('button', { class: 'btn', type: 'submit' }, '調べる');
  const results = h('div', { class: 'results' });
  const page = pageSelect(state.currentPage);
  const count = countSelect(8);
  const addBtn = h('button', { class: 'btn primary', disabled: true }, '追加');
  let found = [];

  const form = h('form', { class: 'row' }, input, findBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    findBtn.disabled = true;
    addBtn.disabled = true;
    results.replaceChildren(h('p', { class: 'muted' }, '調べています…'));
    try {
      found = await resolveInput(proxy(), v);
      results.replaceChildren(
        ...found.map((f, i) =>
          h(
            'label',
            { class: 'result' },
            h('input', { type: 'radio', name: 'feed-pick', value: String(i), checked: i === 0 }),
            h(
              'span',
              {},
              h('strong', {}, f.title),
              h('small', { class: 'muted block' }, `${f.url} · ${f.feed.items.length}件`),
              f.feed.items[0] ? h('small', { class: 'muted block' }, `最新: ${f.feed.items[0].title}`) : null,
            ),
          ),
        ),
      );
      addBtn.disabled = false;
    } catch (err) {
      results.replaceChildren(h('p', { class: 'error' }, err instanceof FeedError ? err.message : '取得に失敗しました'));
    } finally {
      findBtn.disabled = false;
    }
  });

  const body = h(
    'div',
    {},
    form,
    h('p', { class: 'muted small' }, 'ブログやまとめサイトのトップページURLでも、RSSを自動で探します。'),
    results,
    h('div', { class: 'grid2' }, field('追加するページ', page), field('表示件数', count)),
  );
  const dlg = dialog('フィードを追加', body, [h('button', { class: 'btn', onclick: () => dlg.close() }, 'キャンセル'), addBtn]);
  addBtn.addEventListener('click', () => {
    const picked = dlg.querySelector('input[name="feed-pick"]:checked');
    const f = found[picked ? Number(picked.value) : 0];
    if (!f) return;
    const pi = Number(page.value);
    const dest = state.pages[pi];
    dest.feeds.push({ id: store.uid(), title: f.title || hostOf(f.url), url: f.url, count: Number(count.value), siteUrl: f.feed.siteUrl || '', col: shortestCol(dest) });
    store.setCachedFeed(f.url, f.feed);
    persist();
    dlg.close();
    if (pi !== state.currentPage) state.currentPage = pi;
    persist();
    renderTabs();
    renderBoard();
    toast(`「${f.title}」を追加しました`);
  });
  input.focus();
}

function openEditDialog(feedId) {
  const page = currentPage();
  const idx = page.feeds.findIndex((f) => f.id === feedId);
  if (idx < 0) return;
  const feed = page.feeds[idx];
  const title = h('input', { type: 'text', value: feed.title });
  const url = h('input', { type: 'url', value: feed.url });
  const count = countSelect(feed.count);
  const pageSel = pageSelect(state.currentPage);
  const colSel = h('select', {}, ...Array.from({ length: page.columns }, (_, i) => h('option', { value: String(i), selected: i === feed.col }, `${i + 1}列目`)));
  const thumbsCheck = h('input', { type: 'checkbox', checked: feed.showThumbs });
  const siteLink = h('a', { class: 'btn', href: feed.siteUrl || originOf(feed.url), target: '_blank', rel: 'noopener noreferrer' }, 'サイトを開く ↗');
  const sameCol = page.feeds.filter((f) => f.col === feed.col);
  const posInCol = sameCol.indexOf(feed);
  // Swap with the neighbour in the same column.
  const move = (delta) => {
    const other = sameCol[posInCol + delta];
    if (!other) return;
    const a = page.feeds.indexOf(feed);
    const b = page.feeds.indexOf(other);
    page.feeds[a] = other;
    page.feeds[b] = feed;
    persist();
    dlg.close();
    renderBoard();
  };
  const body = h(
    'div',
    {},
    field('名前', title),
    field('RSSのURL', url),
    h('div', { class: 'grid2' }, field('表示件数', count), field('ページ', pageSel), field('列', colSel)),
    h('label', { class: 'check' }, thumbsCheck, 'このフィードのサムネイルを表示する'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', onclick: () => move(-1), disabled: posInCol <= 0 }, '▲ 上へ'),
      h('button', { class: 'btn', onclick: () => move(1), disabled: posInCol >= sameCol.length - 1 }, '下へ ▼'),
      h('span', { class: 'spacer' }),
      siteLink,
    ),
  );
  const del = h('button', { class: 'btn danger' }, '削除');
  const ok = h('button', { class: 'btn primary' }, '保存');
  const dlg = dialog('フィードの編集', body, [del, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => dlg.close() }, 'キャンセル'), ok]);
  del.addEventListener('click', () => {
    if (!confirm(`「${feed.title}」を削除しますか？`)) return;
    page.feeds.splice(page.feeds.indexOf(feed), 1);
    persist();
    dlg.close();
    renderTabs();
    renderBoard();
  });
  ok.addEventListener('click', () => {
    const newUrl = safeHttpUrl(url.value);
    if (!newUrl) {
      toast('URLの形式が正しくありません');
      return;
    }
    const urlChanged = newUrl !== feed.url;
    feed.title = title.value.trim() || feed.title;
    feed.url = newUrl;
    feed.count = Number(count.value);
    feed.showThumbs = thumbsCheck.checked;
    if (urlChanged) feed.siteUrl = '';
    const newCol = Number(colSel.value);
    if (newCol !== feed.col) {
      // Move to the end of the chosen column.
      page.feeds.splice(page.feeds.indexOf(feed), 1);
      feed.col = newCol;
      page.feeds.push(feed);
    }
    const pi = Number(pageSel.value);
    if (pi !== state.currentPage) {
      page.feeds.splice(page.feeds.indexOf(feed), 1);
      feed.col = shortestCol(state.pages[pi]);
      state.pages[pi].feeds.push(feed);
    }
    persist();
    dlg.close();
    renderTabs();
    renderBoard();
  });
}

function openSettings() {
  const s = state.settings;
  const w = state.widgets;
  const sel = (value, options, onchange) =>
    h('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
  const check = (checked, label, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), label);
  const apply = () => {
    persist();
    applyAppearance();
  };

  // --- display
  const display = h(
    'section',
    {},
    h('h3', {}, '表示'),
    h(
      'div',
      { class: 'grid2' },
      field('テーマ', sel(s.theme, [['system', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], (v) => ((s.theme = v), apply()))),
      field('文字サイズ', sel(s.fontSize, [['s', '小'], ['m', '中'], ['l', '大'], ['xl', '特大']], (v) => ((s.fontSize = v), apply()))),
      field('サムネイルの出し方', sel(s.images, [['all', 'すべての記事'], ['first', '最初の記事だけ大きく'], ['none', 'どのフィードも出さない']], (v) => ((s.images = v), persist(), renderBoard()))),
      field(
        '自動更新',
        sel(s.refreshMin, [[15, '15分'], [30, '30分'], [45, '45分'], [60, '60分'], [0, '更新しない']], (v) => ((s.refreshMin = Number(v)), persist(), scheduleRefresh())),
      ),
    ),
    h('p', { class: 'muted small' }, 'サムネイルは最初は非表示です。出したいフィードは、見出しの「⋯」で開く編集画面でオンにしてください。'),
    check(s.ogThumbs, 'RSSに画像が無い記事は、記事ページからサムネイルを取得する', (v) => ((s.ogThumbs = v), persist(), renderBoard())),
    check(s.newTab, 'リンクを新しいタブで開く', (v) => ((s.newTab = v), persist(), renderBoard())),
  );

  // --- colors
  const colorDefs = [
    ['bg', '全体の背景'],
    ['labelBg', 'ラベル背景'],
    ['labelFg', 'ラベル文字'],
    ['cardBg', 'フィード背景'],
    ['cardFg', 'フィード文字'],
  ];
  const colorRows = colorDefs.map(([k, label]) => {
    const current = s.colors[k] || getComputedStyle(document.documentElement).getPropertyValue(cssVar(k)).trim();
    const picker = h('input', { type: 'color', value: toHex6(current) });
    const hex = h('input', { type: 'text', value: s.colors[k], placeholder: '既定', class: 'hex', maxlength: 9 });
    picker.addEventListener('input', () => {
      s.colors[k] = picker.value;
      hex.value = picker.value;
      apply();
    });
    hex.addEventListener('change', () => {
      const v = hex.value.trim();
      if (v === '' || /^#[0-9a-f]{3,8}$/i.test(v)) {
        s.colors[k] = v;
        if (v) picker.value = toHex6(v);
        apply();
      } else {
        toast('#から始まる16進数で入力してください');
      }
    });
    return h('div', { class: 'color-row' }, h('span', {}, label), picker, hex);
  });
  const colors = h(
    'section',
    {},
    h('h3', {}, '色'),
    ...colorRows,
    h(
      'button',
      {
        class: 'btn small',
        onclick: () => {
          for (const [k] of colorDefs) s.colors[k] = '';
          apply();
          dlg.close();
          openSettings();
        },
      },
      '色を既定に戻す',
    ),
  );

  // --- pages
  const pagesList = h('div', { class: 'pages-list' });
  const renderPages = () => {
    pagesList.replaceChildren(
      ...state.pages.map((p, i) => {
        const name = h('input', { type: 'text', value: p.name, 'aria-label': 'ページ名' });
        name.addEventListener('change', () => {
          p.name = name.value.trim() || p.name;
          persist();
          renderTabs();
        });
        return h(
          'div',
          { class: 'page-row' },
          name,
          sel(p.columns, [1, 2, 3, 4, 5, 6].map((n) => [n, `${n}列`]), (v) => {
            p.columns = Number(v);
            for (const f of p.feeds) if (f.col >= p.columns) f.col = p.columns - 1;
            persist();
            if (i === state.currentPage) renderBoard();
          }),
          h('button', { class: 'icon-btn', title: '上へ', 'aria-label': '上へ', disabled: i === 0, onclick: () => movePage(i, -1) }, '↑'),
          h('button', { class: 'icon-btn', title: '下へ', 'aria-label': '下へ', disabled: i === state.pages.length - 1, onclick: () => movePage(i, 1) }, '↓'),
          h(
            'button',
            {
              class: 'icon-btn danger',
              title: '削除',
              'aria-label': '削除',
              disabled: state.pages.length === 1,
              onclick: () => {
                if (!confirm(`ページ「${p.name}」とその中のフィード${p.feeds.length}件を削除しますか？`)) return;
                state.pages.splice(i, 1);
                state.currentPage = Math.min(state.currentPage, state.pages.length - 1);
                persist();
                renderPages();
                renderTabs();
                renderBoard();
              },
            },
            '🗑',
          ),
        );
      }),
    );
  };
  const movePage = (i, d) => {
    const cur = state.pages[state.currentPage];
    const [p] = state.pages.splice(i, 1);
    state.pages.splice(i + d, 0, p);
    state.currentPage = state.pages.indexOf(cur);
    persist();
    renderPages();
    renderTabs();
  };
  renderPages();
  const pages = h(
    'section',
    {},
    h('h3', {}, 'ページ'),
    pagesList,
    h(
      'button',
      {
        class: 'btn small',
        onclick: () => {
          state.pages.push({ id: store.uid(), name: `ページ${state.pages.length + 1}`, columns: 3, feeds: [] });
          persist();
          renderPages();
          renderTabs();
        },
      },
      '＋ ページを追加',
    ),
  );

  // --- widgets
  const placeName = h('input', { type: 'text', placeholder: '地名（例: 横浜）', value: w.place.name });
  const placeResults = h('div', { class: 'place-results' });
  const placeForm = h('form', { class: 'row' }, placeName, h('button', { class: 'btn', type: 'submit' }, '検索'));
  placeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    placeResults.replaceChildren(h('span', { class: 'muted' }, '検索中…'));
    try {
      const list = await searchPlace(placeName.value.trim());
      if (list.length === 0) {
        placeResults.replaceChildren(h('span', { class: 'muted' }, '見つかりませんでした'));
        return;
      }
      placeResults.replaceChildren(
        ...list.map((p) =>
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: () => {
                w.place = { name: p.name, lat: p.lat, lon: p.lon };
                persist();
                renderWidgets();
                placeResults.replaceChildren(h('span', { class: 'muted' }, `「${p.name}」に設定しました`));
              },
            },
            `${p.name}`,
            h('small', { class: 'muted' }, ` ${p.detail}`),
          ),
        ),
      );
    } catch {
      placeResults.replaceChildren(h('span', { class: 'error' }, '検索に失敗しました'));
    }
  });
  const widgets = h(
    'section',
    {},
    h('h3', {}, 'ウィジェット'),
    check(w.clock, '時計と検索バー', (v) => ((w.clock = v), persist(), renderWidgets())),
    field(
      '検索エンジン',
      sel(w.search, Object.entries(SEARCH_ENGINES).map(([k, e]) => [k, e.label]), (v) => ((w.search = v), persist(), renderWidgets())),
    ),
    check(w.weather, '天気予報', (v) => ((w.weather = v), persist(), renderWidgets())),
    field('天気の表示日数', sel(w.weatherDays, [[3, '3日間'], [7, '7日間']], (v) => ((w.weatherDays = Number(v)), persist(), renderWidgets()))),
    field('天気の地点', placeForm),
    placeResults,
    check(w.memo, 'メモ帳（端末ごとに保存）', (v) => ((w.memo = v), persist(), renderWidgets())),
  );

  // --- data
  const proxyInput = h('input', { type: 'url', value: s.proxy, placeholder: store.proxyOf({ settings: { proxy: '' } }) });
  proxyInput.addEventListener('change', () => {
    const v = proxyInput.value.trim();
    if (v && !safeHttpUrl(v)) {
      toast('URLの形式が正しくありません');
      return;
    }
    s.proxy = v;
    persist();
  });
  const data = h(
    'section',
    {},
    h('h3', {}, 'データ'),
    h('p', { class: 'muted small' }, '設定は端末ごとに保存されます。別の端末へ移すときは「設定を書き出す」→ もう一方で「設定を読み込む」を使ってください。'),
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn small', onclick: exportJson }, '設定を書き出す'),
      h('button', { class: 'btn small', onclick: importJson }, '設定を読み込む'),
      h('button', { class: 'btn small', onclick: importOpml }, 'OPMLを読み込む'),
      h('button', { class: 'btn small', onclick: exportOpml }, 'OPMLを書き出す'),
    ),
    field('中継サーバー(Worker)のURL', proxyInput, '空欄なら既定のURLを使います'),
    h(
      'button',
      {
        class: 'btn small danger',
        onclick: () => {
          if (!confirm('すべての設定・既読・メモを消して初期状態に戻しますか？')) return;
          store.resetAll();
          state = store.loadState();
          dlg.close();
          boot();
        },
      },
      '初期状態に戻す',
    ),
  );

  const dlg = dialog('設定', h('div', { class: 'settings' }, display, colors, pages, widgets, data), [
    h('button', { class: 'btn primary', onclick: () => dlg.close() }, '閉じる'),
  ]);
}

const cssVar = (k) => ({ bg: '--bg', labelBg: '--label-bg', labelFg: '--label-fg', cardBg: '--card-bg', cardFg: '--card-fg' })[k];

function toHex6(c) {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2})?$/i.exec((c || '').trim());
  if (!m) return '#000000';
  const hex = m[1];
  return hex.length === 3 ? `#${hex.split('').map((x) => x + x).join('')}` : `#${hex}`;
}

// ---------------------------------------------------------------- import / export

function exportJson() {
  const stamp = new Date().toISOString().slice(0, 10);
  download(`feed-board-${stamp}.json`, JSON.stringify(state, null, 2), 'application/json');
}

async function importJson() {
  const text = await pickFile('application/json,.json');
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('JSONとして読めませんでした');
    return;
  }
  if (!parsed || !Array.isArray(parsed.pages)) {
    toast('feed-boardの設定ファイルではありません');
    return;
  }
  if (!confirm('今の設定を、読み込んだ設定で置き換えますか？')) return;
  state = store.normalizeState(parsed);
  persist();
  document.querySelector('dialog.dlg')?.close();
  boot();
  toast('設定を読み込みました');
}

async function importOpml() {
  const text = await pickFile('.opml,.xml,text/xml,application/xml');
  if (!text) return;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const body = doc.querySelector('body');
  if (!body || doc.getElementsByTagName('parsererror').length) {
    toast('OPMLとして読めませんでした');
    return;
  }
  const toFeed = (o) => {
    const url = safeHttpUrl(o.getAttribute('xmlUrl'));
    if (!url) return null;
    return { id: store.uid(), title: o.getAttribute('title') || o.getAttribute('text') || hostOf(url), url, count: 8, siteUrl: safeHttpUrl(o.getAttribute('htmlUrl')) };
  };
  let added = 0;
  const loose = [];
  for (const o of Array.from(body.children).filter((c) => c.localName === 'outline')) {
    if (o.getAttribute('xmlUrl')) {
      const f = toFeed(o);
      if (f) loose.push(f);
      continue;
    }
    const feeds = Array.from(o.querySelectorAll('outline[xmlUrl]')).map(toFeed).filter(Boolean);
    if (feeds.length === 0) continue;
    feeds.forEach((f, i) => (f.col = store.stackedCol(i, feeds.length, 3)));
    state.pages.push({ id: store.uid(), name: o.getAttribute('title') || o.getAttribute('text') || 'インポート', columns: 3, feeds });
    added += feeds.length;
  }
  for (const f of loose) {
    f.col = shortestCol(currentPage());
    currentPage().feeds.push(f);
  }
  added += loose.length;
  persist();
  renderTabs();
  renderBoard();
  toast(`${added}件のフィードを読み込みました`);
}

function exportOpml() {
  const doc = document.implementation.createDocument(null, 'opml', null);
  const opml = doc.documentElement;
  opml.setAttribute('version', '2.0');
  const head = doc.createElement('head');
  const t = doc.createElement('title');
  t.textContent = 'feed-board';
  head.append(t);
  const body = doc.createElement('body');
  for (const p of state.pages) {
    const group = doc.createElement('outline');
    group.setAttribute('text', p.name);
    group.setAttribute('title', p.name);
    for (const f of p.feeds) {
      const o = doc.createElement('outline');
      o.setAttribute('type', 'rss');
      o.setAttribute('text', f.title);
      o.setAttribute('title', f.title);
      o.setAttribute('xmlUrl', f.url);
      if (f.siteUrl) o.setAttribute('htmlUrl', f.siteUrl);
      group.append(o);
    }
    body.append(group);
  }
  opml.append(head, body);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
  download('feed-board.opml', xml, 'text/x-opml');
}

// ---------------------------------------------------------------- helpers

function originOf(url) {
  try {
    return new URL(url).origin + '/';
  } catch {
    return '#';
  }
}
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- boot

function boot() {
  applyAppearance();
  renderTabs();
  renderWidgets();
  renderBoard();
  scheduleRefresh();
  // Drop cached feeds that are no longer registered anywhere.
  store.dropCachedFeedsExcept(state.pages.flatMap((p) => p.feeds.map((f) => f.url)));
}

function init() {
  document.body.append(tip);
  $('#btn-add').addEventListener('click', openAddDialog);
  $('#btn-refresh').addEventListener('click', () => refreshPage(true));
  $('#btn-settings').addEventListener('click', openSettings);
  // Widgets start collapsed on phones; the choice is remembered per device.
  const savedCollapsed = store.loadWidgetsCollapsed();
  const collapsed = savedCollapsed === null ? window.matchMedia('(max-width: 640px)').matches : savedCollapsed;
  $('#widgets').classList.toggle('collapsed', collapsed);
  $('#btn-widgets').addEventListener('click', () => {
    const now = $('#widgets').classList.toggle('collapsed');
    store.saveWidgetsCollapsed(now);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) finishDrag(false);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (effectiveColumns(currentPage().columns) !== renderedCols) renderBoard();
    }, 200);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const min = state.settings.refreshMin;
    if (min > 0 && Date.now() - lastRefresh > min * 60 * 1000) refreshPage(true);
  });
  // Keep relative times fresh without refetching.
  setInterval(() => {
    document.querySelectorAll('.item-meta time').forEach((t) => {
      t.textContent = relTime(Date.parse(t.getAttribute('datetime')));
    });
  }, 60 * 1000);

  boot();
}

init();
