// feed-board proxy
//   GET /feed?url=<feed or site url>  -> raw bytes of the upstream response (client decodes)
//   GET /og?url=<article url>         -> {"image": "<og:image url or null>"}
// Only origins listed in ALLOWED_ORIGINS may use it.

const FEED_TTL = 600; // seconds
const OG_TTL = 86400;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_OG_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (compatible; feed-board/1.0; +https://github.com/)';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Expose-Headers': 'X-Upstream-Content-Type, X-Final-Url',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        }
      : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    }
    if (request.method !== 'GET') return text('method not allowed', 405, cors);
    if (!originOk) return text('forbidden origin', 403, cors);

    const reqUrl = new URL(request.url);
    const target = validateTarget(reqUrl.searchParams.get('url'));
    if (!target) return text('invalid url', 400, cors);

    try {
      if (reqUrl.pathname === '/feed') return await handleFeed(target, cors, ctx);
      if (reqUrl.pathname === '/og') return await handleOg(target, cors, ctx);
      return text('not found', 404, cors);
    } catch (err) {
      const msg = err && err.name === 'TimeoutError' ? 'upstream timeout' : 'upstream error';
      return text(msg, 502, cors);
    }
  },
};

function text(body, status, headers) {
  return new Response(body, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

function validateTarget(raw) {
  if (!raw || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // Block IP literals and local names; feeds are always on public hostnames.
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  return u;
}

async function cached(cacheKey, ctx, ttl, produce) {
  const cache = caches.default;
  const key = new Request(cacheKey);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await produce();
  if (res.ok) {
    // Cache API is a no-op on workers.dev, so also let the browser cache it.
    res.headers.set('Cache-Control', `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { bytes: concat(chunks, total - value.byteLength), truncated: true };
    }
    chunks.push(value);
  }
  return { bytes: concat(chunks, total), truncated: false };
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function upstream(url, accept) {
  return fetch(url.toString(), {
    headers: { 'User-Agent': UA, Accept: accept },
    redirect: 'follow',
    cf: { cacheTtl: 300, cacheEverything: true },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

async function handleFeed(target, cors, ctx) {
  const res = await cached(`https://cache.feed-board/feed?u=${encodeURIComponent(target)}`, ctx, FEED_TTL, async () => {
    const up = await upstream(target, 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5');
    if (!up.ok) return new Response(`upstream status ${up.status}`, { status: 502 });
    const { bytes, truncated } = await readLimited(up, MAX_FEED_BYTES);
    if (truncated) return new Response('feed too large', { status: 502 });
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upstream-Content-Type': up.headers.get('Content-Type') || '',
        'X-Final-Url': up.url || target.toString(),
      },
    });
  });
  return withCors(res, cors);
}

async function handleOg(target, cors, ctx) {
  const res = await cached(`https://cache.feed-board/og?u=${encodeURIComponent(target)}`, ctx, OG_TTL, async () => {
    let image = null;
    const up = await upstream(target, 'text/html, */*;q=0.5');
    if (up.ok && (up.headers.get('Content-Type') || '').includes('html')) {
      const { bytes } = await readLimited(up, MAX_OG_BYTES);
      // Meta tags are ASCII-safe, so latin1 decoding is fine for extraction.
      const html = new TextDecoder('latin1').decode(bytes);
      image = extractOgImage(html, up.url || target.toString());
    } else if (up.body) {
      await up.body.cancel();
    }
    return new Response(JSON.stringify({ image }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return withCors(res, cors);
}

function extractOgImage(html, base) {
  const metas = html.match(/<meta\s[^>]*>/gi) || [];
  const wanted = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];
  let best = null;
  for (const tag of metas) {
    const key = attr(tag, 'property') || attr(tag, 'name');
    if (!key || !wanted.includes(key.toLowerCase())) continue;
    const content = attr(tag, 'content');
    if (!content) continue;
    const rank = wanted.indexOf(key.toLowerCase());
    if (!best || rank < best.rank) best = { rank, content };
  }
  if (!best) return null;
  try {
    const u = new URL(best.content.replace(/&amp;/g, '&'), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? m[2] ?? m[3] ?? m[4] : null;
}

function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  out.headers.delete('Set-Cookie');
  return out;
}
