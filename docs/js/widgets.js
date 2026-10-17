import { h } from './dom.js';
import { loadMemo, saveMemo } from './store.js';

export const SEARCH_ENGINES = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  yahoo: { label: 'Yahoo! JAPAN', url: 'https://search.yahoo.co.jp/search?p=' },
};

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

let clockTimer = null;

export function clockWidget(state) {
  const time = h('div', { class: 'clock-time' });
  const date = h('div', { class: 'clock-date' });
  const tick = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    date.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${WEEK[d.getDay()]})`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);

  const engine = SEARCH_ENGINES[state.widgets.search] || SEARCH_ENGINES.google;
  const input = h('input', { type: 'search', placeholder: `${engine.label}で検索`, 'aria-label': '検索' });
  const form = h('form', { class: 'search', role: 'search' }, input);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    window.open(engine.url + encodeURIComponent(q), state.settings.newTab ? '_blank' : '_self', 'noopener');
  });
  return h('section', { class: 'widget widget-clock' }, time, date, form);
}

const WMO = {
  0: ['☀️', '快晴'],
  1: ['🌤️', '晴れ'],
  2: ['⛅', '晴れ時々曇り'],
  3: ['☁️', '曇り'],
  45: ['🌫️', '霧'],
  48: ['🌫️', '霧'],
  51: ['🌦️', '霧雨'],
  53: ['🌦️', '霧雨'],
  55: ['🌦️', '霧雨'],
  56: ['🌧️', '着氷性の霧雨'],
  57: ['🌧️', '着氷性の霧雨'],
  61: ['🌧️', '小雨'],
  63: ['🌧️', '雨'],
  65: ['🌧️', '大雨'],
  66: ['🌧️', '着氷性の雨'],
  67: ['🌧️', '着氷性の雨'],
  71: ['🌨️', '小雪'],
  73: ['🌨️', '雪'],
  75: ['❄️', '大雪'],
  77: ['🌨️', '霧雪'],
  80: ['🌦️', 'にわか雨'],
  81: ['🌧️', 'にわか雨'],
  82: ['⛈️', '激しいにわか雨'],
  85: ['🌨️', 'にわか雪'],
  86: ['❄️', '激しいにわか雪'],
  95: ['⛈️', '雷雨'],
  96: ['⛈️', '雷雨(ひょう)'],
  99: ['⛈️', '激しい雷雨'],
};
const wmo = (c) => WMO[c] || ['❔', '不明'];

const weatherCache = { key: '', at: 0, data: null };

export function weatherWidget(state) {
  const body = h('div', { class: 'weather-body' }, h('div', { class: 'muted' }, '読み込み中…'));
  const box = h('section', { class: 'widget widget-weather' }, h('div', { class: 'widget-title' }, `天気 · ${state.widgets.place.name}`), body);
  const days = state.widgets.weatherDays === 3 ? 3 : 7;
  loadWeather(state.widgets.place, days)
    .then((data) => renderWeather(body, data))
    .catch(() => body.replaceChildren(h('div', { class: 'muted' }, '天気を取得できませんでした')));
  return box;
}

async function loadWeather(place, days) {
  const key = `${place.lat},${place.lon},${days}`;
  if (weatherCache.key === key && Date.now() - weatherCache.at < 30 * 60 * 1000) return weatherCache.data;
  const params = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    current: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Tokyo',
    forecast_days: String(days),
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error('weather');
  const data = await res.json();
  Object.assign(weatherCache, { key, at: Date.now(), data });
  return data;
}

function renderWeather(body, data) {
  const [icon, label] = wmo(data.current.weather_code);
  const now = h(
    'div',
    { class: 'weather-now' },
    h('span', { class: 'weather-icon' }, icon),
    h('span', { class: 'weather-temp' }, `${Math.round(data.current.temperature_2m)}℃`),
    h('span', { class: 'muted' }, label),
  );
  const names = ['今日', '明日'];
  const dayLabel = (t, i) => {
    if (names[i]) return names[i];
    const [y, m, d] = t.split('-').map(Number);
    return `${m}/${d}(${WEEK[new Date(y, m - 1, d).getDay()]})`;
  };
  const days = data.daily.time.map((t, i) => {
    const [ic, lb] = wmo(data.daily.weather_code[i]);
    const dow = new Date(`${t}T00:00:00`).getDay();
    return h(
      'div',
      { class: `weather-day${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`, title: lb },
      h('div', { class: 'muted day-label' }, dayLabel(t, i)),
      h('div', { class: 'weather-icon-s' }, ic),
      h('div', {}, h('span', { class: 'hi' }, `${Math.round(data.daily.temperature_2m_max[i])}°`), ' / ', h('span', { class: 'lo' }, `${Math.round(data.daily.temperature_2m_min[i])}°`)),
      h('div', { class: 'muted small' }, `☂ ${data.daily.precipitation_probability_max[i] ?? '-'}%`),
    );
  });
  const grid = h('div', { class: 'weather-days' }, ...days);
  grid.style.setProperty('--days', String(days.length));
  body.replaceChildren(now, grid);
}

export async function searchPlace(name) {
  const params = new URLSearchParams({ name, count: '6', language: 'ja', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!res.ok) throw new Error('geocode');
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(' / '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export function memoWidget() {
  const area = h('textarea', { class: 'memo', placeholder: 'メモ（この端末に自動保存）', 'aria-label': 'メモ' });
  area.value = loadMemo();
  let t = null;
  const status = h('span', { class: 'muted small' }, '');
  area.addEventListener('input', () => {
    clearTimeout(t);
    status.textContent = '…';
    t = setTimeout(() => {
      status.textContent = saveMemo(area.value) ? '保存済み' : '保存できませんでした';
    }, 500);
  });
  return h('section', { class: 'widget widget-memo' }, h('div', { class: 'widget-title' }, 'メモ ', status), area);
}
