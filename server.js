// Gaffer server: serves the app and relays the official FPL API + news feeds.
// Browsers can't call fantasy.premierleague.com directly (CORS), so this does it for them.
// Zero dependencies — needs Node 18+.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const FPL_BASE = (process.env.FPL_BASE || 'https://fantasy.premierleague.com/api').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Headlines + links only; the app links out to the original article.
const NEWS_FEEDS = process.env.NEWS_FEEDS
  ? JSON.parse(process.env.NEWS_FEEDS)
  : [
      { source: 'Fantasy Football Scout', url: 'https://www.fantasyfootballscout.co.uk/feed/', fpl: true },
      { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml' },
      { source: 'The Guardian', url: 'https://www.theguardian.com/football/premierleague/rss' },
      { source: 'Sky Sports', url: 'https://www.skysports.com/rss/11661' },
    ];

// Only these FPL endpoints are relayed, so the server isn't an open proxy.
// [pattern, cache seconds]
const FPL_ROUTES = [
  [/^bootstrap-static\/$/, 300],
  [/^fixtures\/(\?future=1|\?event=\d+)?$/, 600],
  [/^entry\/\d+\/$/, 120],
  [/^entry\/\d+\/history\/$/, 300],
  [/^entry\/\d+\/transfers\/$/, 300],
  [/^entry\/\d+\/event\/\d+\/picks\/$/, 120],
  [/^leagues-classic\/\d+\/standings\/(\?page_standings=\d+)?$/, 120],
  [/^event\/\d+\/live\/$/, 60],
  [/^element-summary\/\d+\/$/, 600],
  [/^event-status\/$/, 60],
];

const cache = new Map(); // key -> { expires, status, body }
const inflight = new Map();

async function cachedFetch(url, ttl, parse = 'json') {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit;
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Gaffer FPL companion)',
          Accept: parse === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      const entry = { status: res.status, body, expires: Date.now() + (res.ok ? ttl * 1000 : 15000) };
      cache.set(url, entry);
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return entry;
    } catch (err) {
      // Serve stale data if we have it rather than failing.
      if (hit) return hit;
      return { status: 502, body: JSON.stringify({ error: 'upstream_unreachable', detail: String(err.message || err) }) };
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

// ---------- tiny RSS parser ----------
const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 30)) {
    let link = decode(tag(b, 'link'));
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    }
    const date = decode(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date'));
    const media = b.match(/<media:(?:thumbnail|content)[^>]*url="([^"]+)"/i);
    items.push({
      source: feed.source,
      fpl: !!feed.fpl,
      title: decode(tag(b, 'title')),
      link,
      summary: decode(tag(b, 'description') || tag(b, 'summary')).slice(0, 240),
      published: date ? new Date(date).toISOString() : null,
      image: media ? media[1] : null,
    });
  }
  return items.filter((i) => i.title && /^https?:\/\//.test(i.link));
}

async function getNews() {
  const results = await Promise.all(
    NEWS_FEEDS.map(async (f) => {
      const r = await cachedFetch(f.url, 900, 'xml');
      if (r.status !== 200) return { source: f.source, ok: false, items: [] };
      try {
        return { source: f.source, ok: true, items: parseFeed(r.body, f) };
      } catch {
        return { source: f.source, ok: false, items: [] };
      }
    })
  );
  const items = results
    .flatMap((r) => r.items)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  return { sources: results.map(({ source, ok, items }) => ({ source, ok, count: items.length })), items };
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    // SPA fallback
    if (!path.extname(rel)) return serveStatic(req, res, '/');
    send(res, 404, 'Not found');
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/fpl/')) {
      const sub = url.pathname.slice('/api/fpl/'.length) + url.search;
      const route = FPL_ROUTES.find(([re]) => re.test(sub));
      if (!route) return send(res, 404, JSON.stringify({ error: 'endpoint_not_allowed' }), 'application/json');
      const r = await cachedFetch(`${FPL_BASE}/${sub}`, route[1]);
      return send(res, r.status, r.body, 'application/json', { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/api/news') {
      return send(res, 200, JSON.stringify(await getNews()), 'application/json');
    }
    if (url.pathname === '/api/health') return send(res, 200, '{"ok":true}', 'application/json');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    send(res, 500, JSON.stringify({ error: 'server_error' }), 'application/json');
  }
});

server.listen(PORT, () => console.log(`Gaffer running on http://localhost:${PORT}`));
