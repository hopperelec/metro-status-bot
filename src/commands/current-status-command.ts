import {ActionRowBuilder, AutocompleteFocusedOption, ButtonBuilder, ButtonStyle, CommandInteraction} from "discord.js";
import {getDayTimetable, getStationCode, lastHistoryEntries} from "../cache";
import {FullTrainResponse, parseLastSeen} from "metro-api-client/src";
import {proxy, trainEmbed} from "../bot";
import {
    calculateDifferenceToTimetable, differenceToTimetableToString,
    expectedTrainStateToString,
    getExpectedTrainState,
    timeDateToStr
} from "../timetable";

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const trainTimetable = getDayTimetable()[trn];

    let train: FullTrainResponse;
    try {
        train = await proxy.getTrain(trn) as FullTrainResponse;
    } catch {
        await interaction.reply(`No train with TRN ${trn} is active or timetabled to be running`);
        return;
    }

    let lines: string[] = [];

    if (train.active) {
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

    if (train.active) {
        if (trainTimetable) {
            const currentTime = timeDateToStr(new Date());
            let differenceAccordingToTimes: number = undefined;
            if (train.status.timesAPI) {
                differenceAccordingToTimes = calculateDifferenceToTimetable(
                    trainTimetable,
                    currentTime,
                    getStationCode(train.status.timesAPI.lastEvent.station),
                    getStationCode(train.status.timesAPI.plannedDestinations[0].name)
                );
            }
            let differenceAccordingToStatuses: number = undefined;
            if (train.status.trainStatusesAPI) {
                differenceAccordingToStatuses = calculateDifferenceToTimetable(
                    trainTimetable,
                    currentTime,
                    getStationCode(parseLastSeen(train.status.trainStatusesAPI.lastSeen).station),
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
                    lines.push(`According to the statuses API, this train is ${differenceToTimetableToString(differenceAccordingToTimes)}`);
                }
            }
        }
        await interaction.reply({
            content: lines.join('\n'),
            embeds: [trainEmbed({ trn, date: train.lastChanged, status: train.status })],
        });
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
        });
    }
}

export function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    return Object.keys(lastHistoryEntries);
}