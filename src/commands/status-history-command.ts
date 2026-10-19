import {ActionRowBuilder, BaseMessageOptionsWithPoll, ButtonBuilder, ButtonStyle} from "discord.js";
import {apiConstants, getTodaysTimetable, trainsWithHistory} from "../cache";
import {HISTORY_PAGE_ROWS} from "../constants";
import {proxy} from "../bot";
import {
    GeoApiData,
    HistoricTimesApiData,
    TimeFilter,
    TrainDataApi,
    TrainHistoryEntry,
    TrainTimetable
} from "tnw-metro-api-client";
import {
    API_EMOJIS,
    renderGeoApiLastSeen,
    renderParsedPlatform,
    renderTimesApiLastEvent,
    renderTimesApiLocation
} from "../rendering";
import {MSBCommand} from "./index";
import {isToday} from "../utils";
import {normalizeTRN, parseDateOption, parseTimeOption, TRN_OPTION} from "./command-utils";

interface RenderedEntry {
    date: Date;
    rendered: string;
}

const TRAIN_DATA_APIS: TrainDataApi[] = ["TIMES", "GEO"];
type ApiStatus = { TIMES: HistoricTimesApiData; GEO: GeoApiData };
/** The history fetched from each API, which is missing for APIs that aren't included */
type ApiPeriods = { [Api in TrainDataApi]?: TrainHistoryEntry<ApiStatus[Api]>[] };
const API_NAMES = { TIMES: "Times API", GEO: "Geo API" };

type Render<Data> = (data: Data, trainTimetable?: TrainTimetable) => string;

/** How to get, compare and render a property from an API's data */
type ApiProperty<Status, Data> = {
    get: (status: Status) => Data;
    equals?: (a: Data, b: Data) => boolean;
    // Strings are shown as they are by default
} & ([Data] extends [string] ? { render?: Render<Data> } : { render: Render<Data> });

/** Type checks an API's property, since the data type can't be checked once it's in `PROPERTY_CHOICES` */
function apiProperty<Status, Data>(property: ApiProperty<Status, Data>) {
    return property;
}

type ApiProperties = { [Api in TrainDataApi]: ApiProperty<ApiStatus[Api], any> };

interface PropertyChoice {
    displayName: string;
    /** How to get the property from each API's data, or undefined for whether the train was active */
    apis?: ApiProperties;
    /** Whether the property can be shown from both APIs at once */
    combinable: boolean;
}

const PROPERTY_CHOICES: Record<string, PropertyChoice> = {
    active: {
        displayName: "Active?",
        combinable: true
    },
    destination: {
        displayName: "Destination",
        combinable: true,
        apis: {
            TIMES: apiProperty({
                get: (status: HistoricTimesApiData) => status.plannedDestinations[0]?.name ?? "*No planned destinations*"
            }),
            GEO: apiProperty({
                get: (status: GeoApiData) => status.destination
            })
        }
    },
    lastSeen: {
        displayName: "Last seen",
        // Each API's last seen status is too different to show together
        combinable: false,
        apis: {
            TIMES: apiProperty({
                get: (status: HistoricTimesApiData) => status.lastEvent,
                equals: (a, b) =>
                    a.type === b.type &&
                    renderTimesApiLocation(a.location) === renderTimesApiLocation(b.location) &&
                    a.time.getTime() === b.time.getTime(),
                render: (lastEvent, trainTimetable) => renderTimesApiLastEvent(lastEvent, trainTimetable)
            }),
            GEO: apiProperty({
                get: (status: GeoApiData) => status.lastSeen,
                equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
                render: (lastSeen, trainTimetable) => renderGeoApiLastSeen(lastSeen, trainTimetable)
            })
        }
    },
    platform: {
        displayName: "Platform",
        combinable: true,
        // Both APIs' platforms are rendered the same way, so that they can be compared
        apis: {
            TIMES: apiProperty({
                get(status: HistoricTimesApiData) {
                    return renderTimesApiLocation(status.lastEvent.location);
                }
            }),
            GEO: apiProperty({
                get(status: GeoApiData) {
                    return typeof status.lastSeen === "string"
                        ? "*Couldn't parse the last seen status*"
                        : renderParsedPlatform(status.lastSeen);
                }
            })
        }
    },
};

function formatDate(date: Date): string {
    return date.toLocaleString("en-GB", {
        dateStyle: "short",
        timeStyle: "medium"
    });
}

function isInTimeFilter(date: Date, time: TimeFilter): boolean {
    return !(
        ('from' in time && date < time.from) ||
        ('to' in time && date > time.to)
    );
}

/** Each time the APIs which the train is active in changed */
async function fetchActiveEntries(trn: string, apis: TrainDataApi[], time: TimeFilter): Promise<RenderedEntry[]> {
    const response = await proxy.getTrainsAvailability({
        trns: [trn],
        apis,
        time,
        // Each range has up to two entries, so this is always enough
        limit: HISTORY_PAGE_ROWS * apis.length
    });

    // When each API's ranges started and ended
    const changes = apis
        .flatMap(api => (response.trains[trn]?.[api] ?? []).flatMap(range => range.end
            ? [{ date: range.start, api, isActive: true }, { date: range.end, api, isActive: false }]
            : [{ date: range.start, api, isActive: true }]
        ))
        // Ends are applied before starts at the same time, in case an API's ranges are adjacent
        .sort((a, b) => a.date.getTime() - b.date.getTime() || +a.isActive - +b.isActive);

    const entries: RenderedEntry[] = [];
    const activeApis = new Set<TrainDataApi>();
    let previous = "";
    for (const [i, change] of changes.entries()) {
        if (change.isActive) activeApis.add(change.api);
        else activeApis.delete(change.api);

        // Changes at the same time are shown together
        if (changes[i + 1]?.date.getTime() === change.date.getTime()) continue;

        const rendered =
            !activeApis.size ? "Inactive" :
            apis.length === 1 ? "Active" :
            `Active in ${
                TRAIN_DATA_APIS
                    .filter(api => activeApis.has(api))
                    .map(api => `${API_EMOJIS[api]} ${API_NAMES[api]}`)
                    .join(" and ")
            }`;
        if (rendered === previous) continue;
        previous = rendered;

        // Ranges include all the data which overlaps the time filter, so may start or end outside of it
        if (isInTimeFilter(change.date, time)) entries.push({ date: change.date, rendered });
    }
    return entries;
}

function isEqual<Data>(property: ApiProperty<any, Data>, a: Data, b: Data): boolean {
    if (property.equals && a !== undefined && b !== undefined) return property.equals(a, b);
    return a === b;
}

function renderData<Data>(property: ApiProperty<any, Data>, data: Data, trainTimetable?: TrainTimetable): string {
    return property.render?.(data, trainTimetable) ?? data as string;
}

/** A change to an API's data, where undefined data means the train became inactive in it */
interface DataChange {
    date: Date;
    api: TrainDataApi;
    data: unknown;
}

function getDataChanges<Api extends TrainDataApi>(
    // Generic so that TypeScript knows `property[api]` and `periods[api]` are for the same API.
    api: Api,
    property: ApiProperties,
    periods: ApiPeriods,
    isLastPeriodKnown: boolean,
    time: TimeFilter
): DataChange[] {
    const apiPeriods = periods[api];
    if (!apiPeriods) return [];
    apiPeriods.sort((a, b) => a.startHeartbeat.startedAt.getTime() - b.startHeartbeat.startedAt.getTime());

    const changes: DataChange[] = [];
    for (const [i, period] of apiPeriods.entries()) {
        changes.push({ date: period.startHeartbeat.startedAt, api, data: property[api].get(period.status) });
        // This isn't known for the last period if later periods haven't been fetched yet
        const nextPeriod = apiPeriods[i + 1];
        const end = period.endHeartbeat?.startedAt;
        if (
            end &&
            isInTimeFilter(end, time) && (
                nextPeriod
                    ? nextPeriod.startHeartbeat.startedAt.getTime() !== end.getTime()
                    : isLastPeriodKnown
            )
        ) {
            changes.push({ date: end, api, data: undefined });
        }
    }
    return changes;
}

/**
 * Each time the property changed in any of the APIs, or the train became inactive in all of them.
 * The first entry is always shown, even if it didn't change from the data before it.
 */
function getPropertyChanges(
    apis: TrainDataApi[],
    property: ApiProperties,
    periods: ApiPeriods,
    isLastPeriodKnown: boolean,
    time: TimeFilter,
    todaysTimetable?: TrainTimetable
): RenderedEntry[] {
    const changes = apis
        .flatMap(api => getDataChanges(api, property, periods, isLastPeriodKnown, time))
        .sort((a, b) => a.date.getTime() - b.date.getTime());

    const entries: RenderedEntry[] = [];
    // Each API's current data, which is undefined while the train is inactive in it
    const current = new Map<TrainDataApi, unknown>();
    let previous: Map<TrainDataApi, unknown> | undefined;
    for (const [i, change] of changes.entries()) {
        current.set(change.api, change.data);
        // Changes during the same heartbeat are shown together
        if (changes[i + 1]?.date.getTime() === change.date.getTime()) continue;
        if (previous && apis.every(api => isEqual(property[api], previous!.get(api), current.get(api)))) continue;
        previous = new Map(current);

        const trainTimetable = isToday(change.date) ? todaysTimetable : undefined;
        const rendered = new Map<TrainDataApi, string>();
        for (const [api, data] of current) {
            if (data !== undefined) rendered.set(api, renderData(property[api], data, trainTimetable));
        }
        entries.push({ date: change.date, rendered: renderEntry(rendered, apis.length > 1) });
    }
    return entries;
}

/** Renders a property from each API, which is only shown once if they're the same */
function renderEntry(renderedData: Map<TrainDataApi, string>, isMultipleApis: boolean): string {
    if (!renderedData.size) return "*Inactive*";
    const values = new Set(renderedData.values());
    if (
        !isMultipleApis ||
        (renderedData.size === TRAIN_DATA_APIS.length && values.size === 1)
    ) return [...values][0]!;
    return TRAIN_DATA_APIS
        .filter(api => renderedData.has(api))
        .map(api => `${API_EMOJIS[api]} ${renderedData.get(api)}`)
        .join(" ");
}

/**
 * Each time the property changed in any of the APIs, or the train became inactive in all of them.
 * The history only has an entry each time any of an API's data changes, so pages are fetched until there are enough
 *  changes to the property. More than needed are fetched, since the first entry is always shown even if it didn't
 *  change from the entry before it, which hasn't been fetched.
 */
async function fetchPropertyEntries(
    trn: string,
    property: ApiProperties,
    apis: TrainDataApi[],
    time: TimeFilter
): Promise<RenderedEntry[]> {
    const todaysTimetable = (await getTodaysTimetable()).trains[trn];
    // History is fetched from `time.from` if it is specified, otherwise backwards from `time.to`
    const isTo = !('from' in time);

    const periods: ApiPeriods = {};
    for (const api of apis) periods[api] = [];
    let pageTime = time;
    while (true) {
        const response = await proxy.getTrainsHistory({
            trns: [trn],
            apis,
            time: pageTime,
            limit: apiConstants.MAX_HISTORY_REQUEST_LIMIT
        });

        const history = response.trains[trn];
        periods.TIMES?.push(...history?.timesAPI ?? []);
        periods.GEO?.push(...history?.geoAPI ?? []);

        const isComplete = response.truncatedTo === null;
        const entries = getPropertyChanges(apis, property, periods, isTo || isComplete, time, todaysTimetable);
        if (isComplete || entries.length > HISTORY_PAGE_ROWS) return entries;

        pageTime = isTo ? { to: response.truncatedTo! } : { ...time, from: response.truncatedTo! };
    }
}

/** When the train was first active in any of the APIs */
async function getFirstActive(trn: string, apis: TrainDataApi[]): Promise<Date | undefined> {
    const response = await proxy.getTrainsAvailability({
        trns: [trn],
        apis,
        time: { from: new Date(0) },
        // If this was 1, then the APIs' first ranges would be omitted if they started at the same time, since the
        //  limit truncates the time window rather than individual ranges
        limit: apis.length
    });
    const starts = apis.flatMap(api => response.trains[trn]?.[api]?.[0]?.start ?? []);
    return starts.length ? new Date(Math.min(...starts.map(start => start.getTime()))) : undefined;
}

/**
 * Gets a page of a train's history.
 * @param trn The train's TRN
 * @param selection The property's key, optionally followed by `.` and a specific API
 * @param range Which entries to show
 */
async function getPage(
    trn: string, selection: string, range: string = "last"
): Promise<BaseMessageOptionsWithPoll> {
    const [propertyKey, api] = selection.split(".") as [string, TrainDataApi | undefined];
    const historyProperty = PROPERTY_CHOICES[propertyKey];
    if (!historyProperty || (api ? !TRAIN_DATA_APIS.includes(api) : !historyProperty.combinable)) {
        // Somehow, the property was "last" one time.
        // The only way I was able to reproduce this was by passing a TRN of `123:last`.
        // However, I doubt that this is what actually caused it.
        // So, in case it happens again and to help with debugging, I'll log all the parameters.
        console.error(`Invalid property: ${selection}`);
        console.log(`getPage("${trn}", "${selection}", "${range}")`);
        return { content: `Invalid property: ${selection}` };
    }
    const apis = api ? [api] : TRAIN_DATA_APIS;
    const displayName = api
        ? `${API_NAMES[api]} ${historyProperty.displayName.toLowerCase()}`
        : historyProperty.displayName;

    let time: TimeFilter;
    let timeDescription: string;
    if (range.startsWith("refresh:")) {
        range = range.slice(8);
    }
    if (range === "first") {
        time = { from: new Date(0) };
        timeDescription = "Earliest entries";
    } else if (range === "last") {
        time = { to: new Date() };
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
            time = { from: new Date(+from!), to: new Date(+to!) };
            timeDescription = `Between ${formatDate(time.from)} and ${formatDate(time.to)}`;
        }
    } else {
        throw new Error(`Invalid range: ${range}`);
    }

    let entries: RenderedEntry[];
    let firstActive: Date | undefined;
    try {
        [entries, firstActive] = await Promise.all([
            historyProperty.apis
                ? fetchPropertyEntries(trn, historyProperty.apis, apis, time)
                : fetchActiveEntries(trn, apis, time),
            getFirstActive(trn, apis)
        ]);
        // History is fetched from `time.from` if it is specified, otherwise backwards from `time.to`
        entries = 'from' in time ? entries.slice(0, HISTORY_PAGE_ROWS) : entries.slice(-HISTORY_PAGE_ROWS);
    } catch (error) {
        // This is a band-aid fix.
        // Ideally, different types of errors should be handled differently.
        // However, that will require changes to the proxy.
        console.error(`Error fetching history for TRN ${trn} and property ${selection}:`, error);
        return {
            content: `Error fetching history: ${error instanceof Error ? error.message : error}`,
        };
    }

    const buttonIdPrefix = `history:${trn}:${selection}`;
    const prevButton = new ButtonBuilder()
        .setLabel("◀️")
        .setStyle(ButtonStyle.Primary);
    const nextButton = new ButtonBuilder()
        .setLabel("▶️")
        .setStyle(ButtonStyle.Primary);

    const lines = [`**Train T${trn} history - ${displayName} - ${timeDescription}**`];
    const firstEntry = entries[0];
    const lastEntry = entries.at(-1);
    if (firstEntry && lastEntry) {
        for (const entry of entries) {
            lines.push(`- [${formatDate(entry.date)}] ${entry.rendered}`)
        }
        prevButton
            .setCustomId(`${buttonIdPrefix}:...${firstEntry.date.getTime() - 1}`)
            .setDisabled(!firstActive || firstActive >= firstEntry.date);
        nextButton.setCustomId(`${buttonIdPrefix}:${lastEntry.date.getTime() + 1}...`);
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
                name: 'api',
                description: 'API to show the history from. Defaults to both where possible.',
                type: 3, // string
                choices: TRAIN_DATA_APIS.map(api => ({ name: API_NAMES[api], value: api }))
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
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        if (trn.includes(':')) {
            await interaction.reply({
                content: "TRN cannot contain a colon.",
                flags: ["Ephemeral"]
            });
            return;
        }

        const property = interaction.options.get('property', true).value as string;
        const api = interaction.options.get('api')?.value as TrainDataApi | undefined;
        if (!api && !PROPERTY_CHOICES[property]?.combinable) {
            await interaction.reply({
                content: `Please choose an API to show the ${PROPERTY_CHOICES[property]?.displayName.toLowerCase()} history from.`,
                flags: ["Ephemeral"]
            });
            return;
        }

        const startDate = interaction.options.get('start-date')?.value as string;
        const startTime = interaction.options.get('start-time')?.value as string;
        const endDate = interaction.options.get('end-date')?.value as string;
        const endTime = interaction.options.get('end-time')?.value as string;
        let from: Date | undefined;
        let to: Date | undefined;
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
                content: error instanceof Error ? error.message : String(error),
                flags: ["Ephemeral"]
            });
            return;
        }

        const deferReply = interaction.deferReply();
        const page = await getPage(
            trn,
            api ? `${property}.${api}` : property,
            from || to ? `${from?.getTime() || ''}...${to?.getTime() || ''}` : undefined,
        );
        await deferReply;
        await interaction.editReply(page);
    },

    autoCompleteOptions: async () => Array.from(trainsWithHistory),

    button: async (interaction, rest) => {
        const [trn, property, ...extra] = rest as [string, string, ...string[]];
        if (!interaction.message.interactionMetadata) {
            console.error(`Button clicked on a message that was not sent by a command: ${interaction.customId}`);
            return;
        }
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
