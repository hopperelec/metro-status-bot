import {CommandInteraction, EmbedBuilder} from "discord.js";
import {proxy} from "../bot";
import {FullTrainsResponse, parseLastSeen, parseTimesAPILocation} from "metro-api-client";
import {calculateDifferenceToTimetable, timeDateToStr, timeNumbersToStr} from "../timetable";
import {getStationCode, getTodaysTimetable} from "../cache";

function listTrains(trains: string[]) {
    return trains.length ? trains.sort().join(', ') : 'None';
}

export default async function command(interaction: CommandInteraction) {
    // TODO: This only needs to know in which APIs it is active, might need to add an option in the proxy for presence in props
    const activeTrains = await proxy.getTrains() as FullTrainsResponse;

    const todaysTimetable = await getTodaysTimetable();
    const timetabledTrains = Object.keys(todaysTimetable);
    const activeTrainsFromTimesAPI: string[] = [];
    const activeTrainsFromTrainStatusesAPI: string[] = [];
    const lateTrains: {
        trn: string,
        possibleDelays: number[],
    }[] = [];
    const earlyTrains: {
        trn: string,
        possibleDelays: number[],
    }[] = [];
    const missingTrains = timetabledTrains.filter(trn => !activeTrains.trains[trn]);
    const extraTrains: string[] = [];
    for (const [trn, data] of Object.entries(activeTrains.trains)) {
        if (!(trn in todaysTimetable)) {
            extraTrains.push(trn);
            continue;
        }
        const trainTimetable = todaysTimetable[trn];
        const secsOffTimetable: number[] = [];
        if (data.status.timesAPI) {
            activeTrainsFromTimesAPI.push(trn);
            const parsedLocation = parseTimesAPILocation(data.status.timesAPI.lastEvent.location);
            if (parsedLocation) {
                secsOffTimetable.push(calculateDifferenceToTimetable(
                    trainTimetable,
                    timeDateToStr(data.status.timesAPI.lastEvent.time),
                    getStationCode(parsedLocation.station),
                    getStationCode(data.status.timesAPI.plannedDestinations[0].name)
                ));
            }
        }
        if (data.status.trainStatusesAPI) {
            activeTrainsFromTrainStatusesAPI.push(trn);
            const parsedLastSeen = parseLastSeen(data.status.trainStatusesAPI.lastSeen);
            if (parsedLastSeen) {
                secsOffTimetable.push(calculateDifferenceToTimetable(
                    trainTimetable,
                    timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes),
                    getStationCode(parsedLastSeen.station),
                    getStationCode(data.status.trainStatusesAPI.destination)
                ));
            }
        }
        const minsOffTimetable = [...new Set(
            secsOffTimetable
                .filter(isFinite)
                .map(secs => Math.round(secs / 60))
        )];
        if (minsOffTimetable.some(delay => delay >= 6)) {
            lateTrains.push({
                trn,
                possibleDelays: minsOffTimetable
            });
        }
        if (minsOffTimetable.some(delay => delay <= -6)) {
            earlyTrains.push({
                trn,
                possibleDelays: minsOffTimetable
            });
        }
    }

    lateTrains.sort((a, b) => Math.max(...a.possibleDelays) - Math.max(...b.possibleDelays));
    earlyTrains.sort((a, b) => Math.min(...b.possibleDelays) - Math.min(...a.possibleDelays));

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
                name: `Potentially late trains (${lateTrains.length})`,
                value: lateTrains.map(train => `${train.trn} (${train.possibleDelays.join('m or ')}m)`).join(', ')
            },
            {
                name: `Potentially early trains (${earlyTrains.length})`,
                value: earlyTrains.map(train => `${train.trn} (${train.possibleDelays.join('m or ')}m)`).join(', ')
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
