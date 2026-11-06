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

function parseSteamContent(raw, maxLength=1000) {
  if (!raw) return { text:'', imageUrl:null, youtubeUrl:null };
  let text = raw;
  const clanImg=text.match(/\{STEAM_CLAN_IMAGE\}\/([^\s\[\]\n,{]+)/i);
  const regImg=text.match(/\[img\](https?:\/\/[^\[]+?)\[\/img\]/i);
  let imageUrl=clanImg?`https://clan.akamai.steamstatic.com/images/${clanImg[1]}`:regImg?regImg[1].trim():null;
  if (!imageUrl) { const si=text.match(/src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|gif|webp))['"]/i); if(si) imageUrl=si[1]; }
  const ytMatch=text.match(/\[previewyoutube=([A-Za-z0-9_-]+)/i)||text.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]+)/i);
  const youtubeUrl=ytMatch?`https://youtube.com/watch?v=${ytMatch[1]}`:null;
  text=text.replace(/\\n/g,'\n').replace(/\r\n|\r/g,'\n');
  text=text.replace(/\{STEAM_CLAN_IMAGE\}\/[^\s\[\]\n,{]+/gi,'').replace(/\[img\][^\[]*?\[\/img\]/gis,'').replace(/\[previewyoutube[^\]]*\][^\[]*?\[\/previewyoutube\]/gis,'');
  // HTML → markdown
  text=text
    .replace(/<h[1-6][^>]*>\s*(.*?)\s*<\/h[1-6]>/gis,'\n**$1**\n')
    .replace(/<(?:strong|b)[^>]*>\s*(.*?)\s*<\/(?:strong|b)>/gis,'\n**$1**')
    .replace(/<(?:em|i)[^>]*>\s*(.*?)\s*<\/(?:em|i)>/gis,'*$1*')
    .replace(/<p[^>]*>/gi,'\n').replace(/<\/p>/gi,'\n')
    .replace(/<li[^>]*>/gi,'\n• ').replace(/<\/li>/gi,'')
    .replace(/<[ou]l[^>]*>/gi,'\n').replace(/<\/[ou]l>/gi,'\n')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'');
  // BBCode → markdown
  text=text
    .replace(/\[h[1-3]\]\s*(.*?)\s*\[\/h[1-3]\]/gis,'\n**$1**\n')
    .replace(/\[b\]\s*(.*?)\s*\[\/b\]/gis,'\n**$1**')
    .replace(/\[i\]\s*(.*?)\s*\[\/i\]/gis,'*$1*')
    .replace(/\[u\]\s*(.*?)\s*\[\/u\]/gis,'__$1__')
    .replace(/\[strike\]\s*(.*?)\s*\[\/strike\]/gis,'~~$1~~')
    .replace(/\[url=([^\]]+)\]\s*(.*?)\s*\[\/url\]/gis,'[$2]($1)')
    .replace(/\[url\](.*?)\[\/url\]/gis,'$1')
    .replace(/\[list\]/gi,'\n').replace(/\[\/list\]/gi,'\n')
    .replace(/\s*\[\*\]\s*\\?/g,'\n• ')
    .replace(/\[[^\]]{1,30}\]/g,'');
  // Entities
  text=text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–');
  // Neutralize any HTML delimiters reintroduced by entity decoding (e.g. &lt;script&gt; -> script)
  text=text.replace(/[<>]/g,'');
  // Raw \ bullets (CS2 style)
  text=text.replace(/^\\([A-Z])/m,'• $1').replace(/([.!?)])\s*\\([A-Z])/g,'$1\n• $2').replace(/\s+\\([A-Z])/g,'\n• $1').replace(/^\\/gm,'• ');
  text=text.replace(/\n{3,}/g,'\n\n').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').trim();
  if (text.length>maxLength) { const c=text.lastIndexOf('\n',maxLength-4); text=(c>maxLength*0.6?text.slice(0,c):text.slice(0,maxLength-3))+'\n...'; }
  return { text, imageUrl, youtubeUrl };
}

module.exports = { searchGames, getAppDetails, getGameNews, getSteamFreeGames, getHeaderImage, parseSteamContent };
