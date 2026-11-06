/**
 * Diagnostics — turns "Error: something went wrong" into a report that says WHAT
 * failed, WHY (in plain English), WHERE in the code, WHAT triggered it, and what the
 * bot was doing just before.
 *
 *  • Breadcrumbs  — rolling timeline of recent activity (commands, buttons, changes, logs)
 *  • Context      — the command/button/event currently being handled (AsyncLocalStorage)
 *  • describeError— classifies an error and extracts the first line of OUR code in the stack
 *  • audit        — records a deliberate change (setup edits, owner actions, restarts)
 *
 * Nothing here ever throws into the caller.
 */

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = path.join(__dirname, '..');
const als  = new AsyncLocalStorage();

// ── Breadcrumbs ───────────────────────────────────────────────────────────────

const MAX_CRUMBS = 40;
const crumbs = [];

function addBreadcrumb(kind, text) {
  crumbs.push({ t: Date.now(), kind, text: String(text ?? '').slice(0, 160) });
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

function recentBreadcrumbs({ limit = 12, withinMs = 10 * 60_000 } = {}) {
  const cutoff = Date.now() - withinMs;
  return crumbs.filter(c => c.t >= cutoff).slice(-limit);
}

/** "-12s  command  /streamers add (user · Home)" lines, newest last. */
function formatBreadcrumbs(list = recentBreadcrumbs(), now = Date.now()) {
  return list.map(c => {
    const age = Math.max(0, Math.round((now - c.t) / 1000));
    const ago = age >= 120 ? `-${Math.round(age / 60)}m` : `-${age}s`;
    return `${ago.padStart(5)}  ${c.kind.padEnd(8)} ${c.text}`;
  });
}

// ── Counters + last error (for the status pages) ──────────────────────────────

const counters = { commands: 0, buttons: 0, errors: 0, warnings: 0 };
let lastError = null;

const bump = (name) => { if (name in counters) counters[name]++; };
const getCounters = () => ({ ...counters });
const noteError = (text) => { counters.errors++; lastError = { at: Date.now(), text: String(text ?? '').slice(0, 120) }; };
const getLastError = () => lastError;

// ── Trigger context (what is the bot handling right now?) ─────────────────────

const runWithContext = (ctx, fn) => als.run(ctx, fn);
const currentContext = () => als.getStore() || null;

/** Context for a Discord interaction: who did what, where. */
function interactionContext(interaction, label) {
  return {
    what:    label,
    user:    interaction.user?.tag || interaction.user?.id,
    userId:  interaction.user?.id,
    guild:   interaction.guild?.name || 'DM',
    guildId: interaction.guild?.id || null,
    channel: interaction.channel?.name || null,
  };
}

const describeContext = (ctx) => !ctx ? null
  : `${ctx.what}${ctx.user ? ` — ${ctx.user}` : ''}${ctx.guild ? ` in ${ctx.guild}` : ''}${ctx.channel ? ` #${ctx.channel}` : ''}`;

// ── Error classification ──────────────────────────────────────────────────────

const DISCORD_CODES = {
  10003: ['Unknown channel',      'The channel was deleted, or the bot can no longer see it.',            'Pick the channel again in /setup.'],
  10004: ['Unknown server',       'The bot is no longer in that server.',                                  'Nothing to fix — the server was left or removed.'],
  10007: ['Unknown member',       'That person has left the server.',                                      'Usually harmless.'],
  10008: ['Unknown message',      'The message was deleted before the bot could use it.',                  'Usually harmless; the bot should skip it.'],
  10011: ['Unknown role',         'The role was deleted.',                                                 'Choose the role again in /setup.'],
  10013: ['Unknown user',         'Discord has no user with that ID.',                                     'Check the ID that was supplied.'],
  10015: ['Unknown webhook',      'The webhook was deleted or the URL is wrong.',                          'Create a new webhook and update the Discloud variable.'],
  10062: ['Unknown interaction',  'The bot took longer than 3 seconds to respond, so Discord discarded it.','Defer the reply earlier, or find what is blocking the event loop.'],
  40060: ['Interaction already acknowledged', 'The bot tried to reply twice to one interaction.',          'A code path replies more than once — check the origin line.'],
  50001: ['Missing access',       'The bot cannot see that channel or server.',                            'Give the bot View Channel there.'],
  50007: ['Cannot DM user',       'The user has DMs closed or blocked the bot.',                           'Nothing to fix on our side.'],
  50013: ['Missing permissions',  'The bot lacks a permission needed for this action.',                    'Check the channel/role permissions; the role must also sit above any role it manages.'],
  50035: ['Invalid form body',    'Discord rejected the data sent (too long, empty or badly formed).',     'See the details line for which field.'],
  30005: ['Max roles reached',    'The server has hit Discord\'s role limit.',                             'Delete unused roles.'],
};

const SYSTEM_CODES = {
  ECONNRESET:   ['Connection reset',       'The remote server dropped the connection mid-request.',  'Usually temporary. If constant, the service may be blocking this host.'],
  ECONNREFUSED: ['Connection refused',     'Nothing is listening at that address.',                  'Check the URL / that the service is up.'],
  ETIMEDOUT:    ['Timed out',              'The remote server did not answer in time.',              'Usually temporary; check the service status.'],
  ENOTFOUND:    ['DNS lookup failed',      'The hostname could not be resolved.',                    'Check the URL, or a temporary DNS/network problem.'],
  EAI_AGAIN:    ['DNS temporarily failing','The host\'s DNS is not answering right now.',            'Temporary; retry.'],
  ENOENT:       ['File or folder missing', 'The code looked for a file that is not there.',          'Check the path; `data/` may have been wiped by a redeploy.'],
  EACCES:       ['No permission on file',  'The bot may not read/write that path.',                  'Check file permissions on the host.'],
  ENOSPC:       ['Disk full',              'There is no storage space left.',                        'Free space on the Discloud app (SSD).'],
  UND_ERR_CONNECT_TIMEOUT: ['Connect timeout', 'Could not connect to the server in time.',           'Usually temporary.'],
};

const PATTERNS = [
  [/Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/, (m) =>
    ['Missing value', `The code read \`.${m[2]}\` from something that was ${m[1]} (e.g. a channel, member or message that was deleted or not cached).`, 'See the origin line — that line needs a check for the missing value.']],
  [/(\w[\w.]*) is not a function/,        (m) => ['Not a function',     `\`${m[1]}\` was called but is not a function (wrong import, typo, or unexpected data).`, 'See the origin line.']],
  [/(\w+) is not defined/,                (m) => ['Undefined variable', `\`${m[1]}\` is used but never declared/imported.`,                                        'A typo or missing import at the origin line.']],
  [/Cannot find module '([^']+)'/,        (m) => ['Missing module',     `Node could not load \`${m[1]}\`.`,                                                         'Run npm install / add the dependency, or fix the path.']],
  [/UNIQUE constraint failed: ([\w.]+)/,  (m) => ['Duplicate database row', `A row with the same unique value already exists in \`${m[1]}\`.`,                       'Usually a double-click or a repeated add; harmless if rare.']],
  [/no such (table|column): (\w+)/,       (m) => ['Database schema problem', `The database has no ${m[1]} named \`${m[2]}\`.`,                                     'A migration did not run, or data/ was replaced.']],
  [/Unexpected token .* JSON|JSON at position|Unexpected end of JSON/, () =>
    ['Bad JSON', 'The code tried to parse something that was not valid JSON (often an HTML error page from an API).', 'Check which service replied; it may be blocking or down.']],
  [/Twitch API (\d+)/,                    (m) => ['Twitch API error',   `Twitch answered HTTP ${m[1]}.`,                                                           m[1] === '401' ? 'Check TWITCH_CLIENT_ID / SECRET.' : 'Usually temporary; 429 means rate limited.']],
  [/Discloud API .* returned (\d+)/,      (m) => ['Discloud API error', `Discloud answered HTTP ${m[1]}.`,                                                         'Check DISCLOUD_API_TOKEN and DISCLOUD_APP_ID.']],
  [/heap out of memory|ERR_WORKER_OUT_OF_MEMORY/, () =>
    ['Out of memory', 'The process ran out of RAM.', 'Check the memory trend; raise RAM or find the leak.']],
  [/Used disallowed intents/,             () => ['Disallowed intents', 'A privileged intent is not enabled for this bot.',                                         'Enable it in the Discord Developer Portal → Bot.']],
  [/Invalid Form Body/,                   () => ['Invalid form body', 'Discord rejected the data sent.',                                                           'See the details line for which field.']],
];

/** Stack frames that belong to OUR code (not node_modules / node internals). */
function projectFrames(stack, max = 4) {
  const out = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[2].replace(/^file:\/\//, '');
    if (file.includes('node_modules') || file.startsWith('node:') || !file.startsWith(ROOT)) continue;
    out.push({ fn: m[1] || '(anonymous)', file: path.relative(ROOT, file), line: Number(m[3]) });
    if (out.length >= max) break;
  }
  return out;
}

function describeError(err) {
  try {
    if (!(err instanceof Error)) {
      return { name: 'Error', message: String(err), summary: null, hint: null, category: 'unknown', origin: null, frames: [], code: null, route: null, title: 'Non-Error thrown' };
    }

    const message = String(err.message || '').slice(0, 400);
    const code    = err.code ?? null;
    const d = { name: err.name, message, code, status: err.status ?? null, category: 'code', summary: null, hint: null, title: null, route: null };

    const isDiscordApi = err.name === 'DiscordAPIError' || (typeof code === 'number' && err.rawError);
    if (isDiscordApi) {
      d.category = 'discord-api';
      const known = DISCORD_CODES[code];
      if (known) [d.title, d.summary, d.hint] = known;
      else { d.title = `Discord API error ${code}`; d.summary = message; }
      if (err.method && err.url) d.route = `${err.method} ${String(err.url).replace(/^https:\/\/discord\.com\/api\/v\d+/, '').split('?')[0]}`;
      if (err.rawError?.errors) d.details = JSON.stringify(err.rawError.errors).slice(0, 300);
    } else if (typeof code === 'string' && SYSTEM_CODES[code]) {
      d.category = 'network/system';
      [d.title, d.summary, d.hint] = SYSTEM_CODES[code];
    } else if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      d.category = 'network/system';
      [d.title, d.summary, d.hint] = ['Request timed out', 'A web request took too long and was cancelled.', 'Usually temporary; check the service.'];
    } else {
      for (const [re, fn] of PATTERNS) {
        const m = re.exec(message);
        if (m) { [d.title, d.summary, d.hint] = fn(m); d.category = /Twitch|Discloud/.test(d.title) ? 'external-api' : 'code'; break; }
      }
    }

    d.frames = projectFrames(err.stack);
    d.origin = d.frames[0] ? `${d.frames[0].file}:${d.frames[0].line} (${d.frames[0].fn})` : null;
    return d;
  } catch {
    return { name: 'Error', message: String(err?.message || err), summary: null, hint: null, category: 'unknown', origin: null, frames: [], code: null, route: null, title: null };
  }
}

/** Multi-line console text for an error report (project frames only). */
function consoleLines(d) {
  const lines = [];
  if (d.frames?.length) lines.push(...d.frames.map(f => `    at ${f.fn} (${f.file}:${f.line})`));
  return lines;
}

// ── Audit (deliberate changes) ────────────────────────────────────────────────

/**
 * Record a change: who did what, where. Shows in the console, in /owner audit,
 * in the breadcrumb timeline, and (if enabled) in your private alert channel.
 * @param {{ action: string, actor?: any, guild?: any, details?: string }} entry
 */
function audit({ action, actor, guild, details }) {
  try {
    const actorName = actor?.tag || actor?.username || (typeof actor === 'string' ? actor : null);
    const guildName = guild?.name || (typeof guild === 'string' ? guild : null);
    addBreadcrumb('change', `${action}${details ? ' — ' + details : ''}${actorName ? ` (${actorName})` : ''}`);
    try { require('./globalConfig').pushAudit({ action, actor: actorName, actorId: actor?.id || null, guild: guildName, details: details || null }); } catch (_) {}
    require('./logger').log('AUDIT', action, { by: actorName, guild: guildName, details });
  } catch (_) { /* auditing must never break the action it records */ }
}

module.exports = {
  addBreadcrumb, recentBreadcrumbs, formatBreadcrumbs,
  runWithContext, currentContext, interactionContext, describeContext,
  describeError, projectFrames, consoleLines, audit,
  bump, getCounters, noteError, getLastError,
};
