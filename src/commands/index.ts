import {
    Client,
    Interaction
} from "discord.js";
import currentStatusCommand, {autoCompleteOptions as currentStatusAutoComplete} from "./current-status-command";
import statusHistoryCommand, {
    autoCompleteOptions as statusHistoryAutoComplete,
    getHistoryPage
} from "./status-history-command";
import alertWhenActiveCommand, {
    autoCompleteOptions as alertWhenActiveAutoComplete,
    subscribeTo
} from "./alert-when-active-command";
import listActiveCommand from "./list-active-command";
import timetableCommand, {autoCompleteOptions as timetableAutoComplete} from "./timetable-command";
import {PROPERTY_CHOICES as HISTORY_PROPERTY_CHOICES} from "./status-history-command";

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
            options: [TRN_OPTION]
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
                }
            ]
        },
        {
            name: 'alert-when-train-active',
            description: 'Get notified via a DM when a train appears',
            options: [TRN_OPTION]
        },
        {
            name: 'list-active-trains',
            description: 'Get a list of active trains, and how many timetabled trains are missing'
        },
        {
            name: 'train-timetable',
            description: 'Get the timetable for a train',
            options: [
                TRN_OPTION,
                {
                    name: 'station',
                    description: 'Station code',
                    type: 3, // string
                    autocomplete: true,
                },
                {
                    name: 'direction',
                    description: 'Direction on the line',
                    type: 3, // string
                    choices: [
                        {name: 'In (towards South Shields or South Hylton)', value: 'in'},
                        {name: 'Out (towards St James or Airport)', value: 'out'}
                    ]
                },
                {
                    name: 'day',
                    description: 'Day of the week.',
                    type: 3, // string
                    choices: [
                        {name: 'Weekday', value: 'weekday'},
                        {name: 'Saturday', value: 'saturday'},
                        {name: 'Sunday', value: 'sunday'}
                    ]
                },
                {
                    name: 'date',
                    description: 'Date, in YYYY-MM-DD format. Defaults to today.',
                    type: 3, // string
                }
            ]
        }
    ]);
}

export async function handleInteraction(interaction: Interaction) {
    if (interaction.isCommand()) {
        if (interaction.commandName === 'current-train-status') {
            await currentStatusCommand(interaction);
        } else if (interaction.commandName === 'train-status-history') {
            await statusHistoryCommand(interaction);
        } else if (interaction.commandName === 'alert-when-train-active') {
            await alertWhenActiveCommand(interaction);
        } else if (interaction.commandName === 'list-active-trains') {
            await listActiveCommand(interaction);
        } else if (interaction.commandName === 'train-timetable') {
            await timetableCommand(interaction);
        }

    } else if (interaction.isButton()) {
        const [action, ...rest] = interaction.customId.split(':');
        if (action === 'alert') {
            await subscribeTo(rest[0], interaction);
        } else if (action === 'history') {
            // TODO: Only allow the user who ran the command to navigate the original message.
            // For other users, an ephemeral message should be created with the new page.
            const [trn, property, ...extra] = rest;
            await interaction.update(await getHistoryPage(trn, property, extra.join(':')));
        }

    } else if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        let options: string[];
        if (interaction.commandName === 'current-train-status') {
            options = currentStatusAutoComplete(focusedOption);
        } else if (interaction.commandName === 'train-status-history') {
            options = statusHistoryAutoComplete(focusedOption);
        } else if (interaction.commandName === 'alert-when-train-active') {
            options = alertWhenActiveAutoComplete(focusedOption);
        } else if (interaction.commandName === 'train-timetable') {
            options = timetableAutoComplete(focusedOption);
        }
        const prompt = focusedOption.value.toLowerCase();
        await interaction.respond(
            options
                .filter(choice => choice.toLowerCase().startsWith(prompt))
                .map(choice => ({name: choice, value: choice}))
                .slice(0, 25)
        )
    }
}
