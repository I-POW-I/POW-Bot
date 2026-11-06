/**
 * Owner monitoring — everything that watches the bot for you.
 *
 *  • Hourly console digest   (Discloud logs → your private webhook / channel / DM)
 *  • Memory watch            (restarts the container through the Discloud API before it is killed)
 *  • Restart orchestration   (one safe path used by /owner restart, alert buttons and auto-restart)
 *  • "Back online" report    (downtime, RAM, servers, voice rejoins — after any restart)
 *
 * Discloud variables (all optional except the API pair for restarts/logs):
 *   DISCLOUD_API_TOKEN, DISCLOUD_APP_ID   enable restart + logs + exact RAM
 *   OWNER_IDS, ADMIN_IDS                  who may restart / read logs (see permissions.js)
 *   LOG_DIGEST_MINUTES        default 60   (0 = off)
 *   MEMORY_RESTART_PERCENT    default 90   (0 = off) restart when RAM stays above this % of the limit
 *   MEMORY_RESTART_MAX_PER_DAY default 3   safety cap so a leak can't cause a restart loop
 *   MEMORY_ALERT_MB           optional absolute limit used only if Discloud's limit is unknown
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, MessageFlags,
} = require('discord.js');

const { log }          = require('./logger');
const alerts           = require('./errorAlerts');
const system           = require('./system');
const discloud         = require('./discloud');
const globalConfig     = require('./globalConfig');
const { isBotAdmin }   = require('./permissions');
const { audit, formatBreadcrumbs, recentBreadcrumbs } = require('./diagnostics');

const MEMORY_CHECK_MS    = 60_000;
const minUptimeSec = () => num(process.env.MEMORY_RESTART_MIN_UPTIME_SEC, 10 * 60);   // never auto-restart a process younger than this
const NEEDS_ATTENTION_MS = 60 * 60_000;
const CONFIRM_TTL_MS     = 5 * 60_000;

let digestTimer = null, memoryTimer = null;
let overCount = 0, lastAttentionAt = 0, lastHighWarnAt = 0;
let digestState = { tail: null };

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const mb  = (n) => `${Math.round(n)} MB`;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} minutes` : `${Math.round(m / 60)} hours`;
}

function voiceConnectionCount() {
  try {
    const entries = require('./connectionStore').getAllEntries();
    return entries?.size ?? entries?.length ?? 0;
  } catch { return 0; }
}

// ── Restart orchestration ─────────────────────────────────────────────────────

/**
 * Restart the whole Discloud container.
 * Saves data, records why, then calls the Discloud API. Resolves { ok, error? }.
 * @param {{ reason: string, by: string, auto?: boolean, client?: any }} o
 */
async function requestRestart({ reason, by, auto = false, client = null }) {
  if (!discloud.isConfigured()) {
    return { ok: false, error: 'Discloud API is not configured — set DISCLOUD_API_TOKEN and DISCLOUD_APP_ID.' };
  }

  const mem = system.getMemoryInfo();
  globalConfig.update(s => {
    s.pendingRestart = {
      reason, by, auto,
      requestedAt: Date.now(),
      ram:         system.formatMemory(mem),
      guilds:      client?.guilds?.cache?.size ?? null,
      voiceBefore: voiceConnectionCount(),
    };
    if (auto) { s.restarts.push(Date.now()); s.restarts = s.restarts.filter(t => Date.now() - t < 24 * 3600e3); }
  });

  audit({ action: auto ? 'Automatic restart' : 'Restart requested', actor: by, details: reason });

  try { require('./database').flush(); } catch (_) {}

  try {
    await discloud.restart();
    return { ok: true };
  } catch (err) {
    globalConfig.update(s => { s.pendingRestart = null; });
    log('ERROR', 'Discloud restart call failed', { err });
    return { ok: false, error: err.message };
  }
}

/** The confirmation message shown before any manual restart. */
function buildRestartConfirm(client) {
  const mem = system.getMemoryInfo();
  const embed = new EmbedBuilder()
    .setColor(0xFAA61A)
    .setTitle('Restart POW-Bot?')
    .setDescription('This restarts the whole Discloud container. The bot will be offline for about 15 seconds.')
    .addFields(
      { name: 'Uptime',  value: formatDuration(process.uptime() * 1000), inline: true },
      { name: 'RAM',     value: system.formatMemory(mem),                inline: true },
      { name: 'Voice',   value: `${voiceConnectionCount()} connection(s) will rejoin`, inline: true },
      { name: 'Servers', value: String(client?.guilds?.cache?.size ?? '?'), inline: true },
      { name: 'Data',    value: 'Saved to disk before restarting',       inline: true },
    );
  const ts = Date.now();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`restart_confirm:${ts}`).setLabel('Restart now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('restart_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

// ── Logs ──────────────────────────────────────────────────────────────────────

/** Fetch the console, strip colour codes, scrub secrets. Returns { text, url }. */
async function fetchConsole() {
  const logs = await discloud.getLogs();
  const raw  = logs.big && logs.big.trim() ? logs.big : logs.small;
  return { text: alerts.redact(stripAnsi(raw)), url: logs.url };
}

/** The last `lines` lines of the console as a file attachment spec. */
async function consoleFile(lines = 400) {
  const { text, url } = await fetchConsole();
  const all = text.split('\n');
  const out = all.slice(-lines).join('\n');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return { name: `console-${stamp}.txt`, data: out, total: all.length, shown: Math.min(lines, all.length), url };
}

// ── Hourly digest ─────────────────────────────────────────────────────────────

async function runDigest() {
  if (!discloud.isConfigured() || !alerts.isEnabled()) return false;

  let consoleText, url;
  try { ({ text: consoleText, url } = await fetchConsole()); }
  catch (err) { log('WARN', 'Log digest: could not read the Discloud console', { err }); return false; }

  const lines = consoleText.split('\n').filter(l => l.trim().length);

  // Find where the previous digest ended so we only report what's new
  let fresh = lines, rolled = false;
  if (digestState.tail) {
    const idx = lines.lastIndexOf(digestState.tail);
    if (idx >= 0) fresh = lines.slice(idx + 1);
    else rolled = true;                       // buffer rolled over or the app restarted
  }
  if (lines.length) digestState.tail = lines[lines.length - 1];

  const count = (re) => fresh.filter(l => re.test(l)).length;
  const errors = count(/\bERROR\b/), warns = count(/\bWARN\b/), changes = count(/\bAUDIT\b/), starts = count(/Bot fully ready/);

  const snap = await system.getSnapshot({ force: true });
  const now  = new Date(), from = new Date(now.getTime() - num(process.env.LOG_DIGEST_MINUTES, 60) * 60_000);
  const hm   = (d) => d.toISOString().slice(11, 16);

  const tailLines = fresh.slice(-6).map(l => l.length > 150 ? l.slice(0, 149) + '…' : l);
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 13);

  return alerts.notify({
    level: 'DIGEST',
    title: `Console log — ${hm(from)} to ${hm(now)} UTC`,
    description: [
      `${errors} error${errors === 1 ? '' : 's'} · ${warns} warning${warns === 1 ? '' : 's'} · ${changes} change${changes === 1 ? '' : 's'} · ${starts} start${starts === 1 ? '' : 's'}`,
      rolled ? '_Console buffer rolled over or the bot restarted since the last digest — some lines may be missing._' : null,
      fresh.length === 0 ? '_No new console output._' : null,
    ].filter(Boolean).join('\n'),
    fields: [
      { name: 'RAM',       value: system.formatMemory(snap.memory) },
      { name: 'CPU',       value: snap.discloud.cpu || `${snap.cpuPercent.toFixed(1)}%` },
      { name: 'Container', value: snap.discloud.container || 'n/a' },
      { name: 'Uptime',    value: formatDuration(snap.uptimeSec * 1000) },
      { name: 'Lines',     value: `${fresh.length} new of ${lines.length}` },
      ...(url ? [{ name: 'Live console', value: url, inline: false }] : []),
    ],
    codeBlocks: tailLines.length ? [{ label: `Latest ${tailLines.length} line(s)`, text: tailLines.join('\n'), max: 1100 }] : [],
    files: fresh.length ? [{ name: `console-${stamp}h.txt`, data: fresh.join('\n') }] : [],
    dm: 'fallback',
  });
}

// ── Memory watch + auto-restart ───────────────────────────────────────────────

async function checkMemory(client) {
  const threshold = num(process.env.MEMORY_RESTART_PERCENT, 90);
  if (!threshold) return;

  const m = system.getMemoryInfo();
  const limit = m.limitMb || num(process.env.MEMORY_ALERT_MB, 0) || null;
  if (!limit) return;
  const percent = (m.usedMb / limit) * 100;

  if (percent < threshold) { overCount = 0; return; }
  overCount++;
  if (overCount < 2) return;                          // needs two checks in a row — ignore brief spikes

  const max   = num(process.env.MEMORY_RESTART_MAX_PER_DAY, 3);
  const used  = globalConfig.get().restarts.filter(t => Date.now() - t < 24 * 3600e3).length;
  const fields = [
    { name: 'RAM',          value: `${mb(m.usedMb)} / ${mb(limit)} (${Math.round(percent)}%)` },
    { name: 'Source',       value: m.source === 'discloud' ? 'Discloud' : 'Process (RSS)' },
    { name: 'Heap used',    value: mb(m.heapMb) },
    { name: 'External',     value: mb(m.externalMb) },
    { name: 'Array buffers', value: mb(m.arrayBuffersMb) },
    { name: 'Uptime',       value: formatDuration(process.uptime() * 1000) },
    { name: 'Auto-restarts', value: `${used} of ${max} used in the last 24h` },
  ];
  const trail = formatBreadcrumbs(recentBreadcrumbs({ limit: 4, withinMs: 5 * 60_000 }));
  const codeBlocks = trail.length ? [{ label: 'Last activity', text: trail.join('\n'), max: 500 }] : [];

  const canRestart = discloud.isConfigured();
  const tooYoung   = process.uptime() < minUptimeSec();

  if (!canRestart || used >= max || tooYoung) {
    if (Date.now() - lastAttentionAt < NEEDS_ATTENTION_MS) return;
    lastAttentionAt = Date.now();
    const why = !canRestart ? 'Set DISCLOUD_API_TOKEN and DISCLOUD_APP_ID to enable automatic restarts.'
      : used >= max ? `Automatic restarts are capped at ${max} per day to prevent a restart loop. Needs your attention.`
      : 'The bot only just started, so it was not restarted again. Needs your attention.';
    await alerts.notify({ level: 'MEMORY', title: `Memory limit reached (${Math.round(percent)}%) — not restarting`, description: why, fields, codeBlocks, dm: true, buttons: true });
    return;
  }

  overCount = 0;
  await Promise.race([
    alerts.notify({ level: 'MEMORY', title: 'Memory limit reached — restarting', description: `RAM stayed above ${threshold}% of the limit. Saving data, then restarting through the Discloud API.`, fields, codeBlocks, dm: true }),
    new Promise(r => setTimeout(r, 4000)),
  ]);
  const res = await requestRestart({ reason: `memory ${Math.round(percent)}% of ${mb(limit)}`, by: 'automatic', auto: true, client });
  if (!res.ok) alerts.notify({ level: 'ERROR', title: 'Automatic restart FAILED', description: res.error, dm: true, buttons: true });
}

// ── Startup ───────────────────────────────────────────────────────────────────

/** Called once from events/ready.js after the bot is fully ready. */
async function onReady(client) {
  system.start();

  const cfg = globalConfig.get();
  const pending = cfg.pendingRestart;
  if (pending) globalConfig.update(s => { s.pendingRestart = null; });

  if (pending && Date.now() - pending.requestedAt < 30 * 60_000) {
    const snap = await system.getSnapshot({ force: true }).catch(() => null);
    await alerts.notify({
      level: 'INFO',
      title: 'Back online after restart',
      fields: [
        { name: 'Downtime',  value: formatDuration(Date.now() - pending.requestedAt) },
        { name: 'Reason',    value: pending.reason },
        { name: 'Requested by', value: pending.by },
        { name: 'RAM before', value: pending.ram || 'n/a' },
        { name: 'RAM now',   value: snap ? system.formatMemory(snap.memory) : system.formatMemory() },
        { name: 'Servers',   value: pending.guilds != null ? `${client.guilds.cache.size} of ${pending.guilds} ready` : String(client.guilds.cache.size) },
        { name: 'Voice',     value: `${voiceConnectionCount()} of ${pending.voiceBefore ?? '?'} rejoined` },
        { name: 'Data',      value: 'Saved before restart — nothing lost' },
      ],
      dm: true,
    });
  } else {
    await alerts.notifyStartup(client);
    // Did Discloud (not us) kill the process for RAM?
    if (discloud.isConfigured()) {
      const snap = await system.getSnapshot({ force: true }).catch(() => null);
      if (snap?.discloud.ramKilled) {
        alerts.notify({
          level: 'MEMORY', title: 'Discloud reports the app was killed for using too much RAM',
          description: 'Discloud restarted the bot because it exceeded its RAM limit (exit code ' + (snap.discloud.exitCode ?? '?') + ').',
          fields: [{ name: 'RAM now', value: system.formatMemory(snap.memory) }], dm: true,
        });
      }
    }
  }

  const digestMin = num(process.env.LOG_DIGEST_MINUTES, 60);
  if (digestMin > 0 && !digestTimer) {
    digestTimer = setInterval(() => runDigest().catch(() => {}), digestMin * 60_000);
    digestTimer.unref?.();
  }
  if (!memoryTimer) {
    memoryTimer = setInterval(() => checkMemory(client).catch(err => log('WARN', 'Memory check failed', { err })), MEMORY_CHECK_MS);
    memoryTimer.unref?.();
  }
}

function stop() { clearInterval(digestTimer); clearInterval(memoryTimer); digestTimer = memoryTimer = null; }

// ── Button handling (alert DMs + /owner restart confirmation) ─────────────────

const deny = (interaction) => interaction.reply({ content: 'Only the bot owner or a selected bot admin can use this.', flags: [MessageFlags.Ephemeral] });

/** Returns true if the interaction was one of ours. */
async function handleComponent(interaction, client) {
  const id = interaction.customId;
  if (!interaction.isButton() || !(id.startsWith('alert_') || id.startsWith('restart_'))) return false;

  if (!isBotAdmin(interaction.user.id)) { await deny(interaction); return true; }

  if (id === 'alert_mute') {
    alerts.mute(3600e3);
    audit({ action: 'Alerts muted for 1 hour', actor: interaction.user });
    await interaction.reply({ content: 'Muted for 1 hour. Changes and one-off notices (restarts, digests) still arrive.', flags: [MessageFlags.Ephemeral] });
    return true;
  }

  if (id === 'alert_logs') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
      const f = await consoleFile(400);
      await interaction.editReply({
        content: `Last ${f.shown} of ${f.total} console lines${f.url ? ` · [open live console](${f.url})` : ''}`,
        files: [new AttachmentBuilder(Buffer.from(f.data), { name: f.name })],
      });
    } catch (err) {
      await interaction.editReply({ content: `Could not read the console: ${err.message}` });
    }
    return true;
  }

  if (id === 'alert_restart') {
    await interaction.reply({ ...buildRestartConfirm(client), flags: [MessageFlags.Ephemeral] });
    return true;
  }

  if (id === 'restart_cancel') {
    await interaction.update({ content: 'Restart cancelled.', embeds: [], components: [] });
    return true;
  }

  if (id.startsWith('restart_confirm:')) {
    const ts = Number(id.split(':')[1]);
    if (!ts || Date.now() - ts > CONFIRM_TTL_MS) {
      await interaction.update({ content: 'That confirmation expired — run it again.', embeds: [], components: [] });
      return true;
    }
    await interaction.update({ content: 'Restarting now… I will report back when I am online again.', embeds: [], components: [] });
    const res = await requestRestart({ reason: 'manual', by: interaction.user.tag, client });
    if (!res.ok) await interaction.followUp({ content: `Restart failed: ${res.error}`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return true;
  }

  return false;
}

module.exports = {
  onReady, stop, requestRestart, buildRestartConfirm, handleComponent,
  runDigest, consoleFile, fetchConsole, checkMemory, formatDuration, voiceConnectionCount,
  _state: () => ({ overCount, digestState }), _resetState: () => { overCount = 0; lastAttentionAt = 0; digestState = { tail: null }; },
};
