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
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const { getGuildConfig, setGuildConfig, getLogChannel } = require('./guildConfig');
const { selectAll, selectOne } = require('./database');
const { audit }  = require('./diagnostics');
const { log }    = require('./logger');
const verification = require('./verification');
const alertsKit = require('./setupAlerts');
const leaderboardKit = require('./setupLeaderboard');
const checkpointKit = require('./setupCheckpoint');
const moderationKit = require('./setupModeration');
const welcomeKit = require('./setupWelcome');
const protectKit = require('./setupProtect');
const logsKit = require('./setupLogs');
const botPermissions = require('./botPermissions');
const KITS = [alertsKit, leaderboardKit, checkpointKit, moderationKit, welcomeKit, protectKit, logsKit];                 // pages that live in their own files
const kitFor = (page) => KITS.find(k => k.owns(page));
const {
  BLUE, GREEN, AMBER, RED, ephemeral, chan, role, onOff, noteBad, noteGood, backButton,
  channelSelect, roleSelect, missingIn, respond,
} = require('./setupKit');

const { LOG_TYPES } = require('./logs');

const PAGES = [
  { value: 'panel',     label: 'Voice panel',                emoji: '🎛️', desc: 'Where the control panel lives',},
  { value: 'logs',      label: 'Logs',                       emoji: '📜', desc: 'Voice, messages, members, server changes, moderation, commands',},
  { value: 'welcome',   label: 'Welcome & leave',            emoji: '👋', desc: 'Welcome and leave posts, extras',},
  { value: 'verify',    label: 'Verification',               emoji: '🔐', desc: 'Verified role, human check, quarantine, auto-kick',},
  { value: 'control',   label: 'Bot control role',           emoji: '🛡️', desc: 'Who may make the bot join / leave',},
  { value: 'streamers', label: 'Streamer alerts',            emoji: '📺', desc: 'Twitch / Kick / YouTube live alerts',},
  { value: 'updates',   label: 'Game update alerts',         emoji: '🎮', desc: 'Patch notes: Steam, Minecraft, Riot, RSS',},
  { value: 'free',      label: 'Free game alerts',           emoji: '🎁', desc: 'Epic Games Store and Steam free games',},
  { value: 'leaderboard', label: 'Voice leaderboard',      emoji: '🏆', desc: 'Top voice time and optional role rewards',},
  { value: 'moderation', label: 'Moderation',                emoji: '🔨', desc: 'Mod log and the moderation commands',},
  { value: 'checkpoint', label: 'Security Check Point',    emoji: '🚧', desc: 'A trap channel that catches spam bots and hacked accounts',},
  { value: 'raid',      label: 'Raid protection',           emoji: '🛑', desc: 'Join-burst detection, raid mode, account age gate',},
  { value: 'automod',   label: 'AutoMod',                    emoji: '🤖', desc: 'Invites, scam links, spam, mentions, words, strikes',},
  { value: 'announce',  label: 'Announcements',              emoji: '📣', desc: 'Where bot news and changelogs are posted',},
];


// ── Status ────────────────────────────────────────────────────────────────────

const FREE_IDS = require('./freeGames').SQL_IDS;

function summary(guild) {
  const c  = getGuildConfig(guild.id);
  const vs = verification.settings(guild.id);
  const exists = (id) => !!(id && guild.channels.cache.has(id));
  const streamers = selectOne('SELECT COUNT(*) AS n FROM streamer_subscriptions WHERE guild_id = ?', [guild.id])?.n || 0;
  const games     = selectOne(`SELECT COUNT(*) AS n FROM game_subscriptions WHERE guild_id = ? AND app_id NOT IN ${FREE_IDS}`, [guild.id])?.n || 0;
  const free      = selectOne(`SELECT COUNT(*) AS n FROM game_subscriptions WHERE guild_id = ? AND app_id IN ${FREE_IDS}`, [guild.id])?.n || 0;
  const lbs       = require('./leaderboard').settings(guild.id);
  const cps       = require('./checkpoint').settings(guild.id);
  const rds       = require('./raid').settings(guild.id);
  const ams       = require('./automod').settings(guild.id);
  const amFilters = Object.values(ams.filters).filter(f => f.on).length;
  const logsSet   = LOG_TYPES.filter(t => getLogChannel(guild.id, t.key)).length;

  return [
    { key: 'panel',   core: true,  done: exists(c.panelChannelId),                 text: c.panelChannelId ? chan(c.panelChannelId) : 'Post the control panel' },
    { key: 'logs',    core: true,  done: logsSet > 0,                              text: `${logsSet} of ${LOG_TYPES.length} log channels set` },
    { key: 'welcome', core: true,  done: exists(c.welcomeChannelId),               text: c.welcomeChannelId ? `${chan(c.welcomeChannelId)} · welcome ${onOff(c.welcomeEnabled !== false)}` : 'Choose a welcome channel' },
    { key: 'verify',  core: true,  done: !!(vs.roleId && vs.messageId),            text: !vs.roleId ? 'Pick the verified role' : !vs.messageId ? 'Role set — post the verification message' : `${role(vs.roleId)} · ${vs.mode === 'captcha' ? 'human check' : 'button'}` },
    { key: 'control', core: false, done: !!c.botControlRoleId,                     text: c.botControlRoleId ? role(c.botControlRoleId) : 'Only the server owner can control the bot' },
    { key: 'streamers', core: false, done: streamers > 0,                          text: streamers ? `${streamers} streamer(s) watched` : 'None yet' },
    { key: 'updates', core: false, done: games > 0,                                text: games ? `${games} game(s) watched` : 'None yet' },
    { key: 'free',    core: false, done: free > 0,                                 text: free ? `${free} on` : 'Off' },
    { key: 'leaderboard', core: false, done: lbs.rewards,                        text: lbs.rewards ? `Rewards on · ${lbs.tiers.length} tiers` : 'Leaderboard on · rewards off' },
    { key: 'moderation', core: false, done: !!getLogChannel(guild.id, 'modlog'), text: getLogChannel(guild.id, 'modlog') ? `Mod log ${chan(getLogChannel(guild.id, 'modlog'))}` : 'Choose a mod log channel' },
    { key: 'checkpoint', core: false, done: cps.enabled && exists(cps.channelId), text: cps.enabled && exists(cps.channelId) ? `On · ${chan(cps.channelId)} · ${cps.caught} caught` : 'Off. Catches spam bots and hacked accounts' },
    { key: 'raid', core: false, done: rds.enabled || rds.gateEnabled, text: rds.active ? '🔴 Raid mode is ON' : rds.enabled ? `On · ${rds.joins} joins in ${rds.seconds}s` : rds.gateEnabled ? 'Age gate on' : 'Off. Protects against join floods' },
    { key: 'automod', core: false, done: ams.enabled && amFilters > 0, text: ams.enabled ? `On · ${amFilters} filter${amFilters === 1 ? '' : 's'}` : 'Off. Invite, scam, spam and word filters' },
    { key: 'announce', core: false, done: !!c.announceChannelId,                   text: c.announceChannelId ? chan(c.announceChannelId) : 'Not set (falls back to another channel)' },
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
  const PANEL = [...POST, ['ReadMessageHistory', 'Read Message History']];

  channelCheck(c.panelChannelId, 'Voice panel', PANEL);
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
  if (LOG_TYPES.some(t => getLogChannel(guild.id, t.key)) && !me.permissions.has(F.ViewAuditLog)) problems.push('**Logs** — I\'m missing **View Audit Log**, so changes will show without who made them.');

  return { problems, good, tips: serverTips(guild) };
}

/** Things that are not broken yet but cause trouble later: my role's position, and channels I can't see. */
function serverTips(guild) {
  const me = guild.members.me, F = PermissionFlagsBits, tips = [];
  if (!me) return tips;

  const missing = botPermissions.missingServerWide(guild);
  if (missing.length) tips.push(`I'm missing **${missing.join(', ')}**. Features that need ${missing.length === 1 ? 'it' : 'them'} won't work. Re-invite me with the full permissions, or add ${missing.length === 1 ? 'it' : 'them'} to my role.`);

  const above = guild.roles.cache.filter(r => r.id !== guild.id && !r.managed && r.position > me.roles.highest.position).size;
  if (above > 0) tips.push(`**${above}** role(s) are above mine. I can't change or remove members who hold them. Move my role near the top of the list: Server Settings, Roles, drag it up.`);

  const list = (channels) => `${channels.slice(0, 6).map(c => `<#${c.id}>`).join(' ')}${channels.length > 6 ? ` and ${channels.length - 6} more` : ''}`;
  const blindText = guild.channels.cache.filter(c => c.isTextBased() && !c.isThread() && !c.permissionsFor(me)?.has(F.ViewChannel)).map(c => c);
  if (blindText.length) tips.push(`I can't see ${blindText.length} text channel(s): ${list(blindText)}. If that's not on purpose, a channel or category setting is blocking my role.`);
  const blindVoice = guild.channels.cache.filter(c => c.isVoiceBased() && !c.permissionsFor(me)?.has(F.Connect)).map(c => c);
  if (blindVoice.length) tips.push(`I can't join ${blindVoice.length} voice channel(s): ${list(blindVoice)}.`);
  return tips;
}

// ── Views ─────────────────────────────────────────────────────────────────────

/** Splits lines into groups that fit an embed field (1024 characters). */
function chunk(lines, max = 1000) {
  const out = [];
  for (const l of lines) { if (out.length && out[out.length - 1].length + l.length + 1 <= max) out[out.length - 1] += `\n${l}`; else out.push(l.slice(0, max)); }
  return out;
}

function viewHome(guild, note) {
  const items = summary(guild);
  const core = items.filter(i => i.core), optional = items.filter(i => !i.core);
  const line = (i) => `${i.done ? '✅ Done' : i.core ? '⚠️ Needs setup' : '▫️ Optional'} · **${PAGES.find(p => p.value === i.key).label}** — ${i.text}`;
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
        '_Everything saves the moment you pick it. Press **Permission check** at any time to see what is missing. Keep my role near the top of the role list so I can manage roles and members._'].join('\n') : null,
    ].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Core', value: core.map(line).join('\n') },
      ...chunk(optional.map(line)).map((value, i) => ({ name: i === 0 ? 'Optional' : 'Optional (continued)', value })),
    )
    .setFooter({ text: 'Pick a section below · changes save instantly' });

  const menu = new StringSelectMenuBuilder().setCustomId('setup:home:go').setPlaceholder('Choose what to configure…')
    .addOptions(PAGES.map(p => ({ label: p.label, value: p.value, description: p.desc, emoji: p.emoji })));
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
  const { problems, good, tips } = checkPermissions(guild);
  const embed = new EmbedBuilder()
    .setColor(problems.length ? RED : tips.length ? AMBER : GREEN)
    .setTitle('Permission check')
    .setDescription(problems.length
      ? `Found **${problems.length}** problem(s) that would stop features working:\n\n${problems.join('\n')}`
      : '**Everything you have set up is working.**');
  if (tips.length) embed.addFields({ name: 'Worth fixing', value: tips.join('\n\n').slice(0, 1000) });
  if (good.length) embed.addFields({ name: 'Working', value: good.join('\n').slice(0, 1000) });
  embed.addFields({ name: 'Keeping me trouble free', value: 'Leave my role near the top of the role list and don\'t block it in channel or category settings. I never need Administrator.' });
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
      `Channel: ${c.announceChannelId ? chan(c.announceChannelId) : '*not set (the bot falls back to the panel or system channel)*'}`, '',
      'Where bot news is posted: changelogs, maintenance notices and important updates. These are rare, and you can change this channel at any time.'].filter(Boolean).join('\n'))],
    components: [channelSelect('setup:announce:set', 'Announcement channel', c.announceChannelId),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:announce:clear').setLabel('Clear').setStyle(ButtonStyle.Danger), backButton())],
  };
}

const VIEWS = { home: viewHome, panel: viewPanel, verify: viewVerify, control: viewControl, announce: viewAnnounce, check: viewCheck };

// ── Actions ───────────────────────────────────────────────────────────────────

async function postPanel(guild, channel, client, by) {
  const { buildPanelEmbed, buildPanelButtons } = require('./statusUpdater');
  const existing = getGuildConfig(guild.id);
  if (existing.panelChannelId && existing.panelMessageId) {
    try { const old = await guild.channels.fetch(existing.panelChannelId); await (await old?.messages.fetch(existing.panelMessageId))?.delete(); } catch { /* already gone */ }
  }
  const message = await channel.send({ embeds: [buildPanelEmbed(guild.id, guild)], components: buildPanelButtons(guild.id) });
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
  const show = (name, ...args) => respond(interaction, kitFor(name) ? kitFor(name).VIEWS[name](guild, by, ...args) : VIEWS[name](guild, ...args));

  // Navigation
  if (page === 'home' && !action) return await show('home'), true;
  if (page === 'home' && action === 'go') return await show(interaction.values[0]), true;   // select menu
  if (page === 'check') return await show('check'), true;
  if (kitFor(page)) return await kitFor(page).handle(interaction, { guild, by, client, page, action, arg }), true;
  if (['panel', 'verify', 'control', 'announce'].includes(page) && !action) return await show(page), true;

  // ── panel ──
  if (page === 'panel' && action === 'set') {
    const channel = interaction.channels.first();
    const missing = missingIn(channel, guild);
    if (missing.length) return await show('panel', noteBad(`I can't post in ${channel}: missing **${missing.join(', ')}**.`)), true;
    try { await postPanel(guild, channel, client, by); } catch (err) { log('ERROR', 'Could not post the control panel', { guild: guild.name, err }); return await show('panel', noteBad('Discord refused the message. Check my permissions in that channel.')), true; }
    done('panel posted', `#${channel.name}`);
    return await show('panel', noteGood(`Panel posted in ${channel}.`)), true;
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