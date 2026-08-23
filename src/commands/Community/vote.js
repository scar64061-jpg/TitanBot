import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';

const VOTE_ROLE_ID = '1540911228082327572';
const TICK_EMOJI = '✅';
const X_EMOJI = '❌';
const DEFAULT_VOTE_THRESHOLD = 10;
const MIN_VOTE_THRESHOLD = 1;
const MAX_VOTE_THRESHOLD = 100;

// Map to track vote messages: messageId -> { votes: Map(userId -> emoji), votedUserName: string }
const voteMessages = new Map();

function parseDuration(durationString) {
    const regex = /^(\d+)([smhd])$/;
    const match = durationString.toLowerCase().match(regex);
    
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
        case 's': return value * 1000; // seconds
        case 'm': return value * 60 * 1000; // minutes
        case 'h': return value * 60 * 60 * 1000; // hours
        case 'd': return value * 24 * 60 * 60 * 1000; // days
        default: return null;
    }
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName("vote")
        .setDescription("Create a vote for a user")
        .addUserOption((option) =>
            option
                .setName("user")
                .setDescription("The user to vote for")
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName("profilelink")
                .setDescription("Profile link for the user")
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("duration")
                .setDescription("How long the vote runs (e.g., 30m, 2h, 1d). Default: 24h")
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName("threshold")
                .setDescription(`Number of votes needed to pass (1-${MAX_VOTE_THRESHOLD}). Default: ${DEFAULT_VOTE_THRESHOLD}`)
                .setMinValue(MIN_VOTE_THRESHOLD)
                .setMaxValue(MAX_VOTE_THRESHOLD)
                .setRequired(false)
        ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        await InteractionHelper.safeDefer(interaction);

        const targetUser = interaction.options.getUser("user");
        const profileLink = interaction.options.getString("profilelink");
        const durationInput = interaction.options.getString("duration") || "24h";
        const customThreshold = interaction.options.getInteger("threshold") || DEFAULT_VOTE_THRESHOLD;

        // Validate threshold
        if (customThreshold < MIN_VOTE_THRESHOLD || customThreshold > MAX_VOTE_THRESHOLD) {
            return await replyUserError(interaction, { 
                type: ErrorTypes.USER_INPUT, 
                message: `Threshold must be between ${MIN_VOTE_THRESHOLD} and ${MAX_VOTE_THRESHOLD}` 
            });
        }

        // Parse duration
        let voteDuration = parseDuration(durationInput);
        if (!voteDuration) {
            return await replyUserError(interaction, { 
                type: ErrorTypes.USER_INPUT, 
                message: 'Invalid duration format. Use: 30s, 5m, 2h, or 1d (e.g., "30m", "2h", "1d")' 
            });
        }

        logger.info(`Vote command executed`, {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            targetUserId: targetUser.id,
            profileLink,
            duration: durationInput,
            durationMs: voteDuration,
            threshold: customThreshold
        });

        // Create the vote embed with grey color scheme
        const embed = new EmbedBuilder()
            .setColor('#808080') // Grey color
            .setTitle('𝐕𝐎𝐓𝐄')
            .setDescription(`Voting for **${targetUser.username}**`)
            .addFields(
                {
                    name: 'User',
                    value: profileLink 
                        ? `[${targetUser.username}](${profileLink})`
                        : `**${targetUser.username}**`,
                    inline: false
                },
                {
                    name: 'Duration',
                    value: `⏱️ ${formatDuration(voteDuration)}`,
                    inline: true
                },
                {
                    name: 'Required Votes',
                    value: `${customThreshold} ✅`,
                    inline: true
                }
            )
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
            .setFooter({ text: `Started by ${interaction.user.username}` })
            .setTimestamp();

        // Send the embed
        const messageReply = await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

        // React with tick and X
        try {
            await messageReply.react(TICK_EMOJI);
            await messageReply.react(X_EMOJI);
        } catch (error) {
            logger.error('Failed to add reactions to vote message:', error);
        }

        // Initialize vote tracking for this message
        voteMessages.set(messageReply.id, {
            votes: new Map(),
            votedUserName: targetUser.username,
            votedUserId: targetUser.id,
            guildId: interaction.guild.id,
            messageId: messageReply.id,
            duration: voteDuration,
            threshold: customThreshold,
            startTime: Date.now()
        });

        // Setup reaction collector
        const filter = (reaction, user) => {
            return !user.bot && (reaction.emoji.name === TICK_EMOJI || reaction.emoji.name === X_EMOJI);
        };

        const collector = messageReply.createReactionCollector({ filter, time: voteDuration });

        collector.on('collect', async (reaction, user) => {
            const voteData = voteMessages.get(messageReply.id);
            if (!voteData) return;

            voteData.votes.set(user.id, reaction.emoji.name);

            // Check if tick votes reached threshold
            const tickVotes = Array.from(voteData.votes.values()).filter(v => v === TICK_EMOJI).length;

            if (tickVotes >= voteData.threshold) {
                logger.info(`Vote threshold reached for user ${voteData.votedUserId}`, {
                    guildId: interaction.guild.id,
                    tickVotes,
                    threshold: voteData.threshold,
                    targetUser: voteData.votedUserName
                });

                // Give the role to the voted user
                try {
                    const guild = interaction.client.guilds.cache.get(voteData.guildId);
                    if (!guild) {
                        logger.error(`Guild ${voteData.guildId} not found`);
                        return;
                    }

                    const member = await guild.members.fetch(voteData.votedUserId);
                    if (!member) {
                        logger.error(`Member ${voteData.votedUserId} not found in guild ${voteData.guildId}`);
                        return;
                    }

                    const role = guild.roles.cache.get(VOTE_ROLE_ID);
                    if (!role) {
                        logger.error(`Role ${VOTE_ROLE_ID} not found in guild ${voteData.guildId}`);
                        return;
                    }

                    await member.roles.add(role);
                    logger.info(`Successfully added role ${VOTE_ROLE_ID} to user ${voteData.votedUserId}`);

                    // Update embed to show completion
                    const completedEmbed = new EmbedBuilder()
                        .setColor('#808080') // Grey color
                        .setTitle('𝐕𝐎𝐓𝐄 - ✅ COMPLETED')
                        .setDescription(`✅ **${voteData.votedUserName}** has been successfully voted in!`)
                        .addFields(
                            {
                                name: 'Final Votes',
                                value: `${TICK_EMOJI} Votes: **${tickVotes}** / ${voteData.threshold}`,
                                inline: false
                            },
                            {
                                name: 'Status',
                                value: 'Threshold reached - Role assigned!',
                                inline: false
                            }
                        )
                        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                        .setFooter({ text: `Vote completed at ${new Date().toLocaleString()}` })
                        .setTimestamp();

                    await messageReply.edit({ embeds: [completedEmbed] });
                    collector.stop();
                    voteMessages.delete(messageReply.id);

                } catch (error) {
                    logger.error(`Error giving role to user ${voteData.votedUserId}:`, error);
                }
            }
        });

        collector.on('end', async () => {
            const voteData = voteMessages.get(messageReply.id);
            if (!voteData) return;

            logger.info(`Vote collector ended for message ${messageReply.id}`);

            // Get final vote count
            const tickVotes = Array.from(voteData.votes.values()).filter(v => v === TICK_EMOJI).length;
            const xVotes = Array.from(voteData.votes.values()).filter(v => v === X_EMOJI).length;
            const thresholdMet = tickVotes >= voteData.threshold;

            // Update embed to show vote ended
            const endedEmbed = new EmbedBuilder()
                .setColor('#808080') // Grey color
                .setTitle('𝐕𝐎𝐓𝐄 - ⏱️ ENDED')
                .setDescription(`Vote for **${voteData.votedUserName}** has ended.`)
                .addFields(
                    {
                        name: 'Final Results',
                        value: `${TICK_EMOJI} Votes: **${tickVotes}**\n${X_EMOJI} Votes: **${xVotes}**`,
                        inline: false
                    },
                    {
                        name: 'Status',
                        value: thresholdMet 
                            ? `✅ Threshold reached (${tickVotes}/${voteData.threshold})` 
                            : `❌ Threshold not reached (${tickVotes}/${voteData.threshold} - ${voteData.threshold - tickVotes} more votes needed)`,
                        inline: false
                    }
                )
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `Vote ended at ${new Date().toLocaleString()}` })
                .setTimestamp();

            try {
                await messageReply.edit({ embeds: [endedEmbed] });
            } catch (error) {
                logger.error(`Error updating vote end embed:`, error);
            }

            voteMessages.delete(messageReply.id);
        });

    }, { type: 'command', commandName: 'vote' })
};
