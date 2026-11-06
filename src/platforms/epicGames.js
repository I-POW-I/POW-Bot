const { log } = require('../logger');
const EPIC_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';

async function getFreeGames() {
  try {
    const res  = await fetch(EPIC_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Epic API ${res.status}`);
    const data  = await res.json();
    const games = data?.data?.Catalog?.searchStore?.elements || [];
    const current = [], upcoming = [];

    for (const game of games) {
      const promos = game.promotions;
      if (!promos) continue;
      const slug     = game.productSlug || game.urlSlug || '';
      const cleanSlug = slug.replace(/\/home$/, '');
      const url      = cleanSlug ? `https://store.epicgames.com/en-US/p/${cleanSlug}` : 'https://store.epicgames.com/free-games';
      const image    = game.keyImages?.find(i => i.type === 'OfferImageWide' || i.type === 'DieselStoreFrontWide')?.url
                    || game.keyImages?.find(i => i.type === 'Thumbnail')?.url
                    || game.keyImages?.[0]?.url || null;
      const title       = game.title;
      const description = game.description || null;
      const publisher   = game.seller?.name || null;
      const origPrice   = game.price?.totalPrice?.fmtPrice?.originalPrice || null;
      const tags        = (game.tags || [])
        .filter(t => t.groupName === 'feature' || t.groupName === 'genre')
        .slice(0, 4).map(t => t.name?.toUpperCase()).filter(Boolean);

      const currentOffers = promos.promotionalOffers?.[0]?.promotionalOffers || [];
      for (const offer of currentOffers) {
        if (offer.discountSetting?.discountPercentage === 0) {
          current.push({ title, url, image, publisher, origPrice, description, tags, endsAt: offer.endDate });
          break;
        }
      }
      const upcomingOffers = promos.upcomingPromotionalOffers?.[0]?.promotionalOffers || [];
      for (const offer of upcomingOffers) {
        if (offer.discountSetting?.discountPercentage === 0) {
          upcoming.push({ title, url, image, publisher, origPrice, description, tags, startsAt: offer.startDate, endsAt: offer.endDate });
          break;
        }
      }
    }
    return { current, upcoming };
  } catch (err) {
    log('WARN', 'Epic Games API failed', { err });
    return { current: [], upcoming: [] };
  }
}

module.exports = { getFreeGames };
