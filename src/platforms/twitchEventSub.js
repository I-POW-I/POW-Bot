/**
 * Twitch EventSub — instant "went live" / "went offline" push events.
 *
 * Instead of asking Twitch "is X live?" every 60 seconds, Twitch tells the bot the
 * moment a stream starts or stops. Polling stays on as a slow safety net (see
 * streamerPoller.js), so nothing is lost if this is down.
 *
 * How it works (no public URL, no user login needed — fine for Discloud):
 *   1. Create (or reuse) a Twitch "conduit" with 1 shard, using the same app
 *      credentials you already set (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET).
 *   2. Open a WebSocket to Twitch and assign it to the conduit's shard.
 *   3. Subscribe to stream.online + stream.offline for every Twitch streamer in the
 *      database (re-synced every 5 minutes and whenever /streamers changes).
 *   4. When an event arrives, hand the streamer's login to the poller, which posts
 *      or removes the Discord message exactly like it always has.
 *
 * Why a conduit? Plain WebSocket EventSub needs a user token and is capped at a
 * total cost of 10 (about 5 streamers). Conduits use the app token and the normal
 * 10,000 limit.
 *
 * Set TWITCH_EVENTSUB=off to disable. IMPORTANT: if you run a second copy of the bot
 * with the SAME Twitch app (e.g. a dev bot), disable it there — two sessions would
 * fight over the one shard.
 */

const { log }            = require('../logger');
const { helixRequest, hasCredentials } = require('./twitch');
const { selectAll }      = require('../database');

const wsUrl        = () => process.env.TWITCH_EVENTSUB_WS_URL || 'wss://eventsub.wss.twitch.tv/ws';
const TYPES        = ['stream.online', 'stream.offline'];
const SYNC_EVERY   = 5 * 60_000;
const SYNC_DEBOUNCE = 3_000;
const WELCOME_WAIT = 15_000;     // Twitch drops sockets that aren't assigned within ~10s
const MAX_BACKOFF  = 60_000;

// Tunable via env only so the automated tests can run quickly
const initialBackoff   = () => Number(process.env.TWITCH_EVENTSUB_BACKOFF_MS)   || 1_000;
const keepaliveMargin  = () => Number(process.env.TWITCH_EVENTSUB_MARGIN_MS)    || 5_000;
const retryDelay       = (d) => Number(process.env.TWITCH_EVENTSUB_RETRY_MS) || d;

let started         = false;
let keepaliveMs     = 15_000;
let onSignal        = null;
let conduitId       = null;
let socket          = null;      // the active WebSocket
let assignedSession = null;      // session id currently attached to the shard
let healthy         = false;     // welcomed + shard assigned
let watchdog        = null;
let reconnectTimer  = null;
let backoff         = 1_000;
let syncTimer       = null;
let syncInterval    = null;
let syncing         = false;
let syncAgain       = false;

const covered       = new Set();         // logins with BOTH subscriptions enabled
const loginToId     = new Map();         // login → broadcaster id
const warnedLogins  = new Set();
const seenMessages  = new Map();         // message_id → timestamp (Twitch can redeliver)

function wsImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;   // Node 22+
  try { return require('ws'); } catch { return null; }
}

// ── Public state ──────────────────────────────────────────────────────────────

/** True when events are flowing, i.e. polling can safely slow down. */
function isHealthy() { return started && healthy && !!socket; }

/** True when push events fully cover this streamer (both online + offline). */
function covers(login) { return isHealthy() && covered.has(String(login).toLowerCase()); }

// ── Conduit ───────────────────────────────────────────────────────────────────

async function ensureConduit() {
  const list = await helixRequest('GET', 'eventsub/conduits');
  if (list.status === 200) {
    const mine = (list.data?.data || []).find(c => c.shard_count === 1);
    if (mine) { conduitId = mine.id; return conduitId; }
  } else if (list.status !== 404) {
    throw new Error(`listing conduits failed (${list.status})`);
  }

  const made = await helixRequest('POST', 'eventsub/conduits', { shard_count: 1 });
  const id   = made.data?.data?.[0]?.id;
  if (made.status < 200 || made.status >= 300 || !id) throw new Error(`creating conduit failed (${made.status})`);
  conduitId = id;
  log('INFO', 'Twitch EventSub: created conduit');
  return conduitId;
}

async function assignShard(sessionId) {
  const res = await helixRequest('PATCH', 'eventsub/conduits/shards', {
    conduit_id: conduitId,
    shards: [{ id: '0', transport: { method: 'websocket', session_id: sessionId } }],
  });

  if (res.status === 404) { conduitId = null; throw new Error('conduit no longer exists'); }
  if (res.status < 200 || res.status >= 300) throw new Error(`assigning shard failed (${res.status})`);
  if (res.data?.errors?.length) throw new Error(`assigning shard failed: ${res.data.errors[0]?.message || 'unknown'}`);

  assignedSession = sessionId;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

async function resolveIds(logins) {
  const need = logins.filter(l => !loginToId.has(l));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const q     = chunk.map(l => `login=${encodeURIComponent(l)}`).join('&');
    const res   = await helixRequest('GET', `users?${q}`);
    if (res.status !== 200) throw new Error(`looking up Twitch users failed (${res.status})`);
    for (const u of res.data?.data || []) loginToId.set(String(u.login).toLowerCase(), String(u.id));
  }
  for (const l of logins) {
    if (!loginToId.has(l) && !warnedLogins.has(l)) {
      warnedLogins.add(l);
      log('WARN', `Twitch EventSub: "${l}" not found on Twitch — instant alerts unavailable for them`);
    }
  }
}

async function listOurSubscriptions() {
  const out = [];
  let cursor = null;
  do {
    const res = await helixRequest('GET', `eventsub/subscriptions?first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
    if (res.status !== 200) throw new Error(`listing subscriptions failed (${res.status})`);
    for (const s of res.data?.data || []) {
      if (s.transport?.method === 'conduit' && s.transport?.conduit_id === conduitId) out.push(s);
    }
    cursor = res.data?.pagination?.cursor || null;
  } while (cursor);
  return out;
}

async function runSync() {
  if (!started || !conduitId) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;

  try {
    const logins = selectAll("SELECT DISTINCT LOWER(username) AS u FROM streamer_subscriptions WHERE platform = 'twitch'").map(r => r.u);
    await resolveIds(logins);

    const wantIds = new Map();                                     // id → login
    for (const l of logins) if (loginToId.has(l)) wantIds.set(loginToId.get(l), l);

    const existing = await listOurSubscriptions();
    const have     = new Map();                                    // "type:id" → subscription

    // Remove ones nobody wants anymore, and ones Twitch has stopped delivering
    for (const s of existing) {
      const bid = String(s.condition?.broadcaster_user_id);
      if (!wantIds.has(bid) || s.status !== 'enabled') {
        await helixRequest('DELETE', `eventsub/subscriptions?id=${encodeURIComponent(s.id)}`);
      } else {
        have.set(`${s.type}:${bid}`, s);
      }
    }

    // Add whatever is missing
    let rateLimited = false;
    for (const [bid, login] of wantIds) {
      for (const type of TYPES) {
        if (have.has(`${type}:${bid}`)) continue;
        const res = await helixRequest('POST', 'eventsub/subscriptions', {
          type, version: '1',
          condition: { broadcaster_user_id: bid },
          transport: { method: 'conduit', conduit_id: conduitId },
        });
        if (res.status === 202 || res.status === 200 || res.status === 409) { have.set(`${type}:${bid}`, true); continue; }
        if (res.status === 429) { rateLimited = true; break; }
        log('WARN', `Twitch EventSub: could not subscribe to ${type} for ${login} (${res.status})`);
      }
      if (rateLimited) break;
    }

    covered.clear();
    for (const [bid, login] of wantIds) {
      if (TYPES.every(t => have.has(`${t}:${bid}`))) covered.add(login);
    }

    if (rateLimited) { log('WARN', 'Twitch EventSub: rate limited while subscribing — will retry shortly'); scheduleSync(retryDelay(60_000)); }
  } catch (err) {
    log('WARN', `Twitch EventSub: sync failed — ${err.message}`);
    scheduleSync(retryDelay(30_000));
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(SYNC_DEBOUNCE); }
  }
}

/** Ask for a re-sync soon (debounced). Safe to call any time, even if EventSub is off. */
function requestSync() { if (started) scheduleSync(SYNC_DEBOUNCE); }

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { runSync(); }, delay);
  syncTimer.unref?.();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function armWatchdog(ms) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    log('WARN', 'Twitch EventSub: connection went quiet — reconnecting');
    dropSocket();
  }, ms);
  watchdog.unref?.();
}

/** Abandon the current socket and schedule a fresh connection. */
function dropSocket() {
  const old = socket;
  socket  = null;
  healthy = false;
  clearTimeout(watchdog);
  if (old) { try { old.close(); } catch (_) {} }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (!started || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!started) return;
    try {
      if (!conduitId) await ensureConduit();
      open(wsUrl(), null);
    } catch (err) {
      log('WARN', `Twitch EventSub: reconnect failed — ${err.message}`);
      scheduleReconnect();
    }
  }, delay);
  reconnectTimer.unref?.();
}

function open(url, replacing) {
  const WS = wsImpl();
  const ws = new WS(url);
  if (!replacing) { socket = ws; armWatchdog(WELCOME_WAIT); }

  ws.addEventListener('message', (ev) => {
    handleMessage(ws, replacing, ev.data).catch(err => {
      log('WARN', `Twitch EventSub: ${err.message}`);
      if (ws === socket) dropSocket();                 // the live connection is unusable → start over
      else { try { ws.close(); } catch (_) {} }        // a half-open reconnect hop → just abandon it
    });
  });

  ws.addEventListener('close', () => {
    if (ws !== socket) return;          // an old/replaced socket closing is expected
    healthy = false;
    clearTimeout(watchdog);
    socket = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { /* a 'close' event always follows */ });
  return ws;
}

async function handleMessage(ws, replacing, raw) {
  const msg  = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString());
  const type = msg.metadata?.message_type;

  // Any traffic proves the active connection is alive
  if (ws === socket) armWatchdog(keepaliveMs);

  if (type === 'session_welcome') {
    const session = msg.payload.session;
    keepaliveMs   = ((session.keepalive_timeout_seconds || 10) * 1000) + keepaliveMargin();

    if (replacing) {
      // Reconnect hop requested by Twitch: new socket takes over, old one is closed
      socket = ws;
      armWatchdog(keepaliveMs);
      try { replacing.close(); } catch (_) {}
      if (session.id !== assignedSession) await assignShard(session.id);
      return;
    }

    if (!conduitId) await ensureConduit();
    await assignShard(session.id);
    healthy = true;
    backoff = initialBackoff();
    log('INFO', 'Twitch EventSub connected — instant live alerts active');
    scheduleSync(0);
    return;
  }

  if (type === 'session_keepalive') return;

  if (type === 'session_reconnect') {
    open(msg.payload.session.reconnect_url, socket);
    return;
  }

  if (type === 'notification') {
    const id = msg.metadata.message_id;
    if (seenMessages.has(id)) return;
    seenMessages.set(id, Date.now());
    if (seenMessages.size > 300) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, t] of seenMessages) if (t < cutoff) seenMessages.delete(k);
    }

    const subType = msg.metadata.subscription_type;
    const login   = msg.payload?.event?.broadcaster_user_login;
    if (!login || !TYPES.includes(subType)) return;
    if (onSignal) {
      Promise.resolve(onSignal(String(login).toLowerCase(), subType === 'stream.online' ? 'online' : 'offline'))
        .catch(err => log('WARN', `Twitch EventSub: handler failed for ${login} — ${err.message}`));
    }
    return;
  }

  if (type === 'revocation') {
    const sub = msg.payload?.subscription || {};
    log('WARN', `Twitch EventSub: subscription revoked (${sub.type}, ${sub.status}) — re-syncing`);
    scheduleSync(1_000);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start EventSub. Resolves true if it's running, false if it can't (no credentials,
 * disabled, or this Node has no WebSocket) — polling then simply carries on alone.
 * @param {{ onSignal: (login: string, kind: 'online'|'offline') => any }} handlers
 */
async function start(handlers) {
  if (started) return true;
  if (String(process.env.TWITCH_EVENTSUB || '').toLowerCase() === 'off') { log('INFO', 'Twitch EventSub disabled (TWITCH_EVENTSUB=off) — polling only'); return false; }
  if (!hasCredentials()) return false;
  if (!wsImpl())         { log('WARN', 'Twitch EventSub: this Node.js has no WebSocket support — polling only'); return false; }

  onSignal = handlers?.onSignal || null;
  started  = true;
  backoff  = initialBackoff();

  try {
    await ensureConduit();
    open(wsUrl(), null);
  } catch (err) {
    log('WARN', `Twitch EventSub: could not start yet (${err.message}) — will keep retrying; polling covers meanwhile`);
    scheduleReconnect();
  }

  syncInterval = setInterval(() => { runSync(); }, SYNC_EVERY);
  syncInterval.unref?.();
  return true;
}

/** Stop everything (used by tests / shutdown). */
function stop() {
  started = false; healthy = false;
  for (const t of [watchdog, reconnectTimer, syncTimer]) clearTimeout(t);
  clearInterval(syncInterval);
  watchdog = reconnectTimer = syncTimer = syncInterval = null;
  const old = socket; socket = null;
  if (old) { try { old.close(); } catch (_) {} }
  conduitId = null; assignedSession = null; syncing = false; syncAgain = false;
  covered.clear(); loginToId.clear(); warnedLogins.clear(); seenMessages.clear();
}

module.exports = { start, stop, isHealthy, covers, requestSync };
