/**
 * /owner — bot-owner control. Works in any server the bot is in (and in the bot's DMs),
 * but ONLY for the people listed in the Discloud variables:
 *   OWNER_IDS  full control            ADMIN_IDS  status, restart, logs, alerts, audit, panels, server list
 *
 * Security: Discord hiding the command is not relied on. Every run checks the caller's
 * user ID against those variables; strangers get a refusal and an alert-log entry.
 * Destructive actions (leave/ban a server, announce, re-register commands, restart) ask
 * for confirmation first, and everything that changes something is audit-logged.
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags, InteractionContextType,
  ChannelType, PermissionFlagsBits, REST, Routes,
} = require('discord.js');
const crypto = require('crypto');

const { isOwner, isBotAdmin } = require('../src/permissions');
const globalConfig = require('../src/globalConfig');
const alerts       = require('../src/errorAlerts');
const monitor      = require('../src/ownerMonitor');
const { buildOwnerEmbeds } = require('../src/botInfo');
const { audit }    = require('../src/diagnostics');
const { log }      = require('../src/logger');
const { getGuildConfig } = require('../src/guildConfig');
const { selectOne } = require('../src/database');

const BLUE = 0x5865F2;
const ephemeral = [MessageFlags.Ephemeral];
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const n  = (v) => Number(v || 0).toLocaleString('en-GB');

/** Subcommands only the owner (not ADMIN_IDS) may use. */
const OWNER_ONLY = new Set(['announce', 'maintenance', 'features', 'block-user', 'unblock-user', 'blocked', 'commands', 'server:leave', 'server:ban', 'server:unban']);

const FEATURES = { streamerAlerts: 'Streamer alerts (Twitch / Kick / YouTube)', gameAlerts: 'Game alerts (free games + patch notes)' };

// Pending confirmations: nonce → { kind, userId, expires, ... }
const pending = new Map();
const PENDING_TTL = 10 * 60_000;
function remember(data) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const nonce = crypto.randomBytes(5).toString('hex');
  pending.set(nonce, { ...data, expires: now + PENDING_TTL });
  return nonce;
}

const confirmRow = (nonce, yesLabel) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`owner:yes:${nonce}`).setLabel(yesLabel).setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`owner:no:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
);

// ── Command definition ────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('owner')
  .setDescription('Bot owner controls')
  .setDefaultMemberPermissions(0)                       // hidden from regular members; the code still checks your ID
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
  .addSubcommand(s => s.setName('status').setDescription('System, usage, services and safety settings'))
  .addSubcommand(s => s.setName('restart').setDescription('Restart the bot through Discloud'))
  .addSubcommand(s => s.setName('logs').setDescription('Get the latest console output as a file')
    .addIntegerOption(o => o.setName('lines').setDescription('How many lines (default 300)').setMinValue(20).setMaxValue(2000)))
  .addSubcommand(s => s.setName('digest').setDescription('Send the console log digest now'))
  .addSubcommand(s => s.setName('alerts').setDescription('Test, mute or unmute your private alerts')
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'Send a test alert', value: 'test' }, { name: 'Mute errors', value: 'mute' }, { name: 'Unmute', value: 'unmute' }))
    .addIntegerOption(o => o.setName('minutes').setDescription('Mute length (default 60)').setMinValue(5).setMaxValue(1440)))
  .addSubcommand(s => s.setName('audit').setDescription('Recent changes made through the bot')
    .addIntegerOption(o => o.setName('count').setDescription('How many (default 15)').setMinValue(1).setMaxValue(40)))
  .addSubcommand(s => s.setName('servers').setDescription('Every server the bot is in')
    .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)))
  .addSubcommandGroup(g => g.setName('server').setDescription('Work with one server')
    .addSubcommand(s => s.setName('info').setDescription('Details about a server')
      .addStringOption(o => o.setName('server').setDescription('Server').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('leave').setDescription('Make the bot leave a server')
      .addStringOption(o => o.setName('server').setDescription('Server').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('ban').setDescription('Block a server from using the bot (and leave it)')
      .addStringOption(o => o.setName('server').setDescription('Server').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(200)))
    .addSubcommand(s => s.setName('unban').setDescription('Allow a blocked server again')
      .addStringOption(o => o.setName('server').setDescription('Server ID').setRequired(true).setAutocomplete(true))))
  .addSubcommand(s => s.setName('announce').setDescription('Send a message to every server'))
  .addSubcommand(s => s.setName('maintenance').setDescription('Turn maintenance mode on or off')
    .addStringOption(o => o.setName('state').setDescription('On or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .addStringOption(o => o.setName('message').setDescription('Message shown to users').setMaxLength(300)))
  .addSubcommand(s => s.setName('features').setDescription('Global on/off switches (leave empty to list)')
    .addStringOption(o => o.setName('feature').setDescription('Feature').addChoices(...Object.entries(FEATURES).map(([value, name]) => ({ name, value }))))
    .addStringOption(o => o.setName('state').setDescription('On or off').addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
  .addSubcommand(s => s.setName('block-user').setDescription('Stop a person using the bot anywhere')
    .addUserOption(o => o.setName('user').setDescription('The person'))
    .addStringOption(o => o.setName('id').setDescription('…or their user ID').setMaxLength(25))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(200)))
  .addSubcommand(s => s.setName('unblock-user').setDescription('Let a blocked person use the bot again')
    .addStringOption(o => o.setName('id').setDescription('User ID').setRequired(true).setMaxLength(25)))
  .addSubcommand(s => s.setName('blocked').setDescription('List blocked users and servers'))
  .addSubcommand(s => s.setName('commands').setDescription('Wipe and re-register the slash commands'))
  .addSubcommand(s => s.setName('panels').setDescription('Refresh the control panel in every server'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function findGuild(client, query) {
  return client.guilds.cache.get(query) || client.guilds.cache.find(g => g.name.toLowerCase() === String(query).toLowerCase()) || null;
}

function postableChannel(guild) {
  const me = guild.members.me;
  const cfg = getGuildConfig(guild.id);
  const ok = (c) => c && c.type === ChannelType.GuildText && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  const configured = cfg.announceChannelId && guild.channels.cache.get(cfg.announceChannelId);
  if (ok(configured)) return configured;
  if (ok(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(ok).sort((a, b) => a.rawPosition - b.rawPosition).first() || null;
}

const reply = (interaction, content) => interaction.reply({ content, flags: ephemeral });

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function status(interaction, client) {
  await interaction.deferReply({ flags: ephemeral });
  return interaction.editReply({ embeds: await buildOwnerEmbeds(client) });
}

async function logs(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  try {
    const f = await monitor.consoleFile(interaction.options.getInteger('lines') ?? 300);
    return interaction.editReply({
      content: `Last ${f.shown} of ${f.total} console lines${f.url ? ` · [open live console](${f.url})` : ''}`,
      files: [new AttachmentBuilder(Buffer.from(f.data), { name: f.name })],
    });
  } catch (err) { return interaction.editReply({ content: `Could not read the console: ${err.message}` }); }
}

async function digest(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  const sent = await monitor.runDigest();
  return interaction.editReply({ content: sent === false ? 'Could not send a digest — check that the Discloud API and an alert destination (webhook / channel / DM) are configured.' : 'Digest sent to your private alerts.' });
}

async function alertsCmd(interaction) {
  const action = interaction.options.getString('action');
  if (action === 'mute') {
    const minutes = interaction.options.getInteger('minutes') ?? 60;
    alerts.mute(minutes * 60_000);
    audit({ action: `Alerts muted for ${minutes} min`, actor: interaction.user });
    return reply(interaction, `🔕 Error alerts muted for **${minutes} minutes**. Changes, restarts and digests still arrive.`);
  }
  if (action === 'unmute') { alerts.mute(0); audit({ action: 'Alerts unmuted', actor: interaction.user }); return reply(interaction, '🔔 Alerts unmuted.'); }

  const d = alerts.describeDestinations();
  const where = [d.webhook && 'webhook', d.channel && 'private channel', d.dm && 'DMs'].filter(Boolean);
  if (!where.length) return reply(interaction, 'No alert destination is configured. Set `ERROR_ALERT_WEBHOOK_URL`, `ERROR_ALERT_CHANNEL_ID` or `ERROR_ALERT_DM=true` (with `OWNER_IDS`) in your Discloud variables.');
  await alerts.notify({ level: 'INFO', title: 'Test alert', description: `Requested by ${interaction.user.tag}. If you can read this, alerts work.`, fields: [{ name: 'Levels', value: d.levels.join(', ') }], dm: true, buttons: true });
  return reply(interaction, `✅ Test alert sent to: **${where.join(' + ')}**.`);
}

function auditCmd(interaction) {
  const count = interaction.options.getInteger('count') ?? 15;
  const rows = globalConfig.get().audit.slice(-count).reverse();
  const lines = rows.map(r => `${ts(r.at)} **${r.action}**${r.actor ? ` — ${r.actor}` : ''}${r.guild ? ` · ${r.guild}` : ''}${r.details ? `\n└ ${r.details}` : ''}`);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(BLUE).setTitle('🛠️ Recent changes').setDescription(lines.join('\n').slice(0, 3900) || 'Nothing recorded yet.')], flags: ephemeral });
}

function servers(interaction, client) {
  const page = interaction.options.getInteger('page') ?? 1, per = 10;
  const all = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
  const pages = Math.max(1, Math.ceil(all.length / per));
  const slice = all.slice((page - 1) * per, page * per);
  const lines = slice.map((g, i) => `**${(page - 1) * per + i + 1}. ${g.name}**${globalConfig.isGuildBanned(g.id) ? ' 🚫' : ''}\n└ \`${g.id}\` · ${n(g.memberCount)} members · added ${ts(g.joinedTimestamp)}`);
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`🌐 Servers (${all.length})`).setDescription(lines.join('\n') || 'No servers on this page.').setFooter({ text: `Page ${page} of ${pages} · /owner server info for details` })],
    flags: ephemeral,
  });
}

async function serverInfo(interaction, client) {
  const guild = findGuild(client, interaction.options.getString('server'));
  if (!guild) return reply(interaction, 'I\'m not in that server.');
  await interaction.deferReply({ flags: ephemeral });

  const owner = await guild.fetchOwner().catch(() => null);
  const me = guild.members.me;
  const cfg = getGuildConfig(guild.id);
  const { summary } = require('../src/setup');
  const items = summary(guild);
  const core = items.filter(i => i.core);
  const wantPerms = ['ManageRoles', 'KickMembers', 'ManageMessages', 'ViewAuditLog', 'Connect', 'Speak'];
  const lacking = wantPerms.filter(p => !me.permissions.has(PermissionFlagsBits[p]));
  const voice = selectOne('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM vc_sessions WHERE guild_id = ? AND duration_ms IS NOT NULL', [guild.id]) || {};
  const { formatMs } = require('../src/database');
  const vs = require('../src/verification').settings(guild.id);

  const embed = new EmbedBuilder().setColor(globalConfig.isGuildBanned(guild.id) ? 0xED4245 : BLUE)
    .setTitle(`🌐 ${guild.name}`).setThumbnail(guild.iconURL({ size: 128 }))
    .addFields(
      { name: 'ID', value: `\`${guild.id}\``, inline: true },
      { name: 'Owner', value: owner ? `${owner.user.tag}\n\`${owner.id}\`` : `\`${guild.ownerId}\``, inline: true },
      { name: 'Members', value: n(guild.memberCount), inline: true },
      { name: 'Created / added', value: `${ts(guild.createdTimestamp, 'D')}\nbot ${ts(guild.joinedTimestamp)}`, inline: true },
      { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0} (tier ${guild.premiumTier})`, inline: true },
      { name: 'Channels / roles', value: `${guild.channels.cache.size} / ${guild.roles.cache.size}`, inline: true },
      { name: 'Setup', value: `Core ${core.filter(i => i.done).length}/${core.length}\n${items.filter(i => i.done).map(i => i.key).join(', ') || 'nothing set'}`, inline: true },
      { name: 'Verification', value: vs.roleId ? `${vs.mode === 'captcha' ? 'human check' : 'button'}${vs.kickMinutes ? ` · auto-remove ${vs.kickMinutes}m` : ''}` : 'off', inline: true },
      { name: 'Voice activity', value: `${n(voice.n)} sessions · ${formatMs(voice.ms || 0)}`, inline: true },
      { name: 'Bot permissions', value: lacking.length ? `Missing: ${lacking.join(', ')}` : 'All the useful ones', inline: false },
    );
  if (globalConfig.isGuildBanned(guild.id)) embed.setDescription(`🚫 **Blocked** — ${globalConfig.get().blacklist.guilds[guild.id].reason || 'no reason given'}`);
  return interaction.editReply({ embeds: [embed] });
}

async function serverAction(interaction, client, kind) {
  const guild = findGuild(client, interaction.options.getString('server'));
  if (!guild) return reply(interaction, 'I\'m not in that server.');
  const reason = interaction.options.getString('reason') || null;
  const nonce = remember({ kind, userId: interaction.user.id, guildId: guild.id, reason });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xED4245).setTitle(kind === 'ban' ? `Block ${guild.name}?` : `Leave ${guild.name}?`)
      .setDescription(kind === 'ban' ? 'The bot leaves immediately and will leave again if it is ever re-added.' : 'The bot leaves this server. It can be re-added later.')
      .addFields({ name: 'Members', value: n(guild.memberCount), inline: true }, { name: 'ID', value: `\`${guild.id}\``, inline: true }, ...(reason ? [{ name: 'Reason', value: reason }] : []))],
    components: [confirmRow(nonce, kind === 'ban' ? 'Block and leave' : 'Leave server')],
    flags: ephemeral,
  });
}

function serverUnban(interaction) {
  const id = interaction.options.getString('server');
  if (!globalConfig.get().blacklist.guilds[id]) return reply(interaction, 'That server is not blocked.');
  globalConfig.update(s => { delete s.blacklist.guilds[id]; });
  audit({ action: 'Server unblocked', actor: interaction.user, details: id });
  return reply(interaction, `✅ Server \`${id}\` can use the bot again.`);
}

function announceModal() {
  return new ModalBuilder().setCustomId('owner:announce_modal').setTitle('Announcement to every server').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('body').setLabel('Message').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true)),
  );
}

function maintenance(interaction) {
  const on = interaction.options.getString('state') === 'on';
  const message = interaction.options.getString('message') || '';
  globalConfig.update(s => { s.maintenance = { enabled: on, message, since: on ? Date.now() : null, by: interaction.user.tag }; });
  audit({ action: `Maintenance mode ${on ? 'ON' : 'OFF'}`, actor: interaction.user, details: message || undefined });
  return reply(interaction, on ? `🔧 Maintenance mode is **ON**. Everyone except you and your bot admins sees: "${message || 'The bot is in maintenance mode.'}"` : '✅ Maintenance mode is **OFF**.');
}

function features(interaction) {
  const feature = interaction.options.getString('feature'), state = interaction.options.getString('state');
  if (feature && state) {
    globalConfig.update(s => { s.features[feature] = state === 'on'; });
    audit({ action: `Feature ${state === 'on' ? 'enabled' : 'disabled'}: ${feature}`, actor: interaction.user });
  }
  const f = globalConfig.get().features;
  return reply(interaction, ['**Global feature switches**', ...Object.entries(FEATURES).map(([k, label]) => `${f[k] !== false ? '🟢' : '🔴'} ${label}`)].join('\n'));
}

function blockUser(interaction) {
  const user = interaction.options.getUser('user');
  const id = (user?.id || interaction.options.getString('id') || '').trim();
  if (!/^\d{15,25}$/.test(id)) return reply(interaction, 'Give a user or a valid user ID.');
  if (isBotAdmin(id)) return reply(interaction, 'You can\'t block an owner or bot admin.');
  const reason = interaction.options.getString('reason') || null;
  globalConfig.update(s => { s.blacklist.users[id] = { reason, at: Date.now(), by: interaction.user.tag }; });
  audit({ action: 'User blocked', actor: interaction.user, details: `${user?.tag || id}${reason ? ` — ${reason}` : ''}` });
  return reply(interaction, `🚫 <@${id}> (\`${id}\`) can no longer use the bot.`);
}

function unblockUser(interaction) {
  const id = interaction.options.getString('id').trim();
  if (!globalConfig.get().blacklist.users[id]) return reply(interaction, 'That user is not blocked.');
  globalConfig.update(s => { delete s.blacklist.users[id]; });
  audit({ action: 'User unblocked', actor: interaction.user, details: id });
  return reply(interaction, `✅ <@${id}> can use the bot again.`);
}

function blocked(interaction) {
  const b = globalConfig.get().blacklist;
  const u = Object.entries(b.users).map(([id, v]) => `<@${id}> \`${id}\` — ${v.reason || 'no reason'} (${ts(v.at)})`);
  const g = Object.entries(b.guilds).map(([id, v]) => `\`${id}\` — ${v.reason || 'no reason'} (${ts(v.at)})`);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🚫 Blocked')
    .addFields({ name: `Users (${u.length})`, value: u.join('\n').slice(0, 1000) || 'none' }, { name: `Servers (${g.length})`, value: g.join('\n').slice(0, 1000) || 'none' })], flags: ephemeral });
}

function commandsConfirm(interaction) {
  const nonce = remember({ kind: 'commands', userId: interaction.user.id });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xFAA61A).setTitle('Re-register slash commands?')
      .setDescription('Wipes every global and per-server command, then registers the current set again. Commands can be missing for a short moment.')],
    components: [confirmRow(nonce, 'Re-register')], flags: ephemeral,
  });
}

async function panels(interaction, client) {
  await interaction.deferReply({ flags: ephemeral });
  await require('../src/statusUpdater').updatePanel(client);
  audit({ action: 'Panels refreshed everywhere', actor: interaction.user });
  return interaction.editReply({ content: '✅ Refreshed the control panel in every server.' });
}

// ── Confirmations + modals ────────────────────────────────────────────────────

async function runReregister(client, by) {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
  let cleared = 0;
  for (const guild of client.guilds.cache.values()) {
    try { await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: [] }); cleared++; } catch { /* no access */ }
  }
  const body = [...client.commands.values()].map(c => c.data.toJSON());
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body });
  audit({ action: 'Slash commands re-registered', actor: by, details: `${body.length} commands · cleared ${cleared} server(s)` });
  return { count: body.length, cleared, names: body.map(c => `\`/${c.name}\``).join(', ') };
}

async function runAnnounce(interaction, client, p) {
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(p.title).setDescription(p.body).setFooter({ text: 'Message from the bot owner' }).setTimestamp();
  let sent = 0; const failed = [];
  for (const guild of client.guilds.cache.values()) {
    if (globalConfig.isGuildBanned(guild.id)) continue;
    const ch = postableChannel(guild);
    if (!ch) { failed.push(`${guild.name} (no channel)`); continue; }
    try { await ch.send({ embeds: [embed] }); sent++; } catch (err) { failed.push(`${guild.name} (${err.message.slice(0, 40)})`); }
    await new Promise(r => setTimeout(r, 400));
  }
  audit({ action: 'Announcement sent', actor: interaction.user, details: `"${p.title}" → ${sent} server(s), ${failed.length} failed` });
  return { sent, failed };
}

/** Buttons + modal belonging to /owner. Returns true when handled. */
async function handleComponent(interaction, client) {
  const id = interaction.customId;
  if (!id || !id.startsWith('owner:')) return false;

  if (!isOwner(interaction.user.id)) { await reply(interaction, 'Only the bot owner can do this.'); return true; }

  if (interaction.isModalSubmit() && id === 'owner:announce_modal') {
    const title = interaction.fields.getTextInputValue('title').trim(), body = interaction.fields.getTextInputValue('body').trim();
    const nonce = remember({ kind: 'announce', userId: interaction.user.id, title, body });
    const targets = client.guilds.cache.filter(g => !globalConfig.isGuildBanned(g.id)).size;
    await interaction.reply({
      content: `**Preview** — this will be posted in **${targets}** server(s):`,
      embeds: [new EmbedBuilder().setColor(BLUE).setTitle(title).setDescription(body).setFooter({ text: 'Message from the bot owner' })],
      components: [confirmRow(nonce, `Send to ${targets} server(s)`)], flags: ephemeral,
    });
    return true;
  }

  if (!interaction.isButton()) return false;
  const [, action, nonce] = id.split(':');
  const p = pending.get(nonce);
  if (action === 'no') { pending.delete(nonce); await interaction.update({ content: 'Cancelled.', embeds: [], components: [] }); return true; }
  if (action !== 'yes') return false;
  if (!p || p.expires < Date.now() || p.userId !== interaction.user.id) { await interaction.update({ content: 'That confirmation expired — run the command again.', embeds: [], components: [] }); return true; }
  pending.delete(nonce);

  if (p.kind === 'leave' || p.kind === 'ban') {
    const guild = client.guilds.cache.get(p.guildId);
    if (p.kind === 'ban') globalConfig.update(s => { s.blacklist.guilds[p.guildId] = { reason: p.reason, at: Date.now(), by: interaction.user.tag }; });
    audit({ action: p.kind === 'ban' ? 'Server blocked' : 'Left a server', actor: interaction.user, guild, details: `${p.guildId}${p.reason ? ` — ${p.reason}` : ''}` });
    let note = '';
    try { await guild?.leave(); } catch (err) { note = ` (could not leave: ${err.message})`; }
    await interaction.update({ content: `${p.kind === 'ban' ? '🚫 Blocked and left' : '👋 Left'} **${guild?.name || p.guildId}**.${note}`, embeds: [], components: [] });
    return true;
  }

  if (p.kind === 'commands') {
    await interaction.update({ content: '🔄 Clearing and re-registering commands…', embeds: [], components: [] });
    try {
      const r = await runReregister(client, interaction.user);
      await interaction.editReply({ content: `✅ Done — registered **${r.count}** command(s): ${r.names}\nCleared per-server commands in ${r.cleared} server(s).` });
    } catch (err) {
      log('ERROR', 'Re-registering commands failed', { err });
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return true;
  }

  if (p.kind === 'announce') {
    await interaction.update({ content: '📣 Sending…', embeds: [], components: [] });
    const r = await runAnnounce(interaction, client, p);
    await interaction.editReply({ content: `✅ Sent to **${r.sent}** server(s).${r.failed.length ? `\n⚠️ Could not post in ${r.failed.length}: ${r.failed.join(', ').slice(0, 800)}` : ''}` });
    return true;
  }
  return false;
}

// ── Autocomplete (server names) ───────────────────────────────────────────────

async function autocomplete(interaction, client) {
  if (!isBotAdmin(interaction.user.id)) return interaction.respond([]);
  const focused = String(interaction.options.getFocused() || '').toLowerCase();
  const sub = interaction.options.getSubcommand(false);
  let choices;
  if (sub === 'unban') choices = Object.entries(globalConfig.get().blacklist.guilds).map(([id, v]) => ({ name: `${id}${v.reason ? ` — ${v.reason}` : ''}`.slice(0, 100), value: id }));
  else choices = [...client.guilds.cache.values()].map(g => ({ name: `${g.name} (${n(g.memberCount)})`.slice(0, 100), value: g.id }));
  return interaction.respond(choices.filter(c => c.name.toLowerCase().includes(focused) || c.value.includes(focused)).slice(0, 25));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function execute(interaction, client) {
  const uid = interaction.user.id;
  if (!isBotAdmin(uid)) {
    log('WARN', 'Unauthorised /owner attempt', { user: interaction.user.tag, userId: uid, guild: interaction.guild?.name || 'DM' });
    return reply(interaction, 'This command is only for the bot owner.');
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub   = interaction.options.getSubcommand();
  const key   = group ? `${group}:${sub}` : sub;
  if (OWNER_ONLY.has(key) && !isOwner(uid)) return reply(interaction, 'That one is for the bot owner only (not bot admins).');

  switch (key) {
    case 'status':       return status(interaction, client);
    case 'restart':      return interaction.reply({ ...monitor.buildRestartConfirm(client), flags: ephemeral });
    case 'logs':         return logs(interaction);
    case 'digest':       return digest(interaction);
    case 'alerts':       return alertsCmd(interaction);
    case 'audit':        return auditCmd(interaction);
    case 'servers':      return servers(interaction, client);
    case 'server:info':  return serverInfo(interaction, client);
    case 'server:leave': return serverAction(interaction, client, 'leave');
    case 'server:ban':   return serverAction(interaction, client, 'ban');
    case 'server:unban': return serverUnban(interaction);
    case 'announce':     return interaction.showModal(announceModal());
    case 'maintenance':  return maintenance(interaction);
    case 'features':     return features(interaction);
    case 'block-user':   return blockUser(interaction);
    case 'unblock-user': return unblockUser(interaction);
    case 'blocked':      return blocked(interaction);
    case 'commands':     return commandsConfirm(interaction);
    case 'panels':       return panels(interaction, client);
    default:             return reply(interaction, 'Unknown subcommand.');
  }
}

module.exports = { data, execute, autocomplete, handleComponent, _pending: pending };
