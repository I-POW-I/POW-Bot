/**
 * More /owner tools, kept apart from ownerHub.js: a closer look at one server, per-server look and feature locks,
 * usage numbers, a recent-errors list, and export or erase of one server's data.
 *
 * Everything here is bot-owner only (the ids start with `owner:x_`), and every change is written to the owner audit.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const globalConfig = require('./globalConfig');
const { getGuildConfig, deleteGuildConfig } = require('./guildConfig');
const { selectAll, selectOne } = require('./database');
const { log } = require('./logger');
const { audit } = require('./diagnostics');

const BLUE = 0x5865F2, RED = 0xED4245, GREEN = 0x57F287;
const FEATURES = [
  ['streamerAlerts', 'Streamer alerts'], ['gameAlerts', 'Game alerts'], ['autoMod', 'AutoMod'], ['raidProtection', 'Raid protection'], ['checkpoint', 'Security Check Point'],
];
const LOOKS = [null, 'auto', 'card', 'embed'];
const LOOK_TEXT = { auto: 'Smart (cards, embeds when too long)', card: 'Always cards', embed: 'Always classic embeds' };
const ephemeral = 64;

// How long the bot goes without being able to answer (event loop delay). Long gaps are what turn into "Unknown interaction".
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const n = (v) => Number(v || 0).toLocaleString('en-GB');
const ts = (t, f = 'R') => `<t:${Math.floor(t / 1000)}:${f}>`;

// ── One server, closely ────────────────────────────────────────────────────────

function serverTools(guild, note) {
  const g = getGuildConfig(guild.id), cfg = globalConfig.get();
  const look = cfg.uiOverrides?.[guild.id] || null, locks = cfg.serverLocks?.[guild.id] || [];
  const logs = Object.entries(g.logChannels || {}).filter(([, v]) => v).map(([k, v]) => `${k} <#${v}>`);
  const count = (table) => Number(selectOne(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`, [guild.id])?.n || 0);
  const lastVoice = selectOne('SELECT MAX(joined_at) AS t FROM vc_sessions WHERE guild_id = ?', [guild.id])?.t;
  const sizeKb = Math.round(JSON.stringify(g).length / 1024 * 10) / 10;

  const embed = new EmbedBuilder().setColor(locks.length || look ? 0xFEE75C : BLUE).setTitle(`${guild.name}: server tools`)
    .setDescription(note || 'What this server has set up, and the owner-only controls for it.')
    .addFields(
      { name: 'Look', value: look ? `**Forced:** ${LOOK_TEXT[look]}` : `Server's own choice (${LOOK_TEXT[require('./ui/style').settings(guild.id).all || 'auto']})`, inline: true },
      { name: 'Locked off here', value: locks.length ? locks.map(k => FEATURES.find(f => f[0] === k)?.[1] || k).join('\n') : 'Nothing', inline: true },
      { name: 'Settings size', value: `${sizeKb} KB`, inline: true },
      { name: 'Logs', value: logs.join('\n') || 'No log channels set', inline: false },
      { name: 'Stored here', value: [`${count('vc_sessions')} voice sessions`, `${count('mod_cases')} moderation cases`, `${count('streamer_subscriptions')} streamer alerts`, `${count('game_subscriptions')} game alerts`, `${count('activity')} activity rows`].join('\n'), inline: true },
      { name: 'Last voice activity', value: lastVoice ? ts(lastVoice) : 'None yet', inline: true },
      { name: 'Panel', value: g.panelMessageId ? `posted in <#${g.panelChannelId}>` : 'not posted', inline: true },
    );
  const lockMenu = new StringSelectMenuBuilder().setCustomId(`owner:x_lock:${guild.id}`).setPlaceholder('Lock features off for this server…').setMinValues(0).setMaxValues(FEATURES.length)
    .addOptions(FEATURES.map(([k, label]) => ({ label, value: k, default: locks.includes(k), description: locks.includes(k) ? 'Locked off here' : 'Allowed' })));
  return { embeds: [embed], components: [
    row(lockMenu),
    row(btn(`owner:x_look:${guild.id}`, `Look: ${look ? { auto: 'Smart', card: 'Cards', embed: 'Embeds' }[look] : 'server choice'}`, ButtonStyle.Primary),
      btn(`owner:x_export:${guild.id}`, 'Export data'), btn(`owner:x_erase:${guild.id}`, 'Erase data…', ButtonStyle.Danger), btn('owner:to:servers', 'Back to servers')),
  ] };
}

/** Everything saved for one server, as one JSON file (webhook and token fields are blanked). */
function exportServer(guild) {
  const { GUILD_TABLES } = require('./retention');
  const redact = (k, v) => (/token|secret|webhook|password/i.test(k) ? '[hidden]' : v);
  const data = { exportedAt: new Date().toISOString(), server: { id: guild.id, name: guild.name }, settings: getGuildConfig(guild.id), tables: {} };
  for (const t of GUILD_TABLES) data.tables[t] = selectAll(`SELECT * FROM ${t} WHERE guild_id = ? LIMIT 10000`, [guild.id]);
  return Buffer.from(JSON.stringify(data, redact, 2));
}

// ── Owner tools: stat check, health, Game Updates Hub ─────────────────────────

const days = (v) => `${v} ${v === 1 ? 'day' : 'days'}`;
const dayName = (n) => new Date(n * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function toolsView(note) {
  return { embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Owner tools').setDescription([note,
    '**Stat check**: look at how one member\'s voice days and streaks add up, to check a number.',
    '**Health**: how responsive the bot is, memory and the database.',
    '**Game Updates Hub**: whether the hub server is connected and which games have a channel.'].filter(Boolean).join('\n'))],
  components: [row(btn('owner:x_stat', 'Stat check', ButtonStyle.Primary), btn('owner:x_health', 'Health'), btn('owner:x_hub', 'Game Updates Hub'), btn('owner:x_cmds', 'Switch commands off')),
    row(btn('owner:x_save', 'Save data now'), btn('owner:home', 'Back'))] };
}

/** Commands the owner can switch off for everyone (the owner and bot admins can still use them). /owner and /setup can never be switched off. */
const KEEP_ON = ['owner', 'setup', 'help'];
function commandsView(client, note) {
  const off = globalConfig.get().disabledCommands || [];
  const names = [...client.commands.keys()].filter(n => !KEEP_ON.includes(n)).sort().slice(0, 25);
  const embed = new EmbedBuilder().setColor(off.length ? 0xFEE75C : BLUE).setTitle('Switch commands off').setDescription([note,
    'A command you switch off answers "switched off for now" for everyone except you and bot admins. Use it if something is misbehaving and you want it quiet while you fix it.',
    '', off.length ? `**Off now:** ${off.map(n => `\`/${n}\``).join(' ')}` : '**Off now:** nothing'].filter(Boolean).join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId('owner:x_cmdset').setPlaceholder('Choose the commands to switch off…').setMinValues(0).setMaxValues(Math.max(1, names.length))
    .addOptions(names.map(n => ({ label: `/${n}`, value: n, default: off.includes(n) })));
  return { embeds: [embed], components: [row(menu), row(btn('owner:x_tools', 'Back'))] };
}

const statModal = (guildId) => new ModalBuilder().setCustomId('owner:x_statgo').setTitle('Stat check').addComponents(
  row(new TextInputBuilder().setCustomId('guild').setLabel('Server ID').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(guildId || '')).setMaxLength(25)),
  row(new TextInputBuilder().setCustomId('user').setLabel('Member ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25)));

function statCheckView(guildId, userId) {
  const db = require('./database');
  const info = db.streakInfo(userId, guildId);
  const one = (sql) => db.selectOne(sql, [userId, guildId]) || {};
  const real = one('SELECT COUNT(*) AS n, MIN(joined_at) AS first, MAX(joined_at) AS last, COALESCE(SUM(duration_ms), 0) AS ms FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND COALESCE(summary, 0) = 0 AND duration_ms IS NOT NULL');
  const summaries = one('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND summary = 1');
  const open = one('SELECT COUNT(*) AS n FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND left_at IS NULL');
  const streams = one('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM stream_sessions WHERE user_id = ? AND guild_id = ? AND duration_ms IS NOT NULL');
  const dur = require('./duration').duration;
  const resets = getGuildConfig(guildId).leaderboard?.yearlyReset;
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Stat check').setDescription(`<@${userId}> in server \`${guildId}\``)
    .addFields(
      { name: 'Sessions', value: `${n(real.n)} recorded\n${dur(Number(real.ms))} in total`, inline: true },
      { name: 'First and last', value: real.n ? `${dayName(Math.floor(real.first / 86_400_000))}\n${dayName(Math.floor(real.last / 86_400_000))}` : 'None', inline: true },
      { name: 'Days in voice', value: n(info.daysActive), inline: true },
      { name: 'Current streak', value: days(info.current), inline: true },
      { name: 'Longest streak', value: info.longest ? `${days(info.longest)}\n${dayName(info.from)} to ${dayName(info.to)}` : 'None', inline: true },
      { name: 'Streaming', value: `${n(streams.n)} ${streams.n === 1 ? 'stream' : 'streams'}\n${dur(Number(streams.ms))}`, inline: true },
      ...(summaries.n || open.n > 1 ? [{ name: 'Not counted for streaks', value: [summaries.n ? `${n(summaries.n)} imported ${summaries.n === 1 ? 'total' : 'totals'} (${dur(Number(summaries.ms))}) with no dates: they add time but no days` : null, open.n > 1 ? `${n(open.n)} unfinished sessions (only the current one counts)` : null].filter(Boolean).join('\n') || 'Nothing', inline: false }] : []),
      ...(resets ? [{ name: 'Yearly reset is on', value: 'Days before 1 January were deleted, so streaks start again each year.', inline: false }] : []),
    );
  return { embeds: [embed], components: [row(btn('owner:x_stat', 'Check someone else'), btn('owner:x_tools', 'Back'))] };
}

function healthView() {
  const mean = lag.mean / 1e6, p99 = lag.percentile(99) / 1e6, max = lag.max / 1e6;
  lag.reset();
  const bad = max > 1000 ? 'Long freezes detected, which cause "Unknown interaction" errors' : p99 > 200 ? 'Some slow moments' : 'Responsive';
  let dbSize = 'n/a'; try { dbSize = `${(fs.statSync(require('./database').DB_PATH).size / 1048576).toFixed(1)} MB`; } catch { /* no file yet */ }
  const c = require('./diagnostics').getCounters();
  const embed = new EmbedBuilder().setColor(max > 1000 ? RED : p99 > 200 ? 0xFEE75C : GREEN).setTitle('Health')
    .setDescription(`${bad}\n-# Measured since the last time this was opened (or the last restart).`)
    .addFields(
      { name: 'Typical delay', value: `${mean.toFixed(0)} ms`, inline: true },
      { name: 'Worst 1%', value: `${p99.toFixed(0)} ms`, inline: true },
      { name: 'Longest freeze', value: `${max.toFixed(0)} ms`, inline: true },
      { name: 'Memory', value: require('./system').formatMemory(), inline: true },
      { name: 'Database', value: dbSize, inline: true },
      { name: 'Discord ping', value: `${require('./client').ws?.ping ?? '?'} ms`, inline: true },
      { name: 'Since restart', value: `${c.commands} commands · ${c.errors} errors · ${c.warnings} warnings`, inline: false },
    );
  return { embeds: [embed], components: [row(btn('owner:x_health', 'Measure again', ButtonStyle.Primary), btn('owner:x_tools', 'Back'))] };
}

function hubView(client) {
  const hub = require('./gameHub'), st = hub.status();
  const guild = st.guildId && client.guilds.cache.get(st.guildId);
  const embed = new EmbedBuilder().setColor(st.enabled && guild ? GREEN : st.enabled ? RED : BLUE).setTitle('Game Updates Hub')
    .setDescription(!st.enabled ? 'Not set up. Add `GAME_UPDATES_HUB_GUILD_ID` (the ID of your own server) to the bot\'s variables, give the bot Manage Channels there, then restart.'
      : !guild ? 'The ID is set, but the bot is not in that server.' : `Connected to **${guild.name}**. Every new game update is copied there, one channel per game.`)
    .addFields({ name: 'Games with a channel', value: String(st.channels), inline: true }, { name: 'Server', value: guild ? guild.name : 'not found', inline: true });
  return { embeds: [embed], components: [row(btn('owner:x_tools', 'Back'))] };
}

// ── Usage and errors ───────────────────────────────────────────────────────────

function usageView() {
  const u = require('./usageStats').summary(30), d = require('./diagnostics');
  const bars = '▁▂▃▄▅▆▇█', max = Math.max(1, ...u.perDay.map(x => x.uses));
  const spark = u.perDay.map(x => bars[Math.min(7, Math.round(x.uses / max * 7))]).join('');
  const week = u.perDay.slice(-7).reduce((a, x) => ({ uses: a.uses + x.uses, errors: a.errors + x.errors }), { uses: 0, errors: 0 });
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('Usage, last 30 days')
    .setDescription(`\`${spark}\`\n-# Oldest on the left, today on the right`)
    .addFields(
      { name: 'Commands', value: String(u.total.commands), inline: true },
      { name: 'Button and menu uses', value: String(u.total.buttons), inline: true },
      { name: 'Errors', value: String(u.total.errors), inline: true },
      { name: 'Last 7 days', value: `${week.uses} uses · ${week.errors} errors`, inline: false },
      { name: 'Most used commands', value: u.top.length ? u.top.map(([n, v], i) => `${i + 1}. \`/${n}\` · ${v}`).join('\n') : 'None yet', inline: false },
      { name: 'Since the last restart', value: (() => { const c = d.getCounters(); return `${c.commands} commands · ${c.buttons} buttons · ${c.errors} errors · ${c.warnings} warnings`; })(), inline: false },
    );
  return { embeds: [embed], components: [row(btn('owner:x_errors', 'Recent errors', ButtonStyle.Primary), btn('owner:x_stats', 'Refresh'), btn('owner:home', 'Back'))] };
}

function errorsView() {
  const list = require('./diagnostics').getRecentErrors();
  const embed = new EmbedBuilder().setColor(list.length ? RED : GREEN).setTitle('Recent errors')
    .setDescription(list.length ? list.slice(0, 12).map(e => `${ts(e.at)} ${String(e.text).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') : 'No errors since the last restart.')
    .setFooter({ text: 'The last 25 are kept in memory and cleared on restart. The full detail is in the console logs.' });
  return { embeds: [embed], components: [row(btn('owner:x_stats', 'Back to usage'), btn('owner:op_logs', 'Console logs'), btn('owner:home', 'Home'))] };
}

// ── Routing ────────────────────────────────────────────────────────────────────

async function handle(interaction, client) {
  const parts = interaction.customId.split(':'), action = parts[1], gid = parts[2];
  const by = interaction.user;
  const guild = gid ? (client || interaction.client).guilds.cache.get(gid) : null;
  const needsGuild = ['x_srv', 'x_lock', 'x_look', 'x_export', 'x_erase', 'x_erase_yes'].includes(action);
  if (needsGuild && !guild) { await interaction.reply({ content: 'I am not in that server any more.', flags: ephemeral }); return true; }

  switch (action) {
    case 'x_srv': await interaction.update(serverTools(guild)); return true;
    case 'x_tools': await interaction.update(toolsView()); return true;
    case 'x_stat': await interaction.showModal(statModal(interaction.guildId)); return true;
    case 'x_statgo': {
      const g = interaction.fields.getTextInputValue('guild').trim(), u = interaction.fields.getTextInputValue('user').trim();
      if (!/^\d{15,25}$/.test(g) || !/^\d{15,25}$/.test(u)) { await interaction.update(toolsView('Those need to be the numeric IDs.')); return true; }
      await interaction.update(statCheckView(g, u)); return true;
    }
    case 'x_cmds': await interaction.update(commandsView(client || interaction.client)); return true;
    case 'x_cmdset': {
      const c = client || interaction.client, chosen = interaction.values.filter(v => c.commands.has(v) && !KEEP_ON.includes(v));
      globalConfig.update(s => { s.disabledCommands = chosen; });
      audit({ action: 'Owner: commands switched off', actor: by, details: chosen.join(', ') || 'none' });
      await interaction.update(commandsView(c, chosen.length ? 'Saved.' : 'Everything is switched on again.')); return true;
    }
    case 'x_save': {
      require('./database').flush();
      audit({ action: 'Owner: data saved now', actor: by });
      await interaction.update(toolsView('Everything is written to disk.')); return true;
    }
    case 'x_health': await interaction.update(healthView()); return true;
    case 'x_hub': await interaction.update(hubView(client || interaction.client)); return true;
    case 'x_stats': await interaction.update(usageView()); return true;
    case 'x_errors': await interaction.update(errorsView()); return true;
    case 'x_look': {
      const cur = globalConfig.get().uiOverrides?.[guild.id] || null, next = LOOKS[(LOOKS.indexOf(cur) + 1) % LOOKS.length];
      globalConfig.update(s => { s.uiOverrides = s.uiOverrides || {}; if (next) s.uiOverrides[guild.id] = next; else delete s.uiOverrides[guild.id]; });
      audit({ action: 'Owner: server look', actor: by, details: `${guild.name}: ${next || 'server choice'}` });
      await interaction.update(serverTools(guild, next ? `Look forced to **${LOOK_TEXT[next]}** for this server.` : 'This server chooses its own look again.')); return true;
    }
    case 'x_lock': {
      const chosen = interaction.values.filter(v => FEATURES.some(f => f[0] === v));
      globalConfig.update(s => { s.serverLocks = s.serverLocks || {}; if (chosen.length) s.serverLocks[guild.id] = chosen; else delete s.serverLocks[guild.id]; });
      audit({ action: 'Owner: server locks', actor: by, details: `${guild.name}: ${chosen.join(', ') || 'none'}` });
      await interaction.update(serverTools(guild, chosen.length ? 'Saved. Those features are off for this server only.' : 'Nothing is locked for this server.')); return true;
    }
    case 'x_export': {
      await interaction.deferReply({ flags: ephemeral });
      await interaction.editReply({ content: `Everything saved for **${guild.name}**.`, files: [new AttachmentBuilder(exportServer(guild), { name: `${guild.name.replace(/[^\w-]+/g, '_')}-data.json` })] });
      audit({ action: 'Owner: exported server data', actor: by, details: guild.name }); return true;
    }
    case 'x_erase': {
      await interaction.reply({ flags: ephemeral, embeds: [new EmbedBuilder().setColor(RED).setTitle(`Erase everything saved for ${guild.name}?`)
        .setDescription('This deletes the server\'s settings and every voice session, case, alert, activity row and stored message for it. The bot stays in the server, and this cannot be undone. Export first if you may need it.')],
      components: [row(btn(`owner:x_erase_yes:${guild.id}`, 'Erase it all', ButtonStyle.Danger), btn(`owner:x_srv:${guild.id}`, 'Cancel'))] }); return true;
    }
    case 'x_erase_yes': {
      require('./retention').purgeGuild(guild.id); deleteGuildConfig(guild.id);
      globalConfig.update(s => { delete s.serverLocks?.[guild.id]; delete s.uiOverrides?.[guild.id]; });
      audit({ action: 'Owner: erased server data', actor: by, details: guild.name }); log('AUDIT', 'Server data erased by the owner', { guild: guild.name });
      await interaction.update({ embeds: [new EmbedBuilder().setColor(GREEN).setTitle('Erased').setDescription(`Everything saved for **${guild.name}** is gone.`)], components: [] }); return true;
    }
    default: return false;
  }
}

module.exports = { commandsView, toolsView, statCheckView, healthView, hubView, handle, serverTools, usageView, errorsView, exportServer };
