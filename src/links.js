/**
 * Public links, set as variables in the host (all optional):
 *   SUPPORT_URL   invite to the support server
 *   PRIVACY_URL   privacy policy
 *   TERMS_URL     terms of service
 * Anything that is not set is simply left out.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const LINKS = [['Support server', 'SUPPORT_URL'], ['Privacy policy', 'PRIVACY_URL'], ['Terms', 'TERMS_URL']];
const valid = (u) => /^https:\/\/\S+$/i.test(String(u || '').trim());

/** One row of link buttons, or an empty list when none are set. */
function linkRows() {
  const buttons = LINKS.filter(([, key]) => valid(process.env[key])).map(([label, key]) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(process.env[key].trim()));
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

module.exports = { linkRows };
