require('dotenv').config();

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    ContainerBuilder,
    GatewayIntentBits,
    MessageFlags,
    SeparatorBuilder,
    SlashCommandBuilder,
    TextDisplayBuilder
} = require('discord.js');
const axios = require('axios');

const config = require('./config');

const token = process.env.DISCORD_TOKEN || config.token;
const erlcKey = process.env.ERLC_SERVER_KEY || config.erlcKey;
const statusChannelId = process.env.STATUS_CHANNEL_ID || config.statusChannelId;
const updateIntervalMs = 45_000;
const sessionPermissionRoleId = process.env.SESSION_PERMISSION_ROLE_ID;
const sessionPermissionRoleNames = new Set([
    process.env.SESSION_PERMISSION_ROLE_NAME || 'Session Permission Role',
    'Session Startup Permission Role'
]);
const sessionVoteRoleIds = (process.env.SESSION_VOTE_ROLE_IDS || '')
    .split(',')
    .map((roleId) => roleId.trim())
    .filter((roleId) => /^\d{17,20}$/.test(roleId));
const requiredSessionVotes = 3;

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

let monitorMessage = null;
let sessionVoteMessage = null;
let updateInProgress = false;
let sessionOverrideActive = false;
let sessionVoteApproved = false;
let sessionVote = null;
let sessionVoteApprovalTimer = null;
let sessionVoteApprovalPending = false;
let sessionStartTime = null;
let sessionStartedBy = null;
let sessionStartVoterIds = [];
let sessionStartPingPending = false;
let sessionStartInProgress = false;
const processedInteractionIds = new Set();

client.once('clientReady', async () => {
    console.log(`[System] Active as ${client.user.tag}. Starting ER:LC monitor. Build: fixed-utc-timestamps-v1`);
    await registerCommands();
    const statusChannel = await client.channels.fetch(statusChannelId).catch(() => null);
    await findExistingMonitorMessage(statusChannel);
    await removeStaleSessionVoteMessages(statusChannel);
    await updateStatusMessage();
    setInterval(updateStatusMessage, updateIntervalMs);
});

client.on('interactionCreate', async (interaction) => {
    if (processedInteractionIds.has(interaction.id)) return;
    processedInteractionIds.add(interaction.id);
    setTimeout(() => processedInteractionIds.delete(interaction.id), 60_000);

    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'session-manage') {
            await handleSessionManageCommand(interaction);
            return;
        }

        if (!interaction.isButton()) return;

        if (interaction.customId === 'server_closed') {
            await interaction.reply({
                content: 'There is not an active session right now. Please check back later.',
                ephemeral: true
            });
            return;
        }

        if (interaction.customId === 'session_vote_cancel') {
            if (!sessionVote) {
                await interaction.reply({ content: 'There is no active Session Vote.', ephemeral: true });
                return;
            }

            if (!memberHasSessionPermissionRole(interaction.member)) {
                await interaction.reply({
                    content: 'You need the **Session Permission Role** to cancel the vote.',
                    ephemeral: true
                });
                return;
            }

            const sessionWasApproved = sessionOverrideActive;
            clearSessionVoteApprovalTimer();
            sessionVote = null;
            sessionVoteApproved = false;
            sessionVoteApprovalPending = false;
            sessionStartVoterIds = [];
            sessionStartPingPending = false;
            await interaction.update({
                flags: MessageFlags.IsComponentsV2,
                components: [buildSessionVoteContainer(true)]
            });

            if (!sessionWasApproved) await updateStatusMessage();
            return;
        }

        if (interaction.customId === 'session_vote_view') {
            if (!sessionVote) {
                await interaction.reply({ content: 'There is no active Session Vote.', ephemeral: true });
                return;
            }

            const voters = [...sessionVote.voters].map((userId) => `<@${userId}>`);

            await interaction.reply({
                content: voters.length > 0
                    ? `**Session Voters (${voters.length}/${requiredSessionVotes}):**\n${voters.join('\n')}`
                    : '**Session Voters:**\nNo votes have been cast yet.',
                ephemeral: true
            });
            return;
        }

        if (interaction.customId !== 'session_vote_yes') return;

        if (!sessionVote) {
            await interaction.reply({ content: 'There is no active Session Vote.', ephemeral: true });
            return;
        }

        const removingVote = sessionVote.voters.has(interaction.user.id);
        if (removingVote) {
            sessionVote.voters.delete(interaction.user.id);
            sessionVote.yesVotes -= 1;
        } else {
            sessionVote.voters.add(interaction.user.id);
            sessionVote.yesVotes += 1;
        }

        if (removingVote && sessionVote.yesVotes < requiredSessionVotes) {
            clearSessionVoteApprovalTimer();
            sessionVoteApprovalPending = false;
        }

        const voteReachedThreshold = sessionVote.yesVotes >= requiredSessionVotes;
        if (voteReachedThreshold && !sessionVoteApprovalPending) {
            sessionVoteApprovalPending = true;
            scheduleSessionVoteApproval();
            notifySessionVoteStarter();
        }

        const voteContainer = buildSessionVoteContainer();

        await interaction.update({
            flags: MessageFlags.IsComponentsV2,
            components: [voteContainer]
        });

        await interaction.followUp({
            content: removingVote
                ? 'Your vote was removed.'
                : voteReachedThreshold
                    ? 'Three votes reached. The vote will be approved in 10 seconds unless a vote is removed.'
                    : `Your vote was recorded. ${requiredSessionVotes - sessionVote.yesVotes} more vote(s) needed.`,
            ephemeral: true
        });

        if (voteReachedThreshold || removingVote) await updateStatusMessage();
    } catch (error) {
        const validationDetails = error.errors
            ? JSON.stringify(error.errors)
            : error.message;
        const shortValidationDetails = validationDetails.slice(0, 500);
        console.error('[Interaction] Session command failed:', {
            message: error.message,
            code: error.code,
            status: error.status,
            errors: validationDetails
        });
        if (interaction.isRepliable() && interaction.deferred) {
            await interaction.editReply({
                content: `The bot could not process that action (Discord error ${error.code ?? 'unknown'}): ${shortValidationDetails}`
            }).catch(() => null);
        } else if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({
                content: `The bot could not process that action (Discord error ${error.code ?? 'unknown'}): ${shortValidationDetails}`,
                ephemeral: true
            }).catch(() => null);
        }
    }
});

async function registerCommands() {
    const command = new SlashCommandBuilder()
        .setName('session-manage')
        .setDescription('Manage the ER:LC session')
        .addSubcommand((subcommand) => subcommand
            .setName('session-vote')
            .setDescription('Start a Session Vote'))
        .addSubcommand((subcommand) => subcommand
            .setName('session-start')
            .setDescription('Start the session')
            .addStringOption((option) => option
                .setName('mode')
                .setDescription('Choose how the session should start')
                .setRequired(true)
                .addChoices(
                    { name: 'Bypass Vote', value: 'bypass-vote' },
                    { name: 'Require 3 Votes', value: 'require-votes' }
                )));

    try {
        const statusChannel = await client.channels.fetch(statusChannelId);
        await client.application.commands.set([command], statusChannel.guildId);
        console.log('[System] Registered /session-manage on the status channel server.');
    } catch (error) {
        console.error('[System] Slash command registration failed:', error.message);
    }
}

async function handleSessionManageCommand(interaction) {
    const member = interaction.member;
    const hasPermissionRole = memberHasSessionPermissionRole(member);

    if (!hasPermissionRole) {
        await interaction.reply({
            content: 'You need the **Session Permission Role** to use this command.',
            ephemeral: true
        });
        return;
    }

    const action = interaction.options.getSubcommand();
    const mode = action === 'session-start'
        ? interaction.options.getString('mode')
        : null;

    if (action === 'session-start') {
        if (sessionStartInProgress) {
            await interaction.reply({ content: 'Session Start is already being processed.', ephemeral: true });
            return;
        }

        if (mode === 'require-votes' && !sessionVoteApproved) {
            await interaction.reply({
                content: 'The Session Vote must reach 3 votes before the session can start.',
                ephemeral: true
            });
            return;
        }

        sessionStartInProgress = true;

        try {
            clearSessionVoteApprovalTimer();
        sessionVote = null;
        sessionVoteApproved = false;
        sessionVoteApprovalPending = false;
        sessionOverrideActive = true;
        sessionStartTime = Date.now();
        sessionStartedBy = interaction.user.id;
        sessionStartPingPending = sessionStartVoterIds.length > 0;
        await findExistingSessionVoteMessage(interaction.channel);
        await findExistingSessionStartedMessage(interaction.channel);

        const sessionStartedPayload = {
            flags: MessageFlags.IsComponentsV2,
            components: [buildSessionStartedContainer()],
            allowedMentions: { users: [sessionStartedBy] }
        };

        if (sessionVoteMessage) {
            try {
                await sessionVoteMessage.edit(sessionStartedPayload);
                console.log('[Session] Updated the Session Vote message to Session Started.');
            } catch (error) {
                console.error('[Session] Could not edit the Session Vote message:', error.message);
                sessionVoteMessage = null;
                await findExistingSessionVoteMessage(interaction.channel);
                if (sessionVoteMessage) {
                    await sessionVoteMessage.edit(sessionStartedPayload);
                    console.log('[Session] Updated the recovered Session Vote message to Session Started.');
                } else {
                    sessionVoteMessage = await interaction.channel.send(sessionStartedPayload);
                    console.log('[Session] Sent a replacement Session Started message.');
                }
            }
        } else {
            sessionVoteMessage = await interaction.channel.send(sessionStartedPayload);
            console.log('[Session] Sent the Session Started message.');
        }

        await updateStatusMessage();
        await interaction.reply({
            content: mode === 'bypass-vote'
                ? 'The session has started and bypassed the Session Vote.'
                : 'The session has started after the Session Vote was approved.',
            ephemeral: true
        });
        } finally {
            sessionStartInProgress = false;
        }
        return;
    }

    if (action !== 'session-vote') return;

    if (sessionVote) {
        await interaction.reply({ content: 'A Session Vote is already active.', ephemeral: true });
        return;
    }

    await removeStaleSessionVoteMessages(interaction.channel);
    clearSessionVoteApprovalTimer();
    sessionOverrideActive = false;
    sessionVoteApproved = false;
    sessionVoteApprovalPending = false;
    sessionStartTime = null;
    sessionStartedBy = null;
    sessionStartVoterIds = [];
    sessionStartPingPending = false;
    sessionVote = { voters: new Set(), yesVotes: 0, startedBy: interaction.user.id };

    try {
        sessionVoteMessage = await interaction.channel.send({
            flags: MessageFlags.IsComponentsV2,
            components: [buildSessionVoteContainer()],
            allowedMentions: { roles: sessionVoteRoleIds }
        });
        await updateStatusMessage();
        await interaction.reply({
            content: 'The Session Vote has started.',
            ephemeral: true
        });
    } catch (error) {
        sessionVote = null;
        throw error;
    }
}

function clearSessionVoteApprovalTimer() {
    if (sessionVoteApprovalTimer) {
        clearTimeout(sessionVoteApprovalTimer);
        sessionVoteApprovalTimer = null;
    }
}

function scheduleSessionVoteApproval() {
    clearSessionVoteApprovalTimer();
    sessionVoteApprovalTimer = setTimeout(async () => {
        sessionVoteApprovalTimer = null;

        if (!sessionVote || sessionVote.yesVotes < requiredSessionVotes) {
            sessionVoteApprovalPending = false;
            return;
        }

        sessionVoteApproved = true;
        sessionStartVoterIds = [...sessionVote.voters];
        sessionVote = null;
        sessionVoteApprovalPending = false;

        if (sessionVoteMessage) {
            await sessionVoteMessage.edit({
                flags: MessageFlags.IsComponentsV2,
                components: [buildSessionVoteApprovedContainer()]
            }).catch(() => null);
        }

        await updateStatusMessage();
    }, 10_000);
}

async function notifySessionVoteStarter() {
    const starterId = sessionVote?.startedBy;
    if (!starterId) return;

    try {
        const starter = await client.users.fetch(starterId);
        await starter.send('Three votes have been reached for the Session Vote. Approval will complete in 10 seconds unless a vote is removed.');
    } catch (error) {
        console.error('[Session Vote] Could not notify the vote starter:', error.message);
    }
}

function buildSessionStartedContainer() {
    return new ContainerBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## Session Started\nThe session was started by **<@${sessionStartedBy || '0'}>**.\nStarted <t:${Math.floor((sessionStartTime || Date.now()) / 1000)}:t>.`
            )
        );
}

function formatTimestamp(timestamp) {
    return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

async function removeStaleSessionVoteMessages(channel) {
    if (!channel?.isTextBased()) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    const staleMessages = messages.filter((message) => (
        message.author.id === client.user.id
        && message.id !== monitorMessage?.id
        && JSON.stringify(message.components).includes('session_vote_yes')
        && JSON.stringify(message.components).includes('session_vote_cancel')
    ));

    await Promise.all(staleMessages.map((message) => message.delete().catch(() => null)));
}

async function findExistingSessionVoteMessage(channel) {
    if (!channel?.isTextBased()) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    sessionVoteMessage = messages.find((message) => (
        message.author.id === client.user.id
        && JSON.stringify(message.components).includes('session_vote_yes')
        && JSON.stringify(message.components).includes('session_vote_cancel')
    )) || sessionVoteMessage;
}

async function findExistingSessionStartedMessage(channel) {
    if (!channel?.isTextBased()) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    const startedMessages = messages.filter((message) => (
        message.author.id === client.user.id
        && JSON.stringify(message.components).includes('Session Started')
    ));

    const [canonicalMessage, ...duplicateMessages] = [...startedMessages.values()];
    await Promise.all(duplicateMessages.map((message) => message.delete().catch(() => null)));

    if (canonicalMessage) sessionVoteMessage = canonicalMessage;
}

async function findExistingMonitorMessage(channel) {
    if (!channel?.isTextBased()) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    monitorMessage = messages.find((message) => (
        message.author.id === client.user.id
        && JSON.stringify(message.components).includes('ER:LC status')
    )) || null;
}

function memberHasSessionPermissionRole(member) {
    return member?.roles?.cache?.some((role) => (
        (sessionPermissionRoleId && role.id === sessionPermissionRoleId)
        || sessionPermissionRoleNames.has(role.name)
    ));
}

function buildSessionVoteContainer(cancelled = false) {
    const roleMentions = sessionVoteRoleIds.map((roleId) => `<@&${roleId}>`).join(' ');
    const approvalNotice = sessionVoteApprovalPending
        ? '\n\n**Three votes reached. Approval in 10 seconds. Remove a vote to cancel.**'
        : '';
    const container = new ContainerBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                cancelled
                    ? '## Session Vote\nThis Session Vote was cancelled.'
                    : `${roleMentions ? `${roleMentions}\n` : ''}## Session Vote\nVote to start the session. Three votes are required.\n**Votes:** ${sessionVote?.yesVotes ?? 0} / ${requiredSessionVotes}${approvalNotice}`
            )
        );

    if (cancelled) return container;

    return container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('session_vote_yes')
                    .setLabel('Vote')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('session_vote_view')
                    .setLabel('☰')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('session_vote_cancel')
                    .setLabel('Cancel Vote')
                    .setStyle(ButtonStyle.Danger)
            )
        );
}

function buildSessionVoteApprovedContainer() {
    return new ContainerBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                '## Session Vote Approved\nThree votes were confirmed. An authorized staff member can now use Session Start.'
            )
        );
}

async function fetchServerStatus() {
    const response = await axios.get('https://api.erlc.gg/v2/server', {
        headers: {
            'server-key': erlcKey.trim(),
            Accept: 'application/json'
        },
        timeout: 10_000
    });

    return response.data;
}

async function fetchRobloxUsername(ownerId) {
    if (!ownerId) return 'Unavailable';

    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${ownerId}`, {
            timeout: 10_000
        });

        return response.data.name || response.data.displayName || `ID: ${ownerId}`;
    } catch (error) {
        console.error(`[${new Date().toLocaleTimeString()}] Roblox owner lookup failed:`, error.message);
        return `ID: ${ownerId}`;
    }
}

async function updateStatusMessage() {
    if (updateInProgress) return;
    updateInProgress = true;

    try {
        console.log(`[Status] Refreshing. Vote active: ${Boolean(sessionVote)}; Override active: ${sessionOverrideActive}`);
        const targetChannel = await client.channels.fetch(statusChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased()) {
            throw new Error('The configured status channel could not be found or is not text-based.');
        }

        const data = await fetchServerStatus();
        const ownerName = await fetchRobloxUsername(data.OwnerId);
        const statusUpdatedAt = Date.now();
        const voteInProgress = Boolean(sessionVote);
        const voteApproved = !voteInProgress && sessionVoteApproved && !sessionOverrideActive;
        const isActive = !voteInProgress && !voteApproved && (sessionOverrideActive || Number(data.CurrentPlayers) > 0);
        const statusText = voteInProgress
            ? '🟡 Vote in Progress'
            : voteApproved
                ? '🟡 Vote Approved'
            : isActive
                ? '🟢 Active'
                : '🔴 Closed';
        const sessionDetails = sessionStartTime && sessionStartedBy
            ? `\n**Started By:** <@${sessionStartedBy}>\n**Started:** <t:${Math.floor(sessionStartTime / 1000)}:t>`
            : '';
        const voterMentions = sessionStartPingPending
            ? sessionStartVoterIds.map((userId) => `<@${userId}>`).join(' ')
            : '';
        const statusContainer = new ContainerBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `## 🚔 ${data.Name || 'ER:LC Private Server'}\n${voteInProgress ? 'A Session Vote is currently in progress.' : voteApproved ? 'The Session Vote passed. Use Session Start to begin.' : isActive ? 'The server is active.' : 'The server is currently closed.'}${voterMentions ? `\n\n**Session voters:** ${voterMentions}` : ''}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Server Name:** ${data.Name || 'Unavailable'}\n**Server Owner:** ${ownerName}\n**Status:** ${statusText}\n**Players:** ${data.CurrentPlayers ?? 0} / ${data.MaxPlayers ?? 0}\n**Join Key:** \`${data.JoinKey || 'Unavailable'}\`${sessionDetails}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true));

        const joinButton = isActive && data.JoinKey
            ? new ButtonBuilder()
                .setLabel('Join Server')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://policeroleplay.community/join?code=${encodeURIComponent(data.JoinKey)}`)
            : new ButtonBuilder()
                .setCustomId('server_closed')
                .setLabel('Join Server')
                .setStyle(ButtonStyle.Secondary);

        statusContainer.addActionRowComponents(
            new ActionRowBuilder().addComponents(joinButton)
        );

        statusContainer
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `*ER:LC status • Updates every 45 seconds • Last updated: <t:${Math.floor(statusUpdatedAt / 1000)}:t>*`
                )
            );

        await postOrEdit(
            targetChannel,
            statusContainer,
            sessionStartPingPending ? sessionStartVoterIds : []
        );
        sessionStartPingPending = false;
        console.log(`[${new Date().toLocaleTimeString()}] ER:LC Components V2 status updated.`);

    } catch (error) {
        if (error.response) {
            console.error(`[${new Date().toLocaleTimeString()}] ER:LC API request failed (HTTP ${error.response.status}).`);
        } else {
            console.error(`[${new Date().toLocaleTimeString()}] Status update failed:`, error.message);
        }
    } finally {
        updateInProgress = false;
    }
}

async function postOrEdit(channel, components, userMentions = []) {
    const payload = {
        flags: MessageFlags.IsComponentsV2,
        components: [components],
        allowedMentions: {
            roles: sessionVoteRoleIds,
            users: userMentions
        }
    };

    if (!monitorMessage) await findExistingMonitorMessage(channel);

    if (!monitorMessage) {
        monitorMessage = await channel.send(payload);
    } else {
        try {
            await monitorMessage.edit(payload);
        } catch (err) {
            console.error('[Status] Existing message edit failed:', {
                message: err.message,
                code: err.code,
                status: err.status,
                messageId: monitorMessage.id
            });

            monitorMessage = null;
            await findExistingMonitorMessage(channel);

            if (monitorMessage) {
                await monitorMessage.edit(payload);
            } else {
                monitorMessage = await channel.send(payload);
            }
        }
    }
}

const missingConfig = [
    ['DISCORD_TOKEN', token],
    ['ERLC_SERVER_KEY', erlcKey],
    ['STATUS_CHANNEL_ID', statusChannelId]
].filter(([, value]) => !value).map(([name]) => name);

if (missingConfig.length > 0) {
    console.error(`Missing configuration: ${missingConfig.join(', ')}`);
    console.error('Create a file named .env (not .env.example), fill in the values, and run npm start again.');
    process.exit(1);
}

client.login(token).catch((error) => {
    console.error('Discord login failed. Check that DISCORD_TOKEN is valid and has not been revoked.');
    console.error(error.message);
    process.exitCode = 1;
});