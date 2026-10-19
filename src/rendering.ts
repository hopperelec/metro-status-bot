import {MAX_PLANNED_DESTINATIONS, MONUMENT_STATION_CODES} from "./constants";
import {apiConstants, lastHeartbeat} from "./cache";
import {EmbedBuilder} from "discord.js";
import {
    ApiType, ExpectedTrainState, GeoApiData, GeoApiEventType, HeartbeatError, HeartbeatWarning, ParsedPlatform,
    TimesApiData, TrainTimetable
} from "tnw-metro-api-client";
import {
    calculateDelayFromTimesApi,
    calculateDelayFromGeoApi,
    parseLocationCode,
    ParsedLocation
} from "./timetable";
import {alert} from "./bot";
import {TrainStatus} from "./train-status";

export interface InactiveTrainEmbedData {
    trn: string;
    timetable?: TrainTimetable;
}

export interface ActiveTrainEmbedData extends InactiveTrainEmbedData {
    status: TrainStatus;
    date: Date;
}

export type TrainEmbedData = ActiveTrainEmbedData | InactiveTrainEmbedData;

export function dueInToString(dueIn: number): string {
    switch (dueIn) {
        case -2: return "Delayed";
        case -1: return "Arrived";
        case 0: return "Due";
        case 1: return "1 min";
        default: return `${dueIn} mins`;
    }
}

function renderSignedNumber(value: number): string {
    return `${value >= 0 ? '+' : ''}${value}`;
}

export function renderDelay(delay: number): string {
    if (delay === Infinity) return "untimetabled";
    if (isNaN(delay)) return "delay unknown";
    if (Math.abs(delay) <= 60) return "on time";
    if (Math.abs(delay) < 120) return `${renderSignedNumber(delay)}s`;
    return `${renderSignedNumber(Math.round(delay / 60))}m`;
}

export function trainEmbed(train: ActiveTrainEmbedData): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(`T${train.trn}`);

    let footer = `Last updated ${train.date.toLocaleTimeString()}`;
    if (train.date.getTime() !== lastHeartbeat.getTime()) {
        footer = `${footer}, last checked ${lastHeartbeat.toLocaleTimeString()}`;
    }
    embed.setFooter({ text: footer });

    if (train.status.timesAPI && train.status.geoAPI) {
        embed.setDescription(`This train is showing in both APIs. Sometimes these APIs have conflicting data. Fields marked with ${API_EMOJIS.TIMES} are from the Times API, and fields marked with ${API_EMOJIS.GEO} are from the Geo API.`);
    } else if (train.status.timesAPI) {
        embed.setDescription(`This train is only showing in the Times API (${API_EMOJIS.TIMES}).`);
    } else if (train.status.geoAPI) {
        embed.setDescription(`This train is only showing in the Geo API (${API_EMOJIS.GEO}).`);
    }

    if (train.status.timesAPI) {
        const data = train.status.timesAPI;
        let plannedDestinationsLines = data.plannedDestinations
            .map(dest => `${dest.name} from ${renderPlatformCode(dest.from.platformCode)} at ${dest.from.time.toLocaleTimeString('en-GB')}`);
        if (plannedDestinationsLines.length > MAX_PLANNED_DESTINATIONS) {
            const CUTOFF = Math.floor(MAX_PLANNED_DESTINATIONS / 2);
            plannedDestinationsLines = [
                ...plannedDestinationsLines.slice(0, CUTOFF),
                `...${plannedDestinationsLines.length - CUTOFF} more...`,
                ...plannedDestinationsLines.slice(plannedDestinationsLines.length - CUTOFF)
            ];
        }
        embed.addFields(
            {
                name: `${API_EMOJIS.TIMES} Last seen`,
                value: renderTimesApiLastEvent(data.lastEvent, train.timetable)
            },
            {
                name: `${API_EMOJIS.TIMES} Planned destinations`,
                value: plannedDestinationsLines.join("\n")
            }
        );
        if ('nextPlatforms' in data) {
            const nextPlatformStrings = data.nextPlatforms.map(nextPlatform => renderPlatformCode(nextPlatform.code));
            let nextPlatformsString = nextPlatformStrings.join(", ");
            let endIndex = nextPlatformStrings.length - 1;
            while (nextPlatformsString.length > 1024) { // Discord embed field value length limit
                nextPlatformsString = [
                    ...nextPlatformStrings.slice(0, endIndex--),
                    `... ${nextPlatformStrings.length - endIndex - 1} more`
                ].join(", ");
            }
            embed.addFields(
                {
                    name: `${API_EMOJIS.TIMES} Next Platforms`,
                    value: nextPlatformsString,
                }
            );
        }
    }

    if (train.status.geoAPI) {
        const data = train.status.geoAPI;
        embed.addFields(
            {
                name: `${API_EMOJIS.GEO} Current destination`,
                value: data.destination
            },
            {
                name: `${API_EMOJIS.GEO} Last seen`,
                value: renderGeoApiLastSeen(data.lastSeen, train.timetable)
            }
        )
    }
    return embed;
}

function prevTrainStatusEmbed(train: TrainEmbedData): EmbedBuilder {
    if ("status" in train)
        return trainEmbed(train).setTitle(`T${train.trn} (previous status)`)
    return new EmbedBuilder()
        .setTitle(`T${train.trn} (previous status)`)
        .setDescription("No previous status available.");
}

export function renderParsedPlatform(platform: ParsedPlatform): string {
    return `${platform.station} Platform ${platform.platformNumber}`;
}

const PLATFORM_CODE_REGEX = /^(?<station>[A-Z]{3});(?<platform>[1-4])$/;
export function renderPlatformCode(code: string): string {
    const parsed = code.match(PLATFORM_CODE_REGEX);
    return parsed?.groups ? renderParsedLocation({
        stationCode: parsed.groups.station!,
        platformNumber: +parsed.groups.platform!
    }) : code;
}

export function renderParsedLocation({ stationCode, platformNumber }: ParsedLocation): string {
    if (platformNumber === undefined) return apiConstants.LOCATION_ABBREVIATIONS[stationCode] || stationCode;
    return renderParsedPlatform({
        station: MONUMENT_STATION_CODES.includes(stationCode)
            ? "Monument"
            : apiConstants.LOCATION_ABBREVIATIONS[stationCode] || stationCode,
        platformNumber
    });
}

export function renderLocationCode(location: string): string {
    const parsedLocation = parseLocationCode(location);
    return parsedLocation ? renderParsedLocation(parsedLocation) : location;
}

export function renderExpectedTrainState(state: ExpectedTrainState, past: boolean = false): string {
    const location = renderLocationCode(state.location);
    const destination = renderLocationCode(state.destination);
    let formatKey: string = state.event;
    if (location === destination) {
        if (formatKey === "APPROACHING") formatKey = "TERMINATING";
        else if (formatKey === "ARRIVED") formatKey = "STORED";
    }
    if (!state.inService) formatKey += "_NIS";
    if (past) formatKey += "_PAST";
    switch (formatKey) {
        case "ARRIVED": return `be at ${location} heading towards ${destination}`;
        case "ARRIVED_PAST": return `have been at ${location} heading towards ${destination}`;
        case "ARRIVED_NIS": return `be at ${location} heading empty towards ${destination}`;
        case "ARRIVED_NIS_PAST": return `have been at ${location} heading empty towards ${destination}`;

        case "APPROACHING": return `be approaching ${location} towards ${destination}`;
        case "APPROACHING_PAST": return `have been approaching ${location} towards ${destination}`;
        case "APPROACHING_NIS": return `be approaching ${location} empty towards ${destination}`;
        case "APPROACHING_NIS_PAST": return `have been approaching ${location} empty towards ${destination}`;

        case "TERMINATING": return `be terminating at ${location}`;
        case "TERMINATING_PAST": return `have been terminating at ${location}`;
        case "TERMINATING_NIS": return `be terminating empty at ${location}`;
        case "TERMINATING_NIS_PAST": return `have been terminating empty at ${location}`;

        case "TERMINATED": return `be terminated at ${location}, about to head to ${destination}`;
        case "TERMINATED_PAST": return `have been terminated at ${location}, about to head to ${destination}`;
        case "TERMINATED_NIS": return `be terminated at ${location}, about to head empty to ${destination}`;
        case "TERMINATED_NIS_PAST": return `have been terminated at ${location}, about to head empty to ${destination}`;

        case "STORED":
        case "STORED_NIS":
            return `be at ${location}`
        case "STORED_PAST":
        case "STORED_NIS_PAST":
            return `have been at ${location}`

        case "DEPARTED":
        case "DEPARTED_PAST":
            return `have departed from ${location} towards ${destination}`;
        case "DEPARTED_NIS":
        case "DEPARTED_NIS_PAST":
            return `have departed empty from ${location} towards ${destination}`;

        default: throw new Error(`Unrecognised expected train state: ${state.event} (inService: ${state.inService}, past: ${past})`);
    }
}

// Heartbeats

function getApiName(code: ApiType): string {
    if (code === "TIMES") return "the Times API";
    if (code === "GEO") return "the Geo API";
    if (code === "GATEWAY") return "the gateway (which provides the token needed for the Times API)";
    return `an unrecognised API (${code})`;
}

export async function announceHeartbeatError(payload: HeartbeatError): Promise<void> {
    await alert({
        content: `⚠️ An error occurred while fetching or parsing data from ${getApiName(payload.api)}:\n` +
            `> ${payload.message}\n` +
            "-# This usually indicates a problem with or downtime of Nexus' APIs; the bot and proxy are still working fine.",
    });
}

export async function announceHeartbeatWarning(payload: HeartbeatWarning): Promise<void> {
    const apiName = getApiName(payload.api);
    await alert({
        content: `⚠️ One or more warnings were produced while parsing data from ${apiName}.\n` +
            "-# This usually indicates strange or unexpected behaviour from Nexus' APIs; the bot and proxy are still working fine.",
        files: [
            {
                name: "warnings.txt",
                description: `Warnings from ${apiName}`,
                attachment: Buffer.from(JSON.stringify(payload.data, null, 2))
            }
        ]
    });
}

// Either API

export const API_EMOJIS = { TIMES: "⌛", GEO: "📍" };

function listTrns(trns: Set<string>): string {
    return `T${Array.from(trns).sort().join(", T")}`;
}

export async function announceTrainOnWrongDay(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `🤔 Train T${train.trn} is active, but it isn't timetabled for today.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainOnWrongDayDisappeared(prevStatus: TrainEmbedData): Promise<void> {
    await alert({
        content: `🤔 Train T${prevStatus.trn} was active despite not being timetabled for today. However, it has now disappeared. Below is it's status from before it disappeared.`,
        embeds: [prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainDuringNightHours(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `🌙 Train T${train.trn} is active during night hours.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceECS(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `🧐 Train T${train.trn} is showing on the Pop app. While this TRN is timetabled for today, it is not meant to be in service, so the Pop app doesn't usually show it.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceUnrecognisedDestinations(
    currStatus: ActiveTrainEmbedData,
    prevStatus: TrainEmbedData,
    unrecognisedDestinations: string[]
): Promise<void> {
    let message: string;
    if (unrecognisedDestinations.length === 1) {
        const destination = unrecognisedDestinations[0]!;
        const lowerDestination = destination.toLowerCase();
        if (["terminates", "not in service"].includes(lowerDestination)) {
            message = `is showing as "${destination}" on the Pop app.`;
        } else if (lowerDestination === "gosforth depot") {
            message = `is heading to ${destination} but is showing on the Pop app.`;
        } else if (destination === "") {
            message = 'is showing a blank destination on the Pop app. This often happens when it is actually heading to Bede.';
        } else if (lowerDestination === "blank") {
            message = `is showing the literal text "${destination}" as its destination on the Pop app. As opposed to an actually blank destination, this does not seem to indicate it is heading to Bede. I am not sure what it means.`;
        } else {
            message = `has a new unrecognised current and/or planned destination "${destination}"`;
        }
    } else {
        const renderedDestinations = unrecognisedDestinations.map(dest => dest === "" ? "*[BLANK]* (often happens when it is actually heading to Bede)" : `"${dest}"`);
        message = `has ${renderedDestinations.length} new unrecognised destinations: ${renderedDestinations.join(", ")}`;
    }
    await alert({
        content: `🤔 Train T${currStatus.trn} ${message}`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainAtUnrecognisedStation(
    currStatus: ActiveTrainEmbedData,
    prevStatus: TrainEmbedData,
    station: string,
): Promise<void> {
    const middle = station === "" ? "a blank station" : `an unrecognised station "${station}"`;
    await alert({
        content: `🤔 Train T${currStatus.trn} was last seen at ${middle}`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainAtUnrecognisedPlatform(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `🤔 Train T${train.trn} is at an unrecognised platform`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtSouthShieldsP1(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `🤔 Train T${train.trn} is at South Shields Platform 1.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtSunderlandP1orP4(train: ActiveTrainEmbedData, platform: 1 | 4): Promise<void> {
    await alert({
        content: `🤔 Train T${train.trn} is at Sunderland Platform ${platform}, but Metro trains are currently only meant to use platforms 2 and 3.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainTeleported(
    currStatus: ActiveTrainEmbedData,
    prevStatus: TrainEmbedData,
    prevLocationCode: string,
    currLocationCode: string
): Promise<void> {
    await alert({
        content: `🌀 Train T${currStatus.trn} has teleported from ${renderLocationCode(prevLocationCode)} to ${renderLocationCode(currLocationCode)}. This could indicate a TRN swap.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainUsingJJC(currStatus: ActiveTrainEmbedData, prevStatus: TrainEmbedData): Promise<void> {
    await alert({
        content: `🤔 Train T${currStatus.trn} appears to have used Jesmond Junction. It is probably not in service.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceAllTrainsDisappeared(trns: Set<string>): Promise<void> {
    await alert({content: `❌ All ${trns.size} active trains have disappeared simultaneously!\n${listTrns(trns)}`});
}

export async function announceMultipleDisappearedTrains(trns: Set<string>): Promise<void> {
    await alert(`❌ The following ${trns.size} trains have disappeared simultaneously!\n${listTrns(trns)}`);
}

export async function announceDisappearedTrain(prevStatus: TrainEmbedData): Promise<void> {
    await alert({
        content: `❌ Train T${prevStatus.trn} has disappeared!`,
        embeds: [prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceReappearedTrain(train: ActiveTrainEmbedData): Promise<void> {
    await alert({
        content: `✅ Train T${train.trn} has reappeared!`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceMultipleReappearedTrains(trns: Set<string>): Promise<void> {
    await alert(`✅ The following ${trns.size} trains have reappeared simultaneously!\n${listTrns(trns)}`);
}

export async function announceTrainAppearedLate(train: ActiveTrainEmbedData, delay: number): Promise<void> {
    await alert({
        content: `✅ Train T${train.trn} has appeared for the first time today, but ${Math.round(delay / 60)} minutes later than its first timetabled passenger departure`,
        embeds: [trainEmbed(train)]
    });
}

// Geo API

const GEO_API_EVENT_TYPES: Record<GeoApiEventType, string> = {
    APPROACHING: "Approaching",
    ARRIVED: "Arrived",
    READY_TO_START: "Ready to start",
    DEPARTED: "Departed",
};

/** Renders the Geo API's last seen status, in the same format as the Pop app's map */
function renderGeoApiLastSeenStatus(lastSeen: GeoApiData["lastSeen"]): string {
    if (typeof lastSeen === "string") return lastSeen;
    const time = lastSeen.time.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `${GEO_API_EVENT_TYPES[lastSeen.type]} ${renderParsedPlatform(lastSeen)} at ${time}`;
}

export function renderGeoApiLastSeen(lastSeen: GeoApiData["lastSeen"], trainTimetable?: TrainTimetable): string {
    const rendered = renderGeoApiLastSeenStatus(lastSeen);
    return trainTimetable
        ? `${rendered} (${renderDelay(calculateDelayFromGeoApi(trainTimetable, lastSeen))})`
        : rendered;
}

export async function announceUnparseableLastSeen(
    currStatus: ActiveTrainEmbedData,
    prevStatus: TrainEmbedData
): Promise<void> {
    await alert({
        content: `⚠️ Not able to parse the last seen message (from the Geo API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

// Times API

export function renderTimesApiLocation(location: string | ParsedPlatform): string {
    return typeof location === "string" ? location : renderParsedPlatform(location);
}

/** Renders the Times API's last event, in the same format as the Pop app */
export function renderTimesApiLastEvent(lastEvent: TimesApiData["lastEvent"], trainTimetable?: TrainTimetable): string {
    const start = `${lastEvent.type.replaceAll("_", " ")} ${renderTimesApiLocation(lastEvent.location)} at ${lastEvent.time.toLocaleTimeString('en-GB')}`;
    return trainTimetable ? `${start} (${renderDelay(calculateDelayFromTimesApi(trainTimetable, lastEvent))})` : start;
}

export async function announceUnparseableLastEventLocation(
    currStatus: ActiveTrainEmbedData,
    prevStatus: TrainEmbedData,
): Promise<void> {
    await alert({
        content: `⚠️ Not able to parse the last event location (from the Times API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}
