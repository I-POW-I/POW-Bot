/**
 * More /owner tools, kept apart from ownerHub.js: a closer look at one server, per-server look and feature locks,
 * usage numbers, a recent-errors list, and export or erase of one server's data.
 *
 * Everything here is bot-owner only (the ids start with `owner:x_`), and every change is written to the owner audit.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
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

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
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

module.exports = { handle, serverTools, usageView, errorsView, exportServer };
