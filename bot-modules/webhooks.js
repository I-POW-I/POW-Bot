const { supabase } = require('./supabase-client');
const { WebhookClient, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');

// Constant-time token compare — a plain `===` leaks timing info that can
// (in theory) be used to guess a secret token character-by-character.
function safeTokenCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Cache: guildId -> { webhooks, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60_000;

// Active webhook clients keyed by webhook config id
const clients = new Map();

async function loadGuild(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.webhooks;
  const { data, error } = await supabase
    .from('webhook_configs')
    .select('*')
    .eq('guild_id', guildId)
    .eq('enabled', true);
  if (error) {
    console.error('[webhooks] fetch error:', error.message);
    return cached?.webhooks ?? [];
  }
  cache.set(guildId, { webhooks: data ?? [], fetchedAt: Date.now() });
  return data ?? [];
}

function invalidateCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

function fillTemplate(template, ctx) {
  if (!template) return '';
  return template
    .replace(/\{user\}/gi, ctx.user ?? '')
    .replace(/\{channel\}/gi, ctx.channel ?? '')
    .replace(/\{timestamp\}/gi, ctx.timestamp ?? new Date().toISOString())
    .replace(/\{content\}/gi, ctx.content ?? '');
}

function getClient(cfg) {
  if (!cfg.webhook_url) return null;
  let client = clients.get(cfg.id);
  if (client) return client;
  try {
    client = new WebhookClient({ url: cfg.webhook_url });
    clients.set(cfg.id, client);
    return client;
  } catch (e) {
    console.error('[webhooks] client init failed:', e.message);
    return null;
  }
}

async function markTriggered(id, totalSent) {
  await supabase
    .from('webhook_configs')
    .update({ last_triggered_at: new Date().toISOString(), total_sent: (totalSent ?? 0) + 1 })
    .eq('id', id);
}

async function fire(guildId, event, ctx) {
  const webhooks = await loadGuild(guildId);
  for (const w of webhooks) {
    if (w.type !== event) continue;
    const client = getClient(w);
    if (!client) continue;
    const content = fillTemplate(w.template, ctx);
    const payload = {
      username: w.username || undefined,
      avatarURL: w.avatar_url || undefined,
      content: content || undefined,
    };
    try {
      await client.send(payload);
      await markTriggered(w.id, w.total_sent);
      invalidateCache(guildId);
    } catch (e) {
      console.error(`[webhooks] fire failed for "${w.name}":`, e.message);
    }
  }
}

// Discord event -> webhook firing helpers
async function onGuildMemberAdd(member) {
  await fire(member.guild.id, 'guildMemberAdd', {
    user: member.user.toString(),
    channel: `<#${member.guild.systemChannelId ?? ''}>`,
    timestamp: new Date().toISOString(),
  });
}

async function onGuildMemberRemove(member) {
  await fire(member.guild.id, 'guildMemberRemove', {
    user: member.user.tag,
    channel: '',
    timestamp: new Date().toISOString(),
  });
}

// Manual trigger (e.g. from dashboard test button or custom HTTP endpoint)
async function triggerCustom(guildId, webhookId, ctx) {
  const { data, error } = await supabase
    .from('webhook_configs')
    .select('*')
    .eq('id', webhookId)
    .maybeSingle();
  if (error || !data) return false;
  const client = getClient(data);
  if (!client) return false;
  const content = fillTemplate(data.template, ctx);
  try {
    await client.send({
      username: data.username || undefined,
      avatarURL: data.avatar_url || undefined,
      content: content || `**Test** from webhook "${data.name}" (${data.type}).`,
    });
    await markTriggered(data.id, data.total_sent);
    return true;
  } catch (e) {
    console.error('[webhooks] custom trigger failed:', e.message);
    return false;
  }
}

// Internal HTTP endpoint for the dashboard to trigger a test fire.
// Wire this into a small http server in the bot (see README).
async function handleHttpTrigger(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  const auth = req.headers.authorization || '';
  const expectedToken = process.env.BOT_API_TOKEN;
  if (!expectedToken || !safeTokenCompare(auth, `Bearer ${expectedToken}`)) {
    res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const MAX_BODY_BYTES = 16 * 1024; // this endpoint only ever needs a tiny JSON body
  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      res.writeHead(413, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
    body += chunk;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  const ok = await triggerCustom(parsed.guildId, parsed.webhookId, parsed.context ?? {});
  res.writeHead(ok ? 200 : 500, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok }));
}

module.exports = {
  fire,
  onGuildMemberAdd,
  onGuildMemberRemove,
  triggerCustom,
  handleHttpTrigger,
  invalidateCache,
  loadGuild,
};
