import {MAX_PLANNED_DESTINATIONS, MONUMENT_STATION_CODES} from "./constants";
import {apiConstants, lastHeartbeat} from "./cache";
import {EmbedBuilder} from "discord.js";
import {
    ActiveTrainHistoryStatus,
    CollatedTrain, ExpectedTrainState,
    TimesApiData
} from "metro-api-client";
import {parseLocation} from "./timetable";

export type TrainEmbedData = {
    trn: string;
    status: CollatedTrain | ActiveTrainHistoryStatus;
    date: Date;
}

export function renderTimesAPILastSeen(data: TimesApiData["lastEvent"]) {
    return `${data.type.replaceAll("_", " ")} ${data.location} at ${data.time.toLocaleTimeString('en-GB')}`;
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
                value: renderTimesAPILastSeen(data.lastEvent)
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
                value: data.lastSeen
            }
        )
    }
    return embed;
}

export function prevTrainStatusEmbed(train: TrainEmbedData) {
    if (train.status)
        return trainEmbed(train).setTitle(`T${train.trn} (previous status)`)
    return new EmbedBuilder()
        .setTitle(`T${train.trn} (previous status)`)
        .setDescription("No previous status available.");
}

export function listTrns(trns: Set<string>) {
    return `T${Array.from(trns).sort().join(", T")}`;
}

export function renderPlatform(stationCode: string, platform?: number) {
    if (platform === undefined) return apiConstants.STATION_CODES[stationCode] || stationCode;
    return `${
        MONUMENT_STATION_CODES.includes(stationCode)
            ? "Monument"
            : apiConstants.STATION_CODES[stationCode] || stationCode
    } Platform ${platform}`;
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

export function renderExpectedTrainState(state: ExpectedTrainState) {
    const location = renderLocation(state.location);
    const destination = renderLocation(state.destination);
    if (state.event === 'DEPARTED') {
        return state.inService
            ? `have departed from ${location} heading to ${destination}`
            : `have departed from ${location} heading empty to ${destination}`;
    }
    if (state.event === 'ARRIVED') {
        if (state.inService) {
            return location === destination
                ? `be terminated at ${location}`
                : `be at ${location} heading to ${destination}`;
        }
        return location === destination
            ? `be terminated at ${location} not in service`
            : `be at ${location} heading empty to ${destination}`;
    }
    if (state.inService) {
        return location === destination
            ? `be terminating at ${location}`
            : `be approaching ${location} heading to ${destination}`;
    }
    return location === destination
        ? `be terminating empty at ${location}`
        : `be approaching ${location} heading empty to ${destination}`;
}

export function renderDifferenceToTimetable(difference: number) {
    if (difference === Infinity) return "not running to timetable."
    if (Math.abs(difference) <= 60) return "on time.";
    if (difference > 120) return `running ${Math.round(difference/60)} minutes late.`;
    if (difference > 0) return `running ${difference} seconds late.`;
    if (difference < -120) return `${Math.round(-difference/60)} minutes early.`;
    return `${-difference} seconds early.`;
}
