import {CommandInteraction, EmbedBuilder} from "discord.js";
import {proxy} from "../bot";
import {FullTrainsResponse, parseLastSeen, parseTimesAPILocation} from "metro-api-client";
import {calculateDifferenceToTimetable, getExpectedTrainState, timeDateToStr, timeNumbersToStr} from "../timetable";
import {getStationCode, getTodaysTimetable} from "../cache";

function listTrains(trains: string[]) {
    return trains.length ? trains.sort().join(', ') : 'None';
}

export default async function command(interaction: CommandInteraction) {
    // TODO: This only needs to know in which APIs it is active, might need to add an option in the proxy for presence in props
    const activeTrains = await proxy.getTrains() as FullTrainsResponse;

    const time = timeDateToStr(new Date());

    const todaysTimetable = await getTodaysTimetable();
    const timetabledTrains = Object.entries(todaysTimetable)
        .filter(([_, trainTimetable]) => getExpectedTrainState(trainTimetable, time).state === "active")
        .map(([trn]) => trn);
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
        const trainTimetable = todaysTimetable[trn];
        const secsOffTimetable: number[] = [];
        if (data.status.timesAPI) {
            const parsedLocation = parseTimesAPILocation(data.status.timesAPI.lastEvent.location);
            if (parsedLocation) {
                secsOffTimetable.push(calculateDifferenceToTimetable(
                    trainTimetable,
                    timeDateToStr(data.status.timesAPI.lastEvent.time),
                    getStationCode(parsedLocation.station, parsedLocation.platform),
                    getStationCode(data.status.timesAPI.plannedDestinations[0].name)
                ));
            }
        }
        if (data.status.trainStatusesAPI) {
            const parsedLastSeen = parseLastSeen(data.status.trainStatusesAPI.lastSeen);
            if (parsedLastSeen) {
                secsOffTimetable.push(calculateDifferenceToTimetable(
                    trainTimetable,
                    timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes),
                    getStationCode(parsedLastSeen.station, parsedLastSeen.platform),
                    getStationCode(data.status.trainStatusesAPI.destination)
                ));
            }
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
    await interaction.reply({ embeds: [embed] }).catch(console.error);
}
