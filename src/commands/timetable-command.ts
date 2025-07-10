import {AutocompleteFocusedOption, CommandInteraction} from "discord.js";
import {apiConstants, compareTimes, getTodaysTimetable} from "../cache";
import {DayTimetable, TrainTimetableEntry} from "metro-api-client";
import {proxy} from "../bot";
import {locationsMatch} from "../timetable";

function formatTime(time: number | undefined) {
    if (time === undefined) return '--:--:--';
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = time % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function parseTime(timeString: string): number | undefined {
    const parts = timeString.split(':').map(Number);
    if (parts.length !== 2 && parts.length !== 3) return;
    if (parts.some(isNaN)) return;
    let time = 0;
    if (parts[0] < 0 || parts[0] > 23) return; // hours
    if (parts[1] < 0 || parts[1] > 59) return; // minutes
    time += parts[0] * 3600 + parts[1] * 60;
    if (parts.length === 3) {
        // seconds
        if (parts[2] < 0 || parts[2] > 59) return;
        time += parts[2];
    }
    return time;
}

export default async function command(interaction: CommandInteraction) {
    const trns = (interaction.options.get('trns')?.value as string | undefined)?.split(',').map(trn => trn.trim());

    const locationsString = interaction.options.get('locations')?.value as string | undefined;
    const locations = locationsString ? locationsString.split(',').map(loc => loc.trim()) : undefined;

    const destinationsString = interaction.options.get('destinations')?.value as string | undefined;
    const destinations = destinationsString ? destinationsString.split(',').map(dest => dest.trim()) : undefined;

    const inService = interaction.options.get('in-service')?.value as boolean | undefined;

    const onlyTermini = interaction.options.get('only-termini')?.value as boolean | undefined;

    const typesString = interaction.options.get('types')?.value as string | undefined;
    let types: Set<number> | undefined;
    if (typesString) {
        types = new Set();
        for (const typeString of typesString.split(',').map(t => t.trim())) {
            const parsedType = +typeString;
            if (![1, 2, 3, 4].includes(parsedType)) {
                await interaction.reply({
                    content: `Invalid type "${typeString}". Valid types are 1 (depot start), 2 (passenger stop), 3 (ECS or skips), and 4 (depot end).`,
                    flags: ["Ephemeral"]
                }).catch(console.error);
                return;
            }
            types.add(parsedType);
        }
    }

    const startTimeString = interaction.options.get('start-time')?.value as string | undefined;
    let startTime: number | undefined;
    if (startTimeString) {
        startTime = parseTime(startTimeString);
        if (startTime === undefined) {
            await interaction.reply({
                content: `Invalid start time "${startTimeString}". Please use HH:MM[:SS] format.`,
                flags: ["Ephemeral"]
            }).catch(console.error);
            return;
        }
    }

    const endTimeString = interaction.options.get('end-time')?.value as string | undefined;
    let endTime: number | undefined;
    if (endTimeString) {
        endTime = parseTime(endTimeString);
        if (endTime === undefined) {
            await interaction.reply({
                content: `Invalid end time "${endTimeString}". Please use HH:MM[:SS] format.`,
                flags: ["Ephemeral"]
            }).catch(console.error);
            return;
        }
    }

    const dateString = interaction.options.get('date')?.value as string | undefined;
    let date: Date | undefined;
    if (dateString) {
        date = new Date(dateString);
        if (isNaN(date.getTime())) {
            await interaction.reply({
                content: `Invalid date "${dateString}". Please use YYYY-MM-DD format.`,
                flags: ["Ephemeral"]
            }).catch(console.error);
            return;
        }
    }

    const limit = interaction.options.get('limit')?.value as number | undefined;

    const deferReply = interaction.deferReply();

    let dayTimetable: DayTimetable;
    if (date) {
        dayTimetable = await proxy.getTimetable({
            date,
            time: {
                from: startTime,
                to: endTime
            },
            limit,
            trns,
            types: types ? [...types] as (1 | 2 | 3 | 4)[]: undefined,
            locations,
            destinations,
            inService,
            onlyTermini,
        });
    } else {
        // Filter using the cached timetable for today
        const todaysTimetable = await getTodaysTimetable();
        dayTimetable = {
            description: todaysTimetable.description,
            trains: {},
        }
        for (const trn of (trns || Object.keys(todaysTimetable.trains))) {
            const trainTimetable = todaysTimetable.trains[trn];
            dayTimetable.trains[trn] = trainTimetable ? trainTimetable.filter(entry => !(
                (locations && !locations.some(loc => locationsMatch(entry.location, loc))) ||
                (destinations && !destinations.some(dest => locationsMatch(entry.destination, dest))) ||
                (inService !== undefined && entry.inService !== inService) ||
                (onlyTermini && entry.arrivalTime && entry.departureTime) ||
                (types && !types.has(entry.type)) ||
                (startTime !== undefined && compareTimes(entry.arrivalTime || entry.departureTime, startTime) < 0) ||
                (endTime !== undefined && compareTimes(entry.departureTime || entry.arrivalTime, endTime) > 0)
            )) : [];
            if (!(dayTimetable.trains[trn]?.length || trns)) {
                delete dayTimetable.trains[trn];
            } else if (limit) {
                dayTimetable.trains[trn] = startTime === undefined && endTime !== undefined
                    ? dayTimetable.trains[trn].slice(-limit)
                    : dayTimetable.trains[trn].slice(0, limit);
            }
        }
    }

    if (Object.keys(dayTimetable.trains).length === 0) {
        await deferReply;
        await interaction.editReply(`No trains found for the specified criteria.`).catch(console.error);
        return;
    }

    const flattenedEntries: ({ trn: string } & TrainTimetableEntry)[] = [];
    for (const trn of Object.keys(dayTimetable.trains)) {
        for (const entry of dayTimetable.trains[trn]) {
            flattenedEntries.push({
                trn,
                ...entry
            });
        }
    }

    const rows: {
        trn: string;
        location: string;
        rest: string;
        arrivalTime?: number;
        departureTime?: number;
    }[] = [];
    for (const entry of flattenedEntries) {
        let location = entry.location;
        if (!onlyTermini) {
            location += ` towards ${entry.destination}`;
        }
        let rest = `${formatTime(entry.arrivalTime)} / ${formatTime(entry.departureTime)}`;
        if (!types || types.size > 1) {
            rest += ` | Type: ${entry.type}`;
        }
        if (inService === undefined && !entry.inService) {
            rest += ' | Not In Service';
        }
        rows.push({
            trn: `T${entry.trn}`,
            location,
            rest,
            arrivalTime: entry.arrivalTime,
            departureTime: entry.departureTime
        });
    }
    rows.sort((a, b) => compareTimes(a.departureTime || a.arrivalTime, b.arrivalTime || b.departureTime));

    const longestTrnLength = Math.max(...rows.map(row => row.trn.length));
    const longestLocationLength = Math.max(...rows.map(row => row.location.length));
    let codeblockContent = '';
    for (const row of rows) {
        if (!trns || trns.length > 1) {
            codeblockContent += `${row.trn.padEnd(longestTrnLength)} | `;
        }
        codeblockContent += `${row.location.padEnd(longestLocationLength)} | ${row.rest}\n`;
    }

    const footer = `-# Based on ${dayTimetable.description}`;
    const fullContent = `${footer}\n\`\`\`${codeblockContent}\`\`\``;

    await deferReply;
    await interaction.editReply(fullContent.length <= 2000 ? fullContent : {
        content: `The response is too long to display in a message so has been attached as a file. Please open the file or refine your search criteria.\n${footer}`,
        files: [{
            attachment: Buffer.from(codeblockContent, 'utf-8'),
            name: 'timetable.txt'
        }],
    }).catch(console.error);
}

export async function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    let options: string[] = [];
    if (focusedOption.name === 'trns') {
        options = Object.keys((await getTodaysTimetable()).trains);
    }
    if (focusedOption.name === 'locations' || focusedOption.name === 'destinations') {
        options = Object.keys(apiConstants.STATION_CODES);
    }
    if (focusedOption.name === 'types') {
        options = ['1', '2', '3', '4'];
    }
    if (!options.length) return [];
    if (!focusedOption.value) return options;
    const parts = focusedOption.value.split(',');
    const start = parts.pop().trim().toLowerCase();
    const rest = parts.join(',');
    return options.filter(item => item.toLowerCase().startsWith(start))
        .map(item => rest ? `${rest},${item}` : item);
}
