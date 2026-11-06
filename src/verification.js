/**
 * Verification + member log.
 *
 * What a new member goes through (all optional, configured in /setup → Verification):
 *   1. Joins → gets the "unverified" role (if set), a prompt is posted in the verify channel
 *      and/or sent by DM, and staff see a detailed join log.
 *   2. Clicks "Verify now" →  button mode: verified immediately
 *                             human-check mode: types the code shown in a generated image
 *      An optional minimum account age sends very new accounts to staff for approval.
 *   3. Gets the verified role, loses the unverified role, staff see a "verified" log.
 *   4. Optional: members who never verify are removed after N minutes.
 *
 * Privacy: only information Discord itself gives the bot is used — account age, public
 * badges, avatar, join/leave times and the verification outcome. No emails, no IP
 * addresses, no locations are collected or logged.
 *
 * Staff logs go to the server's "Member Join/Leave" log channel (/setup → Logs).
 * Every event is also written to the console, and (if VERIFY_OWNER_FEED=true) mirrored to
 * the bot owner's private alerts.
 */

const crypto = require('crypto');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');

const { getGuildConfig, setGuildConfig, getLogChannel } = require('./guildConfig');
const memberLog = require('./memberLog');
const { log }   = require('./logger');
const alerts    = require('./errorAlerts');

const ACCENT = 0x2F6FD6;
const COLOURS = { High: 0xED4245, Medium: 0xFAA61A, Low: 0x57F287 };
const CAPTCHA_TTL_MS   = 5 * 60_000;
const LOCKOUT_MS       = 10 * 60_000;
const MAX_ATTEMPTS     = 3;
const SWEEP_EVERY_MS   = 2 * 60_000;
const MAX_KICKS_SWEEP  = 5;

const ts  = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const ephemeral = [MessageFlags.Ephemeral];

// ── Settings ──────────────────────────────────────────────────────────────────

function settings(guildId) {
  const c = getGuildConfig(guildId);
  return {
    roleId:           c.verifyRoleId || null,
    unverifiedRoleId: c.unverifiedRoleId || null,
    mode:             c.verifyMode === 'captcha' ? 'captcha' : 'button',   // existing servers keep the one-click button
    minAgeDays:       Number(c.verifyMinAccountDays) || 0,
    kickMinutes:      Number(c.verifyKickMinutes) || 0,
    dmOnJoin:         !!c.verifyDmOnJoin,
    raidThreshold:    Number(c.raidThreshold) || 8,
    enabledAt:        Number(c.verifyEnabledAt) || 0,
    channelId:        c.verifyChannelId || null,
    messageId:        c.verifyMessageId || null,
  };
}

const isConfigured = (s) => !!s.roleId;

// ── Account assessment (Discord-provided data only) ───────────────────────────

function badgeNames(user) {
  try {
    const list = user.flags?.toArray?.() || [];
    return list.map(f => f.replace(/([a-z])([A-Z0-9])/g, '$1 $2'));
  } catch { return []; }
}

/** Risk flags for a new account. Level: Low / Medium / High. */
function assessAccount(user, prior = { leaves: 0 }) {
  const ageMs   = Date.now() - user.createdTimestamp;
  const ageDays = Math.floor(ageMs / 86_400_000);
  const flags = [];
  let score = 0;

  if (ageMs < 86_400_000)      { flags.push('Account is less than 24 hours old'); score += 3; }
  else if (ageDays < 7)        { flags.push(`Account is only ${ageDays} day(s) old`); score += 2; }
  else if (ageDays < 30)       { flags.push(`Account is under 30 days old (${ageDays}d)`); score += 1; }

  if (!user.avatar)            { flags.push('Default avatar'); score += 1; }
  if (/discord\.gg|discord(?:app)?\.com\/invite|https?:\/\//i.test(`${user.username} ${user.globalName || ''}`)) { flags.push('Link or invite in username'); score += 2; }
  else if (/\d{6,}$/.test(user.username)) { flags.push('Username ends in a long number'); score += 1; }
  if (prior.leaves > 0)        { flags.push(`Rejoining (left ${prior.leaves}× before)`); score += prior.leaves >= 2 ? 2 : 1; }
  if (user.bot)                  flags.push('Bot account');

  return { ageMs, ageDays, flags, score, level: score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low' };
}

function ageText(days) {
  if (days < 1) return 'under a day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const m = Math.floor(days / 30.4);
  return m < 24 ? `${m} months` : `${(days / 365).toFixed(1)} years`;
}

// ── Staff / owner logging ─────────────────────────────────────────────────────

async function postStaffLog(guild, payload) {
  const channelId = getLogChannel(guild.id, 'members');
  if (!channelId) return null;
  try {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    return await channel.send(payload);
  } catch (err) {
    log('WARN', 'Could not post to the verification log channel', { guild: guild.name, err });
    return null;
  }
}

/** Mirror to the bot owner's private alerts when VERIFY_OWNER_FEED=true. */
function ownerFeed(title, fields, level = 'AUDIT') {
  if (String(process.env.VERIFY_OWNER_FEED || '').toLowerCase() !== 'true') return;
  alerts.notify({ level, title, fields });
}

function buildJoinLog(member, a, prior, s) {
  const { user, guild } = member;
  const badges = badgeNames(user);
  const waiting = isConfigured(s) && !user.bot;
  const embed = new EmbedBuilder()
    .setColor(user.bot ? 0x5865F2 : COLOURS[a.level])
    .setTitle(user.bot ? '🤖 Bot added' : '🌟 New member')
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '👥 User',    value: `${member}\n**${user.tag}**\nID: \`${user.id}\``, inline: true },
      { name: '🗓️ Account', value: `Created ${ts(user.createdTimestamp, 'F')}\n${ts(user.createdTimestamp)} · **${ageText(a.ageDays)}** old\nAvatar: ${user.avatar ? 'custom' : 'default'}\nBadges: ${badges.length ? badges.join(', ') : 'none'}`, inline: true },
      { name: '🚪 Join',    value: `Member **#${guild.memberCount}**\nJoins here: **${prior.joins + 1}**${prior.leaves ? ` · left **${prior.leaves}×**` : ''}${prior.lastLeft ? `\nLast left ${ts(prior.lastLeft)}` : ''}`, inline: true },
      { name: `⚠️ Risk: ${a.level}`, value: a.flags.length ? a.flags.map(f => `• ${f}`).join('\n') : 'No risk flags found', inline: false },
      { name: '🔐 Verification', value: !waiting ? (user.bot ? 'Not required for bots' : 'Not set up for this server') : `Pending — ${s.mode === 'captcha' ? 'human check' : 'button'}${s.minAgeDays && a.ageDays < s.minAgeDays ? ` · **account under ${s.minAgeDays} day(s): staff approval needed**` : ''}`, inline: false },
    )
    .setFooter({ text: `${guild.name} · Verification log` })
    .setTimestamp();
  return embed;
}

function staffButtons(guildId, userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verify:approve:${guildId}:${userId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`verify:kick:${guildId}:${userId}`).setLabel('Kick').setEmoji('👢').setStyle(ButtonStyle.Danger),
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────

/** Add or remove a role with every safety check; never throws. */
async function changeRole(member, roleId, add, reason) {
  const guild = member.guild;
  const me = guild.members.me;
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { ok: false, error: 'The role no longer exists — an admin needs to pick it again in /setup.' };
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return { ok: false, error: 'I need the **Manage Roles** permission.' };
  if (!role.editable) return { ok: false, error: `I can't manage **${role.name}** — move my role above it in Server Settings → Roles.` };
  try {
    if (add) await member.roles.add(role, reason); else await member.roles.remove(role, reason);
    return { ok: true, role };
  } catch (err) {
    log('ERROR', `Could not ${add ? 'give' : 'remove'} a verification role`, { guild: guild.name, user: member.user.tag, role: role.name, err });
    return { ok: false, error: 'Discord refused the role change. An admin has been notified.' };
  }
}

// ── Prompt message (channel post and DM) ──────────────────────────────────────

function buildPrompt(guild) {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('🤖 Verification required')
    .setDescription(`To gain access to **${guild.name}** you need to prove you are a human by completing verification. Click the button below to get started!`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verify:start:${guild.id}`).setLabel('Verify now').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`verify:why:${guild.id}`).setLabel('Why?').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** Post (or replace) the verification message in a channel and remember it. */
async function postPrompt(channel) {
  const guild = channel.guild;
  const old = settings(guild.id);
  if (old.channelId && old.messageId) {
    try { const ch = await guild.channels.fetch(old.channelId); const m = await ch?.messages.fetch(old.messageId); await m?.delete(); } catch { /* already gone */ }
  }
  const msg = await channel.send(buildPrompt(guild));
  setGuildConfig(guild.id, { verifyChannelId: channel.id, verifyMessageId: msg.id });
  return msg;
}

// ── Human check image ─────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L lookalikes
const rand = (min, max) => min + (crypto.randomInt(1_000_000) / 1_000_000) * (max - min);

function makeCaptcha() {
  const code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  const W = 280, H = 96;
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < 70; i++) { ctx.fillStyle = `rgba(${rand(80, 200)},${rand(80, 200)},${rand(80, 200)},0.35)`; ctx.fillRect(rand(0, W), rand(0, H), 2, 2); }
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = `rgba(${rand(90, 220)},${rand(90, 220)},${rand(90, 220)},0.45)`; ctx.lineWidth = rand(1, 2.5);
    ctx.beginPath(); ctx.moveTo(rand(0, W), rand(0, H)); ctx.bezierCurveTo(rand(0, W), rand(0, H), rand(0, W), rand(0, H), rand(0, W), rand(0, H)); ctx.stroke();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [...code].forEach((ch, i) => {
    ctx.save();
    ctx.translate(38 + i * 48, H / 2 + rand(-8, 8));
    ctx.rotate(rand(-0.4, 0.4));
    ctx.font = `bold ${Math.round(rand(40, 50))}px sans-serif`;
    ctx.fillStyle = `rgb(${rand(170, 255)},${rand(170, 255)},${rand(170, 255)})`;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = `rgba(255,255,255,0.35)`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, rand(15, H - 15)); ctx.bezierCurveTo(W / 3, rand(0, H), (2 * W) / 3, rand(0, H), W, rand(15, H - 15)); ctx.stroke();
  }
  return { code, buffer: canvas.toBuffer('image/png') };
}

// key `${guildId}:${userId}` → { code, nonce, expires, attempts, startedAt }
const sessions = new Map();
const lockouts = new Map();      // key → until
const sKey = (g, u) => `${g}:${u}`;

function sweepSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  for (const [k, t] of lockouts) if (t < now) lockouts.delete(k);
}

function captchaMessage(guildId, session, note) {
  const file = new AttachmentBuilder(session.image, { name: 'captcha.png' });
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('🔐 Human check')
    .setDescription([note, 'Type the **5 characters** shown in the picture. It is not case-sensitive.'].filter(Boolean).join('\n\n'))
    .setImage('attachment://captcha.png')
    .setFooter({ text: `Attempt ${session.attempts + 1} of ${MAX_ATTEMPTS} · expires in 5 minutes` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verify:enter:${guildId}:${session.nonce}`).setLabel('Enter code').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`verify:start:${guildId}`).setLabel('New picture').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], files: [file], flags: ephemeral };
}

function newSession(guildId, userId, previous) {
  sweepSessions();
  const { code, buffer } = makeCaptcha();
  const session = { code, image: buffer, nonce: crypto.randomBytes(4).toString('hex'), expires: Date.now() + CAPTCHA_TTL_MS, attempts: previous?.attempts || 0, startedAt: previous?.startedAt || Date.now() };
  sessions.set(sKey(guildId, userId), session);
  return session;
}

// ── Completing a verification ─────────────────────────────────────────────────

async function complete({ guild, member, method, attempts = 0, startedAt = Date.now(), by = null }) {
  const s = settings(guild.id);
  const given = await changeRole(member, s.roleId, true, `Verified (${method})`);
  if (!given.ok) return given;
  if (s.unverifiedRoleId) await changeRole(member, s.unverifiedRoleId, false, 'Verified');

  const tookMs = Date.now() - startedAt;
  const staff = method === 'staff approval';
  memberLog.record(guild.id, member.id, staff ? 'approved' : 'verify_ok', { method, attempts, tookMs, by });
  sessions.delete(sKey(guild.id, member.id));

  const a = assessAccount(member.user, memberLog.priorCounts(guild.id, member.id));
  log('INFO', 'Member verified', { guild: guild.name, user: member.user.tag, method, attempts, took: `${Math.round(tookMs / 1000)}s`, risk: a.level });

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Member verified')
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '👥 User',   value: `${member}\n**${member.user.tag}**\nID: \`${member.id}\``, inline: true },
      { name: '🔐 Method', value: `${method}${by ? `\nApproved by ${by}` : ''}\nAttempts: **${attempts || 1}**\nTook: **${Math.max(1, Math.round(tookMs / 1000))}s**`, inline: true },
      { name: '🏷️ Roles',  value: `+ ${given.role.name}${s.unverifiedRoleId ? '\n− unverified' : ''}`, inline: true },
      { name: `⚠️ Risk: ${a.level}`, value: a.flags.length ? a.flags.map(f => `• ${f}`).join('\n') : 'No risk flags', inline: false },
    )
    .setFooter({ text: `${guild.name} · Verification log` }).setTimestamp();
  await postStaffLog(guild, { embeds: [embed] });
  ownerFeed(`Member verified — ${guild.name}`, [
    { name: 'User', value: member.user.tag }, { name: 'Method', value: method }, { name: 'Account age', value: ageText(a.ageDays) }, { name: 'Risk', value: a.level },
  ]);
  return { ok: true };
}

// ── Member events (called from guildMemberAdd / guildMemberRemove) ────────────

const joinsByGuild = new Map();
const raidAlerted  = new Map();

async function checkRaid(guild, s) {
  const now = Date.now();
  const recent = (joinsByGuild.get(guild.id) || []).filter(t => now - t < 60_000);
  recent.push(now);
  joinsByGuild.set(guild.id, recent);
  if (recent.length < s.raidThreshold || now - (raidAlerted.get(guild.id) || 0) < 10 * 60_000) return;

  raidAlerted.set(guild.id, now);
  memberLog.record(guild.id, '0', 'raid', { joins: recent.length });
  log('WARN', 'Possible raid: many joins in one minute', { guild: guild.name, joins: recent.length });
  await postStaffLog(guild, { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🚨 Possible raid').setDescription(`**${recent.length}** members joined in the last minute (alert threshold: ${s.raidThreshold}). Consider turning on a higher Discord verification level or pausing invites.`).setTimestamp()] });
  ownerFeed(`Possible raid — ${guild.name}`, [{ name: 'Joins in 60s', value: String(recent.length) }], 'WARN');
}

async function onMemberJoin(member) {
  const { guild, user } = member;
  const s = settings(guild.id);
  const prior = memberLog.priorCounts(guild.id, user.id);
  const a = assessAccount(user, prior);

  memberLog.record(guild.id, user.id, 'join', { ageDays: a.ageDays, risk: a.level, flags: a.flags, bot: user.bot });
  log('INFO', user.bot ? 'Bot added' : 'Member joined', { guild: guild.name, user: user.tag, age: ageText(a.ageDays), risk: a.level, members: guild.memberCount });
  if (!user.bot) await checkRaid(guild, s);

  if (isConfigured(s) && !user.bot) {
    if (s.unverifiedRoleId) await changeRole(member, s.unverifiedRoleId, true, 'Awaiting verification');
    if (s.dmOnJoin) { try { await member.send(buildPrompt(guild)); } catch { /* DMs closed */ } }
  }

  const payload = { embeds: [buildJoinLog(member, a, prior, s)] };
  if (isConfigured(s) && !user.bot) payload.components = [staffButtons(guild.id, user.id)];
  await postStaffLog(guild, payload);

  if (a.level === 'High' && !user.bot) {
    ownerFeed(`High-risk join — ${guild.name}`, [{ name: 'User', value: user.tag }, { name: 'Account age', value: ageText(a.ageDays) }, { name: 'Flags', value: a.flags.join('\n') }]);
  }
}

function onMemberLeave(member) {
  const pending = isConfigured(settings(member.guild.id)) && !member.user?.bot && member.roles?.cache && !member.roles.cache.has(settings(member.guild.id).roleId);
  memberLog.record(member.guild.id, member.id, 'leave', { unverified: !!pending, bot: !!member.user?.bot });
}

// ── Interactions ──────────────────────────────────────────────────────────────

async function resolveTarget(interaction, client, guildId) {
  const guild = interaction.guild || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return {};
  const member = interaction.member?.guild?.id === guild.id ? interaction.member : await guild.members.fetch(interaction.user.id).catch(() => null);
  return { guild, member };
}

const say = (interaction, content) => interaction.reply({ content, flags: ephemeral });

async function handleStart(interaction, client, guildId) {
  const { guild, member } = await resolveTarget(interaction, client, guildId);
  if (!guild) return say(interaction, 'I can\'t find that server any more.');
  if (!member) return say(interaction, 'You are not a member of that server.');

  const s = settings(guild.id);
  if (!isConfigured(s)) return say(interaction, 'Verification is not set up yet. Ask a server admin to run `/setup`.');
  if (member.roles.cache.has(s.roleId)) return say(interaction, '✅ You are already verified.');

  const key = sKey(guild.id, member.id);
  const lockedUntil = lockouts.get(key);
  if (lockedUntil && lockedUntil > Date.now()) return say(interaction, `Too many wrong codes. Try again ${ts(lockedUntil)}.`);

  const prior = memberLog.priorCounts(guild.id, member.id);
  const a = assessAccount(member.user, prior);
  if (s.minAgeDays && a.ageDays < s.minAgeDays) {
    memberLog.record(guild.id, member.id, 'verify_blocked', { reason: 'account too new', ageDays: a.ageDays });
    log('INFO', 'Verification needs staff approval (new account)', { guild: guild.name, user: member.user.tag, age: ageText(a.ageDays) });
    await postStaffLog(guild, {
      embeds: [new EmbedBuilder().setColor(0xFAA61A).setTitle('⏳ Staff approval needed').setDescription(`${member} tried to verify but their account is **${ageText(a.ageDays)}** old (the minimum is **${s.minAgeDays}** day(s)).`).setThumbnail(member.user.displayAvatarURL()).setTimestamp()],
      components: [staffButtons(guild.id, member.id)],
    });
    return say(interaction, `Your account is newer than ${s.minAgeDays} day(s), so a moderator needs to approve you. They've been notified — please be patient.`);
  }

  if (s.mode === 'captcha') {
    const session = newSession(guild.id, member.id, sessions.get(key));
    return interaction.reply(captchaMessage(guild.id, session));
  }

  await interaction.deferReply({ flags: ephemeral });
  const res = await complete({ guild, member, method: 'button' });
  return interaction.editReply({ content: res.ok ? `✅ You're verified — welcome to **${guild.name}**!` : `⚠️ ${res.error}` });
}

async function handleEnter(interaction, guildId, nonce) {
  const session = sessions.get(sKey(guildId, interaction.user.id));
  if (!session || session.nonce !== nonce || session.expires < Date.now()) {
    return interaction.update({ content: 'That picture expired — press **Verify now** again.', embeds: [], components: [], files: [] });
  }
  const modal = new ModalBuilder().setCustomId(`verify:modal:${guildId}:${nonce}`).setTitle('Human check')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('code').setLabel('Type the 5 characters from the picture').setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(5).setRequired(true),
    ));
  return interaction.showModal(modal);
}

async function handleModal(interaction, client, guildId, nonce) {
  const { guild, member } = await resolveTarget(interaction, client, guildId);
  if (!guild || !member) return say(interaction, 'I can\'t find you in that server.');
  const key = sKey(guild.id, member.id);
  const session = sessions.get(key);
  if (!session || session.nonce !== nonce || session.expires < Date.now()) return say(interaction, 'That picture expired — press **Verify now** again.');

  const typed = interaction.fields.getTextInputValue('code').trim().toUpperCase();
  if (typed === session.code) {
    await interaction.deferReply({ flags: ephemeral });
    const res = await complete({ guild, member, method: 'human check', attempts: session.attempts + 1, startedAt: session.startedAt });
    return interaction.editReply({ content: res.ok ? `✅ Correct — you're verified. Welcome to **${guild.name}**!` : `⚠️ ${res.error}` });
  }

  session.attempts++;
  if (session.attempts >= MAX_ATTEMPTS) {
    sessions.delete(key);
    lockouts.set(key, Date.now() + LOCKOUT_MS);
    memberLog.record(guild.id, member.id, 'verify_fail', { attempts: session.attempts });
    log('INFO', 'Verification failed (too many wrong codes)', { guild: guild.name, user: member.user.tag });
    await postStaffLog(guild, { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Verification failed').setDescription(`${member} entered the wrong code **${MAX_ATTEMPTS}** times and is locked out for 10 minutes.`).setTimestamp()], components: [staffButtons(guild.id, member.id)] });
    return say(interaction, `That wasn't right, and you're out of attempts. You can try again ${ts(Date.now() + LOCKOUT_MS)}.`);
  }
  const fresh = newSession(guild.id, member.id, session);
  return interaction.reply(captchaMessage(guild.id, fresh, `❌ That wasn't the right code. **${MAX_ATTEMPTS - session.attempts}** attempt(s) left.`));
}

function handleWhy(interaction, guildId) {
  const name = interaction.guild?.name || interaction.client.guilds.cache.get(guildId)?.name || 'this server';
  return interaction.reply({
    flags: ephemeral,
    embeds: [new EmbedBuilder().setColor(ACCENT).setTitle('Why do I need to verify?').setDescription([
      `**${name}** uses verification to keep out spam bots and raiders, so the community stays safe.`,
      '',
      '**What is checked:** only what Discord already shows about your account — how old it is, your public badges and avatar. Nothing is asked of you beyond the button or the code.',
      '**What is NOT collected:** your email, IP address, location or anything private.',
      '**What is recorded:** when you joined and whether you verified, visible to this server\'s staff.',
      '',
      'Stuck? Ask a moderator to approve you.',
    ].join('\n'))],
  });
}

async function handleStaff(interaction, client, action, guildId, userId) {
  const guild = interaction.guild || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild || interaction.guildId !== guildId) return say(interaction, 'Use this button inside the server.');
  const needed = action === 'approve' ? PermissionFlagsBits.ManageRoles : PermissionFlagsBits.KickMembers;
  if (!interaction.memberPermissions?.has(needed)) return say(interaction, `You need the **${action === 'approve' ? 'Manage Roles' : 'Kick Members'}** permission.`);

  const target = await guild.members.fetch(userId).catch(() => null);
  if (!target) {
    await interaction.update({ components: [] }).catch(() => {});
    return interaction.followUp({ content: 'That member has already left.', flags: ephemeral });
  }

  const note = (text) => {
    const base = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(base).addFields({ name: 'Handled', value: `${text} by ${interaction.user.tag} ${ts(Date.now())}`, inline: false });
    return interaction.update({ embeds: [embed], components: [] });
  };

  if (action === 'approve') {
    const res = await complete({ guild, member: target, method: 'staff approval', by: interaction.user.tag });
    if (!res.ok) return say(interaction, `⚠️ ${res.error}`);
    return note('✅ Approved');
  }

  if (!target.kickable) return say(interaction, 'I can\'t kick that member (their role is above mine or they\'re the owner).');
  try { await target.kick(`Kicked from verification log by ${interaction.user.tag}`); }
  catch (err) { log('ERROR', 'Kick from verification log failed', { guild: guild.name, err }); return say(interaction, 'Discord refused the kick.'); }
  memberLog.record(guild.id, userId, 'kicked_staff', { by: interaction.user.tag });
  log('INFO', 'Member kicked from verification log', { guild: guild.name, user: target.user.tag, by: interaction.user.tag });
  return note('👢 Kicked');
}

/** Returns true when the interaction belonged to verification. */
async function handleInteraction(interaction, client) {
  const id = interaction.customId;
  if (!id) return false;

  if (interaction.isButton()) {
    if (id === 'bot_verify')           { await handleStart(interaction, client, interaction.guildId); return true; }   // buttons posted before the upgrade
    if (!id.startsWith('verify:'))     return false;
    const [, action, guildId, extra] = id.split(':');
    if (action === 'start')   { await handleStart(interaction, client, guildId); return true; }
    if (action === 'why')     { await handleWhy(interaction, guildId); return true; }
    if (action === 'enter')   { await handleEnter(interaction, guildId, extra); return true; }
    if (action === 'approve' || action === 'kick') { await handleStaff(interaction, client, action, guildId, extra); return true; }
    return false;
  }
  if (interaction.isModalSubmit() && id.startsWith('verify:modal:')) {
    const [, , guildId, nonce] = id.split(':');
    await handleModal(interaction, client, guildId, nonce);
    return true;
  }
  return false;
}

// ── Auto-kick for members who never verify ────────────────────────────────────

const { selectAll } = require('./database');

async function sweep(client) {
  for (const guild of client.guilds.cache.values()) {
    const s = settings(guild.id);
    if (!s.kickMinutes || !s.roleId || !s.enabledAt) continue;
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) continue;

    const since = Math.max(s.enabledAt, Date.now() - 7 * 86_400_000);
    const pending = selectAll(
      `SELECT user_id,
              MAX(CASE WHEN event = 'join' THEN at END) AS joined,
              MAX(CASE WHEN event IN ('verify_ok','approved','leave','kicked_unverified','kicked_staff') THEN at END) AS resolved
         FROM member_events WHERE guild_id = ? AND at >= ? AND user_id != '0'
         GROUP BY user_id HAVING joined IS NOT NULL AND (resolved IS NULL OR resolved < joined)`,
      [guild.id, since]
    ).filter(r => Date.now() - r.joined >= s.kickMinutes * 60_000);

    let kicked = 0;
    for (const row of pending) {
      if (kicked >= MAX_KICKS_SWEEP) break;
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      if (!member) { memberLog.record(guild.id, row.user_id, 'leave', { assumed: true }); continue; }
      if (member.user.bot || member.roles.cache.has(s.roleId) || !member.kickable) continue;

      try { await member.send(`You were removed from **${guild.name}** because you didn't verify within ${s.kickMinutes} minutes. You're welcome to rejoin and verify.`); } catch { /* DMs closed */ }
      try { await member.kick(`Did not verify within ${s.kickMinutes} minutes`); }
      catch (err) { log('ERROR', 'Auto-kick of an unverified member failed', { guild: guild.name, user: member.user.tag, err }); continue; }

      kicked++;
      memberLog.record(guild.id, member.id, 'kicked_unverified', { minutes: s.kickMinutes });
      log('INFO', 'Unverified member removed', { guild: guild.name, user: member.user.tag, after: `${s.kickMinutes} min` });
      await postStaffLog(guild, { embeds: [new EmbedBuilder().setColor(0xFAA61A).setTitle('👢 Unverified member removed').setDescription(`**${member.user.tag}** (\`${member.id}\`) did not verify within **${s.kickMinutes}** minutes.`).setTimestamp()] });
    }
  }
}

let sweeper = null;
function startSweeper(client) {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(client).catch(err => log('WARN', 'Verification sweep failed', { err })), SWEEP_EVERY_MS);
  sweeper.unref?.();
}
function stopSweeper() { clearInterval(sweeper); sweeper = null; }

module.exports = {
  settings, isConfigured, assessAccount, ageText, buildJoinLog, buildPrompt, postPrompt, makeCaptcha,
  onMemberJoin, onMemberLeave, handleInteraction, sweep, startSweeper, stopSweeper,
  _sessions: sessions, _lockouts: lockouts,
};
