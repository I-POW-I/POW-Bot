const { Events, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { log }          = require('../src/logger');
const { audit }        = require('../src/diagnostics');
const globalConfig     = require('../src/globalConfig');

/** First text channel the bot can actually post in (system channel preferred). */
function findPostableChannel(guild) {
  const me = guild.members.me;
  const ok = (c) => c && c.type === ChannelType.GuildText && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  if (ok(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(ok).sort((a, b) => a.rawPosition - b.rawPosition).first() || null;
}

module.exports = {
  name: Events.GuildCreate,
  once: false,

  async execute(guild) {
    // Servers blocked by the bot owner (/owner server ban) are left immediately
    if (globalConfig.isGuildBanned(guild.id)) {
      audit({ action: 'Left a blocked server', guild, details: 'It tried to add the bot again' });
      try { await guild.leave(); } catch (err) { log('ERROR', 'Could not leave a blocked server', { guild: guild.name, err }); }
      return;
    }

    audit({ action: 'Joined a server', guild, details: `${guild.memberCount} members · owner ${guild.ownerId}` });

    // Tell the admins how to get started (no need for the bot owner to help)
    try {
      const channel = findPostableChannel(guild);
      if (!channel) return;
      await channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('Thanks for adding POW-Bot!')
          .setDescription([
            'A server admin can set everything up in one place:',
            '',
            '**`/setup`** — voice panel, logs, welcome messages, verification, alerts and more, with a checklist and permission checks.',
            '**`/help`** — what every command does.',
            '',
            'Members need nothing — the voice panel does the rest.',
          ].join('\n'))],
      });
    } catch (err) {
      log('WARN', 'Could not post the getting-started message', { guild: guild.name, err });
    }
  },
};
