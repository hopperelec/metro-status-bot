import {EmbedBuilder} from "discord.js";
import {proxy} from "../bot";
import {FullTrainsResponse} from "metro-api-client";
import {
    calculateDelayFromTimesApi,
    calculateDelayFromGeoApi,
    getTimetabledTrains,
    secondsSinceMidnight
} from "../timetable";
import {getTodaysTimetable} from "../cache";
import {MSBCommand} from "./index";

function listTrains(trains: string[]): string {
    return trains.length ? trains.sort().join(', ') : 'None';
}

export default {
    DEFINITION: {
        name: 'list-active-trains',
        description: 'List all trains that are (or are meant to be) active right now',
        contexts: [0, 1, 2]
    },

    execute: async interaction => {
        const [activeTrains, todaysTimetable] = await Promise.all([
            // TODO:
            //  This only needs to know in which APIs it is active;
            //  might need to add an option in the proxy for presence in props
            proxy.getTrains().then(response => response as FullTrainsResponse),
            getTodaysTimetable()
        ]);

        const timetabledTrains = getTimetabledTrains(todaysTimetable, secondsSinceMidnight());
        const activeTrainsFromTimesApi: string[] = [];
        const activeTrainsFromGeoApi: string[] = [];
        const delayedTrains: {
            trn: string,
            possibleDelays: number[],
        }[] = [];
        const missingTrains = timetabledTrains.filter(trn => !activeTrains.trains[trn]);
        const extraTrains: string[] = [];
        for (const [trn, data] of Object.entries(activeTrains.trains)) {
            if (data.status.timesAPI) {
                activeTrainsFromTimesApi.push(trn);
            }
            if (data.status.geoAPI) {
                activeTrainsFromGeoApi.push(trn);
            }
            if (!timetabledTrains.includes(trn)) {
                extraTrains.push(trn);
                continue;
            }
            const trainTimetable = todaysTimetable.trains[trn]!;
            const secsOffTimetable: number[] = [];
            if (data.status.timesAPI) {
                secsOffTimetable.push(calculateDelayFromTimesApi(trainTimetable, data.status.timesAPI.lastEvent));
            }
            if (data.status.geoAPI) {
                secsOffTimetable.push(calculateDelayFromGeoApi(trainTimetable, data.status.geoAPI.lastSeen));
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
                    name: `From Times API (${activeTrainsFromTimesApi.length})`,
                    value: listTrains(activeTrainsFromTimesApi)
                },
                {
                    name: `From Geo API (${activeTrainsFromGeoApi.length})`,
                    value: listTrains(activeTrainsFromGeoApi)
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
