/**
 * /setup — one interactive screen to configure the bot for a server.
 *
 * Pages: home (checklist) · panel · logs · welcome · verify · control · streamers · updates ·
 *        free · announce · check (permission doctor)
 *        (streamers, updates and free live in setupAlerts.js)
 *
 * Everything reads/writes the same guild config keys the rest of the bot already uses
 * (src/guildConfig.js), so existing features keep working. Only members with
 * Manage Server can use it; the bot-control role page needs Administrator.
 * Every change is recorded with diagnostics.audit() (console, /owner audit, owner alerts).
 *
 * customIds: setup:<page>[:<action>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits, MessageFlags, AttachmentBuilder,
} = require('discord.js');

const { getGuildConfig, setGuildConfig, setLogChannel, getLogChannel } = require('./guildConfig');
const { selectAll, selectOne, run } = require('./database');
const { audit }  = require('./diagnostics');
const { log }    = require('./logger');
const verification = require('./verification');
const cards = require('./cards');
const alertsKit = require('./setupAlerts');
const {
  BLUE, GREEN, AMBER, RED, ephemeral, chan, role, onOff, noteBad, noteGood, backButton,
  channelSelect, roleSelect, POST_PERMS, missingIn, respond,
} = require('./setupKit');

const LOG_TYPES = [
  { key: 'voice',    label: 'Voice activity',        desc: 'Joins, leaves and moves in voice channels' },
  { key: 'messages', label: 'Message logs',          desc: 'Deleted and edited messages (text is kept 7 days so this works)' },
  { key: 'members',  label: 'Member join/leave + verification', desc: 'Detailed join log and verification results (staff only)' },
  { key: 'modlog',   label: 'Moderation actions',    desc: 'Kicks, bans, timeouts' },
  { key: 'commands', label: 'Command & button logs', desc: 'Every command and button used' },
];

const PAGES = [
  { value: 'panel',     label: 'Voice panel',                desc: 'Where the control panel lives',},
  { value: 'logs',      label: 'Logs',                       desc: 'Voice, messages, members, moderation, commands',},
  { value: 'welcome',   label: 'Welcome & leave',            desc: 'Welcome / leave cards',},
  { value: 'verify',    label: 'Verification',               desc: 'Verified role, human check, quarantine, auto-kick',},
  { value: 'control',   label: 'Bot control role',           desc: 'Who may make the bot join / leave',},
  { value: 'streamers', label: 'Streamer alerts',            desc: 'Twitch / Kick / YouTube live alerts',},
  { value: 'updates',   label: 'Game update alerts',         desc: 'Patch notes: Steam, Minecraft, Riot, Fortnite, Blizzard, RSS',},
  { value: 'free',      label: 'Free game alerts',           desc: 'Epic Games Store and Steam free games',},
  { value: 'announce',  label: 'Announcements',              desc: 'Where the bot owner can post notices',},
];


// ── Status ────────────────────────────────────────────────────────────────────

const FREE_IDS = "('epic', 'steam_free')";

function summary(guild) {
  const c  = getGuildConfig(guild.id);
  const vs = verification.settings(guild.id);
  const exists = (id) => !!(id && guild.channels.cache.has(id));
  const streamers = selectOne('SELECT COUNT(*) AS n FROM streamer_subscriptions WHERE guild_id = ?', [guild.id])?.n || 0;
  const games     = selectOne(`SELECT COUNT(*) AS n FROM game_subscriptions WHERE guild_id = ? AND app_id NOT IN ${FREE_IDS}`, [guild.id])?.n || 0;
  const free      = selectOne(`SELECT COUNT(*) AS n FROM game_subscriptions WHERE guild_id = ? AND app_id IN ${FREE_IDS}`, [guild.id])?.n || 0;
  const logsSet   = LOG_TYPES.filter(t => getLogChannel(guild.id, t.key)).length;

  return [
    { key: 'panel',   core: true,  done: exists(c.panelChannelId),                 text: c.panelChannelId ? chan(c.panelChannelId) : 'Post the control panel' },
    { key: 'logs',    core: true,  done: logsSet > 0,                              text: `${logsSet} of ${LOG_TYPES.length} log channels set` },
    { key: 'welcome', core: true,  done: exists(c.welcomeChannelId),               text: c.welcomeChannelId ? `${chan(c.welcomeChannelId)} · welcome ${onOff(c.welcomeEnabled !== false)}` : 'Choose a welcome channel' },
    { key: 'verify',  core: true,  done: !!(vs.roleId && vs.messageId),            text: !vs.roleId ? 'Pick the verified role' : !vs.messageId ? 'Role set — post the verification message' : `${role(vs.roleId)} · ${vs.mode === 'captcha' ? 'human check' : 'button'}` },
    { key: 'control', core: false, done: !!c.botControlRoleId,                     text: c.botControlRoleId ? role(c.botControlRoleId) : 'Only the server owner can control the bot' },
    { key: 'streamers', core: false, done: streamers > 0,                          text: streamers ? `${streamers} streamer(s) watched` : 'None yet' },
    { key: 'updates', core: false, done: games > 0,                                text: games ? `${games} game(s) watched` : 'None yet' },
    { key: 'free',    core: false, done: free > 0,                                 text: free ? 'On' : 'Off' },
    { key: 'announce', core: false, done: !!c.announceChannelId,                   text: c.announceChannelId ? chan(c.announceChannelId) : 'Uses the system channel' },
  ];
}

function checkPermissions(guild) {
  const me = guild.members.me;
  const c  = getGuildConfig(guild.id);
  const vs = verification.settings(guild.id);
  const problems = [], good = [];
  const F = PermissionFlagsBits;

  const channelCheck = (id, label, needs) => {
    if (!id) return;
    const ch = guild.channels.cache.get(id);
    if (!ch) { problems.push(`**${label}** — the channel was deleted. Pick it again.`); return; }
    const perms = ch.permissionsFor(me);
    const missing = needs.filter(([flag]) => !perms?.has(F[flag])).map(([, name]) => name);
    if (missing.length) problems.push(`**${label}** (<#${id}>) — I'm missing **${missing.join(', ')}**.`);
    else good.push(`${label} (<#${id}>)`);
  };
  const POST = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']];
  const POST_FILES = [...POST, ['AttachFiles', 'Attach Files']];

  channelCheck(c.panelChannelId, 'Voice panel', POST);
  for (const t of LOG_TYPES) channelCheck(getLogChannel(guild.id, t.key), `${t.label} log`, t.key === 'messages' ? POST_FILES : POST);
  channelCheck(c.welcomeChannelId, 'Welcome channel', POST_FILES);
  if (c.leaveChannelId) channelCheck(c.leaveChannelId, 'Leave channel', POST_FILES);
  channelCheck(c.announceChannelId, 'Announcements', POST);
  channelCheck(vs.channelId, 'Verification message', POST);
  for (const r of selectAll('SELECT DISTINCT discord_channel_id AS id FROM streamer_subscriptions WHERE guild_id = ?', [guild.id])) channelCheck(r.id, 'Streamer alerts', POST);
  for (const r of selectAll('SELECT DISTINCT channel_id AS id FROM game_subscriptions WHERE guild_id = ?', [guild.id])) channelCheck(r.id, 'Game alerts', POST);

  const roleCheck = (id, label) => {
    if (!id) return;
    const r = guild.roles.cache.get(id);
    if (!r) { problems.push(`**${label}** — the role was deleted. Pick it again.`); return; }
    if (!me.permissions.has(F.ManageRoles)) problems.push(`**${label}** (${r}) — I need the **Manage Roles** permission.`);
    else if (!r.editable) problems.push(`**${label}** (${r}) — my role must be **above** it. Server Settings → Roles → drag my role higher.`);
    else good.push(`${label} (${r})`);
  };
  roleCheck(vs.roleId, 'Verified role');
  roleCheck(vs.unverifiedRoleId, 'Unverified role');
  if (c.botControlRoleId && !guild.roles.cache.has(c.botControlRoleId)) problems.push('**Bot control role** — the role was deleted. Pick it again.');
  if (vs.kickMinutes && !me.permissions.has(F.KickMembers)) problems.push('**Auto-kick** is on but I\'m missing **Kick Members**.');

  return { problems, good };
}

// ── Views ─────────────────────────────────────────────────────────────────────

function viewHome(guild, note) {
  const items = summary(guild);
  const core = items.filter(i => i.core), optional = items.filter(i => !i.core);
  const line = (i) => `${i.done ? 'Done' : i.core ? 'Needs setup' : 'Optional'} · **${PAGES.find(p => p.value === i.key).label}** — ${i.text}`;
  const coreDone = core.filter(i => i.done).length;

  const embed = new EmbedBuilder()
    .setColor(coreDone === core.length ? GREEN : AMBER)
    .setTitle(`Setup — ${guild.name}`)
    .setDescription([note, `**Core setup: ${coreDone} of ${core.length}**${coreDone === core.length ? ' — all done' : ''}`,
      coreDone === 0 ? ['**Start here** — four quick steps, pick each from the menu below:',
        '1. **Voice panel** — choose where the control panel lives',
        '2. **Logs** — choose where logs are posted',
        '3. **Welcome & leave** — choose a welcome channel',
        '4. **Verification** — pick the verified role, then the channel for the verify message',
        '_Everything saves the moment you pick it. Press **Permission check** at any time to see what is missing._'].join('\n') : null,
    ].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Core', value: core.map(line).join('\n') },
      { name: 'Optional', value: optional.map(line).join('\n') },
    )
    .setFooter({ text: 'Pick a section below · changes save instantly' });

  const menu = new StringSelectMenuBuilder().setCustomId('setup:home:go').setPlaceholder('Choose what to configure…')
    .addOptions(PAGES.map(p => ({ label: p.label, value: p.value, description: p.desc })));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:check').setLabel('Permission check').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setup:home').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function viewCheck(guild) {
  const { problems, good } = checkPermissions(guild);
  const embed = new EmbedBuilder()
    .setColor(problems.length ? RED : GREEN)
    .setTitle('Permission check')
    .setDescription(problems.length
      ? `Found **${problems.length}** problem(s) that would stop features working:\n\n${problems.join('\n')}`
      : '**Everything I need is in place.**')
    .setTimestamp();
  if (good.length) embed.addFields({ name: 'Working', value: good.join('\n').slice(0, 1000) });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:check').setLabel('Check again').setStyle(ButtonStyle.Primary), backButton())] };
}

function viewPanel(guild, note) {
  const c = getGuildConfig(guild.id);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Voice panel').setDescription([note,
      `Current panel: ${c.panelChannelId ? chan(c.panelChannelId) : '*not posted*'}`,
      '', 'Pick a channel and I\'ll post the live control panel there (an old panel is replaced). Members use its buttons to make me join/leave and look up voice stats.'].filter(Boolean).join('\n'))],
    components: [channelSelect('setup:panel:set', 'Post the control panel in…', c.panelChannelId), new ActionRowBuilder().addComponents(backButton())],
  };
}

function viewLogs(guild, type, note) {
  const lines = LOG_TYPES.map(t => `**${t.label}** — ${chan(getLogChannel(guild.id, t.key))}\n└ ${t.desc}`).join('\n');
  const rows = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('setup:logs:type').setPlaceholder('Choose a log to set…')
      .addOptions(LOG_TYPES.map(t => ({ label: t.label, value: t.key, description: t.desc.slice(0, 90), default: t.key === type }))))];
  if (type) {
    rows.push(channelSelect(`setup:logs:set:${type}`, `Channel for: ${LOG_TYPES.find(t => t.key === type).label}`, getLogChannel(guild.id, type)));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`setup:logs:clear:${type}`).setLabel('Clear this log').setStyle(ButtonStyle.Danger), backButton()));
  } else rows.push(new ActionRowBuilder().addComponents(backButton()));
  return { embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Logs').setDescription([note, lines].filter(Boolean).join('\n\n'))], components: rows };
}

function cardSummary(guildId, type) {
  const o = cards.options(guildId, type);
  const text = (v) => v ? `\`${v.length > 40 ? v.slice(0, 37) + '…' : v}\`` : '*none*';
  return `Card ${o.card ? 'on' : 'off'} · title ${text(o.title)} · subtitle ${text(o.subtitle)} · colour ${o.accent ? `\`${o.accent}\`` : '*default*'} · message ${text(o.message)}`;
}

function viewWelcome(guild, note) {
  const c = getGuildConfig(guild.id);
  const wOn = c.welcomeEnabled !== false, lOn = c.leaveEnabled !== false;
  const wCard = cards.options(guild.id, 'welcome').card, lCard = cards.options(guild.id, 'leave').card;
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Welcome & leave').setDescription([note,
      `**Welcome** — ${chan(c.welcomeChannelId)} · ${wOn ? 'on' : 'off'}\n${cardSummary(guild.id, 'welcome')}`,
      `**Leave** — ${chan(c.leaveChannelId || c.welcomeChannelId)}${c.leaveChannelId ? '' : ' *(defaults to the welcome channel)*'} · ${lOn ? 'on' : 'off'}\n${cardSummary(guild.id, 'leave')}`,
      '**Placeholders:** `{user}` name · `{mention}` @mention · `{server}` server name · `{count}` member count'].filter(Boolean).join('\n\n'))],
    components: [
      channelSelect('setup:welcome:wch', 'Welcome messages channel', c.welcomeChannelId),
      channelSelect('setup:welcome:lch', 'Leave messages channel (optional)', c.leaveChannelId),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:welcome:tw').setLabel(`Welcome ${wOn ? 'ON' : 'OFF'}`).setStyle(wOn ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:tl').setLabel(`Leave ${lOn ? 'ON' : 'OFF'}`).setStyle(lOn ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:pw').setLabel('Preview welcome').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setup:welcome:pl').setLabel('Preview leave').setStyle(ButtonStyle.Primary),
        backButton(),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:welcome:ew').setLabel('Edit welcome').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:el').setLabel('Edit leave').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:cw').setLabel(`Welcome card ${wCard ? 'ON' : 'OFF'}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:cl').setLabel(`Leave card ${lCard ? 'ON' : 'OFF'}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:reset').setLabel('Reset text').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

function cardModal(guild, type) {
  const o = cards.options(guild.id, type);
  const input = (id, label, style, value, max, placeholder, required = false) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setPlaceholder(placeholder).setValue(String(value || '').slice(0, max)));
  return new ModalBuilder().setCustomId(`setup:welcome:${type === 'welcome' ? 'wm' : 'lm'}`).setTitle(type === 'welcome' ? 'Welcome post' : 'Leave post').addComponents(
    input('title',    'Card title',            TextInputStyle.Short,     o.title,    cards.LIMITS.title,    '{user}'),
    input('subtitle', 'Card subtitle (blank = none)', TextInputStyle.Short, o.subtitle, cards.LIMITS.subtitle, 'Welcome to {server}'),
    input('accent',   'Accent colour (hex)',   TextInputStyle.Short,     o.accent,   7,                     '#5865F2'),
    input('message',  'Message above the card (blank = none)', TextInputStyle.Paragraph, o.message, cards.LIMITS.message, '{mention} welcome to {server}! You are member #{count}.'),
  );
}

function viewVerify(guild, note) {
  const s = verification.settings(guild.id);
  const membersLog = getLogChannel(guild.id, 'members');
  const desc = [note,
    `**Verified role** — ${role(s.roleId)}`,
    `**Unverified role** — ${role(s.unverifiedRoleId)} *(given on join, removed when verified)*`,
    `**Method** — ${s.mode === 'captcha' ? 'human check (type the code in a picture)' : 'one-click button'}`,
    `**Rules** — min account age: ${s.minAgeDays ? `${s.minAgeDays} day(s)` : 'off'} · auto-remove unverified: ${s.kickMinutes ? `after ${s.kickMinutes} min` : 'off'} · raid alert: ${s.raidThreshold} joins/min`,
    `**DM prompt on join** — ${onOff(s.dmOnJoin)}`,
    `**Verification message** — ${s.channelId ? chan(s.channelId) : '*not posted*'}`,
    `**Staff log** — ${chan(membersLog)} *(set under Logs → Member join/leave)*`,
    '',
    '_Only what Discord shows about an account is used (age, badges, avatar). No emails, IPs or locations are collected._',
  ].filter(v => v !== null && v !== undefined).join('\n');
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Verification').setDescription(desc)],
    components: [
      roleSelect('setup:verify:role', 'Role members get when verified', s.roleId),
      roleSelect('setup:verify:unv', 'Unverified role (optional)', s.unverifiedRoleId),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:verify:mode').setPlaceholder('Verification method')
        .addOptions([
          { label: 'One-click button', value: 'button', description: 'Fastest — member presses Verify', default: s.mode === 'button' },
          { label: 'Human check (recommended)', value: 'captcha', description: 'Member types the code from a picture', default: s.mode === 'captcha' },
        ])),
      channelSelect('setup:verify:postch', 'Post the verification message in…', s.channelId),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:verify:rules').setLabel('Rules…').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setup:verify:dm').setLabel(`DM prompt ${s.dmOnJoin ? 'ON' : 'OFF'}`).setStyle(s.dmOnJoin ? ButtonStyle.Success : ButtonStyle.Secondary),
        backButton(),
      ),
    ],
  };
}

function viewControl(guild, note) {
  const c = getGuildConfig(guild.id);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Bot control role').setDescription([note,
      `Current: ${role(c.botControlRoleId)}`, '',
      'Members with this role (and the server owner) can use the panel\'s **Leave** button. Without a role, only the server owner can. *Changing this needs the Administrator permission.*'].filter(Boolean).join('\n'))],
    components: [roleSelect('setup:control:set', 'Role that can control the bot', c.botControlRoleId),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:control:reset').setLabel('Reset (owner only)').setStyle(ButtonStyle.Danger), backButton())],
  };
}

function viewAnnounce(guild, note) {
  const c = getGuildConfig(guild.id);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Announcements').setDescription([note,
      `Channel: ${c.announceChannelId ? chan(c.announceChannelId) : '*not set (uses the system channel)*'}`, '',
      'Where the bot\'s owner may post important notices — maintenance, new features. Rare.'].filter(Boolean).join('\n'))],
    components: [channelSelect('setup:announce:set', 'Announcement channel', c.announceChannelId),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:announce:clear').setLabel('Clear').setStyle(ButtonStyle.Danger), backButton())],
  };
}

const VIEWS = { home: viewHome, logs: viewLogs, panel: viewPanel, welcome: viewWelcome, verify: viewVerify, control: viewControl, announce: viewAnnounce, check: viewCheck };

// ── Actions ───────────────────────────────────────────────────────────────────

async function postPanel(guild, channel, client, by) {
  const { buildPanelEmbed, buildPanelButtons } = require('./statusUpdater');
  const existing = getGuildConfig(guild.id);
  if (existing.panelChannelId && existing.panelMessageId) {
    try { const old = await guild.channels.fetch(existing.panelChannelId); await (await old?.messages.fetch(existing.panelMessageId))?.delete(); } catch { /* already gone */ }
  }
  const message = await channel.send({ embeds: [buildPanelEmbed(guild.id)], components: buildPanelButtons() });
  setGuildConfig(guild.id, { panelChannelId: channel.id, panelMessageId: message.id });
  log('INFO', 'Control panel deployed', { guild: guild.name, channel: channel.name, by: by.tag });
}

const parseIntIn = (text, min, max) => { const n = parseInt(String(text).trim(), 10); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

function rulesModal(guild) {
  const s = verification.settings(guild.id);
  const input = (id, label, value, ph) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(value)).setPlaceholder(ph).setMaxLength(5));
  return new ModalBuilder().setCustomId('setup:verify:rulesmodal').setTitle('Verification rules').addComponents(
    input('age',  'Minimum account age in days (0 = off)', s.minAgeDays, '0 – 365'),
    input('kick', 'Remove unverified after N minutes (0 = off)', s.kickMinutes, '0, or 10 – 10080'),
    input('raid', 'Raid alert: joins per minute', s.raidThreshold, '3 – 100'),
  );
}

/** Returns true if the interaction belonged to /setup. */
async function handleInteraction(interaction, client) {
  const id = interaction.customId;
  if (!id || !id.startsWith('setup:')) return false;

  const { guild } = interaction;
  if (!guild) { await interaction.reply({ content: 'Use `/setup` inside a server.', flags: ephemeral }); return true; }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'You need the **Manage Server** permission to change setup.', flags: ephemeral });
    return true;
  }

  const [, page, action, arg] = id.split(':');
  const by = interaction.user;
  const done = (a, details) => audit({ action: `Setup: ${a}`, actor: by, guild, details });
  const show = (name, ...args) => respond(interaction, alertsKit.owns(name) ? alertsKit.VIEWS[name](guild, by, ...args) : VIEWS[name](guild, ...args));

  // Navigation
  if (page === 'home' && !action) return await show('home'), true;
  if (page === 'home' && action === 'go') return await show(interaction.values[0]), true;   // select menu
  if (page === 'check') return await show('check'), true;
  if (alertsKit.owns(page)) return await alertsKit.handle(interaction, { guild, by, client, page, action, arg }), true;
  if (['panel', 'welcome', 'verify', 'control', 'announce'].includes(page) && !action) return await show(page), true;
  if (page === 'logs' && !action) return await respond(interaction, viewLogs(guild)), true;

  // ── panel ──
  if (page === 'panel' && action === 'set') {
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild);
    if (missing.length) return await show('panel', noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`)), true;
    try { await postPanel(guild, channel, client, by); } catch (err) { log('ERROR', 'Could not post the control panel', { guild: guild.name, err }); return await show('panel', noteBad('Discord refused the message. Check my permissions in that channel.')), true; }
    done('panel posted', `#${channel.name}`);
    return await show('panel', noteGood(`Panel posted in ${channel}.`)), true;
  }

  // ── logs ──
  if (page === 'logs') {
    if (action === 'type') return await respond(interaction, viewLogs(guild, interaction.values[0])), true;
    if (action === 'set') {
      const channel = interaction.channels.first();
      const missing = missingIn(channel, guild);
      if (missing.length) return await respond(interaction, viewLogs(guild, arg, noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`))), true;
      setLogChannel(guild.id, arg, channel.id);
      done(`log channel set (${arg})`, `→ #${channel.name}`);
      const privacy = arg === 'messages' ? '\nTo log deleted and edited messages, new messages in this server are kept for **7 days**, then deleted automatically. Removing this log deletes them immediately.' : '';
      return await respond(interaction, viewLogs(guild, arg, noteGood(`**${LOG_TYPES.find(t => t.key === arg).label}** now goes to ${channel}.${privacy}`))), true;
    }
    if (action === 'clear') {
      setLogChannel(guild.id, arg, null);
      if (arg === 'messages') require('./messageStore').purgeGuild(guild.id);   // stop keeping message text
      done(`log channel cleared (${arg})`);
      return await respond(interaction, viewLogs(guild, arg, noteGood('Cleared.'))), true;
    }
  }

  // ── welcome ──
  if (page === 'welcome') {
    if (action === 'wch' || action === 'lch') {
      const channel = interaction.channels.first();
      const missing = missingIn(channel, guild, [...POST_PERMS, 'AttachFiles']);
      if (missing.length) return await show('welcome', noteBad(`I can't post cards in ${channel}: missing **${missing.join(', ')}**.`)), true;
      setGuildConfig(guild.id, action === 'wch' ? { welcomeChannelId: channel.id, welcomeEnabled: true } : { leaveChannelId: channel.id });
      done(action === 'wch' ? 'welcome channel set' : 'leave channel set', `→ #${channel.name}`);
      return await show('welcome', noteGood(`${action === 'wch' ? 'Welcome' : 'Leave'} cards go to ${channel}.`)), true;
    }
    if (action === 'tw' || action === 'tl') {
      const key = action === 'tw' ? 'welcomeEnabled' : 'leaveEnabled';
      const now = getGuildConfig(guild.id)[key] !== false;
      setGuildConfig(guild.id, { [key]: !now });
      done(`${action === 'tw' ? 'welcome' : 'leave'} cards ${!now ? 'enabled' : 'disabled'}`);
      return await show('welcome'), true;
    }
    if (action === 'pw' || action === 'pl') {
      await interaction.deferReply({ flags: ephemeral });
      const type = action === 'pw' ? 'welcome' : 'leave';
      try {
        const { generateCard } = require('./imageGenerator');
        const m = interaction.member, name = m.displayName || by.username;
        const post = cards.compose(guild.id, type, { user: name, mention: `${m}`, server: guild.name, count: guild.memberCount });
        const payload = { content: [`**${type === 'welcome' ? 'Welcome' : 'Leave'} preview**, exactly what will be posted:`, post.text].filter(Boolean).join('\n\n'), allowedMentions: { parse: [] } };
        if (post.card) payload.files = [new AttachmentBuilder(await generateCard(type, name, by.displayAvatarURL({ size: 512 }), guild.memberCount, post.image), { name: `${type}-preview.png` })];
        await interaction.editReply(payload);
      } catch (err) {
        log('ERROR', 'Card preview failed', { guild: guild.name, err });
        await interaction.editReply({ content: 'Could not generate the preview. The bot owner has been notified.' });
      }
      return true;
    }
    if (action === 'ew' || action === 'el') { await interaction.showModal(cardModal(guild, action === 'ew' ? 'welcome' : 'leave')); return true; }
    if (action === 'wm' || action === 'lm') {
      const type = action === 'wm' ? 'welcome' : 'leave', k = cards.keys(type);
      const text = (id) => interaction.fields.getTextInputValue(id).trim();
      const rawAccent = text('accent'), accent = rawAccent ? cards.parseColour(rawAccent) : null;
      if (rawAccent && !accent) return await show('welcome', noteBad('That is not a colour. Use a hex code such as `#5865F2`.')), true;
      setGuildConfig(guild.id, { [k.title]: text('title') || null, [k.subtitle]: text('subtitle'), [k.message]: text('message'), [k.accent]: accent });
      done(`${type} post customised`);
      return await show('welcome', noteGood(`${type === 'welcome' ? 'Welcome' : 'Leave'} post saved. Press **Preview** to see it.`)), true;
    }
    if (action === 'cw' || action === 'cl') {
      const type = action === 'cw' ? 'welcome' : 'leave', k = cards.keys(type);
      const now = cards.options(guild.id, type).card;
      setGuildConfig(guild.id, { [k.card]: !now });
      done(`${type} card ${!now ? 'enabled' : 'disabled'}`);
      return await show('welcome'), true;
    }
    if (action === 'reset') {
      const patch = {};
      for (const type of ['welcome', 'leave']) { const k = cards.keys(type); patch[k.title] = null; patch[k.subtitle] = null; patch[k.message] = null; patch[k.accent] = null; }
      setGuildConfig(guild.id, patch);
      done('welcome and leave text reset to defaults');
      return await show('welcome', noteGood('Titles, subtitles, colours and messages are back to the defaults.')), true;
    }
  }

  // ── verify ──
  if (page === 'verify') {
    const s = verification.settings(guild.id);
    if (action === 'role' || action === 'unv') {
      const picked = interaction.roles.first();
      if (picked.id === guild.id || picked.managed) return await show('verify', noteBad('Pick a normal role (not @everyone or a bot role).')), true;
      const editable = picked.editable && guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles);
      if (action === 'role') setGuildConfig(guild.id, { verifyRoleId: picked.id, ...(s.enabledAt ? {} : { verifyEnabledAt: Date.now() }) });
      else setGuildConfig(guild.id, { unverifiedRoleId: picked.id });
      done(action === 'role' ? 'verified role set' : 'unverified role set', `→ @${picked.name}`);
      return await show('verify', editable ? noteGood(`${picked} saved.`) : noteBad(`${picked} saved, but I can't manage it yet — move my role above it (see Permission check).`)), true;
    }
    if (action === 'mode') {
      setGuildConfig(guild.id, { verifyMode: interaction.values[0] });
      done('verification method changed', interaction.values[0] === 'captcha' ? 'human check' : 'button');
      return await show('verify', noteGood('Method saved.')), true;
    }
    if (action === 'dm') { setGuildConfig(guild.id, { verifyDmOnJoin: !s.dmOnJoin }); done(`join DM prompt ${!s.dmOnJoin ? 'enabled' : 'disabled'}`); return await show('verify'), true; }
    if (action === 'postch') {
      if (!s.roleId) return await show('verify', noteBad('Pick the **verified role** first.')), true;
      const channel = interaction.channels.first();
      const missing = missingIn(channel, guild);
      if (missing.length) return await show('verify', noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`)), true;
      try { await verification.postPrompt(channel); } catch (err) { log('ERROR', 'Could not post the verification message', { guild: guild.name, err }); return await show('verify', noteBad('Discord refused the message.')), true; }
      done('verification message posted', `#${channel.name}`);
      return await show('verify', noteGood(`Verification message posted in ${channel}.`)), true;
    }
    if (action === 'rules') { await interaction.showModal(rulesModal(guild)); return true; }
    if (action === 'rulesmodal') {
      const age = parseIntIn(interaction.fields.getTextInputValue('age') || '0', 0, 365);
      const kick = parseIntIn(interaction.fields.getTextInputValue('kick') || '0', 0, 10080);
      const raid = parseIntIn(interaction.fields.getTextInputValue('raid') || '8', 3, 100);
      if (age === null || kick === null || raid === null || (kick > 0 && kick < 10)) {
        return await show('verify', noteBad('Invalid value. Age 0–365 · auto-remove 0 or 10–10080 minutes · raid 3–100.')), true;
      }
      setGuildConfig(guild.id, { verifyMinAccountDays: age, verifyKickMinutes: kick, raidThreshold: raid, ...(kick > 0 && !s.kickMinutes ? { verifyEnabledAt: Date.now() } : {}) });
      done('verification rules changed', `min age ${age}d · auto-remove ${kick ? kick + ' min' : 'off'} · raid ${raid}/min`);
      return await show('verify', noteGood(`Rules saved.${kick ? ' Auto-remove only applies to members who join from now on.' : ''}`)), true;
    }
  }

  // ── control ──
  if (page === 'control') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return await show('control', noteBad('Only **Administrators** can change this.')), true;
    if (action === 'set') { const r = interaction.roles.first(); setGuildConfig(guild.id, { botControlRoleId: r.id }); done('bot control role set', `→ @${r.name}`); return await show('control', noteGood(`${r} can now control the bot.`)), true; }
    if (action === 'reset') { setGuildConfig(guild.id, { botControlRoleId: null }); done('bot control role reset'); return await show('control', noteGood('Reset — only the server owner can control the bot.')), true; }
  }

  // ── announce ──
  if (page === 'announce') {
    if (action === 'set') { const ch = interaction.channels.first(); const missing = missingIn(ch, guild); if (missing.length) return await show('announce', noteBad(`I can't post in ${ch}: missing **${missing.join(', ')}**.`)), true; setGuildConfig(guild.id, { announceChannelId: ch.id }); done('announcement channel set', `→ #${ch.name}`); return await show('announce', noteGood(`Announcements go to ${ch}.`)), true; }
    if (action === 'clear') { setGuildConfig(guild.id, { announceChannelId: null }); done('announcement channel cleared'); return await show('announce', noteGood('Cleared.')), true; }
  }

  return false;
}

module.exports = { handleInteraction, viewHome, summary, checkPermissions, LOG_TYPES };