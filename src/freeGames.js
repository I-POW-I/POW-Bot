/**
 * The free game stores a server can follow. Each one is a row in game_subscriptions, so a server can have
 * any combination switched on, all posting to the same channel and pinging the same role.
 *
 *   epic        Epic Games Store (Epic's own free games feed)
 *   steam_free  Steam, games that are free to keep for a limited time (GamerPower)
 *   gog_free    GOG, games that are free to keep for a limited time (GamerPower)
 */

const STORES = {
  epic:       { label: 'Epic Games Store', short: 'Epic',  rowName: 'Epic Games Free Games' },
  steam_free: { label: 'Steam',            short: 'Steam', rowName: 'Steam Free Games', platform: 'steam' },
  gog_free:   { label: 'GOG',              short: 'GOG',   rowName: 'GOG Free Games',   platform: 'gog' },
};

const IDS = Object.keys(STORES);
const SQL_IDS = `(${IDS.map(id => `'${id}'`).join(', ')})`;   // for "app_id IN ..." (fixed values, never user input)

module.exports = { STORES, IDS, SQL_IDS };
