import {
    ApplicationCommandData,
    AutocompleteFocusedOption,
    ButtonInteraction,
    Client,
    CommandInteraction,
    Interaction
} from "discord.js";
import currentStatusCommand from "./current-status-command";
import statusHistoryCommand from "./status-history-command";
import listActiveCommand from "./list-active-command";
import timetableCommand from "./timetable-command";
import dueTimesCommand from "./due-times-command";
import trainStatusAtTimeCommand from "./train-status-at-time-command";

export type MSBCommand = {
    DEFINITION: ApplicationCommandData,
    execute: (interaction: CommandInteraction) => Promise<void>,
    button?: (interaction: ButtonInteraction, args: string[]) => Promise<void>,
    autoCompleteOptions?: (focusedOption: {name: string, value: string}) => Promise<string[]>
}

const COMMANDS = [
    currentStatusCommand,
    statusHistoryCommand,
    listActiveCommand,
    timetableCommand,
    dueTimesCommand,
    trainStatusAtTimeCommand,
].reduce((acc, command) => {
    acc[command.DEFINITION.name] = command;
    return acc;
}, {} as Record<string, MSBCommand>);

async function getAutocompleteOptions(commandName: string, focusedOption: AutocompleteFocusedOption) {
    const command = COMMANDS[commandName];
    if (command) {
        if (command.autoCompleteOptions) {
            return command.autoCompleteOptions(focusedOption);
        }
        console.error(`Command ${commandName} does not support autocomplete`);
    } else {
        console.error(`No command found for autocomplete option: ${focusedOption.name}`);
    }
    return [];
}

export async function registerCommands(client: Client) {
    await client.application.commands.set(Object.values(COMMANDS).map(command => command.DEFINITION));
}

export async function handleInteraction(interaction: Interaction) {
    if (interaction.isCommand()) {
        const command = COMMANDS[interaction.commandName];
        if (!command) {
            console.error(`Unknown command: ${interaction.commandName}`);
            return;
        }
        await command.execute(interaction).catch(async error => {
            console.error(`Error executing command ${interaction.commandName}:`, error);
            await interaction.reply({
                content: "An error occurred while processing your request. Please let the bot developer know.",
                flags: ["Ephemeral"]
            }).catch(console.error);
        });

    } else if (interaction.isButton()) {
        const [action, ...rest] = interaction.customId.split(':');
        let button: MSBCommand['button'];
        if (action === 'history') {
            button = statusHistoryCommand.button;
        } else if (action === 'due-times') {
            button = dueTimesCommand.button;
        }
        if (!button) {
            console.error(`Unknown button clicked: ${interaction.customId}`);
            return
        }
        await button(interaction, rest).catch(async error => {
            console.error(`Error handling history button:`, error);
            await interaction.reply({
                content: "An error occurred while processing your request. Please let the bot developer know.",
                flags: ["Ephemeral"]
            }).catch(console.error);
        });

    } else if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        const prompt = focusedOption.value.toLowerCase();
        await interaction.respond(
            (await getAutocompleteOptions(interaction.commandName, focusedOption))
                .filter(choice => choice.toLowerCase().includes(prompt))
                .map(choice => ({name: choice, value: choice}))
                .slice(0, 25)
        ).catch(console.error);
    }
}
