/**
 * /game-updates — patch note / news alerts for games.
 *
 * Sources: Steam · Minecraft (Java + Bedrock) · Riot Games · Fortnite · Blizzard · any RSS/Atom feed
 * (Free game alerts for Epic + Steam live in /free-games.)
 *
 *   add     — watch a game and post its updates in a channel
 *   edit    — change the channel or ping role
 *   remove  — stop watching
 *   list    — everything being watched here
 *   test    — post the latest update right now
 */

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType, InteractionContextType,
} = require('discord.js');
const { selectAll, selectOne, run } = require('../src/database');
const { searchGames } = require('../src/platforms/steam');
const { SOURCES, parseKey, makeKey, isUpdateKey, fetchLatest, fetchLatestFor } = require('../src/updates/sources');
const { audit } = require('../src/diagnostics');
const { log }   = require('../src/logger');

const MAX_PER_SERVER = 20;
const ephemeral = [MessageFlags.Ephemeral];
const NOT_UPDATES = "('epic', 'steam_free')";

const subsOf = (guildId) => selectAll(`SELECT * FROM game_subscriptions WHERE guild_id = ? AND app_id NOT IN ${NOT_UPDATES} ORDER BY game_name`, [guildId]);
const labelOf = (sub) => {
  const { source } = parseKey(sub.app_id);
  return `${sub.game_name || sub.app_id} (${SOURCES[source]?.label || 'Steam'})`;
};

const sourceChoices = Object.entries(SOURCES).map(([value, s]) => ({ name: `${s.label}${s.beta ? ' (beta)' : ''}`, value }));

const data = new SlashCommandBuilder()
  .setName('game-updates')
  .setDescription('Patch note alerts for Steam, Minecraft, Riot, Fortnite, Blizzard and RSS feeds')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(sub => sub.setName('add').setDescription('Watch a game and post its updates in a channel')
    .addStringOption(o => o.setName('source').setDescription('Where the updates come from').setRequired(true).addChoices(...sourceChoices))
    .addStringOption(o => o.setName('game').setDescription('The game — or the feed URL when the source is RSS').setRequired(true).setAutocomplete(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel for the updates').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to ping (optional)')))
  .addSubcommand(sub => sub.setName('edit').setDescription('Change the channel or ping role of an alert')
    .addStringOption(o => o.setName('alert').setDescription('Which alert').setRequired(true).setAutocomplete(true))
    .addChannelOption(o => o.setName('channel').setDescription('New channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('role').setDescription('New ping role'))
    .addBooleanOption(o => o.setName('remove_ping').setDescription('Stop pinging a role')))
  .addSubcommand(sub => sub.setName('remove').setDescription('Stop watching a game')
    .addStringOption(o => o.setName('alert').setDescription('Which alert').setRequired(true).setAutocomplete(true)))
  .addSubcommand(sub => sub.setName('list').setDescription('Show every game being watched here'))
  .addSubcommand(sub => sub.setName('test').setDescription('Post the latest update right now')
    .addStringOption(o => o.setName('alert').setDescription('Which alert').setRequired(true).setAutocomplete(true)));

// ── Autocomplete ──────────────────────────────────────────────────────────────

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const term = String(focused.value || '').trim();
  let choices = [];

  if (focused.name === 'game') {
    const source = interaction.options.getString('source');
    if (source === 'steam') {
      if (term.length >= 2) choices = (await searchGames(term)).map(g => ({ name: `${g.name} (${g.appid})`.slice(0, 100), value: String(g.appid) }));
    } else if (source === 'rss') {
      if (/^https?:\/\//i.test(term)) choices = [{ name: `Use this feed: ${term}`.slice(0, 100), value: term.slice(0, 100) }];
    } else if (SOURCES[source]?.games) {
      choices = SOURCES[source].games.filter(g => g.name.toLowerCase().includes(term.toLowerCase())).map(g => ({ name: g.name, value: g.value }));
    }
  } else if (focused.name === 'alert' && interaction.guildId) {
    choices = subsOf(interaction.guildId)
      .filter(s => labelOf(s).toLowerCase().includes(term.toLowerCase()))
      .map(s => ({ name: `${labelOf(s)} → #${interaction.guild.channels.cache.get(s.channel_id)?.name || 'deleted-channel'}`.slice(0, 100), value: String(s.id) }));
  }
  return interaction.respond(choices.slice(0, 25));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const reply = (i, content) => i.reply({ content, flags: ephemeral });

function missingPerms(channel, guild) {
  const p = channel.permissionsFor(guild.members.me);
  return ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter(x => !p?.has(PermissionFlagsBits[x])).map(x => x.replace(/([a-z])([A-Z])/g, '$1 $2'));
}

/** Work out { source, value, name } from what the admin typed. Throws a friendly Error. */
async function resolveChoice(source, typed) {
  const text = String(typed || '').trim();
  if (source === 'steam') {
    if (/^\d+$/.test(text)) return { source, value: text, name: (await searchGames(text).catch(() => [])).find(g => String(g.appid) === text)?.name || `Steam app ${text}` };
    const hit = (await searchGames(text))[0];
    if (!hit) throw new Error(`Steam has no game matching "${text}". Start typing and pick one from the list.`);
    return { source, value: String(hit.appid), name: hit.name };
  }
  if (source === 'rss') {
    if (!/^https?:\/\/\S+$/i.test(text)) throw new Error('For RSS, paste the full feed URL (starting with https://) into **game**.');
    return { source, value: text, name: null };
  }
  const game = SOURCES[source]?.games?.find(g => g.value === text || g.name.toLowerCase() === text.toLowerCase());
  if (!game) throw new Error(`Pick a ${SOURCES[source]?.label || source} game from the list.`);
  return { source, value: game.value, name: game.name };
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function addAlert(interaction) {
  const { guild } = interaction;
  const channel = interaction.options.getChannel('channel'), role = interaction.options.getRole('role');
  const missing = missingPerms(channel, guild);
  if (missing.length) return reply(interaction, `I can't post in <#${channel.id}> — I'm missing: **${missing.join(', ')}**. Fix that and try again.`);
  if (subsOf(guild.id).length >= MAX_PER_SERVER) return reply(interaction, `This server already watches ${MAX_PER_SERVER} games — remove one first.`);

  await interaction.deferReply({ flags: ephemeral });
  let choice;
  try { choice = await resolveChoice(interaction.options.getString('source'), interaction.options.getString('game')); }
  catch (err) { return interaction.editReply({ content: `❌ ${err.message}` }); }

  const key = makeKey(choice.source, choice.value);
  if (selectOne('SELECT id FROM game_subscriptions WHERE guild_id = ? AND app_id = ?', [guild.id, key])) {
    return interaction.editReply({ content: '❌ This server already watches that — use `/game-updates edit` to change it.' });
  }

  // Read the current newest update: it becomes the starting point so only FUTURE updates are posted
  let latest = null, note = '';
  try { latest = await fetchLatestFor(choice.source, choice.value, choice.name); }
  catch (err) {
    if (!SOURCES[choice.source].beta) return interaction.editReply({ content: `❌ I couldn't read that source: ${err.message}` });
    note = `\n⚠️ I couldn't read **${choice.name || choice.value}** just now (${err.message}). It's saved, and I'll keep trying — use \`/game-updates test\` to check.`;
  }
  const name = choice.name || latest?.game || choice.value;

  run('INSERT INTO game_subscriptions (guild_id, app_id, game_name, channel_id, role_id, last_post_id) VALUES (?, ?, ?, ?, ?, ?)',
    [guild.id, key, name, channel.id, role?.id || null, latest ? String(latest.id) : null]);
  audit({ action: 'Game update alert added', actor: interaction.user, guild, details: `${name} (${SOURCES[choice.source].label}) → #${channel.name}` });

  return interaction.editReply({
    content: [`✅ Now watching **${name}** (${SOURCES[choice.source].label}) in <#${channel.id}>${role ? ` · pinging <@&${role.id}>` : ''}.`,
      latest ? `Latest right now: *${latest.title}* — only newer updates will be posted. Use \`/game-updates test\` to preview the look.` : 'No updates found yet — the next one will be posted automatically.',
      note].filter(Boolean).join('\n'),
  });
}

async function editAlert(interaction) {
  const sub = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [interaction.options.getString('alert'), interaction.guildId]);
  if (!sub || !isUpdateKey(sub.app_id)) return reply(interaction, '❌ I can\'t find that alert.');
  const channel = interaction.options.getChannel('channel'), role = interaction.options.getRole('role'), clear = interaction.options.getBoolean('remove_ping');
  if (!channel && !role && !clear) return reply(interaction, 'Choose a new **channel**, a new **role**, or **remove_ping**.');
  if (channel) { const m = missingPerms(channel, interaction.guild); if (m.length) return reply(interaction, `I can't post in <#${channel.id}> — missing **${m.join(', ')}**.`); }

  const newChannel = channel?.id || sub.channel_id, newRole = clear ? null : (role?.id || sub.role_id);
  run('UPDATE game_subscriptions SET channel_id = ?, role_id = ? WHERE id = ?', [newChannel, newRole, sub.id]);
  audit({ action: 'Game update alert changed', actor: interaction.user, guild: interaction.guild, details: `${sub.game_name} → <#${newChannel}>` });
  return reply(interaction, `✅ **${sub.game_name}** now posts in <#${newChannel}>${newRole ? ` · pinging <@&${newRole}>` : ' · no ping'}.`);
}

function removeAlert(interaction) {
  const sub = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [interaction.options.getString('alert'), interaction.guildId]);
  if (!sub || !isUpdateKey(sub.app_id)) return reply(interaction, '❌ I can\'t find that alert — it may already be removed.');
  run('DELETE FROM game_subscriptions WHERE id = ?', [sub.id]);
  audit({ action: 'Game update alert removed', actor: interaction.user, guild: interaction.guild, details: sub.game_name });
  return reply(interaction, `🗑️ Stopped watching **${sub.game_name}**.`);
}

function listAlerts(interaction) {
  const subs = subsOf(interaction.guildId);
  if (!subs.length) return reply(interaction, '📭 No game update alerts yet. Add one with `/game-updates add`.');
  const lines = subs.map(s => `**${s.game_name || s.app_id}** · ${SOURCES[parseKey(s.app_id).source]?.label || 'Steam'}\n└ <#${s.channel_id}>${s.role_id ? ` · <@&${s.role_id}>` : ''}`);
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`🎮 Game update alerts (${subs.length})`).setDescription(lines.join('\n').slice(0, 3900))
      .setFooter({ text: '/game-updates edit · remove · test' })],
    flags: ephemeral,
  });
}

async function testAlert(interaction, client) {
  const sub = selectOne('SELECT * FROM game_subscriptions WHERE id = ? AND guild_id = ?', [interaction.options.getString('alert'), interaction.guildId]);
  if (!sub || !isUpdateKey(sub.app_id)) return reply(interaction, '❌ I can\'t find that alert.');
  await interaction.deferReply({ flags: ephemeral });
  try {
    const update = await fetchLatest(sub);
    if (!update) return interaction.editReply({ content: `No updates found for **${sub.game_name}** yet.` });
    const { postUpdate } = require('../src/gamePoller');
    const ok = await postUpdate(client || interaction.client, { ...sub, role_id: null }, update);   // a test never pings the role
    return interaction.editReply({ content: ok ? `✅ Posted the latest update (*${update.title}*) in <#${sub.channel_id}>.` : `❌ I couldn't post in <#${sub.channel_id}> — check my permissions there.` });
  } catch (err) {
    log('WARN', 'Game update test failed', { game: sub.game_name, err });
    return interaction.editReply({ content: `❌ I couldn't read the updates: ${err.message}` });
  }
}

async function execute(interaction, client) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return reply(interaction, 'You need **Manage Server** to change game alerts.');
  switch (interaction.options.getSubcommand()) {
    case 'add':    return addAlert(interaction);
    case 'edit':   return editAlert(interaction);
    case 'remove': return removeAlert(interaction);
    case 'list':   return listAlerts(interaction);
    case 'test':   return testAlert(interaction, client);
  }
}

module.exports = { data, execute, autocomplete };
