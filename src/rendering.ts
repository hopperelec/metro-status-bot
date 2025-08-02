import {MAX_PLANNED_DESTINATIONS, MONUMENT_STATION_CODES} from "./constants";
import {apiConstants, lastHeartbeat} from "./cache";
import {EmbedBuilder} from "discord.js";
import {
    ActiveTrainHistoryStatus,
    CollatedTrain, ExpectedTrainState, HeartbeatErrorPayload, HeartbeatWarningsPayload,
    TimesApiData, TrainTimetable
} from "metro-api-client";
import {
    calculateDelayFromTimesAPI,
    calculateDelayFromTrainStatusesAPI,
    parseLocation
} from "./timetable";
import {alert} from "./bot";

export type TrainEmbedData = {
    trn: string;
    status: CollatedTrain | ActiveTrainHistoryStatus;
    date: Date;
    timetable?: TrainTimetable;
}

export function dueInToString(dueIn: number) {
    switch (dueIn) {
        case -2: return "Delayed";
        case -1: return "Arrived";
        case 0: return "Due";
        case 1: return "1 min";
        default: return `${dueIn} mins`;
    }
}

function renderSignedNumber(value: number) {
    return `${value >= 0 ? '+' : ''}${value}`;
}

export function renderDelay(delay: number) {
    if (delay === Infinity) return "untimetabled";
    if (Math.abs(delay) <= 60) return "on time";
    if (Math.abs(delay) < 120) return `${renderSignedNumber(delay)}s`;
    return `${renderSignedNumber(Math.round(delay / 60))}m`;
}

export function renderTimesAPILastEvent(lastEvent: TimesApiData["lastEvent"], trainTimetable?: TrainTimetable) {
    const start = `${lastEvent.type.replaceAll("_", " ")} ${lastEvent.location} at ${lastEvent.time.toLocaleTimeString('en-GB')}`;
    return trainTimetable ? `${start} (${renderDelay(calculateDelayFromTimesAPI(trainTimetable, lastEvent))})` : start;
}

export function renderTrainStatusesAPILastSeen(lastSeen: string, trainTimetable?: TrainTimetable) {
    return trainTimetable
        ? `${lastSeen} (${renderDelay(calculateDelayFromTrainStatusesAPI(trainTimetable, lastSeen))})`
        : lastSeen;
}

export function trainEmbed(train: TrainEmbedData) {
    const embed = new EmbedBuilder()
        .setTitle(`T${train.trn}`);

    let footer = `Last updated ${train.date.toLocaleTimeString()}`;
    if (train.date.getTime() !== lastHeartbeat.getTime()) {
        footer = `${footer}, last checked ${lastHeartbeat.toLocaleTimeString()}`;
    }
    embed.setFooter({ text: footer });

    if (train.status.timesAPI && train.status.trainStatusesAPI) {
        embed.setDescription("This train is showing in both APIs. Sometimes these APIs have conflicting data.\nFields marked with ⌛ are from the times API, and fields marked with 📍 are from the train statuses API.");
    } else if (train.status.timesAPI) {
        embed.setDescription("This train is only showing in the times API (⌛).");
    } else if (train.status.trainStatusesAPI) {
        embed.setDescription("This train is only showing in the train statuses API (📍).");
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
                name: "⌛ Last seen",
                value: renderTimesAPILastEvent(data.lastEvent, train.timetable)
            },
            {
                name: "⌛ Planned destinations",
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
                    name: "⌛ Next Platforms",
                    value: nextPlatformsString,
                }
            );
        }
    }

    if (train.status.trainStatusesAPI) {
        const data = train.status.trainStatusesAPI;
        embed.addFields(
            {
                name: "📍 Current destination",
                value: data.destination
            },
            {
                name: "📍 Last seen",
                value: renderTrainStatusesAPILastSeen(data.lastSeen, train.timetable)
            }
        )
    }
    return embed;
}

function prevTrainStatusEmbed(train: TrainEmbedData) {
    if (train.status)
        return trainEmbed(train).setTitle(`T${train.trn} (previous status)`)
    return new EmbedBuilder()
        .setTitle(`T${train.trn} (previous status)`)
        .setDescription("No previous status available.");
}

export function renderPlatform(stationCode: string, platform?: number) {
    if (platform === undefined) return apiConstants.LOCATION_ABBREVIATIONS[stationCode] || stationCode;
    return `${
        MONUMENT_STATION_CODES.includes(stationCode)
            ? "Monument"
            : apiConstants.LOCATION_ABBREVIATIONS[stationCode] || stationCode
    } platform ${platform}`;
}

const PLATFORM_CODE_REGEX = /^(?<station>[A-Z]{3});(?<platform>[1-4])$/;
export function renderPlatformCode(code: string) {
    const parsed = code.match(PLATFORM_CODE_REGEX);
    return parsed?.groups ? renderPlatform(parsed.groups.station, +parsed.groups.platform) : code;
}

export function renderLocation(location: string) {
    const parsedLocation = parseLocation(location);
    return parsedLocation ? renderPlatform(parsedLocation.station, parsedLocation.platform) : location;
}

export function renderExpectedTrainState(state: ExpectedTrainState, past: boolean = false) {
    const location = renderLocation(state.location);
    const destination = renderLocation(state.destination);
    let formatKey: string = state.event;
    if (formatKey === "APPROACHING" && location === destination) formatKey = "TERMINATING";
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

        case "DEPARTED":
        case "DEPARTED_PAST":
            return `have departed from ${location} towards ${destination}`;
        case "DEPARTED_NIS":
        case "DEPARTED_NIS_PAST":
            return `have departed empty from ${location} towards ${destination}`;
    }
}

// Heartbeats

function getAPIName(code: string) {
    if (code === "timesAPI") return "the times API";
    if (code === "trainStatusesAPI") return "the train statuses API";
    if (code === "gateway") return "the gateway (a prerequisite of the train statuses";
    return `an unrecognised API (${code})`;
}

export async function announceHeartbeatError(payload: HeartbeatErrorPayload) {
    await alert({
        content: `⚠️ An error occurred while fetching or parsing data from ${getAPIName(payload.api)}:\n` +
            `> ${payload.message}\n` +
            "-# This usually indicates a problem with or downtime of Nexus' APIs; the bot and proxy are still working fine.",
    });
}

export async function announceHeartbeatWarnings(payload: HeartbeatWarningsPayload) {
    const apiName = getAPIName(payload.api);
    await alert({
        content: `⚠️ One or more warnings were produced while parsing data from ${apiName}.\n` +
            "-# This usually indicates strange or unexpected behaviour from Nexus' APIs; the bot and proxy are still working fine.",
        files: [
            {
                name: "warnings.txt",
                description: `Warnings from ${apiName}`,
                attachment: Buffer.from(JSON.stringify(payload.warnings, null, 2))
            }
        ]
    });
}

// Either API

function listTrns(trns: Set<string>) {
    return `T${Array.from(trns).sort().join(", T")}`;
}

export async function announceTrainOnWrongDay(train: TrainEmbedData) {
    await alert({
        content: `🤔 Train T${train.trn} is active, but it isn't timetabled for today.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainOnWrongDayDisappeared(train: TrainEmbedData) {
    await alert({
        content: `🤔 Train T${train.trn} was active despite not being timetabled for today. However, it has now disappeared. Below is it's status from before it disappeared.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainDuringNightHours(train: TrainEmbedData) {
    await alert({
        content: `🌙 Train T${train.trn} is active during night hours.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceECS(train: TrainEmbedData) {
    await alert({
        content: `🧐 Train T${train.trn} is showing on the Pop app. While this TRN is timetabled for today, it is not meant to be in service, so the Pop app doesn't usually show it.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceUnrecognisedDestinations(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
    unrecognisedDestinations: string[]
) {
    let message: string;
    if (unrecognisedDestinations.length === 1) {
        const destination = unrecognisedDestinations[0];
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
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
    station: string,
) {
    const middle = station === "" ? "a blank station" : `an unrecognised station "${station}"`;
    await alert({
        content: `🤔 Train T${currStatus.trn} was last seen at ${middle}`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceTrainAtUnrecognisedPlatform(train: TrainEmbedData) {
    await alert({
        content: `🤔 Train T${train.trn} is at an unrecognised platform`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtStJamesP2(train: TrainEmbedData) {
    await alert({
        content: `🤔 Train T${train.trn} is at St James platform 2. ` +
            'This usually means either:\n' +
            '- it is ending service\n' +
            '- there is a Not In Service train on platform 1.\n' +
            '- there is ongoing maintenance work on platform 1.',
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainsAtBothPlatformsStJames(
    train1: TrainEmbedData,
    train2: TrainEmbedData
) {
    await alert({
        content: `🤔 Both platforms at St James are being used simultaneously, by trains T${train1.trn} and T${train2.trn}. ` +
            'This usually means one of them is not in service.',
        embeds: [trainEmbed(train1), trainEmbed(train2)]
    });
}

export async function announceTrainAtSouthShieldsP1(train: TrainEmbedData) {
    await alert({
        content: `🤔 Train T${train.trn} is at South Shields platform 1.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceTrainAtSunderlandP1orP4(train: TrainEmbedData, platform: 1 | 4) {
    await alert({
        content: `🤔 Train T${train.trn} is at Sunderland platform ${platform}, but Metro trains are currently only meant to use platforms 2 and 3.`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceAllTrainsDisappeared() {
    await alert({content: `❌ All trains have disappeared!`});
}

export async function announceMultipleDisappearedTrains(trns: Set<string>) {
    await alert(`❌ The following ${trns.size} trains have disappeared simultaneously!\n${listTrns(trns)}`);
}

export async function announceDisappearedTrain(prevStatus: TrainEmbedData) {
    await alert({
        content: `❌ Train T${prevStatus.trn} has disappeared!`,
        embeds: [prevTrainStatusEmbed(prevStatus)]
    });
}

export async function announceReappearedTrain(train: TrainEmbedData) {
    await alert({
        content: `✅ Train T${train.trn} has reappeared!`,
        embeds: [trainEmbed(train)]
    });
}

export async function announceMultipleReappearedTrains(trns: Set<string>) {
    await alert(`✅ The following ${trns.size} trains have reappeared simultaneously!\n${listTrns(trns)}`);
}

// Train statuses API

export async function announceUnparseableLastSeen(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData
) {
    await alert({
        content: `⚠️ Not able to parse the last seen message (from the train statuses API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}

// Times API

export async function announceUnparseableLastEventLocation(
    currStatus: TrainEmbedData,
    prevStatus: TrainEmbedData,
) {
    await alert({
        content: `⚠️ Not able to parse the last event location (from the times API) for train T${currStatus.trn}.`,
        embeds: [trainEmbed(currStatus), prevTrainStatusEmbed(prevStatus)]
    });
}
