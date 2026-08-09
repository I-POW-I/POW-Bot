const { supabase } = require('./supabase-client');
const { EmbedBuilder } = require('discord.js');

// In-memory cache: guildId -> { rules, fetchedAt }
// TTL 60s to reduce DB reads while still picking up dashboard changes quickly.
const cache = new Map();
const CACHE_TTL_MS = 60_000;

const ACTIONS = {
  warn: 'Warn (DM)',
  delete: 'Delete message',
  mute: 'Timeout',
  kick: 'Kick',
  ban: 'Ban',
};

// Per-user recent message timestamps for spam detection: `${guildId}:${userId}` -> number[]
const spamWindows = new Map();
// Per-user violation counters for strike-threshold rules: `${guildId}:${userId}:${ruleType}` -> count
const strikes = new Map();

async function getRules(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rules;
  }
  const { data, error } = await supabase
    .from('automod_rules')
    .select('*')
    .eq('guild_id', guildId)
    .eq('enabled', true);
  if (error) {
    console.error('[automod] fetch error:', error.message);
    return cached?.rules ?? [];
  }
  cache.set(guildId, { rules: data ?? [], fetchedAt: Date.now() });
  return data ?? [];
}

function invalidateCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

function isExempt(member, rule) {
  const exemptRoles = rule.exempt_roles ?? [];
  if (exemptRoles.length && member.roles.cache.some((r) => exemptRoles.includes(r.id))) {
    return true;
  }
  return false;
}

function extractLinks(content) {
  const re = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+|discord\.com\/invite\/[^\s]+)/gi;
  return content.match(re) ?? [];
}

function detectInvites(content, ownGuildId) {
  const re = /discord(?:app)?\.com\/invite\/([a-zA-Z0-9-]+)|discord\.gg\/([a-zA-Z0-9-]+)/gi;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push(m[1] || m[2]);
  }
  return out;
}

async function takeAction(member, rule, message) {
  const duration = rule.action_duration_seconds ?? null;
  try {
    switch (rule.action) {
      case 'warn': {
        const dm = await member.user.send(
          `⚠️ Warning in **${message.guild.name}**: you triggered the **${rule.rule_type}** auto-mod rule.` +
            (message.content ? `\n\n> ${message.content.slice(0, 500)}` : '')
        ).catch(() => null);
        return dm ? 'warned (DM sent)' : 'warned (DM failed)';
      }
      case 'delete': {
        if (message.deletable) await message.delete().catch(() => {});
        return 'message deleted';
      }
      case 'mute': {
        if (message.deletable) await message.delete().catch(() => {});
        if (typeof member.timeout === 'function' && duration) {
          await member.timeout(duration * 1000, `Automod: ${rule.rule_type}`).catch(() => {});
          return `timed out ${Math.round(duration / 60)}m`;
        }
        return 'message deleted (mute unavailable)';
      }
      case 'kick': {
        if (message.deletable) await message.delete().catch(() => {});
        await member.kick(`Automod: ${rule.rule_type}`).catch(() => {});
        return 'kicked';
      }
      case 'ban': {
        if (message.deletable) await message.delete().catch(() => {});
        await member.ban({ reason: `Automod: ${rule.rule_type}` }).catch(() => {});
        return 'banned';
      }
      default:
        return 'no action';
    }
  } catch (e) {
    return `action failed: ${e.message}`;
  }
}

async function logTrigger(message, rule, actionResult) {
  const logChannelId = rule.log_channel_id;
  if (!logChannelId) return;
  const channel = message.guild.channels.cache.get(logChannelId);
  if (!channel || !channel.isTextBased?.()) return;

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Auto-Mod Action')
    .setColor(0xed4245)
    .addFields(
      { name: 'Rule', value: rule.rule_type, inline: true },
      { name: 'Action', value: ACTIONS[rule.action] ?? rule.action, inline: true },
      { name: 'Result', value: actionResult, inline: true },
      { name: 'User', value: `<@${message.author.id}> (${message.author.tag})`, inline: false },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true }
    )
    .setDescription(message.content ? `**Message:**\n> ${message.content.slice(0, 800)}` : null)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function evaluate(message) {
  if (!message.guild || message.author.bot || message.system) return;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;

  const rules = await getRules(message.guild.id);
  if (!rules.length) return;

  const content = message.content ?? '';
  const lower = content.toLowerCase();

  for (const rule of rules) {
    if (isExempt(member, rule)) continue;
    let triggered = false;

    const cfg = rule.config ?? {};
    switch (rule.rule_type) {
      case 'word_filter': {
        const words = cfg.words ?? [];
        const wildcard = cfg.wildcard ?? true;
        if (words.length === 0) break;
        for (const w of words) {
          if (wildcard) {
            if (lower.includes(w.toLowerCase())) { triggered = true; break; }
          } else {
            const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (re.test(content)) { triggered = true; break; }
          }
        }
        break;
      }
      case 'link_block': {
        const links = extractLinks(content);
        if (links.length === 0) break;
        const mode = cfg.mode ?? 'all';
        const allowlist = cfg.allowlist ?? [];
        if (cfg.block_invites && detectInvites(content, message.guild.id).length) {
          triggered = true;
          break;
        }
        if (mode === 'all') {
          triggered = true;
        } else if (mode === 'allowlist') {
          triggered = links.some((l) => !allowlist.some((d) => l.toLowerCase().includes(d)));
        } else if (mode === 'blocklist') {
          triggered = links.some((l) => allowlist.some((d) => l.toLowerCase().includes(d)));
        }
        break;
      }
      case 'spam': {
        const max = cfg.max_messages ?? 5;
        const perSec = cfg.per_seconds ?? 5;
        const key = `${message.guild.id}:${message.author.id}`;
        const now = Date.now();
        const arr = (spamWindows.get(key) ?? []).filter((t) => now - t < perSec * 1000);
        arr.push(now);
        spamWindows.set(key, arr);
        if (arr.length >= max) {
          const strikeKey = `${key}:spam`;
          const count = (strikes.get(strikeKey) ?? 0) + 1;
          strikes.set(strikeKey, count);
          const threshold = cfg.threshold_count ?? 1;
          spamWindows.delete(key);
          if (count >= threshold) {
            triggered = true;
            strikes.delete(strikeKey);
          }
        }
        break;
      }
      case 'caps_lock': {
        const minLen = cfg.min_length ?? 10;
        const capsPct = cfg.caps_percent ?? 70;
        const letters = content.replace(/[^a-zA-Z]/g, '');
        if (letters.length < minLen) break;
        const caps = letters.replace(/[^A-Z]/g, '').length;
        if ((caps / letters.length) * 100 >= capsPct) triggered = true;
        break;
      }
      case 'mention_spam': {
        const maxMentions = cfg.max_mentions ?? 5;
        let count = message.mentions.users.size;
        if (cfg.include_everyone && (content.includes('@everyone') || content.includes('@here'))) count += 1;
        if (count >= maxMentions) triggered = true;
        break;
      }
      case 'invite_block': {
        const invites = detectInvites(content, message.guild.id);
        if (invites.length === 0) break;
        if (cfg.allow_own_server) {
          triggered = invites.some((code) => code !== message.guild.vanityURLCode);
        } else {
          triggered = true;
        }
        if (triggered && cfg.log_attempts) {
          // logging handled below by logTrigger
        }
        break;
      }
      case 'raid_protection': {
        // Raid protection is join-driven, not message-driven. Skip in message handler.
        break;
      }
      default:
        break;
    }

    if (triggered) {
      const result = await takeAction(member, rule, message);
      await logTrigger(message, rule, result);
      // Only act on the first triggered rule per message to avoid double-punishing
      return;
    }
  }
}

// Clean up spam windows periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of spamWindows.entries()) {
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length === 0) spamWindows.delete(k);
    else spamWindows.set(k, fresh);
  }
}, 60_000).unref();

module.exports = { evaluate, invalidateCache, getRules };
