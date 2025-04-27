import {
    ActionRowBuilder,
    AutocompleteFocusedOption,
    BaseMessageOptionsWithPoll,
    ButtonBuilder, ButtonStyle,
    CommandInteraction
} from "discord.js";
import {trainsWithHistory} from "../cache";
import {HISTORY_PAGE_ROWS} from "../constants";
import {proxy} from "../bot";
import {TrainHistoryOptions} from "metro-api-client";

function formatDate(date: Date): string {
    return date.toLocaleString("en-GB", {
        timeZone: "Europe/London",
        dateStyle: "short",
        timeStyle: "medium"
    });
}

export async function getHistoryPage(trn: string, extra: string = "last"): Promise<BaseMessageOptionsWithPoll> {
    // TODO: Add option for what value to view the history of (e.g: timesAPI, trainStatusesAPI, nextStations)

    let time: TrainHistoryOptions["time"];
    let timeDescription: string;
    if (extra.startsWith("refresh:")) {
        extra = extra.slice(8);
    }
    if (extra === "first") {
        time = { from: new Date(0) };
        timeDescription = "Earliest entries";
    } else if (extra === "last") {
        timeDescription = "Latest entries";
    } else if (extra.startsWith("...")) {
        time = { to: new Date(+extra.slice(3)) };
        timeDescription = `Until ${formatDate(time.to)}`;
    } else if (extra.endsWith("...")) {
        time = { from: new Date(+extra.slice(0, -3)) };
        timeDescription = `From ${formatDate(time.from)}`;
    } else {
        throw new Error(`Invalid extra string: ${extra}`);
    }

    const history = await proxy.getTrainHistory(trn, {
        time,
        limit: HISTORY_PAGE_ROWS,
        active: false
    });

    const prevButton = new ButtonBuilder()
        .setLabel("◀️")
        .setStyle(ButtonStyle.Primary);
    const nextButton = new ButtonBuilder()
        .setLabel("▶️")
        .setStyle(ButtonStyle.Primary);

    const lines = [`**Train T${trn} history - ${timeDescription}**`];
    if (history.extract.length) {
        for (const entry of history.extract) {
            lines.push(
                `- [${new Date(entry.date).toTimeString().split(' ')[0]}] ` +
                (entry.active ? "Active" : "Inactive")
            )
        }
        prevButton
            .setCustomId(`history:${trn}:...${history.extract[0].date.getTime() - 1}`)
            .setDisabled(
                time && "from" in time &&
                history.summary.firstEntry.getTime() >= time.from.getTime()
            );
        nextButton.setCustomId(`history:${trn}:${history.extract[history.extract.length - 1].date.getTime() + 1}...`);
    } else {
        lines.push("*No entries found matching the criteria.*");
        prevButton.setCustomId(`history:${trn}:prev`).setDisabled(true);
        nextButton.setCustomId(`history:${trn}:next`).setDisabled(true);
    }

    return {
        content: lines.join("\n"),
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`history:${trn}:first`)
                    .setLabel("⏮️")
                    .setStyle(ButtonStyle.Primary),
                prevButton,
                new ButtonBuilder()
                    .setCustomId(`history:${trn}:refresh:${extra}`)
                    .setLabel("🔄")
                    .setStyle(ButtonStyle.Primary),
                nextButton,
                new ButtonBuilder()
                    .setCustomId(`history:${trn}:last`)
                    .setLabel("⏭️")
                    .setStyle(ButtonStyle.Primary)
                // TODO: Add a button to view the history to/from a specific time, using a modal
            )
        ]
    }
}

export default async function command(interaction: CommandInteraction) {
    const trn = interaction.options.get('trn').value as string;
    await interaction.reply(await getHistoryPage(trn));
}

export function autoCompleteOptions(focusedOption: AutocompleteFocusedOption) {
    return Array.from(trainsWithHistory);
}