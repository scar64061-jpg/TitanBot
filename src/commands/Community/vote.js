import { SlashCommandBuilder, EmbedBuilder, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';

const VOTE_ROLE_ID = '1540911228082327572';
const TICK_EMOJI = '✅';
const X_EMOJI = '❌';
const DEFAULT_VOTE_THRESHOLD = 10;
const MIN_VOTE_THRESHOLD = 1;
const MAX_VOTE_THRESHOLD = 100;

// Map to track vote messages: messageId -> vote data
const voteMessages = new Map();

function parseDuration(durationString) {
    const regex = /^(\d+)([smhd])$/;
    const match = durationString.toLowerCase().match(regex);
    
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
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
        .setDescription("Create a vote for a Roblox user")
        .addStringOption((option) =>
            option
                .setName("robloxuser")
                .setDescription("Roblox username to vote for")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addUserOption((option) =>
            option
                .setName("discorduser")
                .setDescription("Discord account of the Roblox user (optional)")
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("profilelink")
                .setDescription("Link to the Roblox profile")
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

    autocomplete: async (interaction) => {
        const focusedValue = interaction.options.getFocused();
        
        if (interaction.options.getFocused(true).name === 'robloxuser') {
            // Get guild members who might have Roblox usernames in their nicknames
            if (!interaction.guild) {
                await interaction.respond([]);
                return;
            }

            try {
                const members = await interaction.guild.members.fetch().catch(() => null);
                if (!members) {
                    await interaction.respond([]);
                    return;
                }

                const choices = [];
                for (const [, member] of members) {
                    const displayName = member.nickname || member.user.username;
                    if (displayName.toLowerCase().startsWith(focusedValue.toLowerCase())) {
                        choices.push({
                            name: displayName,
                            value: displayName
                        });
                    }
                }

                // Limit to 25 choices for Discord API
                await interaction.respond(choices.slice(0, 25));
            } catch (error) {
                logger.error('Autocomplete error:', error);
                await interaction.respond([]);
            }
        } else {
            await interaction.respond([]);
        }
    },

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }

        await InteractionHelper.safeDefer(interaction);

        const robloxUsername = interaction.options.getString("robloxuser");
        const discordUser = interaction.options.getUser("discorduser");
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
            robloxUsername,
            discordUserId: discordUser?.id,
            profileLink,
            duration: durationInput,
            durationMs: voteDuration,
            threshold: customThreshold
        });

        // Build user display text
        const userDisplay = discordUser 
            ? `**${robloxUsername}** (${discordUser})` 
            : `**${robloxUsername}**`;

        // Create the vote embed with grey color scheme
        const embed = new EmbedBuilder()
            .setColor('#808080')
            .setTitle('𝐕𝐎𝐓𝐄')
            .setDescription(`Voting for ${userDisplay}`)
            .addFields(
                {
                    name: 'Roblox Username',
                    value: robloxUsername,
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
            .setFooter({ text: `Started by ${interaction.user.username}` })
            .setTimestamp();

        if (discordUser?.displayAvatarURL) {
            embed.setThumbnail(discordUser.displayAvatarURL({ dynamic: true }));
        }

        if (profileLink) {
            embed.addFields({
                name: 'Profile Link',
                value: `[Click here](${profileLink})`,
                inline: false
            });
        }

        // Send the embed
        let messageReply;
        try {
            messageReply = await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        } catch (error) {
            logger.error('Failed to send vote message:', error);
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to create vote message.' });
        }

        // Initialize vote tracking BEFORE adding reactions
        const voteData = {
            votes: new Map(),
            robloxUsername,
            discordUserId: discordUser?.id,
            guildId: interaction.guild.id,
            messageId: messageReply.id,
            duration: voteDuration,
            threshold: customThreshold,
            startTime: Date.now(),
            started: true
        };
        voteMessages.set(messageReply.id, voteData);

        // React with tick and X - CRITICAL: Must happen AFTER tracking is set up
        try {
            await messageReply.react(TICK_EMOJI);
            await messageReply.react(X_EMOJI);
            logger.info(`Added reactions to vote message ${messageReply.id}`);
        } catch (error) {
            logger.error('Failed to add reactions to vote message:', error);
            voteMessages.delete(messageReply.id);
            return await replyUserError(interaction, { 
                type: ErrorTypes.UNKNOWN, 
                message: 'Failed to add reactions. Make sure the bot has permission to add reactions.' 
            });
        }

        // Setup reaction collector with proper filtering
        const filter = (reaction, user) => {
            // Only count non-bot reactions with the correct emojis
            return !user.bot && (reaction.emoji.name === TICK_EMOJI || reaction.emoji.name === X_EMOJI);
        };

        const collector = messageReply.createReactionCollector({ 
            filter, 
            time: voteDuration,
            dispose: true // Track when reactions are removed
        });

        collector.on('collect', async (reaction, user) => {
            const currentVoteData = voteMessages.get(messageReply.id);
            if (!currentVoteData) return;

            logger.info(`Vote received: ${user.tag} voted ${reaction.emoji.name}`, {
                messageId: messageReply.id,
                userId: user.id,
                emoji: reaction.emoji.name
            });

            // Record the vote
            currentVoteData.votes.set(user.id, reaction.emoji.name);

            // Check if tick votes reached threshold
            const tickVotes = Array.from(currentVoteData.votes.values()).filter(v => v === TICK_EMOJI).length;

            logger.info(`Current vote count: ${tickVotes}/${currentVoteData.threshold}`, {
                messageId: messageReply.id,
                totalVotes: currentVoteData.votes.size
            });

            if (tickVotes >= currentVoteData.threshold) {
                logger.info(`Vote threshold reached for ${currentVoteData.robloxUsername}`, {
                    guildId: interaction.guild.id,
                    tickVotes,
                    threshold: currentVoteData.threshold
                });

                // Give the role to the Discord user if provided
                if (currentVoteData.discordUserId) {
                    try {
                        const guild = interaction.client.guilds.cache.get(currentVoteData.guildId);
                        if (!guild) {
                            logger.error(`Guild ${currentVoteData.guildId} not found`);
                        } else {
                            const member = await guild.members.fetch(currentVoteData.discordUserId).catch(() => null);
                            if (!member) {
                                logger.error(`Member ${currentVoteData.discordUserId} not found in guild ${currentVoteData.guildId}`);
                            } else {
                                const role = guild.roles.cache.get(VOTE_ROLE_ID);
                                if (!role) {
                                    logger.error(`Role ${VOTE_ROLE_ID} not found in guild ${currentVoteData.guildId}`);
                                } else {
                                    await member.roles.add(role);
                                    logger.info(`Successfully added role ${VOTE_ROLE_ID} to user ${currentVoteData.discordUserId}`);
                                }
                            }
                        }
                    } catch (error) {
                        logger.error(`Error giving role:`, error);
                    }
                }

                // Update embed to show completion
                const completedEmbed = new EmbedBuilder()
                    .setColor('#00AA00')
                    .setTitle('𝐕𝐎𝐓𝐄 - ✅ COMPLETED')
                    .setDescription(`✅ **${currentVoteData.robloxUsername}** has been successfully voted in!`)
                    .addFields(
                        {
                            name: 'Final Votes',
                            value: `${TICK_EMOJI} Votes: **${tickVotes}** / ${currentVoteData.threshold}`,
                            inline: false
                        },
                        {
                            name: 'Status',
                            value: 'Threshold reached - Vote passed! ✅',
                            inline: false
                        }
                    )
                    .setFooter({ text: `Vote completed at ${new Date().toLocaleString()}` })
                    .setTimestamp();

                try {
                    await messageReply.edit({ embeds: [completedEmbed] });
                } catch (error) {
                    logger.error('Error updating completion embed:', error);
                }

                collector.stop();
                voteMessages.delete(messageReply.id);
            }
        });

        collector.on('remove', async (reaction, user) => {
            const currentVoteData = voteMessages.get(messageReply.id);
            if (!currentVoteData) return;

            logger.info(`Vote removed: ${user.tag} removed their ${reaction.emoji.name} vote`, {
                messageId: messageReply.id,
                userId: user.id
            });

            // Remove the vote
            currentVoteData.votes.delete(user.id);
        });

        collector.on('end', async (collected, reason) => {
            const currentVoteData = voteMessages.get(messageReply.id);
            if (!currentVoteData) return;

            logger.info(`Vote collector ended for message ${messageReply.id}`, {
                reason,
                totalVotes: currentVoteData.votes.size
            });

            // Get final vote count
            const tickVotes = Array.from(currentVoteData.votes.values()).filter(v => v === TICK_EMOJI).length;
            const xVotes = Array.from(currentVoteData.votes.values()).filter(v => v === X_EMOJI).length;
            const thresholdMet = tickVotes >= currentVoteData.threshold;

            // Update embed to show vote ended
            const endedEmbed = new EmbedBuilder()
                .setColor(thresholdMet ? '#00AA00' : '#AA0000')
                .setTitle('𝐕𝐎𝐓𝐄 - ⏱️ ENDED')
                .setDescription(`Vote for **${currentVoteData.robloxUsername}** has ended.`)
                .addFields(
                    {
                        name: 'Final Results',
                        value: `${TICK_EMOJI} Votes: **${tickVotes}**\n${X_EMOJI} Votes: **${xVotes}**`,
                        inline: false
                    },
                    {
                        name: 'Status',
                        value: thresholdMet 
                            ? `✅ Vote Passed (${tickVotes}/${currentVoteData.threshold})` 
                            : `❌ Vote Failed (${tickVotes}/${currentVoteData.threshold} - ${currentVoteData.threshold - tickVotes} more votes needed)`,
                        inline: false
                    }
                )
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
