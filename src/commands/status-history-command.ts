import {ActionRowBuilder, BaseMessageOptionsWithPoll, ButtonBuilder, ButtonStyle} from "discord.js";
import {apiConstants, getTodaysTimetable, trainsWithHistory} from "../cache";
import {HISTORY_PAGE_ROWS} from "../constants";
import {proxy} from "../bot";
import {
    parseLastSeen,
    PropsFilter,
    TimeFilter,
    TimesApiData,
    TrainHistoryOptions,
    TrainTimetable
} from "metro-api-client";
import {renderPlatform, renderTimesAPILastEvent, renderTrainStatusesAPILastSeen} from "../rendering";
import {MSBCommand} from "./index";
import {isToday} from "../utils";
import {normalizeTRN, parseDateOption, parseTimeOption, TRN_OPTION} from "./command-utils";

interface RenderedEntry {
    date: Date;
    rendered: string;
}

interface PropertyChoice {
    displayName: string;
}

interface FetchPropertyChoice extends PropertyChoice {
    customFetch: (trn: string, time: TimeFilter) => Promise<{
        veryFirstEntry: Date;
        entries: RenderedEntry[]
    }>;
}

interface IterativePropertyChoice<OutputData> extends PropertyChoice {
    statusProps?: PropsFilter;
    limit?: number;
    get?: (data: any) => OutputData;
    equals?: (a: OutputData, b: OutputData) => boolean;
    render?: (data: OutputData, trainTimetable: TrainTimetable) => string;
}

function createPropertyChoice<OutputData>(choice: IterativePropertyChoice<OutputData>) {
    return choice;
}

const PROPERTY_CHOICES: Record<string, FetchPropertyChoice | IterativePropertyChoice<unknown>> = {
    active: {
        displayName: "Active?",
        async customFetch(trn, time) {
            const history = await proxy.getTrainHistory(trn, {
                time,
                limit: HISTORY_PAGE_ROWS,
                active: false,
                props: ["extract.date","extract.active","summary.firstEntry"]
            }) as {
                summary: { firstEntry: Date; };
                extract: {
                    date: Date;
                    active: boolean;
                }[]
            };
            if (history.extract.length) return {
                veryFirstEntry: history.summary.firstEntry,
                entries: history.extract.map(entry => ({
                    date: entry.date,
                    rendered: entry.active ? "Active" : "Inactive"
                }))
            };
        }
    },
    destination: createPropertyChoice({
        displayName: "Destination",
        statusProps: ["timesAPI.plannedDestinations.name", "trainStatusesAPI.destination"],
        get(data: {
            timesAPI?: { plannedDestinations: { name: string }[] },
            trainStatusesAPI?: { destination: string }
        }) {
            return {
                timesAPI: data.timesAPI?.plannedDestinations[0]?.name,
                trainStatusesAPI: data.trainStatusesAPI?.destination
            };
        },
        equals(a, b) {
            return a.timesAPI === b.timesAPI && a.trainStatusesAPI === b.trainStatusesAPI
        },
        render({ timesAPI, trainStatusesAPI }) {
            if (timesAPI === trainStatusesAPI) return timesAPI;
            if (timesAPI && trainStatusesAPI) return `Times API: ${timesAPI}, Train Statuses API: ${trainStatusesAPI}`;
            if (timesAPI) return `Times API: ${timesAPI}`;
            if (trainStatusesAPI) return `Train Statuses API: ${trainStatusesAPI}`;
        }
    }),
    "lastSeen.timesAPI": createPropertyChoice({
        displayName: "Times API last seen",
        statusProps: ["timesAPI.lastEvent"],
        get(data: { timesAPI?: { lastEvent: TimesApiData["lastEvent"] } }) {
            return data.timesAPI?.lastEvent
        },
        equals(a, b) {
            return a?.type === b?.type && a?.location === b?.location && a?.time.getTime() === b?.time.getTime()
        },
        render(data, trainTimetable) {
            return data ? renderTimesAPILastEvent(data, trainTimetable) : "*Not showing in the times API*";
        }
    }),
    "platform.timesAPI": createPropertyChoice({
        displayName: "Times API platform",
        statusProps: ["timesAPI.lastEvent.location"],
        get(data: { timesAPI?: { lastEvent: { location: string } } }) {
            return data.timesAPI?.lastEvent.location
        },
        render(data) {
            return data ?? "*Not showing in the times API*";
        }
    }),
    "lastSeen.trainStatusesAPI": createPropertyChoice({
        displayName: "Train Statuses API last seen",
        statusProps: ["trainStatusesAPI.lastSeen"],
        get(data: { trainStatusesAPI?: { lastSeen: string } }) {
            return data.trainStatusesAPI?.lastSeen;
        },
        render(data, trainTimetable) {
            return data ? renderTrainStatusesAPILastSeen(data, trainTimetable) : "*Not showing in the train statuses API*";
        }
    }),
    "platform.trainStatusesAPI": createPropertyChoice({
        displayName: "Train Statuses API platform",
        statusProps: ["trainStatusesAPI.lastSeen"],
        get(data: { trainStatusesAPI?: { lastSeen: string } }) {
            if (!data.trainStatusesAPI?.lastSeen) return "*Not showing in the train statuses API*";
            const parsedLastSeen = parseLastSeen(data.trainStatusesAPI.lastSeen);
            if (parsedLastSeen) return renderPlatform(parsedLastSeen.station, parsedLastSeen.platform);
            return "*Couldn't parse the last seen status*";
        }
    })
};

function formatDate(date: Date): string {
    return date.toLocaleString("en-GB", {
        timeZone: "Europe/London",
        dateStyle: "short",
        timeStyle: "medium"
    });
}

function compareData(historyProperty: IterativePropertyChoice<unknown>, a: unknown, b: unknown) {
    if (historyProperty.equals) {
        if (a === undefined) return b === undefined;
        if (b === undefined) return false;
        return historyProperty.equals(a, b);
    }
    return a === b;
}

async function filterAndRenderEntries(
    trn: string,
    historyProperty: IterativePropertyChoice<unknown>,
    extract: { date: Date; status: any }[],
    isVeryFirstEntry: boolean = true,
    prevData: unknown = undefined,
) {
    const entries: RenderedEntry[] = [];
    let isFirstSubEntry = true;
    let firstData = undefined;
    for (const entry of extract) {
        let rendered: string;
        if (entry.status === undefined) {
            isFirstSubEntry = false;
            if (isVeryFirstEntry) {
                isVeryFirstEntry = false;
            } else if (prevData === undefined) {
                continue;
            }
            rendered = "Inactive";
            prevData = undefined;
        } else {
            const currData = historyProperty.get ? historyProperty.get(entry.status) : entry.status;
            if (isFirstSubEntry) {
                isFirstSubEntry = false;
                firstData = currData;
            }
            if (isVeryFirstEntry) {
                isVeryFirstEntry = false;
            } else if (compareData(historyProperty, prevData, currData)) {
                continue;
            }
            rendered = historyProperty.render ? historyProperty.render(
                currData,
                isToday(entry.date) ? (await getTodaysTimetable()).trains[trn] : undefined
            ) : `${currData}`;
            prevData = currData;
        }
        entries.push({
            date: entry.date,
            rendered,
        });
    }
    return { entries, firstData, lastData: prevData };
}

async function defaultFetch(
    trn: string,
    time: TrainHistoryOptions["time"],
    historyProperty: IterativePropertyChoice<unknown>
) {
    // By default, we repeatedly fetch `limit` entries until we have `HISTORY_PAGE_ROWS`.

    const isTo = time === undefined || 'to' in time;

    const props = ["extract.date"];
    if (historyProperty.statusProps) {
        for (const prop of historyProperty.statusProps) {
            props.push(`extract.status.${prop}`);
        }
    }

    const limit = historyProperty.limit
        ? Math.min(historyProperty.limit, apiConstants.MAX_HISTORY_REQUEST_LIMIT)
        : apiConstants.MAX_HISTORY_REQUEST_LIMIT;
    const firstHistory = await proxy.getTrainHistory(trn, {
        time,
        limit,
        props: ["summary.firstEntry", "summary.lastEntry", ...props]
    }) as {
        summary: {
            firstEntry: Date;
            lastEntry: Date;
        };
        extract: { date: Date; status: any }[]
    };
    if (!firstHistory.extract.length) return;

    let extract = firstHistory.extract;
    let prevResult = await filterAndRenderEntries(trn, historyProperty, extract);
    let entries = prevResult.entries;
    while (true) {
        if (entries.length >= HISTORY_PAGE_ROWS) break;
        if (isTo) {
            if (extract[0].date.getTime() <= firstHistory.summary.firstEntry.getTime()) break;
            time = {to: new Date(extract[0].date.getTime() - 1)};
        } else {
            if (extract[extract.length - 1].date.getTime() >= firstHistory.summary.lastEntry.getTime()) break;
            time = {from: new Date(extract[extract.length - 1].date.getTime() + 1)}
        }
        const nextHistory = await proxy.getTrainHistory(trn, {time, limit, props}) as {
            extract: { date: Date; status: any }[]
        };
        extract = nextHistory.extract;
        if (!extract.length) break; // This could happen if old entries were purged
        const currResult = await filterAndRenderEntries(trn, historyProperty, extract, false, isTo ? undefined : prevResult.lastData);
        if (isTo) {
            if (compareData(historyProperty, currResult.lastData, prevResult.firstData)) {
                entries.shift();
            }
            entries.unshift(...currResult.entries);
        } else {
            entries.push(...currResult.entries);
        }
        prevResult = currResult;
    }

    if (entries.length > HISTORY_PAGE_ROWS) {
        if (isTo) {
            entries = entries.slice(-HISTORY_PAGE_ROWS);
        } else {
            entries = entries.slice(0, HISTORY_PAGE_ROWS);
        }
    }

    return {
        entries,
        veryFirstEntry: firstHistory.summary.firstEntry
    };
}

async function getPage(
    trn: string, historyPropertyName: string, range: string = "last"
): Promise<BaseMessageOptionsWithPoll> {
    const historyProperty = PROPERTY_CHOICES[historyPropertyName];
    if (!historyProperty) {
        // Somehow, the property was "last" one time.
        // The only way I was able to reproduce this was by passing a TRN of `123:last`.
        // However, I doubt that this is what actually caused it.
        // So, in case it happens again and to help with debugging, I'll log all the parameters.
        console.error(`Invalid property: ${historyPropertyName}`);
        console.log(`getPage("${trn}", "${historyPropertyName}", "${range}")`);
        return { content: `Invalid property: ${historyPropertyName}` };
    }

    let time: TrainHistoryOptions["time"];
    let timeDescription: string;
    if (range.startsWith("refresh:")) {
        range = range.slice(8);
    }
    if (range === "first") {
        time = { from: new Date(0) };
        timeDescription = "Earliest entries";
    } else if (range === "last") {
        timeDescription = "Latest entries";
    } else if (range.includes("...")) {
        if (range.startsWith("...")) {
            time = {to: new Date(+range.slice(3))};
            timeDescription = `Until ${formatDate(time.to)}`;
        } else if (range.endsWith("...")) {
            time = {from: new Date(+range.slice(0, -3))};
            timeDescription = `From ${formatDate(time.from)}`;
        } else {
            const [from, to] = range.split("...");
            time = { from: new Date(+from), to: new Date(+to) };
            timeDescription = `Between ${formatDate(time.from)} and ${formatDate(time.to)}`;
        }
    } else {
        throw new Error(`Invalid range: ${range}`);
    }

    let fetchResult: {
        veryFirstEntry: Date
        entries: RenderedEntry[]
    };
    try {
        fetchResult = "customFetch" in historyProperty
            ? await historyProperty.customFetch(trn, time)
            : await defaultFetch(trn, time, historyProperty);
    } catch (error) {
        // This is a band-aid fix.
        // Ideally, different types of errors should be handled differently.
        // However, that will require changes to the proxy.
        console.error(`Error fetching history for TRN ${trn} and property ${historyPropertyName}:`, error);
        return {
            content: `Error fetching history: ${error instanceof Error ? error.message : error}`,
        };
    }

    const buttonIdPrefix = `history:${trn}:${historyPropertyName}`;
    const prevButton = new ButtonBuilder()
        .setLabel("◀️")
        .setStyle(ButtonStyle.Primary);
    const nextButton = new ButtonBuilder()
        .setLabel("▶️")
        .setStyle(ButtonStyle.Primary);

    const lines = [`**Train T${trn} history - ${historyProperty.displayName} - ${timeDescription}**`];
    if (fetchResult?.entries.length) {
        for (const entry of fetchResult.entries) {
            lines.push(`- [${formatDate(entry.date)}] ${entry.rendered}`)
        }
        prevButton
            .setCustomId(`${buttonIdPrefix}:...${fetchResult.entries[0].date.getTime() - 1}`)
            .setDisabled(fetchResult.veryFirstEntry.getTime() >= fetchResult.entries[0].date.getTime());
        nextButton.setCustomId(`${buttonIdPrefix}:${fetchResult.entries[fetchResult.entries.length - 1].date.getTime() + 1}...`);
    } else {
        lines.push("*No entries found matching the criteria.*");
        prevButton.setCustomId(`${buttonIdPrefix}:prev`).setDisabled(true);
        nextButton.setCustomId(`${buttonIdPrefix}:next`).setDisabled(true);
    }

    return {
        content: lines.join("\n"),
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${buttonIdPrefix}:first`)
                    .setLabel("⏮️")
                    .setStyle(ButtonStyle.Primary),
                prevButton,
                new ButtonBuilder()
                    .setCustomId(`${buttonIdPrefix}:refresh:${range}`)
                    .setLabel("🔄")
                    .setStyle(ButtonStyle.Primary),
                nextButton,
                new ButtonBuilder()
                    .setCustomId(`${buttonIdPrefix}:last`)
                    .setLabel("⏭️")
                    .setStyle(ButtonStyle.Primary)
            )
        ]
    }
}

export default {
    DEFINITION: {
        name: 'train-status-history',
        description: 'Explore historic realtime data for a specific train',
        options: [
            TRN_OPTION,
            {
                name: 'property',
                description: 'Property to show the history of',
                type: 3, // string
                choices: Object.entries(PROPERTY_CHOICES)
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

    execute: async interaction => {
        const trn = normalizeTRN(interaction.options.get('trn').value as string);
        if (trn.includes(':')) {
            await interaction.reply({
                content: "TRN cannot contain a colon.",
                flags: ["Ephemeral"]
            });
            return;
        }

        const startDate = interaction.options.get('start-date')?.value as string;
        const startTime = interaction.options.get('start-time')?.value as string;
        const endDate = interaction.options.get('end-date')?.value as string;
        const endTime = interaction.options.get('end-time')?.value as string;
        let from: Date;
        let to: Date;
        try {
            if (startDate || startTime) {
                from = startDate ? parseDateOption(startDate) : new Date();
                if (startTime) {
                    const hms = parseTimeOption(startTime);
                    from.setHours(hms.hours, hms.minutes, hms.seconds, 0);
                } else {
                    from.setHours(0, 0, 0, 0);
                }
            }
            if (endDate || endTime) {
                to = endDate ? parseDateOption(endDate) : new Date();
                if (endTime) {
                    const hms = parseTimeOption(endTime);
                    to.setHours(hms.hours, hms.minutes, hms.seconds, 0);
                } else {
                    to.setHours(23, 59, 59, 999);
                }
            }
        } catch (error) {
            await interaction.reply({
                content: error.message,
                flags: ["Ephemeral"]
            });
            return;
        }

        const deferReply = interaction.deferReply();
        const page = await getPage(
            trn,
            interaction.options.get('property').value as string,
            from || to ? `${from?.getTime() || ''}...${to?.getTime() || ''}` : undefined,
        );
        await deferReply;
        await interaction.editReply(page);
    },

    autoCompleteOptions: async () => Array.from(trainsWithHistory),

    button: async (interaction, rest) => {
        const [trn, property, ...extra] = rest;
        if (interaction.user === interaction.message.interactionMetadata.user) {
            const update = interaction.update({
                content: `Loading...`,
                components: []
            });
            const page = await getPage(trn, property, extra.join(':'));
            await update;
            await interaction.editReply(page);
        } else {
            const pagePromise = getPage(trn, property, extra.join(':'));
            const reply = await interaction.reply({
                content: `Loading...`,
                flags: ["Ephemeral"],
            });
            await reply.edit(await pagePromise)
        }
    }
} as MSBCommand;
