import {CommandInteraction} from "discord.js";
import {getTodaysTimetable} from "../cache";
import {proxy} from "../bot";
import {
    getExpectedTrainState,
    secondsSinceMidnight,
} from "../timetable";
import {renderExpectedTrainState, trainEmbed} from "../rendering";
import {normalizeTRN} from "./index";
import {isToday} from "../utils";

const TIME_REGEX = new RegExp(/^(\d\d):(\d\d)(?::(\d\d))?$/);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export default async function command(interaction: CommandInteraction) {
    const date = new Date();

    const timeOption = interaction.options.get('time').value as string | null;
    const timeMatch = timeOption ? TIME_REGEX.exec(timeOption) : null;
    if (!timeMatch) {
        await interaction.reply("Invalid time format. Please use HH:MM[:SS] format.").catch(console.error);
        return;
    }
    const hours = +timeMatch[1];
    if (hours < 0 || hours > 23) {
        await interaction.reply("Invalid hour; it must be between 00 and 23.").catch(console.error);
        return;
    }
    const minutes = +timeMatch[2];
    if (minutes < 0 || minutes > 59) {
        await interaction.reply("Invalid minute; it must be between 00 and 59.").catch(console.error);
        return;
    }
    const seconds = timeMatch[3] ? +timeMatch[3] : 0;
    if (seconds < 0 || seconds > 59) {
        await interaction.reply("Invalid second; it must be between 00 and 59.").catch(console.error);
        return;
    }
    date.setHours(hours, minutes, seconds, 0);

    const dateOption = interaction.options.get('date')?.value as string | undefined;
    if (dateOption) {
        if (!DATE_REGEX.test(dateOption)) {
            await interaction.reply("Invalid date format. Please use YYYY-MM-DD format.").catch(console.error);
            return;
        }
        const [year, month, day] = dateOption.split('-').map(Number);
        date.setFullYear(year, month - 1, day);
        if (isNaN(date.getTime())) {
            await interaction.reply("Invalid date.").catch(console.error);
            return;
        }
    }

    const trn = normalizeTRN(interaction.options.get('trn').value as string);
    const afterOption = interaction.options.get('after')?.value as boolean | undefined;

    const trainTimetable = (
        isToday(date)
            ? await getTodaysTimetable()
            : await proxy.getTimetable({
                date,
                trns: [trn],
            })
    ).trains[trn];

    const trainHistory = await proxy.getTrainHistory(trn, {
        time: afterOption ? { from: date } : { to: date },
        limit: 1,
    });
    const train = trainHistory.extract[0];

    let lines: string[] = [];

    if (train.active) {
        lines.push(`This train was active, and it's status at the specified time is shown below.`);
    } else {
        lines.push(`No train with TRN ${trn} was showing on the Pop app at the specified time.`);
    }

    if (trainTimetable) {
        const timetabledStatus = getExpectedTrainState(trainTimetable, secondsSinceMidnight(new Date()));
        lines.push(`It should ${renderExpectedTrainState(timetabledStatus, true)}.`);
    } else {
        lines.push("This train was not timetabled to run on that day.");
    }

    if (train.active) {
        await interaction.reply({
            content: lines.join('\n'),
            embeds: [trainEmbed({ trn, date: train.date, status: train.status, timetable: trainTimetable })],
        }).catch(console.error);
    } else {
        await interaction.reply(lines.join('\n')).catch(console.error);
    }
}
