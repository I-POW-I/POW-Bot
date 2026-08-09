const { supabase } = require('./supabase-client');
const { EmbedBuilder } = require('discord.js');

// Cache: guildId -> { commands, prefix, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60_000;

// Cooldowns: `${guildId}:${userId}:${commandName}` -> expiry timestamp
const cooldowns = new Map();

const PREFIX_FALLBACK = '!';

function fillVars(text, ctx) {
  return text
    .replace(/\{user\}/gi, ctx.userTag)
    .replace(/\{server\}/gi, ctx.guildName)
    .replace(/\{channel\}/gi, `<#${ctx.channelId}>`)
    .replace(/\{memberCount\}/gi, String(ctx.memberCount));
}

async function loadGuild(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const { data, error } = await supabase
    .from('custom_commands')
    .select('*')
    .eq('guild_id', guildId)
    .eq('enabled', true);
  if (error) {
    console.error('[custom-commands] fetch error:', error.message);
    return cached ?? { commands: [], prefix: PREFIX_FALLBACK };
  }
  const entry = { commands: data ?? [], prefix: PREFIX_FALLBACK, fetchedAt: Date.now() };
  cache.set(guildId, entry);
  return entry;
}

function invalidateCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

function onCooldown(guildId, userId, name, seconds) {
  if (!seconds || seconds <= 0) return false;
  const key = `${guildId}:${userId}:${name}`;
  const expiry = cooldowns.get(key);
  const now = Date.now();
  if (expiry && expiry > now) return true;
  cooldowns.set(key, now + seconds * 1000);
  return false;
}

async function incrementUsage(id) {
  await supabase
    .rpc('increment_custom_command_usage', { cmd_id: id })
    .catch(() => {
      // Fallback if the RPC isn't defined: read-modify-write
      void supabase
        .from('custom_commands')
        .select('usage_count')
        .eq('id', id)
        .single()
        .then(({ data }) => {
          if (data) {
            supabase
              .from('custom_commands')
              .update({ usage_count: (data.usage_count ?? 0) + 1 })
              .eq('id', id)
              .then(() => {});
          }
        });
    });
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.system) return;
  const { commands, prefix } = await loadGuild(message.guild.id);
  if (!commands.length) return;

  const content = message.content ?? '';
  if (!content.startsWith(prefix)) return;

  const rest = content.slice(prefix.length);
  const spaceIdx = rest.indexOf(' ');
  const name = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
  const cmd = commands.find((c) => c.name.toLowerCase() === name);
  if (!cmd) return;

  // Role restriction
  if (cmd.required_role_id) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member || !member.roles.cache.has(cmd.required_role_id)) {
      return; // silent ignore
    }
  }

  // Cooldown
  if (onCooldown(message.guild.id, message.author.id, cmd.name, cmd.cooldown_seconds)) {
    return;
  }

  const ctx = {
    userTag: message.author.toString(),
    guildName: message.guild.name,
    channelId: message.channel.id,
    memberCount: message.guild.memberCount,
  };

  try {
    if (cmd.response_type === 'embed') {
      let payload;
      try {
        payload = JSON.parse(cmd.response_content);
      } catch {
        await message.reply('Command embed is malformed JSON. Edit it in the dashboard.');
        return;
      }
      const embed = new EmbedBuilder(payload).setColor(payload.color ?? 0x3498db);
      if (typeof embed.data.description === 'string') {
        embed.setDescription(fillVars(embed.data.description, ctx));
      }
      if (typeof embed.data.title === 'string') {
        embed.setTitle(fillVars(embed.data.title, ctx));
      }
      await message.reply({ embeds: [embed] });
    } else if (cmd.response_type === 'random') {
      const lines = cmd.response_content.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) return;
      const line = lines[Math.floor(Math.random() * lines.length)];
      await message.reply(fillVars(line, ctx));
    } else {
      // text (and legacy dm fallback)
      await message.reply(fillVars(cmd.response_content, ctx));
    }
    void incrementUsage(cmd.id);
  } catch (e) {
    console.error('[custom-commands] reply error:', e.message);
  }
}

// Clean expired cooldowns periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of cooldowns.entries()) {
    if (exp <= now) cooldowns.delete(k);
  }
}, 60_000).unref();

module.exports = { handleMessage, invalidateCache, loadGuild };
