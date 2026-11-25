/**
 * The bot owner's control panel, opened with /owner.
 *
 * One private screen with a menu of sections instead of a long list of subcommands:
 *   Overview · Servers · Alerts · Bot status · Announcements · Maintenance & features ·
 *   Blocked users & servers · Recent changes
 * plus Restart, Console logs and Send digest on the home screen.
 *
 * Who may do what (set in the Discloud variables, never in the repo):
 *   OWNER_IDS  everything
 *   ADMIN_IDS  overview, servers (view + refresh panels), alert test/mute, recent changes, restart, console logs
 *
 * Discord hiding the command is not relied on: every click re-checks the person's user ID.
 * Destructive actions ask for confirmation first, and every change is audit-logged.
 *
 * customIds: owner:<action>[:<arg>[:<arg>]]
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
  ChannelType, REST, Routes,
} = require('discord.js');
const crypto = require('crypto');

const { isOwner, isBotAdmin, ownerIds } = require('./permissions');
const globalConfig = require('./globalConfig');
const alerts       = require('./errorAlerts');
const monitor      = require('./ownerMonitor');
const presence     = require('./presence');
const ownerAnnounce = require('./ownerAnnounce');
const system       = require('./system');
const { buildOwnerEmbeds } = require('./botInfo');
const { audit }    = require('./diagnostics');
const { log }      = require('./logger');
const { selectOne, formatMs } = require('./database');
const { duration } = require('./duration');

const BLUE = 0x5865F2, RED = 0xED4245, AMBER = 0xFAA61A;
const ephemeral = [MessageFlags.Ephemeral];
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const n  = (v) => Number(v || 0).toLocaleString('en-GB');

const FEATURES = {
  streamerAlerts: 'Streamer alerts (Twitch / Kick / YouTube)', gameAlerts: 'Game alerts (free games and patch notes)',
  raidProtection: 'Raid protection (join floods, raid mode, account age gate)', autoMod: 'AutoMod (message filters)', checkpoint: 'Security Check Point (trap channel)',
  cardPanels: 'Card panels (messages drawn as cards instead of plain embeds)',
};

const SECTIONS = [
  { key: 'overview',  emoji: '📊', label: 'Overview',                 desc: 'System, usage, services and safety settings' },
  { key: 'servers',   emoji: '🌐', label: 'Servers',                  desc: 'Every server the bot is in' },
  { key: 'alerts',    emoji: '🔔', label: 'Alerts',                   desc: 'Where alerts go, mute, console digest, memory restart' },
  { key: 'status',    emoji: '💬', label: 'Bot status',               desc: 'The rotating status line under the bot\'s name', ownerOnly: true },
  { key: 'announce',  emoji: '📣', label: 'Announcements',            desc: 'Send a message to servers you choose', ownerOnly: true },
  { key: 'control',   emoji: '🛠️', label: 'Maintenance and features', desc: 'Maintenance mode, global switches, commands', ownerOnly: true },
  { key: 'blocks',    emoji: '⛔', label: 'Blocked users and servers', desc: 'Stop someone using the bot', ownerOnly: true },
  { key: 'audit',     emoji: '🧾', label: 'Recent changes',           desc: 'What was changed through the bot, and by whom' },
];

/** Component actions only the owner (not ADMIN_IDS) may use. */
const OWNER_ONLY = /^owner:(ann_|announce|al_(ch|lvl|dig|dto|mem|dm|rm|more|view)|srv_act|blk_|mt_|ft|st_|op_cmds|op_backup|yes|no)/;

// ── Pending confirmations ─────────────────────────────────────────────────────

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

const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const back = (to = 'home', label = 'Back') => btn(to === 'home' ? 'owner:home' : `owner:to:${to}`, label);

/** Edit the screen in place (or open it fresh from the slash command). */
async function show(interaction, view) {
  if (!('content' in view)) view = { ...view, content: null };   // a screen that came after one with text must not keep that text
  if (interaction.deferred || interaction.replied) return interaction.editReply(view);
  if (interaction.isFromMessage?.() || interaction.isMessageComponent?.()) return interaction.update(view);
  return interaction.reply({ ...view, flags: ephemeral });
}
const say = (interaction, content) => interaction.reply({ content, flags: ephemeral });

// ── Home ──────────────────────────────────────────────────────────────────────

const uptimeText = (sec) => duration(sec * 1000);

function viewHome(client, userId, note) {
  const owner = isOwner(userId);
  const dest = alerts.describeDestinations();
  const where = [dest.webhook && 'webhook', dest.channel && 'private channel', dest.dm && 'DMs'].filter(Boolean).join(' + ') || 'not set up';
  const cfg = globalConfig.get();
  const members = client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0);

  const embed = new EmbedBuilder().setColor(cfg.maintenance.enabled ? AMBER : BLUE).setTitle('POW-Bot control panel').setDescription([note, 'Choose a section below.'].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Status',   value: `Online · up ${uptimeText(process.uptime())} · ${client.ws.ping >= 0 ? `${client.ws.ping} ms` : 'ping n/a'}`, inline: false },
      { name: 'Servers',  value: `\`${n(client.guilds.cache.size)}\``, inline: true },
      { name: 'Members',  value: `\`${n(members)}\``, inline: true },
      { name: 'Memory',   value: `\`${system.formatMemory()}\``, inline: true },
      { name: 'Alerts',   value: `${where}${dest.muted ? ' (muted)' : ''}`, inline: true },
      { name: 'Maintenance', value: cfg.maintenance.enabled ? `**on** since ${ts(cfg.maintenance.since)}` : 'off', inline: true },
      { name: 'Bot status', value: `${presence.list().length} status(es)`, inline: true },
    )
    .setFooter({ text: owner ? 'Bot owner' : 'Bot admin' });

  const menu = new StringSelectMenuBuilder().setCustomId('owner:go').setPlaceholder('Open a section…')
    .addOptions(SECTIONS.filter(s => owner || !s.ownerOnly).map(s => ({ label: s.label, value: s.key, description: s.desc, emoji: s.emoji })));
  return { embeds: [embed], components: [row(menu), row(btn('owner:op_restart', 'Restart bot', ButtonStyle.Danger), btn('owner:op_logs', 'Console logs'), btn('owner:op_digest', 'Send digest'), btn('owner:home', 'Refresh'))] };
}

// ── Overview ──────────────────────────────────────────────────────────────────

async function viewOverview(client) {
  return { embeds: await buildOwnerEmbeds(client), components: [row(back())] };
}

// ── Servers ───────────────────────────────────────────────────────────────────

const PER_PAGE = 10;
const sortedGuilds = (client) => [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);

function viewServers(client, page = 0, note) {
  const all = sortedGuilds(client), pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const lines = slice.map((g, i) => `**${page * PER_PAGE + i + 1}. ${g.name}**${globalConfig.isGuildBanned(g.id) ? ' (blocked)' : ''}\n└ \`${g.id}\` · ${n(g.memberCount)} members · added ${ts(g.joinedTimestamp)}`);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`Servers (${all.length})`).setDescription([note, lines.join('\n') || 'No servers.'].filter(Boolean).join('\n\n')).setFooter({ text: `Page ${page + 1} of ${pages}` });
  const components = [];
  if (slice.length) components.push(row(new StringSelectMenuBuilder().setCustomId(`owner:srv_pick:${page}`).setPlaceholder('Open a server…')
    .addOptions(slice.map(g => ({ label: g.name.slice(0, 100), value: g.id, description: `${n(g.memberCount)} members` })))));
  components.push(row(btn(`owner:srv_pg:${page - 1}`, 'Previous', ButtonStyle.Secondary, page === 0), btn(`owner:srv_pg:${page + 1}`, 'Next', ButtonStyle.Secondary, page >= pages - 1), btn('owner:op_panels', 'Refresh panels everywhere'), back()));
  return { embeds: [embed], components };
}

async function serverEmbed(guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  const { summary } = require('./setup');
  const items = summary(guild), core = items.filter(i => i.core);
  const lacking = require('./botPermissions').missingServerWide(guild);
  const voice = selectOne('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM vc_sessions WHERE guild_id = ? AND duration_ms IS NOT NULL', [guild.id]) || {};
  const vs = require('./verification').settings(guild.id);
  const blocked = globalConfig.isGuildBanned(guild.id);

  const embed = new EmbedBuilder().setColor(blocked ? RED : BLUE).setTitle(guild.name).setThumbnail(guild.iconURL({ size: 128 }))
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
      { name: 'Bot permissions', value: lacking.length ? `Missing: ${lacking.join(', ')}` : 'All present', inline: false },
    );
  if (blocked) embed.setDescription(`**Blocked**: ${globalConfig.get().blacklist.guilds[guild.id].reason || 'no reason given'}`);
  return embed;
}

async function viewServer(guild, page, userId) {
  const buttons = [];
  if (isOwner(userId)) buttons.push(btn(`owner:srv_act:leave:${guild.id}`, 'Leave server', ButtonStyle.Secondary), btn(`owner:srv_act:ban:${guild.id}`, 'Block and leave', ButtonStyle.Danger));
  buttons.push(btn(`owner:srv_pg:${page}`, 'Back to servers'));
  return { embeds: [await serverEmbed(guild)], components: [row(...buttons)] };
}

function confirmServerAction(interaction, kind, guildId) {
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) return say(interaction, 'I\'m not in that server any more.');
  const nonce = remember({ kind, userId: interaction.user.id, guildId: guild.id, reason: null });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(RED).setTitle(kind === 'ban' ? `Block ${guild.name}?` : `Leave ${guild.name}?`)
      .setDescription(kind === 'ban' ? 'The bot leaves immediately and will leave again if it is ever re-added. Unblock it from Blocked users and servers.' : 'The bot leaves this server. It can be re-added later.')
      .addFields({ name: 'Members', value: n(guild.memberCount), inline: true }, { name: 'ID', value: `\`${guild.id}\``, inline: true })],
    components: [confirmRow(nonce, kind === 'ban' ? 'Block and leave' : 'Leave server')],
    flags: ephemeral,
  });
}

// ── Alerts ────────────────────────────────────────────────────────────────────

const LEVEL_PRESETS = [
  { value: 'ERROR',                  label: 'Errors only',                       levels: ['ERROR'] },
  { value: 'ERROR,AUDIT',            label: 'Errors + changes (recommended)',    levels: ['ERROR', 'AUDIT'] },
  { value: 'ERROR,AUDIT,WARN',       label: 'Errors, changes + warnings',        levels: ['ERROR', 'AUDIT', 'WARN'] },
  { value: 'ERROR,AUDIT,WARN,GHOST', label: 'Everything',                        levels: ['ERROR', 'AUDIT', 'WARN', 'GHOST'] },
];
const DIGEST_OPTIONS = [['0', 'Console digest: off'], ['30', 'Console digest: every 30 minutes'], ['60', 'Console digest: every hour (recommended)'], ['120', 'Console digest: every 2 hours'], ['360', 'Console digest: every 6 hours']];
const DIGEST_TO_OPTIONS = [['auto', 'Digest goes to: webhook or channel, else my DMs (default)'], ['webhook', 'Digest goes to: webhook or alerts channel only'], ['dm', 'Digest goes to: my DMs only'], ['both', 'Digest goes to: webhook or channel, and my DMs']];
const DIGEST_TO_LABEL = { webhook: 'webhook or alerts channel only', dm: 'your DMs only', both: 'webhook or channel, and your DMs' };
const MEMORY_OPTIONS = [['0', 'Memory auto-restart: off'], ['80', 'Memory auto-restart: at 80%'], ['90', 'Memory auto-restart: at 90% (recommended)'], ['95', 'Memory auto-restart: at 95%']];

function viewAlerts(userId, note) {
  const d = alerts.describeDestinations(), st = monitor.getSettings();
  const lvlKey = [...d.levels].sort().join(',');
  const preset = LEVEL_PRESETS.find(p => [...p.levels].sort().join(',') === lvlKey);
  const owner = isOwner(userId);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Alerts').setDescription([note,
    `**Webhook**: ${d.webhook ? `connected${d.from?.webhook === 'Discloud variable' ? ' (set by a Discloud variable, which overrides this screen)' : ''}` : 'not set. Pick a private channel below and I\'ll create it.'}`,
    `**DMs to you**: ${d.dm ? 'on (with Restart, Logs and Mute buttons)' : 'off'}`,
    `**What is sent**: ${preset ? preset.label : d.levels.join(', ')}`,
    `**Console digest**: ${st.digestMinutes ? `every ${st.digestMinutes} minutes, to ${DIGEST_TO_LABEL[st.digestTo] || 'the webhook or channel, else your DMs'}` : 'off'}`,
    `**Memory auto-restart**: ${st.memoryPercent ? `at ${st.memoryPercent}% of the limit` : 'off'}`,
    d.muted ? '**Errors are muted** right now.' : null,
    owner ? '\nPick a channel only you can see. Everything here is private to you.' : '\nOnly the bot owner can change where alerts go.'].filter(Boolean).join('\n'));

  const muteButton = d.muted ? btn('owner:al_mute', 'Unmute') : btn('owner:al_mute', 'Mute 1 hour');
  if (!owner) return { embeds: [embed], components: [row(btn('owner:al_test', 'Send test', ButtonStyle.Primary), muteButton, back())] };

  const pick = (id, ph, opts, cur) => row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph).addOptions(opts.map(([value, label]) => ({ label, value, default: String(cur) === value }))));
  return {
    embeds: [embed],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId('owner:al_ch').setPlaceholder('Create the alerts webhook in this channel…').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
      pick('owner:al_lvl', 'What to send…', LEVEL_PRESETS.map(p => [p.value, p.label]), preset?.value),
      row(btn('owner:al_dm', `DMs: ${d.dm ? 'ON' : 'OFF'}`, d.dm ? ButtonStyle.Success : ButtonStyle.Secondary), btn('owner:al_test', 'Send test', ButtonStyle.Primary), muteButton,
        btn('owner:al_rm', 'Remove webhook', ButtonStyle.Danger, !globalConfig.get().alerts.webhookUrl), btn('owner:al_more', 'Digest and memory…')),
      row(back()),
    ],
  };
}

/** Second alerts page: how often the console digest is sent, where it goes, and the memory watch. */
function viewAlertsMore(userId, note) {
  const st = monitor.getSettings(), d = alerts.describeDestinations();
  const dmOk = ownerIds().length > 0;
  const embed = new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'Owner · Alerts' }).setTitle('Digest and memory').setDescription([note,
    'The console digest is a short summary of the bot\'s console with the full log attached. Choose how often it is sent and where it goes.'].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Digest', value: st.digestMinutes ? `every ${st.digestMinutes} minutes` : 'off', inline: true },
      { name: 'Sent to', value: DIGEST_TO_LABEL[st.digestTo] || 'webhook or channel, else your DMs', inline: true },
      { name: 'Memory auto-restart', value: st.memoryPercent ? `at ${st.memoryPercent}%` : 'off', inline: true },
      { name: 'Webhook / channel', value: d.webhook || d.channel ? 'connected' : 'not set', inline: true },
      { name: 'DMs to you', value: dmOk ? 'available' : 'set OWNER_IDS first', inline: true });
  const pick = (id, ph, opts, cur) => row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph).addOptions(opts.map(([value, label]) => ({ label, value, default: String(cur) === value }))));
  return { embeds: [embed], components: [
    pick('owner:al_dig', 'How often…', DIGEST_OPTIONS, st.digestMinutes),
    pick('owner:al_dto', 'Where to send it…', DIGEST_TO_OPTIONS, st.digestTo || 'auto'),
    pick('owner:al_mem', 'Memory auto-restart…', MEMORY_OPTIONS, st.memoryPercent),
    row(btn('owner:op_digest', 'Send a digest now', ButtonStyle.Primary), btn('owner:al_view', 'Back to alerts')),
  ] };
}

async function handleAlerts(interaction) {
  const id = interaction.customId;
  const sv = () => globalConfig.get().alerts;
  const again = (note, more = false) => show(interaction, more ? viewAlertsMore(interaction.user.id, note) : viewAlerts(interaction.user.id, note));

  if (interaction.isChannelSelectMenu() && id === 'owner:al_ch') {
    const channel = interaction.channels.first();
    try {
      const hook = await channel.createWebhook({ name: 'POW Bot Alerts', reason: `Private alerts set up by ${interaction.user.tag}` });
      globalConfig.update(s => { s.alerts.webhookUrl = hook.url; s.alerts.webhookId = hook.id; });
      audit({ action: 'Alerts webhook created', actor: interaction.user, details: `#${channel.name}` });
      await alerts.notify({ level: 'INFO', title: 'Alerts connected', description: `Set up by ${interaction.user.tag}. Errors and changes will appear in this channel.` });
      await again(`Webhook created in ${channel} and a test message was sent. Make sure only you can see that channel.`);
    } catch (err) {
      await again(`I couldn't create a webhook in ${channel}. I need the **Manage Webhooks** permission there. (${err.message})`);
    }
    return true;
  }
  if (interaction.isStringSelectMenu() && /^owner:al_(lvl|dig|dto|mem)$/.test(id)) {
    const v = interaction.values[0];
    const more = id !== 'owner:al_lvl';
    if (id === 'owner:al_dto') {
      if ((v === 'dm' || v === 'both') && !ownerIds().length) { await again('Set `OWNER_IDS` in your Discloud variables first, so I know who to DM.', true); return true; }
      globalConfig.update(s => { s.alerts.digestTo = v === 'auto' ? null : v; });
    }
    if (id === 'owner:al_lvl') globalConfig.update(s => { s.alerts.levels = LEVEL_PRESETS.find(p => p.value === v)?.levels || ['ERROR', 'AUDIT']; });
    if (id === 'owner:al_dig') { globalConfig.update(s => { s.alerts.digestMinutes = Number(v); }); monitor.reschedule(); }
    if (id === 'owner:al_mem') globalConfig.update(s => { s.alerts.memoryPercent = Number(v); });
    audit({ action: `Alert setting changed (${id.slice(9)})`, actor: interaction.user, details: v });
    await again('Saved.', more);
    return true;
  }
  if (!interaction.isButton()) return false;
  if (id === 'owner:al_more') { await again(null, true); return true; }
  if (id === 'owner:al_view') { await again(null); return true; }
  if (id === 'owner:al_dm') {
    const now = alerts.describeDestinations().dm;
    if (!now && !ownerIds().length) { await again('Set `OWNER_IDS` in your Discloud variables first, so I know who to DM.'); return true; }
    globalConfig.update(s => { s.alerts.dm = !now; });
    audit({ action: `Alert DMs ${!now ? 'enabled' : 'disabled'}`, actor: interaction.user });
    await again(`DMs ${!now ? 'on' : 'off'}.`);
    return true;
  }
  if (id === 'owner:al_test') {
    if (!alerts.isEnabled()) { await again('Nothing is set up yet. Pick a channel or turn on DMs first.'); return true; }
    await alerts.notify({ level: 'INFO', title: 'Test alert', description: `Requested by ${interaction.user.tag}. If you can read this, alerts work.`, dm: true, buttons: true });
    await again('Test alert sent.');
    return true;
  }
  if (id === 'owner:al_mute') {
    const muted = alerts.describeDestinations().muted;
    alerts.mute(muted ? 0 : 60 * 60_000);
    audit({ action: muted ? 'Alerts unmuted' : 'Alerts muted for 60 min', actor: interaction.user });
    await again(muted ? 'Alerts unmuted.' : 'Error alerts muted for 1 hour. Changes, restarts and digests still arrive.');
    return true;
  }
  if (id === 'owner:al_rm') {
    const m = /webhooks\/(\d+)\/([\w-]+)/.exec(sv().webhookUrl || '');
    if (m) { try { await interaction.client.deleteWebhook(m[1], { token: m[2], reason: 'Removed from the /owner alerts screen' }); } catch { /* it may already be gone */ } }
    globalConfig.update(s => { s.alerts.webhookUrl = null; s.alerts.webhookId = null; });
    audit({ action: 'Alerts webhook removed', actor: interaction.user });
    await again('Webhook removed.');
    return true;
  }
  return false;
}

// ── Bot status (presence) ─────────────────────────────────────────────────────

const typeLabel = (t) => presence.TYPES[t]?.label || 'Custom';
const entryText = (e) => (e.type === 'custom' ? e.text : `${typeLabel(e.type)} ${e.text}`);

function viewStatus(client, note) {
  const list = presence.list(), st = presence.settings();
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Bot status').setDescription([note,
    list.map((e, i) => `${i + 1}. ${entryText(e)}`).join('\n'),
    '',
    `Shown as **${{ online: 'Online', idle: 'Idle', dnd: 'Do not disturb' }[st.status]}** · changes every **${st.rotateSeconds >= 60 ? `${st.rotateSeconds / 60} min` : `${st.rotateSeconds}s`}**`,
    presence.isCustomised() ? null : 'These are the built-in statuses. Add or edit one to make the list your own.',
    'Placeholders: `{servers}` `{members}` `{voicehours}` `{voicenow}` `{uptime}` `{version}`. Only totals are shown, never a server, channel or member.'].filter(v => v !== null && v !== undefined).join('\n'));
  const pickOne = (id, ph, opts, cur) => row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(ph).addOptions(opts.map(([value, label]) => ({ label, value, default: String(cur) === value }))));
  return {
    embeds: [embed],
    components: [
      row(new StringSelectMenuBuilder().setCustomId('owner:st_pick').setPlaceholder('Edit or remove a status…')
        .addOptions(list.map((e, i) => ({ label: `${i + 1}. ${entryText(e)}`.slice(0, 100), value: e.id })))),
      pickOne('owner:st_online', 'Presence', [['online', 'Online (green)'], ['idle', 'Idle (yellow)'], ['dnd', 'Do not disturb (red)']], st.status),
      pickOne('owner:st_rot', 'Rotation speed', [['15', 'Change every 15 seconds'], ['30', 'Change every 30 seconds'], ['60', 'Change every minute'], ['120', 'Change every 2 minutes'], ['300', 'Change every 5 minutes']], st.rotateSeconds),
      row(btn('owner:st_new', 'Add status', ButtonStyle.Primary, presence.isCustomised() && list.length >= presence.MAX_ENTRIES), btn('owner:st_reset', 'Reset to defaults', ButtonStyle.Danger, !presence.isCustomised()), back()),
    ],
  };
}

function viewStatusNew(type = 'playing') {
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Add a status').setDescription(`Type: **${typeLabel(type)}**\n\nChoose how it reads, then press **Write text**.\n\`Playing\` shows as "Playing …", \`Watching\` as "Watching …", and \`Custom\` shows just your text.`)],
    components: [
      row(new StringSelectMenuBuilder().setCustomId('owner:st_tpl').setPlaceholder('Start from a template')
        .addOptions(presence.TEMPLATES.map((t, i) => ({ label: t.label, value: String(i), description: `${t.type === 'custom' ? '' : typeLabel(t.type) + ' '}${t.text}`.slice(0, 100) })))),
      row(new StringSelectMenuBuilder().setCustomId('owner:st_newtype').setPlaceholder('Status type')
        .addOptions(Object.entries(presence.TYPES).map(([value, t]) => ({ label: t.label, value, default: value === type })))),
      row(btn(`owner:st_text:${type}`, 'Write text', ButtonStyle.Primary), back('status', 'Cancel')),
    ],
  };
}

function viewStatusOne(client, id, note) {
  const e = presence.list().find(x => x.id === id);
  if (!e) return viewStatus(client, 'That status no longer exists.');
  const list = presence.list(), i = list.indexOf(e);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle(`Status ${i + 1}`).setDescription([note,
      `**Type:** ${typeLabel(e.type)}`, `**Text:** ${e.text}`, `**Shows as:** ${typeLabel(e.type) === 'Custom' ? '' : typeLabel(e.type) + ' '}${presence.render(e.text, client)}`].filter(Boolean).join('\n'))],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(`owner:st_type:${id}`).setPlaceholder('Change the type')
        .addOptions(Object.entries(presence.TYPES).map(([value, t]) => ({ label: t.label, value, default: value === e.type })))),
      row(btn(`owner:st_edit:${id}`, 'Edit text', ButtonStyle.Primary), btn(`owner:st_mv:${id}:-1`, 'Move up', ButtonStyle.Secondary, i === 0), btn(`owner:st_mv:${id}:1`, 'Move down', ButtonStyle.Secondary, i === list.length - 1),
        btn(`owner:st_rm:${id}`, 'Remove', ButtonStyle.Danger, list.length <= 1), back('status')),
    ],
  };
}

const statusTextModal = (customId, title, value = '') => new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
  row(new TextInputBuilder().setCustomId('text').setLabel('Status text').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(presence.MAX_TEXT).setValue(String(value).slice(0, presence.MAX_TEXT)).setPlaceholder('{servers} servers')));

// ── Maintenance and features ──────────────────────────────────────────────────

function backupLine(b) {
  if (!b?.lastAt && !b?.error) return 'weekly, none sent yet';
  const sent = b.lastAt ? `last sent ${ts(b.lastAt)} (${(b.size / 1048576).toFixed(1)} MB, ${b.scope})` : 'none sent yet';
  return `weekly, ${sent}${b.error ? `\nThe last attempt failed: ${b.error}` : ''}`;
}

function viewControl(note) {
  const cfg = globalConfig.get(), m = cfg.maintenance, f = cfg.features;
  const embed = new EmbedBuilder().setColor(m.enabled ? AMBER : BLUE).setTitle('Maintenance and features').setDescription([note,
    `**Maintenance mode**: ${m.enabled ? `on since ${ts(m.since)}${m.message ? `\nEveryone except you and your bot admins sees: "${m.message}"` : ''}` : 'off'}`,
    ...Object.entries(FEATURES).map(([k, label]) => `**${label}**: ${f[k] !== false ? 'on' : 'off'}`),
    `**Backup**: ${backupLine(cfg.backup)}`,
    '',
    'Maintenance mode pauses the bot for everyone except you. The switches turn a feature off in every server at once. Re-registering commands wipes and re-creates the slash commands (use it if one looks out of date).'].filter(Boolean).join('\n'));
  return { embeds: [embed], components: [
    row(btn('owner:mt_toggle', m.enabled ? 'Turn maintenance OFF' : 'Turn maintenance ON', m.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
      btn('owner:ft:streamerAlerts', `Streamer alerts: ${f.streamerAlerts !== false ? 'ON' : 'OFF'}`, f.streamerAlerts !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn('owner:ft:gameAlerts', `Game alerts: ${f.gameAlerts !== false ? 'ON' : 'OFF'}`, f.gameAlerts !== false ? ButtonStyle.Success : ButtonStyle.Secondary)),
    row(...['raidProtection', 'autoMod', 'checkpoint', 'cardPanels'].map(k => btn(`owner:ft:${k}`, `${{ raidProtection: 'Raid protection', autoMod: 'AutoMod', checkpoint: 'Check Point', cardPanels: 'Card panels' }[k]}: ${f[k] !== false ? 'ON' : 'OFF'}`, f[k] !== false ? ButtonStyle.Success : ButtonStyle.Secondary))),
    row(btn('owner:op_cmds', 'Re-register commands'), btn('owner:op_backup', 'Back up now'), back()),
  ] };
}

const maintenanceModal = () => new ModalBuilder().setCustomId('owner:mt_modal').setTitle('Maintenance mode').addComponents(
  row(new TextInputBuilder().setCustomId('message').setLabel('Message shown to users (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300).setPlaceholder('The bot is being updated and will be back shortly.')));

// ── Blocked users and servers ─────────────────────────────────────────────────

function viewBlocks(note) {
  const b = globalConfig.get().blacklist;
  const u = Object.entries(b.users).map(([id, v]) => `<@${id}> \`${id}\`: ${v.reason || 'no reason'} (${ts(v.at)})`);
  const g = Object.entries(b.guilds).map(([id, v]) => `\`${id}\`: ${v.reason || 'no reason'} (${ts(v.at)})`);
  const embed = new EmbedBuilder().setColor(RED).setTitle('Blocked users and servers').setDescription(note || null)
    .addFields({ name: `Users (${u.length})`, value: u.join('\n').slice(0, 1000) || 'none' }, { name: `Servers (${g.length})`, value: g.join('\n').slice(0, 1000) || 'none' });
  return { embeds: [embed], components: [row(btn('owner:blk_add', 'Block a user', ButtonStyle.Danger), btn('owner:blk_rmview', 'Unblock…', ButtonStyle.Secondary, !u.length && !g.length), back())] };
}

function viewUnblock() {
  const b = globalConfig.get().blacklist;
  const options = [
    ...Object.entries(b.users).map(([id, v]) => ({ label: `User ${id}`.slice(0, 100), value: `u:${id}`, description: (v.reason || 'no reason').slice(0, 100) })),
    ...Object.entries(b.guilds).map(([id, v]) => ({ label: `Server ${id}`.slice(0, 100), value: `g:${id}`, description: (v.reason || 'no reason').slice(0, 100) })),
  ].slice(0, 25);
  return {
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Unblock').setDescription(options.length ? 'Pick who to allow again.' : 'Nothing is blocked.')],
    components: [...(options.length ? [row(new StringSelectMenuBuilder().setCustomId('owner:blk_rm').setPlaceholder('Pick one to unblock…').addOptions(options))] : []), row(back('blocks'))],
  };
}

const blockModal = () => new ModalBuilder().setCustomId('owner:blk_modal').setTitle('Block a user').addComponents(
  row(new TextInputBuilder().setCustomId('id').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25).setPlaceholder('123456789012345678')),
  row(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)));

// ── Recent changes ────────────────────────────────────────────────────────────

function viewAudit() {
  const rows = globalConfig.get().audit.slice(-15).reverse();
  const lines = rows.map(r => `${ts(r.at)} **${r.action}**${r.actor ? ` · ${r.actor}` : ''}${r.guild ? ` · ${r.guild}` : ''}${r.details ? `\n└ ${r.details}` : ''}`);
  return { embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Recent changes').setDescription(lines.join('\n').slice(0, 3900) || 'Nothing recorded yet.')], components: [row(back())] };
}

// ── Operations ────────────────────────────────────────────────────────────────

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

async function sendLogs(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  try {
    const f = await monitor.consoleFile(300);
    return interaction.editReply({ content: `Last ${f.shown} of ${f.total} console lines${f.url ? ` · [open live console](${f.url})` : ''}`, files: [new AttachmentBuilder(Buffer.from(f.data), { name: f.name })] });
  } catch (err) { return interaction.editReply({ content: `Could not read the console: ${err.message}` }); }
}

async function sendDigest(interaction) {
  await interaction.deferReply({ flags: ephemeral });
  const sent = await monitor.runDigest();
  return interaction.editReply({ content: sent === false ? 'Could not send a digest. Check that the Discloud API and an alert destination (webhook, channel or DM) are set up.' : 'Digest sent to your private alerts.' });
}

async function refreshPanels(interaction, client) {
  await interaction.deferUpdate();
  await require('./statusUpdater').updatePanel(client);
  audit({ action: 'Panels refreshed everywhere', actor: interaction.user });
  return interaction.editReply(viewServers(client, 0, 'Refreshed the control panel in every server.'));
}

// ── Section router ────────────────────────────────────────────────────────────

async function openSection(interaction, client, key) {
  const uid = interaction.user.id;
  const def = SECTIONS.find(s => s.key === key);
  if (def?.ownerOnly && !isOwner(uid)) return say(interaction, 'That section is for the bot owner only.');
  switch (key) {
    case 'overview': await interaction.deferUpdate(); return show(interaction, await viewOverview(client));
    case 'servers':  return show(interaction, viewServers(client, 0));
    case 'alerts':   return show(interaction, viewAlerts(uid));
    case 'status':   return show(interaction, viewStatus(client));
    case 'announce': return show(interaction, ownerAnnounce.viewHome());
    case 'control':  return show(interaction, viewControl());
    case 'blocks':   return show(interaction, viewBlocks());
    case 'audit':    return show(interaction, viewAudit());
    default:         return show(interaction, viewHome(client, uid));
  }
}

// ── The slash command ─────────────────────────────────────────────────────────

async function open(interaction, client) {
  const uid = interaction.user.id;
  if (!isBotAdmin(uid)) {
    log('WARN', 'Unauthorised /owner attempt', { user: interaction.user.tag, userId: uid, guild: interaction.guild?.name || 'DM' });
    return say(interaction, 'This command is only for the bot owner.');
  }
  return interaction.reply({ ...viewHome(client, uid), flags: ephemeral });
}

// ── Components, modals and confirmations ──────────────────────────────────────

/** Returns true when the interaction belonged to /owner. */
async function handleComponent(interaction, client) {
  const id = interaction.customId;
  if (!id || !id.startsWith('owner:')) return false;
  client = client || interaction.client;
  const uid = interaction.user.id;

  if (!isBotAdmin(uid)) { await say(interaction, 'Only the bot owner can do this.'); return true; }
  if (OWNER_ONLY.test(id) && !isOwner(uid)) { await say(interaction, 'That one is for the bot owner only (not bot admins).'); return true; }

  const parts = id.split(':'), action = parts[1];

  if (action.startsWith('ann_')) return ownerAnnounce.handle(interaction, client);

  // ── Modals ──
  if (interaction.isModalSubmit()) {
    if (action === 'mt_modal') {
      const message = interaction.fields.getTextInputValue('message').trim();
      globalConfig.update(s => { s.maintenance = { enabled: true, message, since: Date.now(), by: interaction.user.tag }; });
      audit({ action: 'Maintenance mode ON', actor: interaction.user, details: message || undefined });
      await show(interaction, viewControl('Maintenance mode is on.'));
      return true;
    }
    if (action === 'blk_modal') {
      const target = interaction.fields.getTextInputValue('id').trim(), reason = interaction.fields.getTextInputValue('reason').trim() || null;
      if (!/^\d{15,25}$/.test(target)) { await show(interaction, viewBlocks('That is not a valid user ID.')); return true; }
      if (isBotAdmin(target)) { await show(interaction, viewBlocks('You can\'t block an owner or bot admin.')); return true; }
      globalConfig.update(s => { s.blacklist.users[target] = { reason, at: Date.now(), by: interaction.user.tag }; });
      audit({ action: 'User blocked', actor: interaction.user, details: `${target}${reason ? ` — ${reason}` : ''}` });
      await show(interaction, viewBlocks(`<@${target}> can no longer use the bot.`));
      return true;
    }
    if (action === 'st_addmodal') {
      const res = presence.add(parts[2], interaction.fields.getTextInputValue('text'));
      if (res.ok) { audit({ action: 'Bot status added', actor: interaction.user, details: res.entry.text }); presence.refresh(client); }
      await show(interaction, viewStatus(client, res.ok ? 'Status added.' : res.error));
      return true;
    }
    if (action === 'st_editmodal') {
      const current = presence.list().find(e => e.id === parts[2]);
      const res = presence.edit(parts[2], current?.type, interaction.fields.getTextInputValue('text'));
      if (res.ok) { audit({ action: 'Bot status edited', actor: interaction.user }); presence.refresh(client); }
      await show(interaction, res.ok ? viewStatusOne(client, parts[2], 'Saved.') : viewStatus(client, res.error));
      return true;
    }
    return false;
  }

  // ── Select menus ──
  if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
    if (/^owner:al_/.test(id)) return handleAlerts(interaction);
    if (!interaction.isStringSelectMenu()) return false;
    const v = interaction.values[0];

    if (action === 'go') { await openSection(interaction, client, v); return true; }
    if (action === 'srv_pick') {
      const guild = client.guilds.cache.get(v);
      if (!guild) { await show(interaction, viewServers(client, Number(parts[2]) || 0, 'I\'m not in that server any more.')); return true; }
      await interaction.deferUpdate();
      await show(interaction, await viewServer(guild, Number(parts[2]) || 0, uid));
      return true;
    }
    if (action === 'blk_rm') {
      const [kind, target] = v.split(':');
      globalConfig.update(s => { delete (kind === 'u' ? s.blacklist.users : s.blacklist.guilds)[target]; });
      audit({ action: kind === 'u' ? 'User unblocked' : 'Server unblocked', actor: interaction.user, details: target });
      await show(interaction, viewBlocks(`${kind === 'u' ? 'User' : 'Server'} \`${target}\` can use the bot again.`));
      return true;
    }
    if (action === 'st_pick') { await show(interaction, viewStatusOne(client, v)); return true; }
    if (action === 'st_tpl') {
      const t = presence.TEMPLATES[Number(v)];
      const res = t ? presence.add(t.type, t.text) : { ok: false, error: 'That template no longer exists.' };
      if (res.ok) { audit({ action: 'Bot status added', actor: interaction.user, details: res.entry.text }); presence.refresh(client); }
      await show(interaction, viewStatus(client, res.ok ? `Added: ${entryText(res.entry)}` : res.error));
      return true;
    }
    if (action === 'st_newtype') { await show(interaction, viewStatusNew(v)); return true; }
    if (action === 'st_type') {
      const current = presence.list().find(e => e.id === parts[2]);
      const res = current ? presence.edit(parts[2], v, current.text) : { ok: false };
      if (res.ok) { audit({ action: 'Bot status type changed', actor: interaction.user, details: v }); presence.refresh(client); }
      await show(interaction, viewStatusOne(client, parts[2], res.ok ? 'Saved.' : 'That status no longer exists.'));
      return true;
    }
    if (action === 'st_online') { presence.setStatus(v); audit({ action: 'Bot presence changed', actor: interaction.user, details: v }); presence.refresh(client); await show(interaction, viewStatus(client, 'Saved.')); return true; }
    if (action === 'st_rot')    { presence.setRotate(v); audit({ action: 'Status rotation changed', actor: interaction.user, details: `${v}s` }); presence.refresh(client); await show(interaction, viewStatus(client, 'Saved.')); return true; }

    return false;
  }

  if (!interaction.isButton()) return false;
  if (/^owner:al_/.test(id)) return handleAlerts(interaction);

  switch (action) {
    case 'home': await show(interaction, viewHome(client, uid)); return true;
    case 'to':   await openSection(interaction, client, parts[2]); return true;
    case 'srv_pg': await show(interaction, viewServers(client, Number(parts[2]) || 0)); return true;
    case 'srv_act': return confirmServerAction(interaction, parts[2], parts[3]), true;
    case 'op_restart': await interaction.reply({ ...monitor.buildRestartConfirm(client), flags: ephemeral }); return true;
    case 'op_logs':    await sendLogs(interaction); return true;
    case 'op_digest':  await sendDigest(interaction); return true;
    case 'op_panels':  await refreshPanels(interaction, client); return true;
    case 'op_cmds': {
      const nonce = remember({ kind: 'commands', userId: uid });
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(AMBER).setTitle('Re-register slash commands?').setDescription('Wipes every global and per-server command, then registers the current set again. Commands can be missing for a short moment.')], components: [confirmRow(nonce, 'Re-register')], flags: ephemeral });
      return true;
    }
    case 'op_backup': {
      await interaction.deferUpdate();
      const res = await require('./backup').run(client);
      audit({ action: 'Backup requested', actor: interaction.user, details: res.ok ? 'sent' : res.error });
      await show(interaction, viewControl(res.ok ? 'The backup was sent to your DMs.' : `The backup failed: ${res.error}`));
      return true;
    }
    case 'mt_toggle': {
      if (globalConfig.isMaintenance()) {
        globalConfig.update(s => { s.maintenance = { enabled: false, message: '', since: null, by: interaction.user.tag }; });
        audit({ action: 'Maintenance mode OFF', actor: interaction.user });
        await show(interaction, viewControl('Maintenance mode is off.'));
      } else await interaction.showModal(maintenanceModal());
      return true;
    }
    case 'ft': {
      const feature = parts[2];
      if (!FEATURES[feature]) return true;
      const now = globalConfig.featureEnabled(feature);
      globalConfig.update(s => { s.features[feature] = !now; });
      audit({ action: `Feature ${!now ? 'enabled' : 'disabled'}: ${feature}`, actor: interaction.user });
      await show(interaction, viewControl());
      return true;
    }
    case 'blk_add':    await interaction.showModal(blockModal()); return true;
    case 'blk_rmview': await show(interaction, viewUnblock()); return true;
    case 'st_new':     await show(interaction, viewStatusNew()); return true;
    case 'st_text':    await interaction.showModal(statusTextModal(`owner:st_addmodal:${parts[2]}`, 'New status')); return true;
    case 'st_edit': {
      const e = presence.list().find(x => x.id === parts[2]);
      if (!e) { await show(interaction, viewStatus(client, 'That status no longer exists.')); return true; }
      await interaction.showModal(statusTextModal(`owner:st_editmodal:${e.id}`, 'Edit status', e.text));
      return true;
    }
    case 'st_mv': { presence.move(parts[2], Number(parts[3])); presence.refresh(client); await show(interaction, viewStatusOne(client, parts[2])); return true; }
    case 'st_rm': {
      const res = presence.remove(parts[2]);
      if (res.ok) { audit({ action: 'Bot status removed', actor: interaction.user }); presence.refresh(client); }
      await show(interaction, viewStatus(client, res.ok ? 'Status removed.' : res.error));
      return true;
    }
    case 'st_reset': {
      presence.reset(); presence.refresh(client);
      audit({ action: 'Bot status reset to defaults', actor: interaction.user });
      await show(interaction, viewStatus(client, 'Back to the built-in statuses.'));
      return true;
    }
    case 'no': {
      pending.delete(parts[2]);
      await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
      return true;
    }
    case 'yes': return confirmed(interaction, client, parts[2]);
    default: return false;
  }
}

async function confirmed(interaction, client, nonce) {
  const p = pending.get(nonce);
  if (!p || p.expires < Date.now() || p.userId !== interaction.user.id) {
    await interaction.update({ content: 'That confirmation expired. Run it again.', embeds: [], components: [] });
    return true;
  }
  pending.delete(nonce);

  if (p.kind === 'leave' || p.kind === 'ban') {
    const guild = client.guilds.cache.get(p.guildId);
    if (p.kind === 'ban') globalConfig.update(s => { s.blacklist.guilds[p.guildId] = { reason: p.reason, at: Date.now(), by: interaction.user.tag }; });
    audit({ action: p.kind === 'ban' ? 'Server blocked' : 'Left a server', actor: interaction.user, guild, details: `${p.guildId}${p.reason ? ` — ${p.reason}` : ''}` });
    let note = '';
    try { await guild?.leave(); } catch (err) { note = ` (could not leave: ${err.message})`; }
    await interaction.update({ content: `${p.kind === 'ban' ? 'Blocked and left' : 'Left'} **${guild?.name || p.guildId}**.${note}`, embeds: [], components: [] });
    return true;
  }

  if (p.kind === 'commands') {
    await interaction.update({ content: 'Clearing and re-registering commands…', embeds: [], components: [] });
    try {
      const r = await runReregister(client, interaction.user);
      await interaction.editReply({ content: `Done. Registered **${r.count}** command(s): ${r.names}\nCleared per-server commands in ${r.cleared} server(s).` });
    } catch (err) {
      log('ERROR', 'Re-registering commands failed', { err });
      await interaction.editReply({ content: `Failed: ${err.message}` });
    }
    return true;
  }

  return false;
}

module.exports = { open, handleComponent, SECTIONS, _pending: pending, _views: { viewHome, viewServers, viewAlerts, viewStatus, viewControl, viewBlocks, viewAudit } };
