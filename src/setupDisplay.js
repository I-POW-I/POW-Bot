/**
 * /setup > Display: card pictures or classic Discord embeds, for everything or for one area at a time.
 *
 * customIds: setup:display[:cycle:<all|setup|logs|commands|posts|reset>] [:cards] [:clock] [:tz] [:accent]
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const kit = require('./setupKit');
const style = require('./ui/style');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { audit } = require('./diagnostics');

const { BLUE, noteGood, backButton, respond } = kit;
const PAGES = ['display'];
const owns = (page) => PAGES.includes(page);

const LABEL = { auto: 'Smart', card: 'Always cards', embed: 'Classic embeds' };
const row = (...c) => new ActionRowBuilder().addComponents(...c);

function globalOff() { try { return !require('./globalConfig').featureEnabled('cardPanels'); } catch { return false; } }

function viewDisplay(guild, user, note) {
  const s = style.settings(guild.id);
  const forced = (() => { try { return require('./globalConfig').get().uiOverrides?.[guild.id] || null; } catch { return null; } })();
  const eff = (area) => LABEL[style.styleFor(guild.id, area)];
  const cardLook = style.styleFor(guild.id, 'commands', true) === 'embed' ? 'Embed' : 'Image';
  const lines = [note,
    'Choose how the bot\'s messages look in this server.\n**Card style** covers the messages made to be looked at and shared: the live panel, My card and member cards, Wrapped, busy times, the weekly recap, the leaderboard, and streamer, game update and free game posts. They are dark picture cards (**Image**) or standard Discord boxes (**Embed**). Embeds send faster, and their text can be copied and read aloud by a screen reader.\nEverything else (verification, reaction roles, help, setup, confirmations, polls, announcements, log entries and error replies) is a classic embed unless you change it below.',
    globalOff() ? 'The bot owner has switched cards off for every server, so everything is shown as classic embeds right now.' : null,
    forced ? `The bot owner has set this server to **${LABEL[forced]}**, which overrides the choices below.` : null,
  ].filter(Boolean).join('\n\n');
  const fields = [
    { name: 'Card style', value: s.cards ? (s.cards === 'embed' ? 'Embed' : 'Image') : `Image (default)`, inline: true },
    { name: 'Everything', value: s.all ? LABEL[s.all] : 'Smart (default)', inline: true },
    ...style.AREAS.map(a => ({ name: a.label, value: s[a.key] ? LABEL[s[a.key]] : `Follows everything (${eff(a.key)})`, inline: true })),
  ];
  const btn = (id, label, cur) => new ButtonBuilder().setCustomId(`setup:display:cycle:${id}`).setLabel(`${label}: ${cur ? LABEL[cur] : 'follow'}`.slice(0, 80)).setStyle(cur === 'card' ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Setup · Display' }).setTitle('Display').setDescription(lines).addFields(fields)],
    components: [
      row(btn('all', 'Everything', s.all), btn('setup', 'Setup', s.setup), btn('logs', 'Logs', s.logs), btn('commands', 'Commands', s.commands), btn('posts', 'Posts', s.posts)),
      tzMenu(guild),
      accentMenu(guild),
      row(new ButtonBuilder().setCustomId('setup:display:cards').setLabel(`Card style: ${cardLook}`).setStyle(cardLook === 'Image' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:display:clock').setLabel(`Clock: ${require('./timezone').clockOf(guild.id) === '24' ? '24 hour' : '12 hour'}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:display:cycle:reset').setLabel('Reset looks').setStyle(ButtonStyle.Danger).setDisabled(!Object.values(s).some(Boolean)), backButton('home', 'Back to setup')),
    ],
  };
}

const tzMenu = (guild) => { const tz = require('./timezone'), cur = tz.zoneOf(guild.id);
  return row(new StringSelectMenuBuilder().setCustomId('setup:display:tz').setPlaceholder('Time zone for busy times and Wrapped').addOptions(tz.ZONES.map(([v, label]) => ({ label, value: v, default: v === cur })))); };

const accentMenu = (guild) => { const cur = getGuildConfig(guild.id).accent || 'default';
  return row(new StringSelectMenuBuilder().setCustomId('setup:display:accent').setPlaceholder('Accent colour for posts and replies').addOptions(Object.entries(style.ACCENTS).map(([value, [label]]) => ({ label, value, default: value === cur })))); };

const VIEWS = { display: (guild, user, note) => viewDisplay(guild, user, note) };

async function handle(interaction, { guild, by, action, arg }) {
  if (!action) return respond(interaction, viewDisplay(guild, by));
  if (action === 'accent') {
    const key = interaction.values[0];
    if (!style.ACCENTS[key]) return false;
    setGuildConfig(guild.id, { accent: key === 'default' ? null : key });
    audit({ action: 'Setup: accent colour', actor: by, guild, details: key });
    return respond(interaction, viewDisplay(guild, by, noteGood(key === 'default' ? 'Back to the default colour.' : `Posts and replies now use **${style.ACCENTS[key][0].toLowerCase()}** as their colour. Only card posts that use the default blue change.`)));
  }
  if (action === 'cards') {
    const next = style.settings(guild.id).cards === 'embed' ? null : 'embed';
    const saved = { ...(getGuildConfig(guild.id).uiStyle || {}) };
    if (next) saved.cards = next; else delete saved.cards;
    setGuildConfig(guild.id, { uiStyle: saved });
    audit({ action: 'Setup: card style', actor: by, guild, details: next ? 'embed' : 'image' });
    return respond(interaction, viewDisplay(guild, by, noteGood(next ? 'The panel, member cards, Wrapped, busy times, the weekly recap, the leaderboard and the streamer, game update and free game posts are now sent as embeds. Existing posts change the next time they update.' : 'Those messages are back to picture cards.')));
  }
  if (action === 'clock') {
    const next = require('./timezone').clockOf(guild.id) === '24' ? '12' : '24';
    setGuildConfig(guild.id, { clock: next });
    audit({ action: 'Setup: clock format', actor: by, guild, details: `${next} hour` });
    return respond(interaction, viewDisplay(guild, by, noteGood(`Times of day now read like ${next === '24' ? '21:00' : '9:00 PM'}.`)));
  }
  if (action === 'tz') {
    const zone = interaction.values[0];
    if (!require('./timezone').ZONES.some(z => z[0] === zone)) return false;
    setGuildConfig(guild.id, { timezone: zone });
    audit({ action: 'Setup: time zone', actor: by, guild, details: zone });
    return respond(interaction, viewDisplay(guild, by, noteGood(`Times of day are now shown in ${require('./timezone').labelOf(zone)}.`)));
  }
  if (action === 'cycle') {
    const cur = style.settings(guild.id);
    if (arg === 'reset') {
      setGuildConfig(guild.id, { uiStyle: {} });
      audit({ action: 'Setup: display reset', actor: by, guild });
      return respond(interaction, viewDisplay(guild, by, noteGood('Back to the default look.')));
    }
    if (arg !== 'all' && !style.AREAS.some(a => a.key === arg)) return false;
    // follow -> smart -> always cards -> classic embeds -> follow ("Everything" has no smart step: not set already means smart)
    const order = arg === 'all' ? [null, 'card', 'embed'] : [null, 'auto', 'card', 'embed'];
    const nextValue = order[(order.indexOf(cur[arg] || null) + 1) % order.length];
    const saved = { ...(getGuildConfig(guild.id).uiStyle || {}) };
    if (nextValue) saved[arg] = nextValue; else delete saved[arg];
    setGuildConfig(guild.id, { uiStyle: saved });
    audit({ action: `Setup: display (${arg})`, actor: by, guild, details: nextValue || 'follow' });
    return respond(interaction, viewDisplay(guild, by));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
