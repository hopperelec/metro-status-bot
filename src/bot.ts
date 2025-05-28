import {config} from "dotenv";
import {Client, EmbedBuilder, Events, GatewayIntentBits, TextChannel} from "discord.js";
import {handleInteraction, registerCommands} from "./commands";
import {
    ActiveTrainHistoryStatus,
    CollatedTrain,
    HeartbeatErrorPayload, HeartbeatWarningsPayload,
    MetroApiClient, TimesApiData
} from "metro-api-client";
import {apiConstants, lastHeartbeat} from "./cache";
import {startMonitoring} from "./monitoring";
import {API_CODES} from "./constants";

config();
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PROXY_BASE_URL = process.env.PROXY_BASE_URL;
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN environment variable must be set");
if (!PROXY_BASE_URL) throw new Error("PROXY_BASE_URL environment variable must be set");

export const proxy = new MetroApiClient(PROXY_BASE_URL);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});
let mainChannel: TextChannel;

export type TrainEmbedData = {
    trn: string;
    status: CollatedTrain | ActiveTrainHistoryStatus;
    date: Date;
}

export function renderTimesAPILastSeen(data: TimesApiData["lastEvent"]) {
    return `${data.type.replaceAll("_", " ")} ${data.location} at ${data.time.toLocaleTimeString('en-GB')}`;
}

export function trainEmbed(train: TrainEmbedData) {
    const embed = new EmbedBuilder()
        .setTitle(`T${train.trn}`);

    let footer = `Last updated ${train.date.toLocaleTimeString()}`;
    if (train.date.getTime() !== lastHeartbeat.getTime()) {
        footer = `${footer}, last checked ${lastHeartbeat.toLocaleTimeString()}`;
    }
    embed.setFooter({ text: footer });

    if (train.status.timesAPI && train.status.trainStatusesAPI) {
        embed.setDescription("This train is showing in both APIs. Sometimes these APIs have conflicting data.\nFields marked with ⌛ are from the times API, and fields marked with 📍 are from the train statuses API.");
    } else if (train.status.timesAPI) {
        embed.setDescription("This train is only showing in the times API (⌛).");
    } else if (train.status.trainStatusesAPI) {
        embed.setDescription("This train is only showing in the train statuses API (📍).");
    }

    if (train.status.timesAPI) {
        const data = train.status.timesAPI;
        embed.addFields(
            {
                name: "⌛ Last seen",
                value: renderTimesAPILastSeen(data.lastEvent)
            },
            {
                name: "⌛ Planned destinations",
                value: data.plannedDestinations.map(dest => `${dest.name} from ${renderPlatformCode(dest.from.platformCode)} at ${dest.from.time.toLocaleTimeString('en-GB')}`).join("\n")
            }
        );
        if ('nextPlatforms' in data) {
            embed.addFields(
                {
                    name: "⌛ Next Platforms",
                    value: data.nextPlatforms.map(nextPlatform => renderPlatformCode(nextPlatform.code)).join(", ")
                }
            );
        }
    }

    if (train.status.trainStatusesAPI) {
        const data = train.status.trainStatusesAPI;
        embed.addFields(
            {
                name: "📍 Current destination",
                value: data.destination
            },
            {
                name: "📍 Last seen",
                value: data.lastSeen
            }
        )
    }
    return embed;
}

function prevTrainStatusEmbed(train: TrainEmbedData) {
    if (train.status)
        return trainEmbed(train).setTitle(`T${train.trn} (previous status)`)
    return new EmbedBuilder()
        .setTitle(`T${train.trn} (previous status)`)
        .setDescription("No previous status available.");
}

const PLATFORM_CODE_REGEX = /^(?<station>[A-Z]{3});(?<platform>[1-4])$/;

function renderPlatformCode(code: string) {
    const parsed = code.match(PLATFORM_CODE_REGEX);
    if (!parsed?.groups) return code;
    return `${apiConstants.STATION_CODES[parsed.groups.station]} P${parsed.groups.platform}`;
}

function listTrns(trns: Set<string>) {
    return `T${Array.from(trns).sort().join(", T")}`;
}

client.once(Events.ClientReady, async () => {
    console.log('Bot is ready!');
    await registerCommands(client);
    if (MAIN_CHANNEL_ID) {
        mainChannel = await client.channels.fetch(MAIN_CHANNEL_ID) as TextChannel;
        if (mainChannel) {
            await startMonitoring();
        } else {
            console.warn("Could not connect to main channel, will not monitor trains.");
        }
    } else {
        console.warn("MAIN_CHANNEL_ID environment variable not set, will not monitor trains.")
    }
});

client.on(Events.InteractionCreate, handleInteraction);

export type AlertSubscription = {
    userId: string;
    trn: string;
}
export const alertSubscriptions: AlertSubscription[] = [];

export async function updateActivity(numActive: number) {
    client.user.setActivity(
        `${numActive} trains`,
        { type: 3 } // Watching
    );
}

client.login(DISCORD_TOKEN).then();

// Heartbeats

export function getAPIName(code: string) {
    return API_CODES[code] || `an unrecognised API (${code})`;
}

export async function announceHeartbeatError(payload: HeartbeatErrorPayload) {
    await mainChannel.send({
        content: `⚠️ An error occurred while fetching or parsing data from ${getAPIName(payload.api)}: ${payload.message}`,
    });
}

export async function announceHeartbeatWarnings(payload: HeartbeatWarningsPayload) {
    const apiName = getAPIName(payload.api);
    await mainChannel.send({
        content: `⚠️ One or more warnings were produced while parsing data from ${apiName}.`,
        files: [
            {
                name: "warnings.txt",
                description: `Warnings from ${apiName}`,
                attachment: Buffer.from(JSON.stringify(payload.warnings, null, 2))
            }
        ]
    });
}

// Either API

export async function announceTrainOnWrongDay(train: TrainEmbedData) {
    await mainChannel.send({
        content: `🤔 Train T${train.trn} is active, but it isn't timetabled for today.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainOnWrongDayDisappeared(train: TrainEmbedData, dayType: string) {
    await mainChannel.send({
        content: `🤔 Train T${train.trn} was active on a ${dayType}, which it isn't timetabled for. However, it has now disappeared. Below is it's status from before it disappeared.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainDuringNightHours(train: TrainEmbedData) {
    await mainChannel.send({
        content: `🌙 Train T${train.trn} is active during night hours.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceUnrecognisedDestinations(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
    unrecognisedDestinations: string[]
) {
    let message: string;
    if (unrecognisedDestinations.length === 1) {
        const destination = unrecognisedDestinations[0];
        if (["terminates", "not in service"].includes(destination.toLowerCase())) {
            message = `is showing as "${destination}" on the Pop app.`;
        } else if (destination.toLowerCase() === "gosforth depot") {
            message = `is heading to ${destination} but is showing on the Pop app.`;
        } else if (destination === "") {
            message = 'is showing a blank destination on the Pop app. This often happens when it is actually heading to Bede.';
        } else {
            message = `has a new unrecognised current and/or planned destination "${destination}"`;
        }
    } else {
        for (const [i, destination] of unrecognisedDestinations.entries()) {
            if (destination === "") {
                unrecognisedDestinations[i] = `*[BLANK]* (often happens when it is actually heading to Bede)`;
            } else {
                unrecognisedDestinations[i] = `"${destination}"`;
            }
        }
        message = `has ${unrecognisedDestinations.length} new unrecognised destinations: ${unrecognisedDestinations.join(", ")}`;
    }
    await mainChannel.send({
        content: `🤔 Train T${currStatus.trn} ${message}`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainAtUnrecognisedStation(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
    station: string,
) {
    const middle = station === "" ? "a blank station" : `an unrecognised station "${station}"`;
    await mainChannel.send({
        content: `🤔 Train T${currStatus.trn} was last seen at ${middle}`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainAtUnrecognisedPlatform(train: TrainEmbedData) {
    await mainChannel.send({
        content: `🤔 Train T${train.trn} is at an unrecognised platform`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtStJamesP2(train: TrainEmbedData) {
    await mainChannel.send({
        content: `🤔 Train T${train.trn} is at St James platform 2. ` +
            'This usually means either:\n' +
            '- it is ending service\n' +
            '- there is a Not In Service train on platform 1.\n' +
            '- there is ongoing maintenance work on platform 1.',
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtSouthShieldsP1(train: TrainEmbedData) {
    await mainChannel.send({
        content: `🤔 Train T${train.trn} is at South Shields platform 1.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceAllTrainsDisappeared() {
    await mainChannel.send({content: `❌ All trains have disappeared!`});
}

export async function announceMultipleDisappearedTrains(trns: Set<string>) {
    await mainChannel.send({
        content: `❌ The following ${trns.size} trains have disappeared simultaneously!\n${listTrns(trns)}`,
    });
}

export async function announceDisappearedTrain(prevStatus: TrainEmbedData) {
    await mainChannel.send({
        content: `❌ Train T${prevStatus.trn} has disappeared!`,
        embeds: [prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceReappearedTrain(train: TrainEmbedData) {
    await mainChannel.send({
        content: `✅ Train T${train.trn} has reappeared!`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceMultipleReappearedTrains(trns: Set<string>) {
    await mainChannel.send({
        content: `✅ The following ${trns.size} trains have reappeared simultaneously!\n${listTrns(trns)}`,
    });
}

export async function alertNowActive(subscription: AlertSubscription, train: TrainEmbedData) {
    const user = await client.users.fetch(subscription.userId);
    let message: string;
    if (train.status.timesAPI && train.status.trainStatusesAPI) {
        message = `🎉 Train T${train.trn} is now active.`;
    } else if (train.status.timesAPI) {
        message = `🎭 Train T${train.trn} is now showing as active, but only on the times API and not the train statuses API.`;
    } else {
        message = `🎭 Train T${train.trn} is now showing as active, but only on the train statuses API and not the times API.`;
    }
    await user.send({
        content: message,
        embeds: [trainEmbed(train)]
    });
}

// Train statuses API

export async function announceUnparseableLastSeen(currStatus: TrainEmbedData) {
    await mainChannel.send({
        content: `⚠️ Not able to parse the last seen message (from the train statuses API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus)]
    });
}

// Times API

export async function announceUnparseableLastEventLocation(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
) {
    await mainChannel.send({
        content: `⚠️ Not able to parse the last event location (from the times API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}
