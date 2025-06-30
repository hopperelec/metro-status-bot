import {
    ActionRowBuilder,
    AutocompleteFocusedOption, ButtonBuilder,
    ButtonInteraction, ButtonStyle,
    CommandInteraction,
    EmbedBuilder, InteractionUpdateOptions
} from "discord.js";
import {
    DueTime,
    PlatformNumber, TimesApiData
} from "metro-api-client";
import {proxy, renderTimesAPILastSeen} from "../bot";
import {getStationOptions, parseStationOption} from "./index";
import {apiConstants} from "../cache";
import {DUE_TIMES_PAGE_ROWS} from "../constants";

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

function dueInToString(dueIn: number): string {
    switch (dueIn) {
        case -2:
            return "Delayed";
        case -1:
            return "Arrived";
        case 0:
            return "Due";
        case 1:
            return "1 min";
        default:
            return `${dueIn} mins`;
    }
}

function summarizeTrain(time: DueTime, train: BaseFilteredDueTime['status']) {
    const lines = [`**Predicted time:** ${time.actualPredictedTime.toLocaleTimeString('en-GB')}`];
    if (time.actualScheduledTime) {
        lines[0] += ` - **Scheduled time:** ${time.actualScheduledTime.toLocaleTimeString('en-GB')}`;
    }

    let destination = `**Destination:** ⌛ ${train.timesAPI.plannedDestinations[0].name}`;
    if (train.trainStatusesAPI) {
        destination += ` 📍 ${train.trainStatusesAPI.destination}`;
    }
    lines.push(destination);

    lines.push(`**⌛ Last seen:** ${renderTimesAPILastSeen(train.timesAPI.lastEvent)}`);
    if (train.trainStatusesAPI) {
        lines.push(`**📍 Last seen:** ${train.trainStatusesAPI.lastSeen}`);
    }

    return lines.join('\n');
}

function getButtons(context: string, page: number, isLastPage: boolean) {
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

async function getStationPage(
    stationCode: string, page = "first"
) {
    const embedBuilder = new EmbedBuilder();
    let dueTimes: BaseFilteredDueTime[];
    try {
        const response = await proxy.getStationDueTimes(
            stationCode,
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
    embedBuilder.setTitle(`Next trains due at ${apiConstants.STATION_CODES[stationCode]} - Page ${pageNum}/${numPages}`);
    if (dueTimes.length === 0) {
        embedBuilder.setDescription("*No trains due at this station.*");
    } else {
        embedBuilder.addFields(
            dueTimes.slice((pageNum - 1) * DUE_TIMES_PAGE_ROWS, pageNum * DUE_TIMES_PAGE_ROWS).map((train) => {
                const lines = summarizeTrain(train.time, train.status);
                return {
                    name: `**T${train.trn} - ${dueInToString(train.time.dueIn)}**`,
                    value: lines
                }
            })
        )
    }
    return {
        embeds: [embedBuilder],
        components: getButtons(stationCode, pageNum, dueTimes.length <= DUE_TIMES_PAGE_ROWS)
    };
}

async function getPlatformPage(
    stationCode: string, platform: PlatformNumber, page = "first"
) {
    const embedBuilder = new EmbedBuilder();
    let stationName: string;
    let dueTimes: (BaseFilteredDueTime & { platform: PlatformNumber })[];
    try {
        if (["MMT", "MTS", "MTW", "MTE"].includes(stationCode)) {
            stationCode = [1, 2].includes(platform) ? "MTS" : "MTW";
            stationName = "Monument";
        } else {
            stationName = apiConstants.STATION_CODES[stationCode];
        }
        const response = await proxy.getPlatformDueTimes(
            `${stationCode};${platform}`,
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
    embedBuilder.setTitle(`Next trains due at ${stationName} platform ${platform} - Page ${pageNum}/${numPages}`);
    if (dueTimes.length === 0) {
        embedBuilder.setDescription("*No trains due at this platform.*");
    } else {
        embedBuilder.addFields(
            dueTimes.slice((pageNum - 1) * DUE_TIMES_PAGE_ROWS, pageNum * DUE_TIMES_PAGE_ROWS).map((train) => {
                const lines = summarizeTrain(train.time, train.status);
                return {
                    name: `**T${train.trn} - ${dueInToString(train.time.dueIn)}**`,
                    value: lines
                }
            })
        )
    }
    return {
        embeds: [embedBuilder],
        components: getButtons(`${stationCode}:${platform}`, pageNum, dueTimes.length <= DUE_TIMES_PAGE_ROWS)
    };
}

export default async function command(interaction: CommandInteraction) {
    const station = interaction.options.get('station', true).value as string;
    let stationCode = parseStationOption(station);
    if (!stationCode) {
        await interaction.reply({
            content: "Invalid station",
            flags: ["Ephemeral"]
        }).catch(console.error);
        return;
    }
    const platform = interaction.options.get('platform')?.value as PlatformNumber;
    await interaction.reply(
        platform ? await getPlatformPage(stationCode, platform) : await getStationPage(stationCode)
    ).catch(console.error);
}

export async function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    return getStationOptions();
}

export async function button(interaction: ButtonInteraction, rest: string[]) {
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
        await interaction.update(page).catch(console.error);
    } else {
        await interaction.reply({
            ...(typeof page === "object" ? page : { content: page }),
            flags: ["Ephemeral"]
        }).catch(console.error);
    }
}
