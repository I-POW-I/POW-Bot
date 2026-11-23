const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const VERIFICATION    = ['None', 'Low', 'Medium', 'High', 'Very High'];
const BOOST_TIER      = { 0: 'No Tier', 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };
const UPLOAD_LIMIT    = { 0: '25 MB', 1: '25 MB', 2: '50 MB', 3: '100 MB' };
const CONTENT_FILTER  = ['Disabled', 'Members without roles', 'All members'];
const NOTABLE_FEATURES = {
  COMMUNITY: 'Community', PARTNERED: 'Partnered', VERIFIED: 'Verified',
  DISCOVERABLE: 'Discoverable', ANIMATED_ICON: 'Animated Icon',
  BANNER: 'Banner', NEWS: 'Announcements', VANITY_URL: 'Vanity URL',
  ROLE_ICONS: 'Role Icons', MONETIZATION_ENABLED: 'Monetization',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show detailed information about this server'),
  async execute(interaction) {
    const { guild } = interaction;
    await guild.fetch();
    const owner    = await guild.fetchOwner().catch(() => null);
    const channels = guild.channels.cache;
    const members  = guild.members.cache;
    const textCh    = channels.filter(c => c.type === 0).size;
    const voiceCh   = channels.filter(c => c.type === 2).size;
    const categoryCh = channels.filter(c => c.type === 4).size;
    const announceCh = channels.filter(c => c.type === 5).size;
    const forumCh   = channels.filter(c => c.type === 15).size;
    const stageCh   = channels.filter(c => c.type === 13).size;
    const cachedBots   = members.filter(m => m.user.bot).size;
    const cachedHumans = members.filter(m => !m.user.bot).size;
    const memberStr = cachedBots > 0
      ? `${guild.memberCount} total · ${cachedHumans} humans · ${cachedBots} bots`
      : `${guild.memberCount}`;
    const emojis   = guild.emojis.cache;
    const animated = emojis.filter(e => e.animated).size;
    const staticE  = emojis.filter(e => !e.animated).size;
    const stickers = guild.stickers?.cache.size ?? 0;
    const boosts   = guild.premiumSubscriptionCount ?? 0;
    const tier     = guild.premiumTier;
    const features = guild.features.map(f => NOTABLE_FEATURES[f]).filter(Boolean).join(', ') || null;
    const vanity   = guild.vanityURLCode ? `discord.gg/${guild.vanityURLCode}` : null;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: 'Owner',           value: owner ? `${owner.user}` : '—', inline: true },
        { name: 'Created',         value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>\n<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Server ID',       value: guild.id, inline: true },
        { name: 'Members',         value: memberStr, inline: false },
        { name: 'Channels',        value: [
            `${textCh} text`, `${voiceCh} voice`, `${categoryCh} categories`,
            announceCh > 0 ? `${announceCh} announcements` : null,
            forumCh > 0 ? `${forumCh} forums` : null,
            stageCh > 0 ? `${stageCh} stages` : null,
          ].filter(Boolean).join(' · '), inline: false },
        { name: 'Roles',           value: `${guild.roles.cache.size - 1}`, inline: true },
        { name: 'Emojis',          value: `${staticE} static · ${animated} animated`, inline: true },
        { name: 'Stickers',        value: `${stickers}`, inline: true },
        { name: 'Boosts',          value: `${boosts} · ${BOOST_TIER[tier] || 'No Tier'}`, inline: true },
        { name: 'Upload Limit',    value: UPLOAD_LIMIT[tier] || '25 MB', inline: true },
        { name: 'Verification',    value: VERIFICATION[guild.verificationLevel] || '—', inline: true },
        { name: '2FA Requirement', value: guild.mfaLevel === 1 ? 'Required' : 'Not required', inline: true },
        { name: 'Content Filter',  value: CONTENT_FILTER[guild.explicitContentFilter] || '—', inline: true },
        { name: 'Locale',          value: guild.preferredLocale || '—', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: guild.name });

    if (features) embed.addFields({ name: 'Features', value: features, inline: false });
    if (vanity)   embed.addFields({ name: 'Vanity URL', value: vanity, inline: true });
    if (guild.description) embed.setDescription(guild.description);
    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));

    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  },
};
