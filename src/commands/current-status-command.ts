import {ActionRowBuilder, AutocompleteFocusedOption, ButtonBuilder, ButtonStyle, CommandInteraction} from "discord.js";
import {lastHistoryEntries, getTodaysTimetable, setLastHeartbeat} from "../cache";
import {FullTrainResponse} from "metro-api-client";
import {proxy, trainEmbed} from "../bot";
import {
    calculateDifferenceToTimetableFromTimesAPI,
    calculateDifferenceToTimetableFromTrainStatusesAPI,
    differenceToTimetableToString,
    expectedTrainStateToString,
    getExpectedTrainState,
    secondsSinceMidnight,
} from "../timetable";

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const trainTimetable = (await getTodaysTimetable()).trains[trn];

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
        lines.push(`No train with TRN ${trn} is currently showing on the Pop app.`);
    }

    if (trainTimetable) {
        const timetabledStatus = getExpectedTrainState(trainTimetable, secondsSinceMidnight(new Date()));
        lines.push(`It should ${expectedTrainStateToString(timetabledStatus)}.`);
    } else {
        lines.push("This train is not timetabled to run today.");
    }

    if (train.status) {
        if (trainTimetable) {
            let differenceAccordingToTimes: number = undefined;
            if (train.status.timesAPI) {
                differenceAccordingToTimes = calculateDifferenceToTimetableFromTimesAPI(trainTimetable, train.status.timesAPI);
            }
            let differenceAccordingToStatuses: number = undefined;
            if (train.status.trainStatusesAPI) {
                differenceAccordingToStatuses = calculateDifferenceToTimetableFromTrainStatusesAPI(trainTimetable, train.status.trainStatusesAPI);
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