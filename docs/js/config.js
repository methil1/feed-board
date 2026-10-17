// Proxy (Cloudflare Worker) endpoint. Replaced after `wrangler deploy`.
const PRODUCTION_PROXY = 'https://feed-board-proxy.example.workers.dev';
const LOCAL_PROXY = 'http://127.0.0.1:8787';

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const DEFAULT_PROXY = isLocal ? LOCAL_PROXY : PRODUCTION_PROXY;
