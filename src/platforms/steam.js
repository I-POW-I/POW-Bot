const { log } = require('../logger');

async function steamFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Steam ${res.status}`);
  return res.json();
}

async function searchGames(term) {
  try {
    const data = await steamFetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`);
    return (data.items || []).slice(0, 5).map(i => ({ appid: i.id, name: i.name, tinyImage: i.tiny_image }));
  } catch (err) { log('WARN', 'Steam search failed', { err }); return []; }
}

async function getAppDetails(appId) {
  try {
    const data = await steamFetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=US&l=english`);
    const app = data[String(appId)];
    if (!app?.success) return null;
    const d = app.data;
    const platforms = Object.entries(d.platforms || {}).filter(([,v])=>v).map(([k])=>k.charAt(0).toUpperCase()+k.slice(1)).join(', ');
    return {
      name: d.name, headerImage: d.header_image,
      screenshots: d.screenshots?.slice(0,1).map(s=>s.path_full) || [],
      description: d.short_description || null, platforms: platforms || null,
      releaseDate: d.release_date?.date || null, price: d.price_overview || null,
      reviews: d.reviews || (d.metacritic?.score ? `Metacritic: ${d.metacritic.score}/100` : null),
    };
  } catch { return null; }
}

const UPDATE_KEYWORDS = ['update','patch','hotfix','hot fix','changelog','maintenance','build','notes','fix','release','series'];
function isActualUpdate(item) {
  const title = (item.title||'').toLowerCase();
  const ok = item.feedname==='steam_community_announcements'||item.feedname==='steam_updates'||item.feed_type===1;
  return ok && UPDATE_KEYWORDS.some(kw=>title.includes(kw));
}

async function getGameNews(appId, count=5) {
  try {
    const data = await steamFetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=${count}&maxlength=5000&format=json`);
    return (data?.appnews?.newsitems||[]).filter(isActualUpdate);
  } catch (err) { log('WARN', `Steam news failed for ${appId}`, { err }); return []; }
}

async function getSteamFreeGames() {
  try {
    const freeGames = new Map();
    const addIfFree = item => {
      if (item?.discount_percent===100 && item.final_price===0 && item.type===0 && item.id && !freeGames.has(item.id)) {
        freeGames.set(item.id, { appid:item.id, name:item.name, originalPrice:item.original_price,
          headerImage:`https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/header.jpg`,
          url:`https://store.steampowered.com/app/${item.id}`, discountExpiry:item.discount_expiration||null });
      }
    };
    // Check ALL sections in featuredcategories
    const featCat = await steamFetch('https://store.steampowered.com/api/featuredcategories?cc=US&l=en');
    for (const section of Object.values(featCat)) {
      if (typeof section==='object' && Array.isArray(section?.items)) section.items.forEach(addIfFree);
    }
    // Also check featured endpoint for more coverage
    try {
      const feat = await steamFetch('https://store.steampowered.com/api/featured/?cc=US&l=en');
      [feat.large_capsules,feat.featured_win,feat.featured_mac,feat.featured_linux].forEach(list=>{
        if (Array.isArray(list)) list.forEach(addIfFree);
      });
    } catch {}
    return [...freeGames.values()];
  } catch (err) { log('WARN', 'Steam free games check failed', { err }); return []; }
}

function getHeaderImage(appId) { return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`; }

module.exports = { searchGames, getAppDetails, getGameNews, getSteamFreeGames, getHeaderImage };
