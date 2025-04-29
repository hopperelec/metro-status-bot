import {AutocompleteFocusedOption, CommandInteraction, EmbedBuilder} from "discord.js";
import {
    AllStationsRoute,
    FullArrival,
    FullDeparture, SingleStationRoute, TimetableOptions,
    TrainDirection,
    TrainTimetable,
} from "metro-api-client";
import {DayType} from "../timetable";
import {apiConstants, compareTimes, weekTimetable, timetabledTrns, getTodaysTimetable} from "../cache";
import {TRAIN_DIRECTIONS} from "../constants";
import {proxy} from "../bot";
import {getStationOptions, parseStationOption} from "./index";

function formatTime(time: string) {
    return `${time.slice(0, 2)}:${time.slice(2, 4)}${time.length > 4 ? `:${time.slice(4)}` : ''}`;
}

function formatCachedTimetable(
    trainTimetable: TrainTimetable,
    station?: string,
    direction?: TrainDirection,
) {
    let timeStrings: string[];
    if (station) {
        if (direction) {
            // {time}, {time}, ...
            timeStrings = trainTimetable[direction]
                .map(route => route.stations[station])
                .filter(Boolean)
                .sort(compareTimes)
                .map(time => formatTime(time));
        } else {
            // in @ {time}, out @ {time}, in @ {time}, ...
            timeStrings = TRAIN_DIRECTIONS
                .flatMap(direction =>
                    trainTimetable[direction]
                        .map(entry => entry.stations[station])
                        .filter(Boolean)
                        .map(time => ({ direction, time }))
                )
                .sort((a, b) => compareTimes(a.time, b.time))
                .map(route => `${route.direction} @ ${formatTime(route.time)}`);
        }
    } else {
        // {terminus} @ {time}, {terminus} @ {time}, ...
        timeStrings = (
            direction ? trainTimetable[direction] : [...trainTimetable.in, ...trainTimetable.out]
        ).map(route =>
            Object.entries(route.stations)
                .filter(([station]) => station !== "FORMS")
        ).filter(stations => stations.length)
            .map(stations => {
                stations.sort((a, b) => compareTimes(a[1], b[1]));
                return stations[stations.length - 1];
            })
            .sort((a, b) => compareTimes(a[1], b[1]))
            .map(([station, time]) => `${station} @ ${formatTime(time)}`);
    }
    if (timeStrings.length) return timeStrings.join(', ');
    return '*This train is not timetabled to stop here*';
}

function formatProxyTimetable<Options extends TimetableOptions>(
    trainTimetable: TrainTimetable<Options>,
    {station, direction}: Options
): string {
    let timeStrings: string[];
    if (station) {
        if (direction) {
            // {time}, {time}, ...
            timeStrings = (trainTimetable[direction] as SingleStationRoute[])
                .map(route => route.time)
                .sort(compareTimes)
                .map(time => formatTime(time));
        } else {
            const _trainTimetable = trainTimetable as TrainTimetable<{ station: string; }>
            // in @ {time}, out @ {time}, in @ {time}, ...
            timeStrings = TRAIN_DIRECTIONS
                .flatMap(direction =>
                    _trainTimetable[direction]
                        .map(entry => entry.time)
                        .filter(Boolean)
                        .map(time => ({ direction, time }))
                )
                .sort((a, b) => compareTimes(a.time, b.time))
                .map(route => `${route.direction} @ ${formatTime(route.time)}`);
        }
    } else {
        // {terminus} @ {time}, {terminus} @ {time}, ...
        timeStrings = (
            (direction ? trainTimetable[direction] : [...trainTimetable.in, ...trainTimetable.out]) as AllStationsRoute[]
        ).map(route =>
            Object.entries(route.stations)
                .filter(([station]) => station !== "FORMS")
        ).filter(stations => stations.length)
            .map(stations => {
                stations.sort((a, b) => compareTimes(a[1], b[1]));
                return stations[stations.length - 1];
            })
            .sort((a, b) => compareTimes(a[1], b[1]))
            .map(([station, time]) => `${station} @ ${formatTime(time)}`);
    }
    return timeStrings.join(', ');
}

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const station = interaction.options.get('station')?.value as string | undefined;
    const direction = interaction.options.get('direction')?.value as TrainDirection | undefined;
    const dayType = interaction.options.get('day')?.value as DayType | undefined;
    const dateString = interaction.options.get('date')?.value as string | undefined;

    if (dayType && dateString) {
        await interaction.reply({
            content: "You can only specify either a day type or a date, not both.",
            flags: ["Ephemeral"]
        });
        return;
    }

    let stationCode: string | undefined;
    if (station) {
        stationCode = parseStationOption(station);
        if (!stationCode) {
            await interaction.reply({
                content: "Invalid station",
                flags: ["Ephemeral"]
            });
            return;
        }
    }

    let whenDescription: string;
    let departure: FullDeparture;
    let arrival: FullArrival;
    let timesString: string;
    if (dayType) {
        const trainTimetable = weekTimetable[dayType][trn];
        if (!trainTimetable) {
            await interaction.reply(`Train T${trn} is not timetabled for a ${dayType}.`);
            return;
        }
        whenDescription = `on ${dayType}s`;
        departure = trainTimetable.departure as FullDeparture;
        arrival = trainTimetable.arrival as FullArrival;
        timesString = formatCachedTimetable(trainTimetable, stationCode, direction);
    } else if (dateString) {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            await interaction.reply({
                content: "Invalid date format. Please use YYYY-MM-DD.",
                flags: ["Ephemeral"]
            });
            return;
        }
        const options = { trn, date, station: stationCode, direction }
        let trainTimetable: TrainTimetable<typeof options>;
        try {
            trainTimetable = await proxy.getTimetable(options)
        } catch (e) {
            await interaction.reply(`An error occurred trying to fetch this train's timetable: ${e}`);
            return;
        }
        whenDescription = `on ${dateString}`;
        departure = trainTimetable.departure as FullDeparture;
        arrival = trainTimetable.arrival as FullArrival;
        timesString = formatProxyTimetable(trainTimetable, options);
    } else {
        const trainTimetable = (await getTodaysTimetable())[trn];
        if (!trainTimetable) {
            await interaction.reply(`Train T${trn} is not timetabled for today.`);
            return;
        }
        whenDescription = 'today';
        departure = trainTimetable.departure as FullDeparture;
        arrival = trainTimetable.arrival as FullArrival;
        timesString = formatCachedTimetable(trainTimetable, stationCode, direction);
    }

    let whereDescription: string;
    if (stationCode) {
        const stationName = apiConstants.STATION_CODES[stationCode];
        whereDescription = direction
            ? `at ${stationName} ${direction}-line`
            : `at ${stationName}`;
    } else {
        whereDescription = direction
            ? `${direction}-line termini`
            : 'at termini';
    }

    const embed = new EmbedBuilder()
        .setTitle(`T${trn}'s timetable ${whenDescription}`)
        .setFields([
            { name: 'Departure', value: `${departure.place} @ ${formatTime(departure.time)} via ${departure.via}` },
            { name: 'Arrival', value: `${arrival.place} @ ${formatTime(arrival.time)} via ${arrival.via}` },
            { name: `Times ${whereDescription}`, value: timesString }
        ]);
    await interaction.reply({ embeds: [embed] });
}

export function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    if (focusedOption.name === 'trn') {
        return Array.from(timetabledTrns);
    }
    if (focusedOption.name === 'station') {
        return getStationOptions();
    }
}
