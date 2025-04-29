import {AutocompleteFocusedOption, CommandInteraction, EmbedBuilder} from "discord.js";
import {
    DueTime,
    PlatformNumber, TimesApiData
} from "metro-api-client";
import {proxy, renderTimesAPILastSeen} from "../bot";
import {getStationOptions, parseStationOption} from "./index";
import {apiConstants} from "../cache";

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

export default async function command(interaction: CommandInteraction) {
    const station = interaction.options.get('station', true).value as string;
    let stationCode = parseStationOption(station);
    if (!stationCode) {
        await interaction.reply({
            content: "Invalid station",
            flags: ["Ephemeral"]
        });
        return;
    }
    const platform = interaction.options.get('platform')?.value as PlatformNumber;

    const embedBuilder = new EmbedBuilder();
    let lastChecked: Date;
    if (platform) {
        let dueTimes: (BaseFilteredDueTime & { platform: PlatformNumber })[];
        try {
            if (["MMT", "MTS", "MTW", "MTE"].includes(stationCode)) {
                stationCode = [1, 2].includes(platform) ? "MTS" : "MTW";
            }
            const response = await proxy.getPlatformDueTimes(
                `${stationCode};${platform}`,
                { props: [...PROPS, "dueTimes.platform"] }
            ) as {
                lastChecked: Date,
                dueTimes: typeof dueTimes
            };
            lastChecked = response.lastChecked;
            dueTimes = response.dueTimes;
        } catch (e) {
            await interaction.reply(`An error occurred while fetching the due times: ${e}`);
            return;
        }
        embedBuilder.setTitle(`Next trains due at ${apiConstants.STATION_CODES[stationCode]} platform ${platform}`);
        if (dueTimes.length === 0) {
            embedBuilder.setDescription("*No trains due at this platform.*");
        } else {
            embedBuilder.addFields(
                dueTimes.map((train) => {
                    const lines = summarizeTrain(train.time, train.status);
                    return {
                        name: `**T${train.trn} - ${dueInToString(train.time.dueIn)}**`,
                        value: lines
                    }
                })
            )
        }
    } else {
        let dueTimes: BaseFilteredDueTime[];
        try {
            const response = await proxy.getStationDueTimes(
                stationCode,
                { props: PROPS }
            ) as {
                lastChecked: Date,
                dueTimes: typeof dueTimes
            };
            lastChecked = response.lastChecked;
            dueTimes = response.dueTimes;
        } catch (e) {
            await interaction.reply(`An error occurred while fetching the due times: ${e}`);
            return;
        }
        embedBuilder.setTitle(`Next trains due at ${apiConstants.STATION_CODES[stationCode]}`);
        if (dueTimes.length === 0) {
            embedBuilder.setDescription("*No trains due at this station.*");
        } else {
            embedBuilder.addFields(
                dueTimes.slice(0, 4).map((train) => {
                    const lines = summarizeTrain(train.time, train.status);
                    return {
                        name: `**T${train.trn} - ${dueInToString(train.time.dueIn)}**`,
                        value: lines
                    }
                })
            )
        }
    }
    embedBuilder.setFooter({ text: `Last checked: ${lastChecked.toLocaleDateString('en-GB')}` });
    await interaction.reply({ embeds: [embedBuilder] });
}

export async function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    return getStationOptions();
}
