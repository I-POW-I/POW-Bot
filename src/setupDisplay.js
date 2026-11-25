/**
 * /setup > Display: card pictures or classic Discord embeds, for everything or for one area at a time.
 *
 * customIds: setup:display[:cycle:<all|setup|logs|commands|posts>]
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
  const lines = [note,
    'Choose how the bot\'s messages look in this server.\n**Smart** (default): dark picture cards, but a message that is too long to read as a picture is sent as a classic embed.\n**Always cards**: every message is a picture card. Long ones are shown smaller by Discord.\n**Classic embeds**: the standard Discord boxes. Text is large and can be copied.',
    globalOff() ? '⚠️ The bot owner has switched cards off for every server, so everything is shown as classic embeds right now.' : null,
    forced ? `⚠️ The bot owner has set this server to **${LABEL[forced]}**, which overrides the choices below.` : null,
  ].filter(Boolean).join('\n\n');
  const fields = [
    { name: 'Everything', value: s.all ? LABEL[s.all] : 'Smart (default)', inline: true },
    ...style.AREAS.map(a => ({ name: a.label, value: s[a.key] ? LABEL[s[a.key]] : `Follows everything (${eff(a.key)})`, inline: true })),
  ];
  const btn = (id, label, cur) => new ButtonBuilder().setCustomId(`setup:display:cycle:${id}`).setLabel(`${label}: ${cur ? LABEL[cur] : 'follow'}`.slice(0, 80)).setStyle(cur === 'card' ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Setup · Display' }).setTitle('Display').setDescription(lines).addFields(fields)],
    components: [
      row(btn('all', 'Everything', s.all), btn('setup', 'Setup', s.setup), btn('logs', 'Logs', s.logs), btn('commands', 'Commands', s.commands), btn('posts', 'Posts', s.posts)),
      row(new ButtonBuilder().setCustomId('setup:display:cycle:reset').setLabel('Reset to default').setStyle(ButtonStyle.Danger).setDisabled(!Object.values(s).some(Boolean)), backButton('home', 'Back to setup')),
    ],
  };
}

const VIEWS = { display: (guild, user, note) => viewDisplay(guild, user, note) };

async function handle(interaction, { guild, by, action, arg }) {
  if (!action) return respond(interaction, viewDisplay(guild, by));
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
