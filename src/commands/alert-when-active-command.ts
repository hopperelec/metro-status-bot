import {AutocompleteFocusedOption, ButtonInteraction, CommandInteraction} from "discord.js";
import {alertSubscriptions, proxy, trainEmbed} from "../bot";
import {FullTrainResponse} from "metro-api-client/src";
import {lastHeartbeat, lastHistoryEntries} from "../cache";
import {getTimetabledTrains} from "../timetable";

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    const train = await proxy.getTrain(trn, { props: ["active"] }) as FullTrainResponse;
    if (train.active) {
        await interaction.reply({
            content: `Train T${trn} is already active`,
            embeds: [trainEmbed({ trn, date: train.lastChanged, status: train.status })]
        });
    } else {
        await subscribeTo(trn, interaction);
    }
}

export function autoCompleteOptions(_: AutocompleteFocusedOption) {
    const activeTrains = Object.keys(lastHistoryEntries);
    return getTimetabledTrains(lastHeartbeat).filter(trn => !activeTrains.includes(trn));
}

export async function subscribeTo(
    trn: string,
    interaction: CommandInteraction | ButtonInteraction
) {
    for (const subscription of alertSubscriptions) {
        if (subscription.userId === interaction.user.id && subscription.trn === trn) {
            await interaction.reply({
                content: `You're already subscribed to train ${trn}.`,
                flags: ['Ephemeral']
            });
            return;
        }
    }
    alertSubscriptions.push({
        userId: interaction.user.id,
        trn: trn
    });
    await interaction.reply({
        content: `I'll DM you when train ${trn} appears.`,
        flags: ['Ephemeral']
    });
}