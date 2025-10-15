import {apiConstants, compareTimes, getTodaysTimetable} from "../cache";
import {DayTimetable, TrainTimetableEntry} from "metro-api-client";
import {proxy} from "../bot";
import {locationsMatch} from "../timetable";
import {MSBCommand} from "./index";
import {normalizeTRN, parseDateOption, parseTimeOption} from "./command-utils";

function formatTime(time: number | undefined) {
    if (time === undefined) return '--:--:--';
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = time % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export default {
    DEFINITION: {
        name: 'train-timetable',
        description: 'Get the timetable for a train',
        options: [
            {
                name: 'trns',
                description: 'One or more Train Running Numbers (TRNs) to get the timetable for, separated by commas.',
                type: 3, // string
                autocomplete: true,
            },
            {
                name: 'locations',
                description: 'One or more locations to filter by, separated by commas. Example: DEP,MMT,HOW_2',
                type: 3, // string
                autocomplete: true,
            },
            {
                name: 'destinations',
                description: 'One or more destinations to filter by, separated by commas. Example: DEP,MMT,HOW_2',
                type: 3, // string
                autocomplete: true,
            },
            {
                name: 'in-service',
                description: 'Filter by whether entries are in service. Defaults to ignoring whether entries are in service.',
                type: 5, // boolean
            },
            {
                name: 'only-termini',
                description: 'Whether to only show when and where the train is terminating. Defaults to false.',
                type: 5, // boolean
            },
            {
                name: 'types',
                description: 'One or more types to filter by. 1 - Depot start, 2 - Passenger stop, 3 - ECS or skips, 4 - Depot end',
                type: 3, // string
                autocomplete: true,
            },
            {
                name: 'start-time',
                description: 'Start time, in HH:MM[:SS] format. Defaults to start of service.',
                type: 3, // string
            },
            {
                name: 'end-time',
                description: 'End time, in HH:MM[:SS] format. Defaults to end of service.',
                type: 3, // string
            },
            {
                name: 'date',
                description: 'Date, in YYYY-MM-DD format. Defaults to today.',
                type: 3, // string
            },
            {
                name: 'limit',
                description: 'Maximum number of entries to list. Applied in reverse if `end-time` is set but not `start-time`',
                type: 4, // integer
                minValue: 1,
            }
        ],
        contexts: [0, 1, 2]
    },

    execute: async interaction => {
        const trns = (interaction.options.get('trns')?.value as string | undefined)?.split(',').map(normalizeTRN);

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
                    });
                    return;
                }
                types.add(parsedType);
            }
        }

        let startTime: number | undefined;
        let endTime: number | undefined;
        try {
            const startTimeString = interaction.options.get('start-time')?.value as string | undefined;
            if (startTimeString) {
                const hms = parseTimeOption(startTimeString);
                startTime = hms.hours * 3600 + hms.minutes * 60 + hms.seconds;
            }
            const endTimeString = interaction.options.get('end-time')?.value as string | undefined;
            if (endTimeString) {
                const hms = parseTimeOption(endTimeString);
                endTime = hms.hours * 3600 + hms.minutes * 60 + hms.seconds;
            }
        } catch (error) {
            await interaction.reply({
                content: error.message,
                flags: ["Ephemeral"]
            });
            return;
        }

        const dateString = interaction.options.get('date')?.value as string | undefined;
        let date: Date | undefined;
        if (dateString) {
            try {
                date = parseDateOption(dateString);
            } catch (error) {
                await interaction.reply({
                    content: error.message,
                    flags: ["Ephemeral"]
                });
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
                if (!trainTimetable) continue;
                let filteredTimetable = trainTimetable.filter(entry => !(
                    (locations && !locations.some(loc => locationsMatch(entry.location, loc))) ||
                    (destinations && !destinations.some(dest => locationsMatch(entry.destination, dest))) ||
                    (inService !== undefined && entry.inService !== inService) ||
                    (onlyTermini && entry.arrivalTime !== undefined && entry.departureTime !== undefined) ||
                    (types && !types.has(entry.type)) ||
                    (startTime !== undefined && compareTimes(entry.arrivalTime || entry.departureTime, startTime) < 0) ||
                    (endTime !== undefined && compareTimes(entry.departureTime || entry.arrivalTime, endTime) > 0)
                ));
                if (!filteredTimetable.length) continue;
                if (limit) {
                    filteredTimetable = startTime === undefined && endTime !== undefined
                        ? filteredTimetable.slice(-limit)
                        : filteredTimetable.slice(0, limit);
                }
                dayTimetable.trains[trn] = filteredTimetable;
            }
        }

        if (Object.keys(dayTimetable.trains).length === 0) {
            await deferReply;
            await interaction.editReply(`No trains found for the specified criteria.`);
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
        });
    },

    autoCompleteOptions: async (focusedOption) => {
        let options: string[] = [];
        if (focusedOption.name === 'trns') {
            options = Object.keys((await getTodaysTimetable()).trains);
        }
        if (focusedOption.name === 'locations' || focusedOption.name === 'destinations') {
            options = Object.keys(apiConstants.LOCATION_ABBREVIATIONS);
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
} as MSBCommand;
