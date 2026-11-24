/**
 * Game update sources — every source returns the same "update" shape:
 *   { id, title, url, body, bodyKind, image, icon, date, version, game, source, buttons }
 * which src/updates/format.js turns into the readable card.
 *
 * A subscription row (game_subscriptions) keeps its source in app_id:
 *   "570"                → Steam app 570 (unchanged from before, so existing alerts keep working)
 *   "minecraft:bedrock"  → source:game
 *   "rss:https://…"      → any RSS / Atom feed
 *
 * Confirmed sources (documented / verified feeds): steam, minecraft, rss
 * Beta sources (read the publisher's news page; may need tweaking if a site changes): riot, fortnite, blizzard
 */

const steam = require('../platforms/steam');
const { parseFeed } = require('./feed');
const page = require('./page');
const { toBlocks } = require('./format');

const MC_BASE = 'https://launchercontent.mojang.com';
const ZD_BASE = 'https://feedback.minecraft.net/api/v2/help_center/en-us';

const SOURCES = {
  steam:     { label: 'Steam',            beta: false, games: null },
  minecraft: { label: 'Minecraft',        beta: false, games: [
    { value: 'java',            name: 'Java Edition — releases' },
    { value: 'java-snapshots',  name: 'Java Edition — snapshots' },
    { value: 'bedrock',         name: 'Bedrock Edition — releases' },
    { value: 'bedrock-preview', name: 'Bedrock Edition — Beta & Preview' },
  ] },
  riot:      { label: 'Riot Games',       beta: true, games: [
    { value: 'lol',      name: 'League of Legends' },
    { value: 'valorant', name: 'VALORANT' },
    { value: 'tft',      name: 'Teamfight Tactics' },
  ] },
  fortnite:  { label: 'Epic Games (Fortnite)', beta: true, games: [
    { value: 'patch-notes', name: 'Fortnite — patch notes & news' },
  ] },
  blizzard:  { label: 'Blizzard',         beta: true, games: [
    { value: 'overwatch',   name: 'Overwatch' },
    { value: 'diablo4',     name: 'Diablo IV' },
    { value: 'wow',         name: 'World of Warcraft' },
    { value: 'hearthstone', name: 'Hearthstone' },
  ] },
  rss:       { label: 'RSS / Atom feed',  beta: false, games: null },
};

// Pages for the "beta" sources: where the list of articles is, and which links are patch notes.
const PAGES = {
  'riot:lol':      { name: 'League of Legends', listing: 'https://www.leagueoflegends.com/en-us/news/tags/patch-notes/', re: /\/en-us\/news\/game-updates\/league-of-legends-patch-[a-z0-9-]*\/?$/i },
  'riot:tft':      { name: 'Teamfight Tactics', listing: 'https://www.leagueoflegends.com/en-us/news/tags/patch-notes/', re: /\/en-us\/news\/game-updates\/teamfight-tactics-patch-[a-z0-9-]*\/?$/i },
  'riot:valorant': { name: 'VALORANT',          listing: 'https://playvalorant.com/en-us/news/tags/patch-notes/',        re: /\/en-us\/news\/game-updates\/valorant-patch-notes-[a-z0-9-]*\/?$/i },
  'fortnite:patch-notes': { name: 'Fortnite',   listing: 'https://www.fortnite.com/news?lang=en-US',                     re: /fortnite\.com\/news\/[a-z0-9-]*(?:v\d|update|patch|release)[a-z0-9-]*\/?$/i },
  'blizzard:overwatch':   { name: 'Overwatch',  listing: 'https://news.blizzard.com/en-us/overwatch',   re: /news\.blizzard\.com\/en-us\/(?:article|overwatch)\/\d+\/[a-z0-9-]+/i, slug: /patch|hotfix|update|season|notes|changes/i },
  'blizzard:diablo4':     { name: 'Diablo IV',  listing: 'https://news.blizzard.com/en-us/diablo4',     re: /news\.blizzard\.com\/en-us\/(?:article|diablo4)\/\d+\/[a-z0-9-]+/i,   slug: /patch|hotfix|update|season|notes|changes/i },
  'blizzard:wow':         { name: 'World of Warcraft', listing: 'https://news.blizzard.com/en-us/world-of-warcraft', re: /news\.blizzard\.com\/en-us\/(?:article|world-of-warcraft)\/\d+\/[a-z0-9-]+/i, slug: /patch|hotfix|update|season|notes|changes/i },
  'blizzard:hearthstone': { name: 'Hearthstone', listing: 'https://news.blizzard.com/en-us/hearthstone', re: /news\.blizzard\.com\/en-us\/(?:article|hearthstone)\/\d+\/[a-z0-9-]+/i, slug: /patch|hotfix|update|notes|changes/i },
};

// ── Keys ──────────────────────────────────────────────────────────────────────

const FREE_KEYS = new Set(['epic', 'steam_free']);

/** app_id stored in the database → { source, value } (source null = a free-games row). */
function parseKey(appId) {
  const id = String(appId ?? '');
  if (FREE_KEYS.has(id)) return { source: null, value: id };
  if (/^\d+$/.test(id)) return { source: 'steam', value: id };
  const i = id.indexOf(':');
  return i > 0 ? { source: id.slice(0, i), value: id.slice(i + 1) } : { source: null, value: id };
}
const makeKey = (source, value) => source === 'steam' ? String(value) : `${source}:${value}`;
const isUpdateKey = (appId) => !!parseKey(appId).source;

const absolute = (u, base) => { try { return new URL(u, base).toString(); } catch { return null; } };
const firstImage = (html) => (toBlocks(html, 'html').images.find(x => /^https?:\/\//.test(x)) || null);
const verFrom = (s) => (/(\d+(?:\.\d+){1,3}[a-z]?|\d{2}w\d{2}[a-z])/i.exec(String(s)) || [])[1] || null;

// ── Adapters ──────────────────────────────────────────────────────────────────

const iconCache = new Map();

/** The game's cover art from Steam's CDN, used as the small picture in the corner of the post. */
async function steamIcon(appId) {
  if (iconCache.has(appId)) return iconCache.get(appId);
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}`;
  let found = null;
  for (const file of ['library_600x900.jpg', 'capsule_231x87.jpg']) {
    try {
      const res = await fetch(`${base}/${file}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.ok) { found = `${base}/${file}`; break; }
    } catch { /* try the next one */ }
  }
  iconCache.set(appId, found);
  return found;
}

async function steamLatest(appId, name) {
  const n = (await steam.getGameNews(appId, 5))[0];
  if (!n) return null;
  return {
    id: String(n.gid), title: n.title, url: n.url, body: n.contents, bodyKind: 'auto',
    image: steam.getHeaderImage(appId), icon: await steamIcon(appId),
    date: (n.date || 0) * 1000 || null, version: null, game: name, source: 'Steam',
    buttons: [{ label: 'Open store page', url: `https://store.steampowered.com/app/${appId}` }],
  };
}

async function minecraftJava(value, name) {
  const data = await page.fetchJson(`${MC_BASE}/v2/javaPatchNotes.json`);
  const wanted = value === 'java-snapshots' ? 'snapshot' : 'release';
  const e = (data.entries || []).filter(x => x.type === wanted).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  if (!e) return null;

  let body = e.shortText || '';
  const path = String(e.contentPath || '').replace(/^\//, '');
  if (path) {
    for (const u of [`${MC_BASE}/v2/${path}`, `${MC_BASE}/${path}`]) {
      try { const t = await page.fetchText(u); try { body = JSON.parse(t).body ?? t; } catch { body = t; } break; } catch { /* try next */ }
    }
  }
  return {
    id: String(e.id || e.version), title: e.title || `Minecraft ${e.version}`, url: `https://minecraft.wiki/w/Java_Edition_${encodeURIComponent(e.version)}`,
    body, bodyKind: 'html', image: e.image?.url ? absolute(e.image.url, MC_BASE) : null, icon: null,
    date: Date.parse(e.date) || null, version: e.version, game: name || 'Minecraft: Java Edition', source: 'Minecraft', buttons: [],
  };
}

async function minecraftBedrock(value, name) {
  const preview = value === 'bedrock-preview';
  let articles = null;
  try {
    const secs = (await page.fetchJson(`${ZD_BASE}/sections.json?per_page=100`)).sections || [];
    const sec = secs.find(s => (preview ? /beta.*preview/i : /release\s*changelog/i).test(s.name));
    if (sec) articles = (await page.fetchJson(`${ZD_BASE}/sections/${sec.id}/articles.json?sort_by=created_at&sort_order=desc&per_page=5`)).articles;
  } catch { /* fall back below */ }
  if (!articles?.length) {
    const all = (await page.fetchJson(`${ZD_BASE}/articles.json?sort_by=created_at&sort_order=desc&per_page=40`)).articles || [];
    articles = all.filter(a => /bedrock/i.test(a.title) && (/beta|preview/i.test(a.title) === preview));
  }
  const a = (articles || []).find(x => !x.draft);
  if (!a) return null;
  return {
    id: String(a.id), title: a.title, url: a.html_url, body: a.body, bodyKind: 'html', image: firstImage(a.body), icon: null,
    date: Date.parse(a.created_at) || null, version: verFrom(a.title), game: name || 'Minecraft: Bedrock Edition', source: 'Minecraft', buttons: [],
  };
}

/** Reads a publisher's news page: finds the newest matching article, then reads that article. */
async function pageLatest(key, cfg, sourceId) {
  const html = await page.fetchText(cfg.listing);
  let links = page.findLinks(html, cfg.listing, cfg.re);
  if (cfg.slug) links = links.filter(l => cfg.slug.test(l));
  const url = links[0];
  if (!url) throw new Error(`Couldn't find any patch notes on ${new URL(cfg.listing).hostname} — the site layout may have changed.`);

  const art = await page.fetchText(url);
  const m = page.pageMeta(art);
  const title = (m.title || '').replace(/\s*[|–-]\s*(League of Legends|VALORANT|Fortnite|Blizzard News|Overwatch|Diablo.*|World of Warcraft|Hearthstone|Site)\s*$/i, '').trim() || cfg.name;
  return {
    id: url, title, url, body: page.mainContent(art), bodyKind: 'html', image: m.image || null, icon: null,
    date: Date.parse(m.published || '') || null, version: verFrom(title), game: cfg.name, source: SOURCES[sourceId].label, buttons: [],
  };
}

async function rssLatest(url, name) {
  const feed = parseFeed(await page.fetchText(url, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' }));
  const it = feed.items[0];
  if (!it) return null;
  return {
    id: String(it.id), title: it.title, url: it.url, body: it.content, bodyKind: 'html', image: it.image, icon: null,
    date: it.date, version: null, game: name || feed.title || new URL(url).hostname, source: 'RSS', buttons: [],
  };
}

// ── Public ────────────────────────────────────────────────────────────────────

/** Newest update for a source → update object, or null if there is none yet. Throws a readable Error on failure. */
async function fetchLatestFor(source, value, name) {
  switch (source) {
    case 'steam':     return steamLatest(value, name);
    case 'rss':       return rssLatest(value, name);
    case 'minecraft': return value.startsWith('bedrock') ? minecraftBedrock(value, name) : minecraftJava(value, name);
    case 'riot': case 'fortnite': case 'blizzard': {
      const cfg = PAGES[`${source}:${value}`];
      if (!cfg) throw new Error(`Unknown ${source} game "${value}".`);
      return pageLatest(`${source}:${value}`, cfg, source);
    }
    default: throw new Error(`Unknown update source "${source}".`);
  }
}

/** Convenience: fetch for a database row. */
function fetchLatest(sub) {
  const { source, value } = parseKey(sub.app_id);
  if (!source) return Promise.resolve(null);
  return fetchLatestFor(source, value, sub.game_name);
}

module.exports = { SOURCES, PAGES, parseKey, makeKey, isUpdateKey, fetchLatest, fetchLatestFor };
