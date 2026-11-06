/**
 * Bot-owner permissions.
 *
 * OWNER_IDS — comma-separated Discord user IDs with full control (set in Discloud variables)
 * ADMIN_IDS — comma-separated IDs that may restart the bot and read logs, but cannot
 *             ban servers, send announcements or change global settings
 *
 * IDs live only in environment variables, never in the code or the repo.
 */

const parse = (value) =>
  new Set(String(value || '').split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{15,25}$/.test(s)));

const owners = () => parse(process.env.OWNER_IDS);
const admins = () => parse(process.env.ADMIN_IDS);

/** Full bot owner. */
const isOwner = (userId) => owners().has(String(userId));

/** Owner OR selected admin (restart, logs, status). */
const isBotAdmin = (userId) => isOwner(userId) || admins().has(String(userId));

const ownerIds = () => [...owners()];

module.exports = { isOwner, isBotAdmin, ownerIds };
