const { supabase } = require('./supabase-client');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

// Cache: guildId -> { config, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60_000;

const STYLE_TO_FLAG = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

async function getConfig(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.config;
  const { data, error } = await supabase
    .from('ticket_configs')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    console.error('[tickets] fetch error:', error.message);
    return cached?.config ?? null;
  }
  cache.set(guildId, { config: data, fetchedAt: Date.now() });
  return data;
}

function invalidateCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

async function countOpenTickets(guildId, userId) {
  const { count, error } = await supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('status', 'open');
  if (error) return 0;
  return count ?? 0;
}

async function recordTicket({ guildId, channelId, userId }) {
  await supabase.from('tickets').insert({
    guild_id: guildId,
    channel_id: channelId,
    user_id: userId,
    status: 'open',
  });
}

async function closeTicketRecord(channelId, closedBy) {
  await supabase
    .from('tickets')
    .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: closedBy })
    .eq('channel_id', channelId)
    .eq('status', 'open');
}

async function ensurePanel(client, guildId) {
  const config = await getConfig(guildId);
  if (!config || !config.enabled) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(config.panel_channel_id || config.category_id);
  if (!channel || !channel.isTextBased?.()) return;

  // Reuse existing panel if present
  if (config.panel_message_id) {
    const existing = await channel.messages.fetch(config.panel_message_id).catch(() => null);
    if (existing) return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎫 Support Tickets')
    .setColor(0x3498db)
    .setDescription(
      config.welcome_message ||
        'Need help? Click the button below to open a private ticket with the staff team.'
    )
    .setFooter({ text: 'Ticket System' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_open')
      .setLabel(config.button_label || 'Open Ticket')
      .setEmoji(config.button_emoji || '🎫')
      .setStyle(STYLE_TO_FLAG[config.button_style] ?? ButtonStyle.Primary)
  );

  const sent = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (sent) {
    await supabase
      .from('ticket_configs')
      .update({ panel_message_id: sent.id, panel_channel_id: channel.id })
      .eq('id', config.id);
    invalidateCache(guildId);
  }
}

async function openTicket(interaction) {
  if (interaction.customId !== 'ticket_open') return;
  const config = await getConfig(interaction.guild.id);
  if (!config || !config.enabled) {
    await interaction.reply({ content: 'The ticket system is currently disabled.', ephemeral: true });
    return;
  }

  const openCount = await countOpenTickets(interaction.guild.id, interaction.user.id);
  if (openCount >= (config.max_open_tickets || 1)) {
    await interaction.reply({
      content: `You already have ${openCount} open ticket${openCount !== 1 ? 's' : ''}. Please close one before opening another.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const categoryId = config.category_id || null;
  const overwrites = [
    {
      id: guild.roles.everyone,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  if (config.support_role_id) {
    overwrites.push({
      id: config.support_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `ticket-${interaction.user.username}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: overwrites,
  }).catch(async (e) => {
    await interaction.editReply({ content: `Failed to create ticket channel: ${e.message}` });
    return null;
  });
  if (!channel) return;

  await recordTicket({
    guildId: guild.id,
    channelId: channel.id,
    userId: interaction.user.id,
  });

  const welcome = (config.welcome_message || 'Support will be with you shortly.')
    .replace(/\{user\}/gi, interaction.user.toString())
    .replace(/\{ticket\}/gi, channel.toString());

  const embed = new EmbedBuilder()
    .setTitle(`Ticket — ${interaction.user.tag}`)
    .setColor(0x2ecc71)
    .setDescription(welcome)
    .setFooter({ text: `Ticket for ${interaction.user.id}` })
    .setTimestamp();

  const components = [];
  const rows = [];
  if (config.claim_button) {
    rows.push(new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Secondary));
  }
  if (config.close_button) {
    rows.push(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
  }
  if (rows.length) {
    components.push(new ActionRowBuilder().addComponents(...rows));
  }

  await channel.send({ content: `${interaction.user}${config.support_role_id ? ` <@&${config.support_role_id}>` : ''}`, embeds: [embed], components });
  await interaction.editReply({ content: `Ticket opened: ${channel}` });
}

async function closeTicket(interaction) {
  if (interaction.customId !== 'ticket_close') return;
  const config = await getConfig(interaction.guild.id);
  if (!config) return;

  await interaction.deferReply();
  const channel = interaction.channel;

  let transcriptText = '';
  if (config.transcript_on_close) {
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      transcriptText = sorted
        .map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`)
        .join('\n');
    } catch (e) {
      console.error('[tickets] transcript fetch failed:', e.message);
    }

    if (config.log_channel_id && transcriptText) {
      const logChannel = interaction.guild.channels.cache.get(config.log_channel_id);
      if (logChannel && logChannel.isTextBased?.()) {
        const logEmbed = new EmbedBuilder()
          .setTitle(`Ticket closed — #${channel.name}`)
          .setColor(0xed4245)
          .addFields(
            { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Channel', value: channel.toString(), inline: true }
          )
          .setTimestamp();
        const buffer = Buffer.from(transcriptText, 'utf-8');
        await logChannel.send({
          embeds: [logEmbed],
          files: [{ attachment: buffer, name: `transcript-${channel.name}.txt` }],
        }).catch(() => {});
      }
    }
  }

  await closeTicketRecord(channel.id, interaction.user.id);
  await interaction.editReply({ content: 'Ticket closed. This channel will be deleted in 3 seconds.' });
  setTimeout(() => {
    channel.delete().catch(() => {});
  }, 3000);
}

async function handleButton(interaction) {
  if (!interaction.isButton?.()) return;
  if (interaction.customId === 'ticket_open') return openTicket(interaction);
  if (interaction.customId === 'ticket_close') return closeTicket(interaction);
  if (interaction.customId === 'ticket_claim') {
    await interaction.reply({ content: `Ticket claimed by ${interaction.user}.`, ephemeral: false }).catch(() => {});
  }
}

module.exports = { ensurePanel, handleButton, invalidateCache, getConfig };
