import {getTodaysTimetable} from "../cache";
import {proxy} from "../bot";
import {getExpectedTrainState, secondsSinceMidnight} from "../timetable";
import {renderExpectedTrainState, trainEmbed} from "../rendering";
import {MSBCommand} from "./index";
import {isToday} from "../utils";
import {normalizeTRN, parseDateOption, parseTimeOption, TRN_OPTION} from "./command-utils";
import statusHistoryCommand from "./status-history-command";

export default {
    DEFINITION: {
        name: 'train-status-at-time',
        description: 'Get the full status of a train at a specific time',
        options: [
            TRN_OPTION,
            {
                name: 'time',
                description: 'Time to get the status for, in HH:MM[:SS] format. Defaults to now.',
                type: 3, // string
                required: true,
            },
            {
                name: 'date',
                description: 'Date to get the status for, in YYYY-MM-DD format. Defaults to today.',
                type: 3, // string
            },
            {
                name: 'after',
                description: 'Show status at or just after the specified time (as opposed to default of at or just before).',
                type: 5, // boolean
            }
        ],
        contexts: [0, 1, 2]
    },

    execute: async interaction => {
        let date: Date;

        try {
            const dateOption = interaction.options.get('date')?.value as string | undefined;
            date = dateOption ? parseDateOption(dateOption) : new Date();
            const hms = parseTimeOption(interaction.options.get('time').value as string);
            date.setHours(hms.hours, hms.minutes, hms.seconds, 0);
        } catch (error) {
            await interaction.reply({
                content: error.message,
                flags: ["Ephemeral"]
            });
            return;
        }

        const trn = normalizeTRN(interaction.options.get('trn').value as string);
        const afterOption = interaction.options.get('after')?.value as boolean | undefined;

        const [trainTimetable, train] = await Promise.all([
            (
                isToday(date)
                    ? getTodaysTimetable()
                    : proxy.getTimetable({ date, trns: [trn] })
            ).then(dayTimetable => dayTimetable.trains[trn]),

            proxy.getTrainHistory(trn, {
                time: afterOption ? { from: date } : { to: date },
                limit: 1,
            }).then(history => history.extract[0])
        ]);

        let lines: string[] = [];
        if (train?.active) {
            lines.push(`This train was active, and it's status at the specified time is shown below.`);
        } else {
            lines.push(`No train with TRN ${trn} was showing on the Pop app at the specified time.`);
        }
        if (trainTimetable) {
            const timetabledStatus = getExpectedTrainState(trainTimetable, secondsSinceMidnight(date));
            lines.push(`It should ${renderExpectedTrainState(timetabledStatus, true)}.`);
        } else {
            lines.push("This train was not timetabled to run on that day.");
        }

        if (train && train.active) {
            await interaction.reply({
                content: lines.join('\n'),
                embeds: [trainEmbed({ trn, date: train.date, status: train.status, timetable: trainTimetable })],
            });
        } else {
            await interaction.reply(lines.join('\n'));
        }
    },

    autoCompleteOptions: statusHistoryCommand.autoCompleteOptions,
} as MSBCommand;
