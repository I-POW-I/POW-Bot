/**
 * /setup > Logs.
 *
 *   main    every log and where it goes
 *   type    one log: its channel, which kinds of event it records, and a test entry
 *   ignore  message logs: channels, roles, people and bots to leave out
 *   routes  server changes: send each kind to its own channel
 *
 * customIds: setup:logs[:<action>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType,
} = require('discord.js');

const kit = require('./setupKit');
const logs = require('./logs');
const { getGuildConfig, setGuildConfig, getLogChannel, setLogChannel } = require('./guildConfig');
const { audit } = require('./diagnostics');

const { BLUE, chan, onOff, noteBad, noteGood, backButton, channelSelect, respond, missingIn } = kit;

const PAGES = ['logs'];
const owns = (page) => PAGES.includes(page);

const TYPES = Object.fromEntries(logs.LOG_TYPES.map(t => [t.key, t]));
const GROUPS = Object.fromEntries(logs.EVENTS.server.map(g => [g.key, g]));
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const frame = (title, description, fields) => new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Setup · Logs' }).setTitle(title).setDescription(description || null).addFields(fields || []);
const exists = (guild, id) => guild.channels.cache.has(id);
const list = (items, fn) => items.length ? items.map(fn).join(' ') : '*none*';

function viewMain(guild, user, note) {
  const c = getGuildConfig(guild.id);
  const fields = logs.LOG_TYPES.map(t => {
    const own = getLogChannel(guild.id, t.key);
    const off = (logs.EVENTS[t.key] || []).filter(e => !logs.enabled(guild.id, e.key)).length;
    const where = own ? chan(own) : '*not set*';
    return { name: t.label, value: `${where}${off ? ` · ${off} kind${off === 1 ? '' : 's'} off` : ''}\n-# ${t.desc}`, inline: false };
  });
  const ig = { ch: logs.ignoredChannels(guild.id).filter(id => exists(guild, id)).length, ro: logs.ignoredRoles(guild.id).length, us: logs.ignoredUsers(guild.id).length };
  const routed = Object.keys(logs.routes(guild.id)).filter(k => GROUPS[k]).length;
  fields.push({ name: 'Message logs ignore', value: ig.ch + ig.ro + ig.us ? `${ig.ch} channel${ig.ch === 1 ? '' : 's'} · ${ig.ro} role${ig.ro === 1 ? '' : 's'} · ${ig.us} people or bots` : 'nothing', inline: true });
  fields.push({ name: 'Server change routing', value: routed ? `${routed} kind${routed === 1 ? '' : 's'} have their own channel` : 'everything in one channel', inline: true });
  fields.push({ name: 'Other bots\' deleted messages', value: onOff(c.logBotMessages === true), inline: true });
  // the other features that write to a log channel, and where each one actually goes
  const modlog = getLogChannel(guild.id, 'modlog');
  const where = (own, fallback) => own ? `${chan(own)} *(its own channel)*` : fallback ? `${chan(fallback)} *(Moderation actions log)*` : '*nowhere yet*';
  const am = require('./automod').settings(guild.id), rd = require('./raid').settings(guild.id), cp = require('./checkpoint').settings(guild.id);
  fields.push({ name: 'Also writes to a log', value: [
    `AutoMod: ${am.enabled ? where(am.logChannelId, modlog) : 'off'}`,
    `Raid protection: ${rd.enabled ? where(rd.alertChannelId, modlog || getLogChannel(guild.id, 'members')) : 'off'}`,
    `Security Check Point: ${cp.enabled ? where(cp.logChannelId, modlog) : 'off'}`,
  ].join('\n') + '\n-# These use the Moderation actions log unless you give them their own channel on their own setup page.', inline: false });
  return {
    embeds: [frame('Logs', [note, 'Every log has one channel, set here and nowhere else. Choose a log below to set its channel, switch kinds of event on or off, and send a test entry.'].filter(Boolean).join('\n\n'), fields)],
    components: [
      row(new StringSelectMenuBuilder().setCustomId('setup:logs:type').setPlaceholder('Choose a log to set up…')
        .addOptions(logs.LOG_TYPES.map(t => ({ label: t.label, value: t.key, description: t.desc.slice(0, 90) })))),
      row(backButton('home', 'Back to setup')),
    ],
  };
}

function viewType(guild, user, type, note) {
  const t = TYPES[type];
  const own = getLogChannel(guild.id, type);
  const events = logs.EVENTS[type] || [];

  const lines = [note, t.desc];
  if (type === 'server') {
    lines.push(own ? 'Every change is logged with **who made it**.' : 'Choose a channel to start logging server changes.');
    if (own && !guild.members.me.permissions.has('ViewAuditLog')) lines.push('⚠️ I need the **View Audit Log** permission to see these changes.');
  }
  const fields = [{ name: 'Channel', value: chan(own), inline: true }];
  if (events.length) fields.push({ name: 'Recorded', value: events.map(e => `${logs.enabled(guild.id, e.key) ? '✅' : '⬜'} ${e.label}`).join('\n'), inline: true });
  if (type === 'messages') {
    const c = getGuildConfig(guild.id);
    fields.push({ name: 'Ignored', value: `${logs.ignoredChannels(guild.id).filter(id => exists(guild, id)).length} channels · ${logs.ignoredRoles(guild.id).length} roles · ${logs.ignoredUsers(guild.id).length} people or bots`, inline: true });
    fields.push({ name: 'Other bots\' deleted messages', value: onOff(c.logBotMessages === true), inline: true });
  }
  if (type === 'server') {
    const routed = Object.entries(logs.routes(guild.id)).filter(([k]) => GROUPS[k]);
    fields.push({ name: 'Routing', value: routed.length ? routed.map(([k, id]) => `${GROUPS[k].label} → ${chan(id)}`).join('\n') : 'everything in one channel', inline: true });
  }

  const rows = [row(new StringSelectMenuBuilder().setCustomId('setup:logs:type').setPlaceholder('Choose another log…')
    .addOptions(logs.LOG_TYPES.map(x => ({ label: x.label, value: x.key, description: x.desc.slice(0, 90), default: x.key === type })))),
  channelSelect(`setup:logs:set:${type}`, `Channel for: ${t.label}`, own)];
  if (events.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(`setup:logs:ev:${type}`).setPlaceholder('Kinds of event to record').setMinValues(0).setMaxValues(events.length)
    .addOptions(events.map(e => ({ label: e.label, value: e.key, description: (e.desc || '').slice(0, 100) || undefined, default: logs.enabled(guild.id, e.key) })))));
  rows.push(row(button(`setup:logs:test:${type}`, 'Send a test entry', ButtonStyle.Primary, !own), button(`setup:logs:clear:${type}`, 'Clear this log', ButtonStyle.Danger, !own),
    ...(type === 'messages' ? [button('setup:logs:ig:messages', 'Ignore lists…')] : []),
    ...(type === 'server' ? [button('setup:logs:rt:server', 'Route by kind…')] : []), backButton('logs', 'Back')));
  return { embeds: [frame(t.label, lines.filter(Boolean).join('\n\n'), fields)], components: rows };
}

function viewIgnore(guild, user, note) {
  const c = getGuildConfig(guild.id);
  const channels = logs.ignoredChannels(guild.id).filter(id => exists(guild, id)).slice(0, 25);
  const roles = logs.ignoredRoles(guild.id).filter(id => guild.roles.cache.has(id)).slice(0, 25);
  const users = logs.ignoredUsers(guild.id).slice(0, 25);

  const ch = new ChannelSelectMenuBuilder().setCustomId('setup:logs:ign:messages').setPlaceholder('Channels to ignore').setMinValues(0).setMaxValues(25)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice);
  if (channels.length) ch.setDefaultChannels(...channels);
  const ro = new RoleSelectMenuBuilder().setCustomId('setup:logs:igr:messages').setPlaceholder('Roles to ignore').setMinValues(0).setMaxValues(25);
  if (roles.length) ro.setDefaultRoles(...roles);
  const us = new UserSelectMenuBuilder().setCustomId('setup:logs:igu:messages').setPlaceholder('People and bots to ignore').setMinValues(0).setMaxValues(25);
  if (users.length) us.setDefaultUsers(...users);

  return {
    embeds: [frame('Message logs · ignore lists', [note, 'Anything sent by an ignored person, bot or role, or in an ignored channel, is left out of the deleted and edited message logs. Their text is not even kept.'].filter(Boolean).join('\n\n'), [
      { name: 'Channels', value: list(channels, chan), inline: false },
      { name: 'Roles', value: list(roles, id => `<@&${id}>`), inline: false },
      { name: 'People and bots', value: list(users, id => `<@${id}>`), inline: false },
      { name: 'Other bots\' deleted messages', value: `${onOff(c.logBotMessages === true)}${c.logBotMessages === true ? ' · pick a bot above to leave just that one out' : ''}`, inline: false },
    ])],
    components: [row(ch), row(ro), row(us),
      row(button('setup:logs:bots:messages', `Other bots' deleted messages: ${onOff(c.logBotMessages === true)}`), button('setup:logs:igx:messages', 'Clear all ignores', ButtonStyle.Danger, !(channels.length + roles.length + users.length)), backButton('logs:type:messages', 'Back to Message logs'))],
  };
}

function viewRoutes(guild, user, kind, note) {
  const routes = logs.routes(guild.id);
  const fallback = logs.serverLogChannel(guild.id);
  const fields = logs.EVENTS.server.map(g => ({ name: g.label, value: routes[g.key] && exists(guild, routes[g.key]) ? chan(routes[g.key]) : fallback ? `${chan(fallback)} *(main)*` : '*off*', inline: true }));
  const picker = new StringSelectMenuBuilder().setCustomId('setup:logs:rtk').setPlaceholder('1. Choose a kind of change…')
    .addOptions(logs.EVENTS.server.map(g => ({ label: g.label, value: g.key, description: (routes[g.key] && guild.channels.cache.get(routes[g.key]) ? `Sent to #${guild.channels.cache.get(routes[g.key]).name}` : g.desc).slice(0, 100), default: g.key === kind })));
  const chPicker = new ChannelSelectMenuBuilder().setCustomId(`setup:logs:rtc:${kind || 'none'}`).setPlaceholder(kind && GROUPS[kind] ? `2. Channel for: ${GROUPS[kind].label}` : '2. Then choose its channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1).setMaxValues(1).setDisabled(!(kind && GROUPS[kind]));
  if (kind && GROUPS[kind] && routes[kind]) chPicker.setDefaultChannels(routes[kind]);
  const hint = kind && GROUPS[kind] ? `Choosing a channel for **${GROUPS[kind].label}**.` : 'Pick a kind of change, then the channel it should go to.';
  return {
    embeds: [frame('Server changes · route by kind', [note, 'Send each kind of change to its own channel, for example roles to #staff-log and invites to #invites. Kinds without their own channel go to the main Server log.', hint].filter(Boolean).join('\n\n'), fields)],
    components: [row(picker), row(chPicker),
      row(button(`setup:logs:rtx:${kind || 'none'}`, 'Use the main channel for this kind', ButtonStyle.Secondary, !(kind && GROUPS[kind] && routes[kind])), button('setup:logs:rta:server', 'Reset all routing', ButtonStyle.Danger, !Object.keys(routes).length), backButton('logs:type:server', 'Back to Server changes'))],
  };
}

const VIEWS = { logs: (guild, user, note) => viewMain(guild, user, note) };

async function handle(interaction, { guild, by, action, arg }) {
  const main = (note) => respond(interaction, viewMain(guild, by, note));
  const type = (key, note) => respond(interaction, viewType(guild, by, key, note));
  const ignore = (note) => respond(interaction, viewIgnore(guild, by, note));
  const routes = (kind, note) => respond(interaction, viewRoutes(guild, by, kind, note));
  const done = (what, details) => audit({ action: `Setup: logs, ${what}`, actor: by, guild, details });
  const valid = !!TYPES[arg];

  if (!action) return main();
  if (action === 'type') return type(interaction.values?.[0] || arg);

  if (action === 'set' && valid) {
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild);
    if (missing.length) return type(arg, noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    setLogChannel(guild.id, arg, channel.id);
    done(`channel set (${arg})`, `#${channel.name}`);
    const privacy = arg === 'messages' ? '\nTo log deleted and edited messages, new messages in this server are kept for **7 days**, then deleted automatically. Removing this log deletes them immediately.' : '';
    return type(arg, noteGood(`**${TYPES[arg].label}** now goes to ${channel}.${privacy}`));
  }
  if (action === 'clear' && valid) {
    setLogChannel(guild.id, arg, null);
    if (arg === 'messages') require('./messageStore').purgeGuild(guild.id);   // stop keeping message text
    done(`channel cleared (${arg})`);
    return type(arg, noteGood('Cleared.'));
  }
  if (action === 'ev' && valid) {
    const keys = (logs.EVENTS[arg] || []).map(e => e.key), chosen = new Set(interaction.values);
    const offNow = new Set(logs.off(guild.id));
    for (const k of keys) chosen.has(k) ? offNow.delete(k) : offNow.add(k);
    setGuildConfig(guild.id, { logOff: [...offNow] });
    done(`kinds of event (${arg})`, `on: ${[...chosen].join(', ') || 'none'}`);
    return type(arg, noteGood('Saved.'));
  }

  // ignore lists (message logs)
  if (action === 'ig') return ignore();
  if (action === 'ign') { setGuildConfig(guild.id, { logIgnoreChannelIds: [...interaction.channels.keys()] }); done('ignored channels', `${interaction.channels.size} channel(s)`); return ignore(noteGood('Saved.')); }
  if (action === 'igr') { setGuildConfig(guild.id, { logIgnoreRoleIds: [...interaction.roles.keys()] }); done('ignored roles', `${interaction.roles.size} role(s)`); return ignore(noteGood('Saved.')); }
  if (action === 'igu') {
    const ids = [...interaction.users.keys()];
    setGuildConfig(guild.id, { logIgnoreUserIds: ids });
    require('./messageStore').purgeUsers(guild.id, ids);
    done('ignored people and bots', `${ids.length}`);
    return ignore(noteGood('Saved. Anything already kept from them was deleted.'));
  }
  if (action === 'igx') {
    setGuildConfig(guild.id, { logIgnoreChannelIds: [], logIgnoreRoleIds: [], logIgnoreUserIds: [] });
    done('ignore lists cleared');
    return ignore(noteGood('Nothing is ignored now.'));
  }
  if (action === 'bots') {
    const on = getGuildConfig(guild.id).logBotMessages !== true;
    setGuildConfig(guild.id, { logBotMessages: on });
    if (!on) require('./messageStore').purgeBots(guild.id);
    done('deleted bot messages', on ? 'on' : 'off');
    const needs = on && !getLogChannel(guild.id, 'messages') ? ' Set a Message log channel for it to work.' : '';
    return ignore(noteGood(on ? `Messages deleted by other bots will now be logged. This bot's own messages never are.${needs}` : 'Deleted bot messages are no longer logged, and any stored ones were removed.'));
  }

  // routing (server changes)
  if (action === 'rt') return routes(null);
  if (action === 'rtk') return routes(interaction.values[0]);
  if (action === 'rtc' && GROUPS[arg]) {
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild);
    if (missing.length) return routes(arg, noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`));
    setGuildConfig(guild.id, { logRoutes: { ...logs.routes(guild.id), [arg]: channel.id } });
    done(`route (${arg})`, `#${channel.name}`);
    return routes(arg, noteGood(`**${GROUPS[arg].label}** now go to ${channel}.`));
  }
  if (action === 'rtx' && GROUPS[arg]) {
    const next = { ...logs.routes(guild.id) }; delete next[arg];
    setGuildConfig(guild.id, { logRoutes: next });
    done(`route cleared (${arg})`);
    return routes(arg, noteGood(`**${GROUPS[arg].label}** go to the main Server log again.`));
  }
  if (action === 'rta') { setGuildConfig(guild.id, { logRoutes: {} }); done('routing reset'); return routes(null, noteGood('Everything goes to the main Server log again.')); }

  if (action === 'test' && valid) {
    await interaction.deferUpdate();
    const channel = await guild.channels.fetch(getLogChannel(guild.id, arg) || '0').catch(() => null);
    if (!channel?.isTextBased()) return type(arg, noteBad('That log has no channel, or I can no longer see it. Choose the channel again.'));
    const sample = new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Test entry' }).setTitle(TYPES[arg].label)
      .setDescription(`This is a test from ${by}. Real entries for this log will appear here. Nothing has happened in the server.`);
    try { await channel.send({ embeds: [sample], allowedMentions: { parse: [] } }); } catch (err) { return type(arg, noteBad(`I could not post in ${channel}: ${err.message}`)); }
    return type(arg, noteGood(`Sent a test entry to ${channel}.`));
  }
  return false;
}

module.exports = { PAGES, owns, handle, VIEWS };
