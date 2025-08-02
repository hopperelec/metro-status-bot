import {EmbedBuilder} from "discord.js";
import {proxy} from "../bot";
import {FullTrainsResponse} from "metro-api-client";
import {
    calculateDelayFromTimesAPI,
    calculateDelayFromTrainStatusesAPI,
    getTimetabledTrains,
    secondsSinceMidnight
} from "../timetable";
import {getTodaysTimetable} from "../cache";
import {MSBCommand} from "./index";

function listTrains(trains: string[]) {
    return trains.length ? trains.sort().join(', ') : 'None';
}

export default {
    DEFINITION: {
        name: 'list-active-trains',
        description: 'Get a list of active trains, and how many timetabled trains are missing',
        contexts: [0, 1, 2]
    },

    execute: async interaction => {
        // TODO: This only needs to know in which APIs it is active, might need to add an option in the proxy for presence in props
        const activeTrains = await proxy.getTrains() as FullTrainsResponse;

        const todaysTimetable = await getTodaysTimetable();
        const timetabledTrains = getTimetabledTrains(todaysTimetable, secondsSinceMidnight());
        const activeTrainsFromTimesAPI: string[] = [];
        const activeTrainsFromTrainStatusesAPI: string[] = [];
        const delayedTrains: {
            trn: string,
            possibleDelays: number[],
        }[] = [];
        const missingTrains = timetabledTrains.filter(trn => !activeTrains.trains[trn]);
        const extraTrains: string[] = [];
        for (const [trn, data] of Object.entries(activeTrains.trains)) {
            if (data.status.timesAPI) {
                activeTrainsFromTimesAPI.push(trn);
            }
            if (data.status.trainStatusesAPI) {
                activeTrainsFromTrainStatusesAPI.push(trn);
            }
            if (!timetabledTrains.includes(trn)) {
                extraTrains.push(trn);
                continue;
            }
            const trainTimetable = todaysTimetable.trains[trn];
            const secsOffTimetable: number[] = [];
            if (data.status.timesAPI) {
                secsOffTimetable.push(calculateDelayFromTimesAPI(trainTimetable, data.status.timesAPI.lastEvent));
            }
            if (data.status.trainStatusesAPI) {
                secsOffTimetable.push(calculateDelayFromTrainStatusesAPI(trainTimetable, data.status.trainStatusesAPI.lastSeen));
            }
            const minsOffTimetable = [...new Set(
                secsOffTimetable
                    .filter(isFinite)
                    .map(secs => Math.round(secs / 60))
            )];
            if (minsOffTimetable.some(delay => Math.abs(delay) >= 6)) {
                delayedTrains.push({
                    trn,
                    possibleDelays: minsOffTimetable
                });
            }
        }
        delayedTrains.sort((a, b) => Math.max(...a.possibleDelays) - Math.max(...b.possibleDelays));

        const embed = new EmbedBuilder()
            .addFields(
                {
                    name: `From times API (${activeTrainsFromTimesAPI.length})`,
                    value: listTrains(activeTrainsFromTimesAPI)
                },
                {
                    name: `From train statuses API (${activeTrainsFromTrainStatusesAPI.length})`,
                    value: listTrains(activeTrainsFromTrainStatusesAPI)
                },
                {
                    name: `Timetabled trains (${timetabledTrains.length})`,
                    value: listTrains(timetabledTrains)
                },
                {
                    name: `Potentially delayed trains (${delayedTrains.length})`,
                    value: delayedTrains.length
                        ? delayedTrains.map(train => `${train.trn} (${train.possibleDelays.map(d => `${d<0?'':'+'}${d}m`).join(' or ')})`).join(', ')
                        : 'None'
                },
                {
                    name: `Missing trains (${missingTrains.length})`,
                    value: listTrains(missingTrains)
                },
                {
                    name: `Extra trains (${extraTrains.length})`,
                    value: listTrains(extraTrains)
                }
            );
        await interaction.reply({ embeds: [embed] });
    }
} as MSBCommand
