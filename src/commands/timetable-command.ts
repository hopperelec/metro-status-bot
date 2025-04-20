import {AutocompleteFocusedOption, CommandInteraction, EmbedBuilder} from "discord.js";
import {TrainDirection} from "metro-api-client/src";
import {DayType, getDayType} from "../timetable";
import {apiConstants, compareTimes, timetable, timetabledTrns} from "../cache";
import {TRAIN_DIRECTIONS} from "../constants";

function formatTime(time: string) {
    return `${time.slice(0, 2)}:${time.slice(2, 4)}${time.length > 4 ? `:${time.slice(4)}` : ''}`;
}

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const station = interaction.options.get('station')?.value as string;
    const direction = interaction.options.get('direction')?.value as TrainDirection
    let dayType = interaction.options.get('day')?.value as DayType;
    if (!dayType) {
        dayType = getDayType();
    }

    const trainTimetable = timetable[dayType][trn];
    if (!trainTimetable) {
        await interaction.reply(`Train T${trn} is not timetabled for a ${dayType}.`);
        return;
    }

    let times: string[];
    if (station) {
        if (direction) {
            // {time}, {time}, ...
            times = trainTimetable[direction]
                .map(route => route.stations[station])
                .filter(Boolean)
                .sort(compareTimes)
                .map(time => formatTime(time));
        } else {
            // in @ {time}, out @ {time}, in @ {time}, ...
            times = TRAIN_DIRECTIONS
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
        times = (
            direction
                ? trainTimetable[direction]
                : [...trainTimetable.in, ...trainTimetable.out]
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

    const embed = new EmbedBuilder()
        .setTitle(`T${trn} Timetable for ${dayType}s`)
        .setFields([
            { name: 'Departure', value: `${trainTimetable.departure.place} @ ${formatTime(trainTimetable.departure.time)} via ${trainTimetable.departure.via}` },
            { name: 'Arrival', value: `${trainTimetable.arrival.place} @ ${formatTime(trainTimetable.arrival.time)} via ${trainTimetable.arrival.via}` },
            { name: 'Times', value: times.length ? times.join(", ") : 'No times found matching the criteria' }
        ])
        .setFooter({ text: `Filters: ${station || 'All stations'}, ${direction || 'In and Out'}` });
    await interaction.reply({ embeds: [embed] });
}

export function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    if (focusedOption.name === 'trn') {
        return Array.from(timetabledTrns);
    }
    if (focusedOption.name === 'station') {
        return Object.keys(apiConstants.STATION_CODES);
    }
}