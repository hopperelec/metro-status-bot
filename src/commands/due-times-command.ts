import {
    ActionRowBuilder, ButtonBuilder,
    ButtonStyle, EmbedBuilder, InteractionUpdateOptions
} from "discord.js";
import {DueTime, PlatformNumber, TimesApiData, TrainTimetable} from "metro-api-client";
import {proxy} from "../bot";
import {MSBCommand} from "./index";
import {apiConstants, getTodaysTimetable} from "../cache";
import {DUE_TIMES_PAGE_ROWS, MONUMENT_STATION_CODES} from "../constants";
import {dueInToString, renderPlatform, renderTimesAPILastEvent, renderTrainStatusesAPILastSeen} from "../rendering";
import {parseStationOption} from "./command-utils";

const PROPS = [
    "lastChecked",
    "dueTimes.trn",
    "dueTimes.time",
    "dueTimes.status.timesAPI.lastEvent",
    "dueTimes.status.timesAPI.plannedDestinations",
    "dueTimes.status.trainStatusesAPI",
];

type BaseFilteredDueTime = {
    trn: string,
    time: DueTime,
    status: {
        timesAPI: {
            lastEvent: TimesApiData['lastEvent'],
            plannedDestinations: TimesApiData['plannedDestinations']
        },
        trainStatusesAPI?: {
            lastSeen: string,
            destination: string
        }
    }
}

function summarizeTrain(time: DueTime, train: BaseFilteredDueTime['status'], trainTimetable: TrainTimetable) {
    const lines = [`**Predicted time:** ${time.actualPredictedTime.toLocaleTimeString('en-GB')}`];
    if (time.actualScheduledTime) {
        lines[0] += ` - **Scheduled time:** ${time.actualScheduledTime.toLocaleTimeString('en-GB')}`;
    }

    let destination = `**Destination:** ⌛ ${train.timesAPI.plannedDestinations[0].name}`;
    if (train.trainStatusesAPI) {
        destination += ` 📍 ${train.trainStatusesAPI.destination}`;
    }
    lines.push(destination);

    lines.push(`**⌛ Last seen:** ${renderTimesAPILastEvent(train.timesAPI.lastEvent, trainTimetable)}`);
    if (train.trainStatusesAPI) {
        lines.push(`**📍 Last seen:** ${renderTrainStatusesAPILastSeen(train.trainStatusesAPI.lastSeen, trainTimetable)}`);
    }

    return lines.join('\n');
}

function createButtons(context: string, page: number, isLastPage: boolean) {
    return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`due-times:${context}:first`)
                .setLabel("⏮️")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`due-times:${context}:${page - 1}`)
                .setLabel("◀️")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === 1),
            new ButtonBuilder()
                .setCustomId(`due-times:${context}:${page}`)
                .setLabel("🔄")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`due-times:${context}:${page + 1}`)
                .setLabel("▶️")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(isLastPage),
            new ButtonBuilder()
                .setCustomId(`due-times:${context}:last`)
                .setLabel("⏭️")
                .setStyle(ButtonStyle.Primary)
        )
    ]
}

async function getStationPage(stationCode: string, page = "first") {
    const embedBuilder = new EmbedBuilder();
    let dueTimes: (BaseFilteredDueTime & { platform: number })[];
    try {
        const response = await proxy.getStationDueTimes(
            stationCode,
            { props: [...PROPS, "dueTimes.platform"] }
        ) as {
            lastChecked: Date,
            dueTimes: typeof dueTimes
        };
        embedBuilder.setFooter({ text: `Last checked: ${response.lastChecked.toLocaleTimeString('en-GB')}` });
        dueTimes = response.dueTimes;
    } catch (e) {
        return `An error occurred while fetching the due times: ${e}`;
    }
    const numPages = Math.ceil(dueTimes.length / DUE_TIMES_PAGE_ROWS);
    let pageNum: number;
    if (page === "first") pageNum = 1;
    else if (page === "last") pageNum = numPages;
    else pageNum = Math.min(+page, numPages);
    embedBuilder.setTitle(`Next trains due at ${apiConstants.LOCATION_ABBREVIATIONS[stationCode] || stationCode} - Page ${pageNum}/${numPages}`);
    if (dueTimes.length === 0) {
        embedBuilder.setDescription("*No trains due at this station.*");
    } else {
        const todaysTimetable = await getTodaysTimetable();
        embedBuilder.addFields(
            dueTimes.slice((pageNum - 1) * DUE_TIMES_PAGE_ROWS, pageNum * DUE_TIMES_PAGE_ROWS).map(dueTime => {
                const lines = summarizeTrain(dueTime.time, dueTime.status, todaysTimetable.trains[dueTime.trn]);
                return {
                    name: `**P${dueTime.platform} - T${dueTime.trn} - ${dueInToString(dueTime.time.dueIn)}**`,
                    value: lines
                }
            })
        )
    }
    return {
        embeds: [embedBuilder],
        components: createButtons(stationCode, pageNum, dueTimes.length <= DUE_TIMES_PAGE_ROWS)
    };
}

async function getPlatformPage(stationCode: string, platform: PlatformNumber, page = "first") {
    const embedBuilder = new EmbedBuilder();
    let dueTimes: (BaseFilteredDueTime & { platform: PlatformNumber })[];
    try {
        if (MONUMENT_STATION_CODES.includes(stationCode)) {
            stationCode = platform === 1 || platform === 2 ? "MTS" : "MTW";
        }
        const response = await proxy.getPlatformDueTimes(
            `${stationCode};${platform}`,
            { props: PROPS }
        ) as {
            lastChecked: Date,
            dueTimes: typeof dueTimes
        };
        embedBuilder.setFooter({ text: `Last checked: ${response.lastChecked.toLocaleTimeString('en-GB')}` });
        dueTimes = response.dueTimes;
    } catch (e) {
        return `An error occurred while fetching the due times: ${e}`;
    }
    const numPages = Math.ceil(dueTimes.length / DUE_TIMES_PAGE_ROWS);
    let pageNum: number;
    if (page === "first") pageNum = 1;
    else if (page === "last") pageNum = numPages;
    else pageNum = Math.min(+page, numPages);
    embedBuilder.setTitle(`Next trains due at ${renderPlatform(stationCode, platform)} - Page ${pageNum}/${numPages}`);
    if (dueTimes.length === 0) {
        embedBuilder.setDescription("*No trains due at this platform.*");
    } else {
        const todaysTimetable = await getTodaysTimetable();
        embedBuilder.addFields(
            dueTimes.slice((pageNum - 1) * DUE_TIMES_PAGE_ROWS, pageNum * DUE_TIMES_PAGE_ROWS).map((train) => {
                const lines = summarizeTrain(train.time, train.status, todaysTimetable.trains[train.trn]);
                return {
                    name: `**T${train.trn} - ${dueInToString(train.time.dueIn)}**`,
                    value: lines
                }
            })
        )
    }
    return {
        embeds: [embedBuilder],
        components: createButtons(`${stationCode}:${platform}`, pageNum, dueTimes.length <= DUE_TIMES_PAGE_ROWS)
    };
}

export default {
    DEFINITION: {
        name: 'due-times',
        description: 'Get the next trains due at a station (or a specific platform)',
        options: [
            {
                name: 'station',
                description: 'Station code',
                type: 3, // string
                required: true,
                autocomplete: true,
            },
            {
                name: 'platform',
                description: 'Platform number',
                type: 4, // integer
                minValue: 1,
                maxValue: 4,
            }
        ],
        contexts: [0, 1, 2]
    },

    execute: async interaction => {
        const stationCode = parseStationOption(interaction.options.get('station', true).value as string);
        if (stationCode) {
            const platform = interaction.options.get('platform')?.value as PlatformNumber;
            await interaction.reply(
                platform ? await getPlatformPage(stationCode, platform) : await getStationPage(stationCode)
            );
        } else {
            await interaction.reply({
                content: "Invalid station",
                flags: ["Ephemeral"]
            });
        }
    },

    autoCompleteOptions: async () => apiConstants.PASSENGER_STOPS
        .filter((code) =>
            code !== "MTE" && // Alias for MTW
            code !== "MTN" && // Alias for MTS
            code !== "PJC"    // Not shown in times API
        ).map(code => `${code} - ${apiConstants.LOCATION_ABBREVIATIONS[code]}`),

    button: async (interaction, rest) => {
        let page: string | InteractionUpdateOptions;
        if (rest.length === 3) {
            page = await getPlatformPage(rest[0], +rest[1] as PlatformNumber, rest[2]);
        } else if (rest.length === 2) {
            page = await getStationPage(rest[0], rest[1]);
        } else {
            console.error(`Unknown button clicked: ${interaction.customId}`);
            return;
        }
        if (interaction.user === interaction.message.interactionMetadata.user) {
            await interaction.update(page);
        } else {
            await interaction.reply({
                ...(typeof page === "object" ? page : { content: page }),
                flags: ["Ephemeral"]
            });
        }
    }
} as MSBCommand;
