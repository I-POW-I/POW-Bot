const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, InteractionContextType,
} = require('discord.js');
const memberLog    = require('../src/memberLog');
const verification = require('../src/verification');
const { getUserStats, formatMs } = require('../src/database');

const BLUE = 0x5865F2;
const DAY = 86_400_000;
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const n  = (v) => Number(v || 0).toLocaleString('en-GB');

const EVENT_LABELS = {
  join: '🚪 joined', leave: '🏃 left', verify_ok: '✅ verified', approved: '✅ approved by staff',
  verify_fail: '❌ failed the check', verify_blocked: '⏳ needs approval', kicked_unverified: '👢 removed (never verified)',
  kicked_staff: '👢 kicked by staff', raid: '🚨 raid alert',
};

/** All members, fetched safely (big servers use whatever is cached). */
async function loadMembers(guild) {
  if (guild.memberCount <= 5000) { try { return { members: await guild.members.fetch(), partial: false }; } catch { /* fall through */ } }
  return { members: guild.members.cache, partial: true };
}

async function overview(interaction) {
  const { guild } = interaction;
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const { members, partial } = await loadMembers(guild);
  const now = Date.now(), s = verification.settings(guild.id);

  let humans = 0, bots = 0, j24 = 0, j7 = 0, j30 = 0, young = 0, defAvatar = 0, inVoice = 0, timedOut = 0, verified = 0, pending = 0;
  for (const m of members.values()) {
    if (m.user.bot) { bots++; continue; }
    humans++;
    const joined = m.joinedTimestamp || 0;
    if (now - joined < DAY) j24++;
    if (now - joined < 7 * DAY) j7++;
    if (now - joined < 30 * DAY) j30++;
    if (now - m.user.createdTimestamp < 7 * DAY) young++;
    if (!m.user.avatar) defAvatar++;
    if (m.voice?.channelId) inVoice++;
    if (m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > now) timedOut++;
    if (s.roleId) { if (m.roles.cache.has(s.roleId)) verified++; else pending++; }
  }

  const f7 = memberLog.funnel(guild.id, now - 7 * DAY);
  const left24 = memberLog.count(guild.id, 'leave', now - DAY), left7 = f7.left;
  const newest = [...members.values()].filter(m => !m.user.bot).sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0)).slice(0, 5)
    .map(m => `${m} · joined ${ts(m.joinedTimestamp || now)}`).join('\n') || '—';

  const embed = new EmbedBuilder().setColor(BLUE).setTitle(`👥 Members — ${guild.name}`)
    .addFields(
      { name: 'Total',        value: `**${n(guild.memberCount)}**\n${n(humans)} people · ${n(bots)} bots`, inline: true },
      { name: 'Joined',       value: `24h: **${j24}**\n7d: **${j7}**\n30d: **${j30}**`, inline: true },
      { name: 'Left',         value: `24h: **${left24}**\n7d: **${left7}**`, inline: true },
      { name: 'Verification', value: s.roleId ? `Verified: **${n(verified)}**\nNot verified: **${n(pending)}**` : '*Not set up* — `/setup`', inline: true },
      { name: 'Watch list',   value: `Accounts < 7 days: **${young}**\nDefault avatar: **${defAvatar}**\nTimed out: **${timedOut}**`, inline: true },
      { name: 'Right now',    value: `In voice: **${inVoice}**`, inline: true },
      { name: 'Verification funnel (7 days)', value: `Joined **${f7.joined}** → verified **${f7.verified}**${f7.joined ? ` (${Math.round(100 * f7.verified / f7.joined)}%)` : ''}\nFailed **${f7.failed}** · needed approval **${f7.blocked}** · removed **${f7.kicked}** · raid alerts **${f7.raids}**`, inline: false },
      { name: 'Newest members', value: newest, inline: false },
    ).setTimestamp();
  if (partial) embed.setFooter({ text: 'Large server — counts use cached members only' });
  return interaction.editReply({ embeds: [embed] });
}

async function recent(interaction) {
  const count = interaction.options.getInteger('count') ?? 10;
  const rows = memberLog.recent(interaction.guild.id, count);
  const lines = rows.map(r => {
    const who = r.user_id === '0' ? '' : ` <@${r.user_id}>`;
    const extra = r.data?.method ? ` · ${r.data.method}` : r.data?.risk && r.event === 'join' ? ` · risk ${r.data.risk}` : '';
    return `${ts(r.at)} ${EVENT_LABELS[r.event] || r.event}${who}${extra}`;
  });
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('🕒 Recent member activity').setDescription(lines.join('\n') || 'Nothing recorded yet — history starts from the first join after this update.')],
    flags: [MessageFlags.Ephemeral],
  });
}

async function pending(interaction) {
  const { guild } = interaction;
  const s = verification.settings(guild.id);
  if (!s.roleId) return interaction.reply({ content: 'Verification is not set up yet — use `/setup`.', flags: [MessageFlags.Ephemeral] });
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const { members } = await loadMembers(guild);
  const list = [...members.values()].filter(m => !m.user.bot && !m.roles.cache.has(s.roleId))
    .sort((a, b) => (a.joinedTimestamp || 0) - (b.joinedTimestamp || 0));
  const lines = list.slice(0, 20).map(m => {
    const a = verification.assessAccount(m.user, memberLog.priorCounts(guild.id, m.id));
    return `${m} · joined ${ts(m.joinedTimestamp || Date.now())} · account ${verification.ageText(a.ageDays)} · risk **${a.level}**`;
  });
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(list.length ? 0xFAA61A : 0x57F287).setTitle(`⏳ Not verified (${list.length})`)
      .setDescription(lines.join('\n') + (list.length > 20 ? `\n…and ${list.length - 20} more` : '') || 'Everyone is verified. 🎉')],
  });
}

async function lookup(interaction) {
  const { guild } = interaction;
  const user = interaction.options.getUser('user');
  const member = await guild.members.fetch(user.id).catch(() => null);
  const prior = memberLog.priorCounts(guild.id, user.id);
  const a = verification.assessAccount(user, prior);
  const s = verification.settings(guild.id);
  const stats = getUserStats(user.id, guild.id);
  const hist = memberLog.history(guild.id, user.id, 8).map(r => `${ts(r.at)} ${EVENT_LABELS[r.event] || r.event}${r.data?.method ? ` · ${r.data.method}` : ''}`).join('\n') || 'No history recorded';

  const embed = new EmbedBuilder().setColor(member ? 0x5865F2 : 0x99AAB5).setTitle(`🔎 ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Account',   value: `Created ${ts(user.createdTimestamp, 'F')}\n**${verification.ageText(a.ageDays)}** old · ID \`${user.id}\``, inline: true },
      { name: 'In server', value: member ? `Joined ${ts(member.joinedTimestamp)}\nRoles: **${member.roles.cache.size - 1}**` : 'Not in this server', inline: true },
      { name: 'Verification', value: !s.roleId ? 'Not set up' : member ? (member.roles.cache.has(s.roleId) ? '✅ Verified' : '⏳ Not verified') : '—', inline: true },
      { name: `Risk: ${a.level}`, value: a.flags.length ? a.flags.map(f => `• ${f}`).join('\n') : 'No flags', inline: false },
      { name: 'Voice', value: stats.session_count ? `**${formatMs(stats.total_ms)}** in ${n(stats.session_count)} sessions · streak **${stats.streak}** day(s)` : 'No voice activity recorded', inline: false },
      { name: 'History', value: hist, inline: false },
    ).setTimestamp();
  return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('members')
    .setDescription('See who is in the server and what is happening')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(sub => sub.setName('overview').setDescription('Counts, joins, leaves, verification funnel and watch list'))
    .addSubcommand(sub => sub.setName('recent').setDescription('Latest joins, leaves and verification results')
      .addIntegerOption(o => o.setName('count').setDescription('How many entries (default 10)').setMinValue(1).setMaxValue(25)))
    .addSubcommand(sub => sub.setName('pending').setDescription('Members who have not verified yet'))
    .addSubcommand(sub => sub.setName('lookup').setDescription('Full picture of one member')
      .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true))),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** to use this.', flags: [MessageFlags.Ephemeral] });
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'overview') return overview(interaction);
    if (sub === 'recent')   return recent(interaction);
    if (sub === 'pending')  return pending(interaction);
    if (sub === 'lookup')   return lookup(interaction);
  },
};
