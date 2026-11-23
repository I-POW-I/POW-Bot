/**
 * Small helpers for reading a news page when there is no feed.
 */

const { decode } = require('./format');

const UA = 'Mozilla/5.0 (compatible; POW-Bot/5; Discord bot patch-note reader)';

async function fetchText(url, { timeout = 15000, accept = 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8' } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  const text = await res.text();
  if (text.length > 4_000_000) throw new Error('page too large');
  return text;
}
async function fetchJson(url, opts) { return JSON.parse(await fetchText(url, { ...opts, accept: 'application/json' })); }

function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const m = re.exec(html); if (!m) return null;
  const c = /content\s*=\s*["']([^"']*)["']/i.exec(m[0]);
  return c ? decode(c[1]).trim() : null;
}

/** Open Graph / basic page metadata. */
function pageMeta(html) {
  const title = meta(html, 'og:title') || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  return {
    title: title ? decode(title).replace(/\s+/g, ' ').trim() : null,
    image: meta(html, 'og:image'),
    description: meta(html, 'og:description') || meta(html, 'description'),
    published: meta(html, 'article:published_time') || ((/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i.exec(html) || [])[1] || null),
    canonical: (/<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html) || [])[1] || null,
  };
}

/** Unique absolute links (in page order) whose href matches `re`. */
function findLinks(html, base, re) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/href\s*=\s*["']([^"'#?]+)["']/gi)) {
    let abs; try { abs = new URL(decode(m[1]), base).toString(); } catch { continue; }
    if (!re.test(abs) || seen.has(abs)) continue;
    seen.add(abs); out.push(abs);
  }
  return out;
}

/** Inner HTML of <article>, else <main>, else <body>. */
function mainContent(html) {
  for (const t of ['article', 'main', 'body']) {
    const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(html);
    if (m && m[1].length > 200) return m[1];
  }
  return html;
}

module.exports = { fetchText, fetchJson, pageMeta, findLinks, mainContent, UA };
