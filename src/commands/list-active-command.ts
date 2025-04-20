import {CommandInteraction, EmbedBuilder} from "discord.js";
import {proxy} from "../bot";
import {FullTrainsResponse} from "../../../metro-api-client/src";
import {getTimetabledTrains} from "../timetable";

function listTrains(trains: string[]) {
    return trains.length ? trains.sort().join(', ') : 'None';
}

export default async function command(interaction: CommandInteraction) {
    // TODO: This only needs to know in which APIs it is active, might need to add an option in the proxy for presence in props
    const activeTrains = await proxy.getTrains() as FullTrainsResponse;

    const timetabledTrains = getTimetabledTrains(activeTrains.lastChecked);
    const activeTrainsFromTimesAPI = [];
    const activeTrainsFromTrainStatusesAPI = [];
    const missingTrains = timetabledTrains.filter(trn => !activeTrains.trains[trn]);
    const extraTrains = [];
    for (const [trn, data] of Object.entries(activeTrains.trains)) {
        if (data.status.timesAPI) activeTrainsFromTimesAPI.push(trn);
        if (data.status.trainStatusesAPI) activeTrainsFromTrainStatusesAPI.push(trn);
        if (!timetabledTrains.includes(trn)) extraTrains.push(trn);
    }

    const embed = new EmbedBuilder()
        .addFields(
            {
                name: `From times API (${activeTrainsFromTimesAPI.length})`,
                value: listTrains(activeTrainsFromTimesAPI)
            },
            {
                name: `From train statuses API (${activeTrainsFromTrainStatusesAPI.length})`,
                value: listTrains(activeTrainsFromTrainStatusesAPI)
            },
            {
                name: `Timetabled trains (${timetabledTrains.length})`,
                value: listTrains(timetabledTrains)
            },
            {
                name: `Missing trains (${missingTrains.length})`,
                value: listTrains(missingTrains)
            },
            // TODO: section for trains over a certain threshold off-timetable
            {
                name: `Extra trains (${extraTrains.length})`,
                value: listTrains(extraTrains)
            }
        );
    await interaction.reply({ embeds: [embed] });
}
