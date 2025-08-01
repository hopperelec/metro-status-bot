import {AutocompleteFocusedOption, ButtonInteraction, CommandInteraction} from "discord.js";
import {alertSubscriptions, proxy} from "../bot";
import {getTodaysTimetable, lastHeartbeat, lastHistoryEntries} from "../cache";
import {getTimetabledTrains, secondsSinceMidnight} from "../timetable";
import {CollatedTrain} from "metro-api-client";
import {trainEmbed} from "../rendering";
import {normalizeTRN} from "./index";

export default async function command(interaction: CommandInteraction) {
    const trn = normalizeTRN(interaction.options.get('trn').value as string);
    const train = await proxy.getTrain(trn, { props: ["status", "lastChanged"] }) as {
        lastChanged: Date
        status?: CollatedTrain
    }
    if (train.status) {
        await interaction.reply({
            content: `Train T${trn} is already active`,
            embeds: [trainEmbed({ trn, date: train.lastChanged as Date, status: train.status })]
        }).catch(console.error);
    } else {
        await subscribeTo(trn, interaction);
    }
}

export async function autoCompleteOptions(_: AutocompleteFocusedOption) {
    const activeTrains = Object.keys(lastHistoryEntries);
    return getTimetabledTrains(await getTodaysTimetable(), secondsSinceMidnight(lastHeartbeat)).filter(trn => !activeTrains.includes(trn));
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
            }).catch(console.error);
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
    }).catch(console.error);
}