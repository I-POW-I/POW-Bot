/**
 * Private alerts — errors, crashes, changes, restarts and log digests delivered ONLY to you.
 *
 * Destinations (Discloud variables — set any combination; nothing is sent if none are set):
 *
 *   ERROR_ALERT_WEBHOOK_URL   Private-channel webhook. Works even if the bot can't connect to Discord.
 *   ERROR_ALERT_CHANNEL_ID    OR a private channel the bot can post in (can carry buttons).
 *   ERROR_ALERT_DM            "true" → also DM every user in OWNER_IDS (with Restart / Logs / Mute buttons).
 *
 *   ERROR_ALERT_PING_USER_ID  Optional — pinged on ERROR alerts (max once per 15 minutes).
 *   ERROR_ALERT_LEVELS        Levels to alert on. Default: ERROR,AUDIT   (also: WARN, GHOST)
 *   ERROR_ALERT_STARTUP       "false" to skip the "Bot online" notice.
 *
 * What gets sent: anything logged with log('ERROR' | 'AUDIT' …), plus crashes, restarts,
 * memory events and the hourly console digest (see ownerMonitor.js). Error alerts include
 * the plain-English cause, where in the code it happened, what triggered it and the
 * activity leading up to it (see diagnostics.js).
 *
 * Safety: identical alerts collapse for 10 minutes, at most 6 per minute, secrets are
 * scrubbed, and this module never calls log() — a failing alert can't cause more alerts.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Routes } = require('discord.js');

const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_PER_MINUTE   = 6;
const PING_COOLDOWN_MS = 15 * 60_000;
const SEND_TIMEOUT_MS  = 12_000;
const SEND_FAIL_LOG_MS = 30 * 60_000;

const COLOURS = { ERROR: 0xED4245, WARN: 0xFEE75C, GHOST: 0xEB459E, INFO: 0x57F287, MEMORY: 0xFAA61A, AUDIT: 0x5865F2, DIGEST: 0x3498DB };
const EMOJI   = { ERROR: '🔴', WARN: '🟡', GHOST: '👻', INFO: '🟢', MEMORY: '🧠', AUDIT: '🛠️', DIGEST: '📜' };

let client       = null;
let queue        = Promise.resolve();
let lastPingAt   = 0;
let lastSendFail = 0;
let droppedCount = 0;
let mutedUntil   = 0;
const recentSends = [];
const seen        = new Map();

// ── Config (read lazily so Discloud variables are always loaded first) ────────

function config() {
  const levels = (process.env.ERROR_ALERT_LEVELS || 'ERROR,AUDIT')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return {
    webhookUrl: (process.env.ERROR_ALERT_WEBHOOK_URL || '').trim(),
    channelId:  (process.env.ERROR_ALERT_CHANNEL_ID  || '').trim(),
    dm:         String(process.env.ERROR_ALERT_DM || '').toLowerCase() === 'true',
    pingUserId: (process.env.ERROR_ALERT_PING_USER_ID || '').trim(),
    levels:     new Set(levels),
    startup:    String(process.env.ERROR_ALERT_STARTUP || 'true').toLowerCase() !== 'false',
  };
}

function isEnabled() {
  const c = config();
  return !!(c.webhookUrl || c.channelId || (c.dm && ownerIds().length));
}

function ownerIds() { try { return require('./permissions').ownerIds(); } catch { return []; } }

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET_ENV = /(TOKEN|SECRET|API_KEY|WEBHOOK_URL|PASSWORD|SERVICE_KEY)/i;

/** Remove anything that looks like a credential before text leaves the process. */
function redact(text) {
  let out = String(text ?? '');
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(key)) out = out.split(value).join('[redacted]');
  }
  out = out.replace(/[MNO][A-Za-z0-9_-]{23,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '[redacted-token]');
  out = out.replace(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g, '[redacted-webhook]');
  return out;
}

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function footerText() {
  let ram = '';
  try { ram = ` • ${require('./system').formatMemory()}`; } catch { ram = ` • ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RAM`; }
  let version = '';
  try { version = ' • v' + require('../package.json').version; } catch (_) {}
  return `up ${formatUptime(process.uptime())}${ram}${version}`;
}

function prune() {
  if (seen.size < 200) return;
  const cutoff = Date.now() - 60 * 60_000;
  for (const [k, v] of seen) if (v.at < cutoff) seen.delete(k);
}

function allowedByRateLimit() {
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > 60_000) recentSends.shift();
  if (recentSends.length >= MAX_PER_MINUTE) return false;
  recentSends.push(now);
  return true;
}

// ── Buttons (only on messages the BOT sends — DMs and bot channel posts) ─────

/** [View logs] [Restart bot] [Mute 1 hour] — handled in ownerMonitor.handleAlertButton */
function alertButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('alert_logs').setLabel('View logs').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('alert_restart').setLabel('Restart bot').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('alert_mute').setLabel('Mute 1 hour').setEmoji('🔕').setStyle(ButtonStyle.Secondary),
  );
}

// ── Building ──────────────────────────────────────────────────────────────────

function buildEmbed({ level, title, description, fields = [], codeBlocks = [] }) {
  const embed = new EmbedBuilder()
    .setColor(COLOURS[level] ?? COLOURS.ERROR)
    .setTitle(trunc(`${EMOJI[level] ?? '🔴'} ${redact(title)}`, 250))
    .setTimestamp()
    .setFooter({ text: footerText() });

  const parts = [];
  if (description) parts.push(redact(description));
  for (const b of codeBlocks) {
    if (b?.text) parts.push(`**${b.label}**\n\`\`\`\n${trunc(redact(b.text).replace(/```/g, "'''"), b.max || 900)}\n\`\`\``);
  }
  if (parts.length) embed.setDescription(trunc(parts.join('\n'), 3900));

  const clean = fields.filter(f => f && f.value !== undefined && f.value !== null && f.value !== '').slice(0, 12)
    .map(f => ({ name: trunc(f.name, 250), value: trunc(redact(f.value), 1000) || '—', inline: f.inline ?? true }));
  if (clean.length) embed.addFields(clean);
  return embed;
}

/** Turn a log() call into a full diagnostic embed spec. */
function buildFromLog(level, message, context) {
  let d = null, diag = null;
  try { diag = require('./diagnostics'); } catch (_) {}

  const err = context.err instanceof Error ? context.err : null;
  if (diag && err) d = diag.describeError(err);

  if (level === 'AUDIT') {
    return {
      level, title: message,
      fields: [
        { name: 'By',     value: context.by },
        { name: 'Server', value: context.guild },
        { name: 'Details', value: context.details, inline: false },
      ],
    };
  }

  const fields = [];
  const lines  = [];
  if (d?.summary) lines.push(`**What happened:** ${d.title ? `${d.title} — ` : ''}${d.summary}`);
  else if (context.error) lines.push(`**What happened:** ${context.error}`);
  if (d?.hint) lines.push(`**Likely fix:** ${d.hint}`);

  const trigger = diag ? diag.describeContext(diag.currentContext()) : null;
  if (d?.origin)  fields.push({ name: 'Where in the code', value: d.origin, inline: false });
  if (trigger)    fields.push({ name: 'Triggered by', value: trigger, inline: false });
  if (d?.route)   fields.push({ name: 'Discord request', value: d.route, inline: true });
  if (d?.code != null) fields.push({ name: 'Error code', value: String(d.code), inline: true });
  if (d?.details) fields.push({ name: 'Details', value: d.details, inline: false });

  for (const [k, v] of Object.entries(context)) {
    if (['stack', 'err', 'error'].includes(k) || v === undefined || v === null) continue;
    fields.push({ name: k, value: String(v) });
  }

  const codeBlocks = [];
  if (d?.frames?.length) codeBlocks.push({ label: 'Stack (bot code only)', text: d.frames.map(f => `${f.fn}  ${f.file}:${f.line}`).join('\n'), max: 600 });
  else if (context.stack) codeBlocks.push({ label: 'Stack', text: String(context.stack).split('\n').slice(0, 6).join('\n'), max: 700 });
  if (diag) {
    const trail = diag.formatBreadcrumbs(diag.recentBreadcrumbs({ limit: 9, withinMs: 5 * 60_000 }));
    if (trail.length > 1) codeBlocks.push({ label: 'Activity leading up to this', text: trail.join('\n'), max: 1100 });
  }

  return { level, title: message, description: lines.join('\n'), fields, codeBlocks };
}

// ── Delivery ──────────────────────────────────────────────────────────────────

function toRestFiles(files) { return (files || []).map(f => ({ name: f.name, data: Buffer.from(f.data) })); }

async function sendWebhook(url, body, files) {
  let res;
  if (files?.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(body));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data]), f.name));
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  } else {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
}

/**
 * @param {EmbedBuilder} embed
 * @param {{ ping?: boolean, dm?: boolean, buttons?: boolean, files?: {name:string,data:string|Buffer}[] }} opts
 */
async function deliver(embed, { ping, dm, buttons, files } = {}) {
  const c = config();
  const mention = ping && c.pingUserId ? `<@${c.pingUserId}>` : undefined;
  const allowed = { parse: [], users: mention ? [c.pingUserId] : [] };
  const errors  = [];

  // 1) Webhook (no buttons — a plain webhook can't route button clicks to the bot)
  if (c.webhookUrl) {
    try { await sendWebhook(c.webhookUrl, { username: 'POW Bot Alerts', content: mention, embeds: [embed.toJSON()], allowed_mentions: allowed }, files); }
    catch (err) { errors.push(err); }
  }

  // 2) Private channel posted by the bot (can carry buttons)
  if (c.channelId) {
    try {
      const cl = client || require('./client');
      await cl.rest.post(Routes.channelMessages(c.channelId), {
        body:  { content: mention, embeds: [embed.toJSON()], allowed_mentions: allowed, ...(buttons ? { components: [alertButtons().toJSON()] } : {}) },
        files: toRestFiles(files),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) { errors.push(err); }
  }

  // 3) DMs to every owner (can carry buttons). dm:'fallback' = only when there is no webhook/channel.
  const wantDm = dm === 'fallback' ? !(c.webhookUrl || c.channelId) : dm;
  if (wantDm && c.dm) {
    const cl = client || require('./client');
    for (const id of ownerIds()) {
      try {
        const user = await cl.users.fetch(id);
        await user.send({
          embeds: [embed],
          ...(buttons ? { components: [alertButtons()] } : {}),
          ...(files?.length ? { files: files.map(f => new AttachmentBuilder(Buffer.from(f.data), { name: f.name })) } : {}),
        });
      } catch (err) { errors.push(err); }
    }
  }

  if (errors.length) throw errors[0];
}

/** Send one alert, in order, never throwing and never calling log(). */
function enqueue(embed, opts) {
  queue = queue
    .then(() => deliver(embed, opts))
    .catch(err => {
      if (Date.now() - lastSendFail > SEND_FAIL_LOG_MS) {
        lastSendFail = Date.now();
        console.error('[errorAlerts] could not deliver alert:', redact(err?.message || err));
      }
    });
  return queue;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Called by logger.js for every log line. Cheap no-op unless alerts are configured. */
function capture(level, message, context = {}) {
  try {
    if (!isEnabled()) return;
    const cfg = config();
    if (!cfg.levels.has(level)) return;
    if (level !== 'AUDIT' && Date.now() < mutedUntil) return;

    const detail = context.err?.message || context.error || context.message || context.details || '';
    const key    = `${level}|${message}|${String(detail).slice(0, 200)}`;
    const now    = Date.now();
    const prev   = seen.get(key);

    if (prev && now - prev.at < DEDUPE_WINDOW_MS) { prev.suppressed++; return; }
    if (!allowedByRateLimit()) { droppedCount++; return; }

    const spec = buildFromLog(level, message, context);
    if (prev?.suppressed) spec.fields.push({ name: 'Repeated', value: `${prev.suppressed}× in the last ${Math.round(DEDUPE_WINDOW_MS / 60000)} min`, inline: false });
    if (droppedCount)     spec.fields.push({ name: 'Dropped', value: `${droppedCount} other alert(s) skipped (rate limit)`, inline: false });
    droppedCount = 0;

    seen.set(key, { at: now, suppressed: 0 });
    prune();

    const ping = level === 'ERROR' && now - lastPingAt > PING_COOLDOWN_MS;
    if (ping) lastPingAt = now;

    // Errors also go to your DMs with action buttons
    enqueue(buildEmbed(spec), { ping, dm: level === 'ERROR', buttons: level === 'ERROR' });
  } catch (err) {
    console.error('[errorAlerts] capture failed:', err?.message || err);
  }
}

/**
 * One-off message (startup, restart, digest…). Bypasses dedupe and mute.
 * @param {{ level?: string, title: string, description?: string, fields?: any[], codeBlocks?: any[],
 *           files?: {name:string,data:string}[], dm?: boolean, buttons?: boolean, ping?: boolean }} o
 */
function notify({ level = 'INFO', title, description, fields, codeBlocks, files, dm = false, buttons = false, ping = false }) {
  try {
    if (!isEnabled()) return Promise.resolve();
    return enqueue(buildEmbed({ level, title, description, fields, codeBlocks }), { dm, buttons, files, ping });
  } catch (err) {
    console.error('[errorAlerts] notify failed:', err?.message || err);
    return Promise.resolve();
  }
}

function notifyStartup(discordClient) {
  if (!isEnabled() || !config().startup) return Promise.resolve();
  return notify({
    level: 'INFO',
    title: 'Bot online',
    fields: [
      { name: 'Account', value: discordClient?.user?.tag || 'unknown' },
      { name: 'Servers', value: String(discordClient?.guilds?.cache?.size ?? '?') },
      { name: 'Node',    value: process.version },
    ],
  });
}

/** Resolves once the shutdown notice is sent, or after `timeoutMs`. */
function notifyShutdown(reason, timeoutMs = 3000) {
  if (!isEnabled()) return Promise.resolve();
  return Promise.race([
    notify({ level: 'WARN', title: `Bot shutting down (${reason})` }),
    new Promise(r => setTimeout(r, timeoutMs)),
  ]);
}

/** Silence ERROR/WARN alerts for a while (AUDIT and one-off notices still arrive). */
function mute(ms) { mutedUntil = Date.now() + ms; return mutedUntil; }
const isMuted = () => Date.now() < mutedUntil;

/** For the owner status page: where alerts go right now. */
function describeDestinations() {
  const c = config();
  return { webhook: !!c.webhookUrl, channel: !!c.channelId, dm: c.dm && ownerIds().length > 0, levels: [...c.levels], muted: isMuted(), mutedUntil };
}

/** Call once after the client exists. */
function init(discordClient) { client = discordClient; }

module.exports = { init, capture, notify, notifyStartup, notifyShutdown, isEnabled, redact, alertButtons, mute, isMuted, describeDestinations };
