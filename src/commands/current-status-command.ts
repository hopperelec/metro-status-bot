import {ActionRowBuilder, AutocompleteFocusedOption, ButtonBuilder, ButtonStyle, CommandInteraction} from "discord.js";
import {getStationCode, lastHistoryEntries, getTodaysTimetable, setLastHeartbeat} from "../cache";
import {FullTrainResponse, parseLastSeen, parseTimesAPILocation} from "metro-api-client";
import {proxy, trainEmbed} from "../bot";
import {
    calculateDifferenceToTimetable, differenceToTimetableToString,
    expectedTrainStateToString,
    getExpectedTrainState,
    timeDateToStr, timeNumbersToStr
} from "../timetable";

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const trainTimetable = (await getTodaysTimetable())[trn];

    let train: FullTrainResponse;
    try {
        train = await proxy.getTrain(trn) as FullTrainResponse;
    } catch {
        await interaction.reply(`No train with TRN ${trn} is active or timetabled to be running`).catch(console.error);
        return;
    }

    // The embed will be sent before the stream receives the update,
    // so we set this in advance to make sure the embed shows the current time.
    setLastHeartbeat(train.lastChecked);

    let lines: string[] = [];

    if (train.status) {
        lines.push(`This train is currently active, and it's current status is shown below.`);
    } else {
        lines.push(`No train with TRN ${trn} is currently running.`);
    }

    if (trainTimetable) {
        const timetabledStatus = getExpectedTrainState(trainTimetable, timeDateToStr(new Date()));
        lines.push(`It should be ${expectedTrainStateToString(timetabledStatus)}`);
    } else {
        lines.push("This train is not timetabled to run today.");
    }

    if (train.status) {
        if (trainTimetable) {
            let differenceAccordingToTimes: number = undefined;
            timesAPI: if (train.status.timesAPI) {
                const parsedLocation = parseTimesAPILocation(train.status.timesAPI.lastEvent.location);
                if (!parsedLocation) break timesAPI;
                differenceAccordingToTimes = calculateDifferenceToTimetable(
                    trainTimetable,
                    timeDateToStr(train.status.timesAPI.lastEvent.time),
                    getStationCode(parsedLocation.station, parsedLocation.platform),
                    getStationCode(train.status.timesAPI.plannedDestinations[0].name)
                );
            }
            let differenceAccordingToStatuses: number = undefined;
            trainStatusesAPI: if (train.status.trainStatusesAPI) {
                const parsedLastSeen = parseLastSeen(train.status.trainStatusesAPI.lastSeen);
                if (!parsedLastSeen) break trainStatusesAPI;
                differenceAccordingToStatuses = calculateDifferenceToTimetable(
                    trainTimetable,
                    timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes),
                    getStationCode(parsedLastSeen.station, parsedLastSeen.platform),
                    getStationCode(train.status.trainStatusesAPI.destination)
                );
            }
            if (
                (!(Number.isFinite(differenceAccordingToTimes) || Number.isFinite(differenceAccordingToStatuses))) ||
                (Math.abs(differenceAccordingToTimes - differenceAccordingToStatuses) < 60)
            ) {
                lines.push(`This train is ${differenceToTimetableToString(differenceAccordingToTimes)}`);
            } else {
                if (differenceAccordingToTimes !== undefined) {
                    lines.push(`According to the times API, this train is ${differenceToTimetableToString(differenceAccordingToTimes)}`);
                }
                if (differenceAccordingToStatuses !== undefined) {
                    lines.push(`According to the statuses API, this train is ${differenceToTimetableToString(differenceAccordingToStatuses)}`);
                }
            }
        }
        await interaction.reply({
            content: lines.join('\n'),
            embeds: [trainEmbed({ trn, date: train.lastChanged, status: train.status })],
        }).catch(console.error);
    } else {
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`alert:${trn}`)
                    .setLabel('Alert me when this train appears')
                    .setStyle(ButtonStyle.Primary)
            );

        await interaction.reply({
            content: lines.join('\n'),
            components: [row]
        }).catch(console.error);
    }
}

export function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    return Object.keys(lastHistoryEntries);
}