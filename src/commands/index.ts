import {
    Client,
    Interaction
} from "discord.js";
import currentStatusCommand, {autoCompleteOptions as currentStatusAutoComplete} from "./current-status-command";
import statusHistoryCommand, {
    autoCompleteOptions as statusHistoryAutoComplete,
    button as historyButtons
} from "./status-history-command";
import listActiveCommand from "./list-active-command";
import timetableCommand, {autoCompleteOptions as timetableAutoComplete} from "./timetable-command";
import {PROPERTY_CHOICES as HISTORY_PROPERTY_CHOICES} from "./status-history-command";
import dueTimesCommand, {
    autoCompleteOptions as dueTimesAutoComplete,
    button as dueTimesButtons
} from "./due-times-command";

export async function registerCommands(client: Client) {
    const TRN_OPTION = {
        name: 'trn',
        description: "Train Running Number",
        required: true,
        type: 3, // string
        autocomplete: true,
    }
    await client.application.commands.set([
        {
            name: 'current-train-status',
            description: 'Get the current status of a train',
            options: [TRN_OPTION],
            contexts: [0, 1, 2]
        },
        {
            name: 'train-status-history',
            description: 'Get the recent activity of a train',
            options: [
                TRN_OPTION,
                {
                    name: 'property',
                    description: 'Property to show the history of',
                    type: 3, // string
                    choices: Object.entries(HISTORY_PROPERTY_CHOICES)
                        .map(([key, choice]) => ({ name: choice.displayName, value: key })),
                    required: true
                },
                {
                    name: 'start-date',
                    description: 'Start date to show history from, in YYYY-MM-DD format. Defaults to today/yesterday if time is set.',
                    type: 3, // string
                },
                {
                    name: 'start-time',
                    description: 'Start time to show history from, in HH:MM[:SS] format',
                    type: 3, // string
                },
                {
                    name: 'end-date',
                    description: 'End date to show history up to, in YYYY-MM-DD format. Defaults to today/yesterday if time is set.',
                    type: 3, // string
                },
                {
                    name: 'end-time',
                    description: 'End time to show history up to, in HH:MM[:SS] format',
                    type: 3, // string
                }
            ],
            contexts: [0, 1, 2]
        },
        {
            name: 'list-active-trains',
            description: 'Get a list of active trains, and how many timetabled trains are missing',
            contexts: [0, 1, 2]
        },
        {
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
        {
            name: 'due-times',
            description: 'Get the next trains due at a station (or a specific platform)',
            options: [
                {
                    name: 'station',
                    description: 'Station code',
                    type: 3, // string
                    required: true,
                    autocomplete: true,
                },
                {
                    name: 'platform',
                    description: 'Platform number',
                    type: 4, // integer
                    minValue: 1,
                    maxValue: 4,
                }
            ],
            contexts: [0, 1, 2]
        }
    ]);
}

export async function handleInteraction(interaction: Interaction) {
    if (interaction.isCommand()) {
        if (interaction.commandName === 'current-train-status') {
            await currentStatusCommand(interaction);
        } else if (interaction.commandName === 'train-status-history') {
            await statusHistoryCommand(interaction);
        } else if (interaction.commandName === 'list-active-trains') {
            await listActiveCommand(interaction);
        } else if (interaction.commandName === 'train-timetable') {
            await timetableCommand(interaction);
        } else if (interaction.commandName === 'due-times') {
            await dueTimesCommand(interaction);
        }

    } else if (interaction.isButton()) {
        const [action, ...rest] = interaction.customId.split(':');
        if (action === 'history') {
            await historyButtons(interaction, rest);
        } else if (action === 'due-times') {
            await dueTimesButtons(interaction, rest);
        } else {
            console.error(`Unknown button clicked: ${interaction.customId}`);
        }

    } else if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        let options: string[];
        if (interaction.commandName === 'current-train-status') {
            options = currentStatusAutoComplete(focusedOption);
        } else if (interaction.commandName === 'train-status-history') {
            options = statusHistoryAutoComplete(focusedOption);
        } else if (interaction.commandName === 'train-timetable') {
            options = await timetableAutoComplete(focusedOption);
        } else if (interaction.commandName === 'due-times') {
            options = await dueTimesAutoComplete(focusedOption);
        }
        const prompt = focusedOption.value.toLowerCase();
        await interaction.respond(
            options
                .filter(choice => choice.toLowerCase().includes(prompt))
                .map(choice => ({name: choice, value: choice}))
                .slice(0, 25)
        ).catch(console.error);
    }
}

const STATION_REGEX = new RegExp(/^([A-Z]{3})( - .+)?/i);
export function parseStationOption(station: string) {
    const match = station.match(STATION_REGEX);
    return match?.[1];
}

const T1xx_REGEX = new RegExp(/^T1\d\d$/i);
export function normalizeTRN(trn: string) {
    trn = trn.trim();
    // Remove the leading 'T' if included
    return T1xx_REGEX.test(trn) ? trn.slice(1) : trn;
}
