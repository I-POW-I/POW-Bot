/*
 * Live guild data over HTTP — lets the dashboard show real channels and
 * roles instead of hardcoded placeholder lists, and render a pixel-accurate
 * welcome/leave card preview instead of a hand-drawn CSS mockup. Runs on the
 * same HTTP server as the webhook trigger endpoint (index.js), reusing the
 * same BOT_API_TOKEN bearer-auth scheme.
 *
 * Routes (all require Authorization: Bearer <BOT_API_TOKEN>):
 *   GET /guilds/:guildId/channels
 *     -> [{ id, name, position }]   text channels only
 *   GET /guilds/:guildId/roles
 *     -> [{ id, name, color, position }]  excludes @everyone and managed/bot roles
 *   GET /guilds/:guildId/welcome-preview?discordId=...&type=welcome|leave&nameMode=&accentColor=&avatarPosition=&textAlign=
 *     -> image/png, rendered with generateCard() using the REAL guild
 *        member identified by discordId (their real nickname/username/
 *        avatar) — never an arbitrary caller-supplied avatar URL, which
 *        would otherwise be a server-side request forgery risk. discordId
 *        is meant to be the dashboard user's own ID, so the preview shows
 *        them exactly what their own join/leave card would look like.
 */

const crypto = require('crypto');
const { ChannelType } = require('discord.js');
const { generateCard } = require('../src/imageGenerator');
const { normalizeCardConfig } = require('../src/welcomeConfig');

function safeTokenCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const cors = {
  'Access-Control-Allow-Origin': process.env.DASHBOARD_URL || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Matches /guilds/:guildId/(channels|roles|welcome-preview) and dispatches.
 * Returns true if it handled the request, false if the path didn't match
 * (so the caller can fall through to other routes / 404).
 */
async function handleGuildDataRequest(req, res, client) {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/guilds\/(\d+)\/(channels|roles|welcome-preview)$/);
  if (!match) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return true;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const expectedToken = process.env.BOT_API_TOKEN;
  const auth = req.headers.authorization || '';
  if (!expectedToken || !safeTokenCompare(auth, `Bearer ${expectedToken}`)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const [, guildId, resource] = match;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    sendJson(res, 404, { error: 'Bot is not in that guild' });
    return true;
  }

  try {
    if (resource === 'channels') {
      const channels = guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildText)
        .map((c) => ({ id: c.id, name: c.name, position: c.position }))
        .sort((a, b) => a.position - b.position);
      sendJson(res, 200, { channels });
    } else if (resource === 'roles') {
      const roles = guild.roles.cache
        .filter((r) => r.id !== guild.id && !r.managed) // exclude @everyone and bot-integration roles
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position }))
        .sort((a, b) => b.position - a.position);
      sendJson(res, 200, { roles });
    } else {
      const discordId = url.searchParams.get('discordId');
      if (!discordId) {
        sendJson(res, 400, { error: 'discordId query param required' });
        return true;
      }

      let member;
      try {
        member = await guild.members.fetch(discordId);
      } catch {
        sendJson(res, 404, { error: 'That user is not a member of this guild' });
        return true;
      }

      const type = url.searchParams.get('type') === 'leave' ? 'leave' : 'welcome';
      const cardConfig = normalizeCardConfig({
        nameMode: url.searchParams.get('nameMode'),
        accentColor: url.searchParams.get('accentColor'),
        avatarPosition: url.searchParams.get('avatarPosition'),
        textAlign: url.searchParams.get('textAlign'),
      });

      const buffer = await generateCard(
        type,
        { nickname: member.nickname, username: member.user.username },
        member.user.displayAvatarURL({ dynamic: false, size: 512 }),
        guild.memberCount,
        cardConfig
      );

      res.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buffer);
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }

  return true;
}

module.exports = { handleGuildDataRequest };
