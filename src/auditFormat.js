/**
 * Turns the raw changes in a Discord audit log entry into lines a person can read.
 *
 * Discord reports changes as { key, old, new } with internal names and numbers: `system_channel_id: 1571… → 1574…`,
 * `allow: 0 → 1049600`. Here channel ids become channel mentions, permission numbers become a list of permission names,
 * on/off settings read as on/off, and times read as durations.
 */

const { PermissionsBitField } = require('discord.js');
const { duration } = require('./duration');

const LABELS = {
  name: 'Name', topic: 'Topic', description: 'Description', nsfw: 'Age-restricted', position: 'Position', rate_limit_per_user: 'Slowmode',
  bitrate: 'Bitrate', user_limit: 'User limit', parent_id: 'Category', type: 'Type', color: 'Colour', hoist: 'Shown separately', mentionable: 'Mentionable',
  permissions: 'Permissions', allow: 'Allowed', deny: 'Denied', nick: 'Nickname', owner_id: 'Owner',
  system_channel_id: 'System messages channel', rules_channel_id: 'Rules channel', public_updates_channel_id: 'Updates channel',
  afk_channel_id: 'AFK channel', afk_timeout: 'AFK timeout', widget_channel_id: 'Widget channel', widget_enabled: 'Widget',
  verification_level: 'Verification level', default_message_notifications: 'Default notifications', explicit_content_filter: 'Media scanning',
  mfa_level: '2FA for moderators', preferred_locale: 'Language', vanity_url_code: 'Vanity link', system_channel_flags: 'System message options',
  premium_progress_bar_enabled: 'Boost progress bar', default_auto_archive_duration: 'Thread auto-archive', rtc_region: 'Voice region', region: 'Region',
  video_quality_mode: 'Video quality', locked: 'Locked', archived: 'Archived', auto_archive_duration: 'Auto-archive', invitable: 'Anyone can invite',
  max_uses: 'Max uses', max_age: 'Expires after', temporary: 'Temporary', uses: 'Uses', code: 'Code', deaf: 'Server deafened', mute: 'Server muted',
  communication_disabled_until: 'Timed out until', enabled: 'Enabled', unicode_emoji: 'Emoji', icon_hash: 'Icon', banner_hash: 'Banner', splash_hash: 'Invite background',
  applied_tags: 'Tags', available_tags: 'Tags', flags: 'Flags', default_thread_rate_limit_per_user: 'Thread slowmode',
};
const CHANNEL_KEYS = new Set(['system_channel_id', 'rules_channel_id', 'public_updates_channel_id', 'afk_channel_id', 'widget_channel_id', 'parent_id', 'channel_id']);
const USER_KEYS = new Set(['owner_id', 'user_id', 'inviter_id']);
const BOOLEANS = new Set(['nsfw', 'hoist', 'mentionable', 'widget_enabled', 'premium_progress_bar_enabled', 'locked', 'archived', 'invitable', 'temporary', 'deaf', 'mute', 'enabled']);
const ENUMS = {
  verification_level: { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Highest' },
  default_message_notifications: { 0: 'All messages', 1: 'Only @mentions' },
  explicit_content_filter: { 0: 'Off', 1: 'Members without roles', 2: 'All members' },
  mfa_level: { 0: 'Off', 1: 'On' },
  video_quality_mode: { 1: 'Automatic', 2: '720p' },
};
const CHANNEL_TYPES = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement', 10: 'Announcement thread', 11: 'Thread', 12: 'Private thread', 13: 'Stage', 15: 'Forum', 16: 'Media' };
const HIDDEN = new Set(['icon_hash', 'splash_hash', 'banner_hash', 'discovery_splash_hash', 'permission_overwrites', 'id']);

const pretty = (flag) => flag.replace(/([a-z])([A-Z])/g, '$1 $2');
const labelOf = (key) => LABELS[key] || key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** "View Channel, Send Messages" for a permission number. */
function permissionNames(value) {
  try { return new PermissionsBitField(BigInt(value ?? 0)).toArray().map(pretty); } catch { return []; }
}
/** What a permission number gained and lost. */
function permissionDiff(oldValue, newValue) {
  const a = new Set(permissionNames(oldValue)), b = new Set(permissionNames(newValue));
  return { added: [...b].filter(x => !a.has(x)), removed: [...a].filter(x => !b.has(x)) };
}

const short = (text, n = 200) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/** One value, written the way the setting is meant to be read. */
function value(key, v) {
  if (v === null || v === undefined || v === '') return '*none*';
  if (CHANNEL_KEYS.has(key)) return `<#${v}>`;
  if (USER_KEYS.has(key)) return `<@${v}>`;
  if (BOOLEANS.has(key)) return v ? 'on' : 'off';
  if (ENUMS[key] && ENUMS[key][v] !== undefined) return ENUMS[key][v];
  if (key === 'type' && CHANNEL_TYPES[v]) return CHANNEL_TYPES[v];
  if (key === 'color') return Number(v) ? `#${Number(v).toString(16).padStart(6, '0')}` : 'default';
  if (key === 'bitrate') return `${Math.round(Number(v) / 1000)} kbps`;
  if (key === 'rate_limit_per_user' || key === 'default_thread_rate_limit_per_user') return Number(v) ? duration(Number(v) * 1000) : 'off';
  if (key === 'afk_timeout' || key === 'max_age') return Number(v) ? duration(Number(v) * 1000) : key === 'max_age' ? 'never' : 'off';
  if (key === 'default_auto_archive_duration' || key === 'auto_archive_duration') return duration(Number(v) * 60_000);
  if (key === 'communication_disabled_until') { const t = Date.parse(v); return Number.isNaN(t) ? short(v) : `<t:${Math.floor(t / 1000)}:f>`; }
  if (key === 'max_uses') return Number(v) ? String(v) : 'unlimited';
  if (key === 'user_limit') return Number(v) ? String(v) : 'no limit';
  if (Array.isArray(v) || typeof v === 'object') return short(JSON.stringify(v), 120);
  return short(v);
}

/** The lines for one change. */
function line(change) {
  const { key } = change, old = change.old, now = change.new;
  const name = labelOf(key);
  if (key === 'permissions' || key === 'allow' || key === 'deny') {
    const { added, removed } = permissionDiff(old, now);
    const verb = key === 'permissions' ? ['added', 'removed'] : key === 'allow' ? ['now allowed', 'no longer allowed'] : ['now denied', 'no longer denied'];
    const parts = [added.length && `${verb[0]}: ${added.join(', ')}`, removed.length && `${verb[1]}: ${removed.join(', ')}`].filter(Boolean);
    return parts.length ? `**${key === 'permissions' ? 'Permissions' : 'Permission change'}** ${parts.join(' · ')}` : null;
  }
  if (old === undefined || old === null) return `**${name}:** ${value(key, now)}`;
  if (now === undefined || now === null) return `**${name}:** removed (was ${value(key, old)})`;
  return `**${name}:** ${value(key, old)} → ${value(key, now)}`;
}

/** All the readable lines for an entry's changes, skipping noise. */
function lines(entry, { skip = [] } = {}) {
  return (entry.changes || []).filter(c => !HIDDEN.has(c.key) && !skip.includes(c.key)).map(line).filter(Boolean);
}

/**
 * For a permission override added, changed or removed on a channel: who it is for, and what it allows and denies.
 * Returns { who, lines }.
 */
function overwrite(entry) {
  const get = (k) => entry.changes?.find(c => c.key === k);
  const id = get('id')?.new ?? get('id')?.old ?? entry.extra?.id;
  const type = get('type')?.new ?? get('type')?.old ?? entry.extra?.type;
  const isRole = type === 0 || type === 'role' || entry.extra?.constructor?.name === 'Role';
  const who = id ? (isRole ? `<@&${id}>` : `<@${id}>`) : 'someone';
  const out = [];
  for (const key of ['allow', 'deny']) {
    const c = get(key); if (!c) continue;
    const { added, removed } = permissionDiff(c.old ?? 0, c.new ?? 0);
    const word = key === 'allow' ? 'Allowed' : 'Denied';
    if (c.old === undefined || c.old === null) { if (added.length) out.push(`**${word}:** ${added.join(', ')}`); }
    else {
      if (added.length) out.push(`**Now ${word.toLowerCase()}:** ${added.join(', ')}`);
      if (removed.length) out.push(`**No longer ${word.toLowerCase()}:** ${removed.join(', ')}`);
    }
  }
  return { who, lines: out };
}

module.exports = { lines, line, value, labelOf, overwrite, permissionNames, permissionDiff };
