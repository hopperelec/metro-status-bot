import {apiConstants, compareTimes, getStationCode} from "./cache";
import {
    DayTimetable,
    ExpectedTrainState,
    GeoApiData,
    ParsedPlatform,
    TimesApiData,
    TrainTimetable,
    TrainTimetableEntry,
} from "tnw-metro-api-client";
import {MONUMENT_STATION_CODES} from "./constants";

export function whenIsNextDay(date = new Date()): Date {
    const nextDay = new Date(date);
    nextDay.setHours(apiConstants.NEW_DAY_HOUR);
    if (nextDay < date) nextDay.setDate(nextDay.getDate() + 1);
    return nextDay;
}

export function secondsSinceMidnight(date?: Date): number {
    if (!date) date = new Date();
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

// At least one of an entry's arrival and departure times is always present

/** When an entry starts, which is when the train arrives, or departs if it starts at the entry's location */
export function entryStartTime(entry: Pick<TrainTimetableEntry, 'arrivalTime' | 'departureTime'>): number {
    return (entry.arrivalTime ?? entry.departureTime)!;
}

/** When an entry ends, which is when the train departs, or arrives if it terminates at the entry's location */
export function entryEndTime(entry: Pick<TrainTimetableEntry, 'arrivalTime' | 'departureTime'>): number {
    return (entry.departureTime ?? entry.arrivalTime)!;
}

export function getTimetabledTrains(timetable: DayTimetable, time: number): string[] {
    return Object.entries(timetable.trains)
        .filter(([_,trainTimetable]) => getExpectedTrainState(trainTimetable, time).inService)
        .map(([trn]) => trn);
}

export function isNightHours(trainTimetable: TrainTimetable, date: Date): boolean {
    const time = secondsSinceMidnight(date);

    if (compareTimes(time, entryStartTime(trainTimetable[0]!)) < 0) return true;
    return compareTimes(time, entryEndTime(trainTimetable[trainTimetable.length - 1]!)) > 0;
}

export function getExpectedTrainState(trainTimetable: TrainTimetable, time: number): ExpectedTrainState {
    // Special case for GTFS timetables, which only include inService entries
    const firstEntry = trainTimetable[0]!;
    if (firstEntry.inService && firstEntry.arrivalTime !== undefined && compareTimes(time, firstEntry.arrivalTime) < 0) {
        return {
            event: 'APPROACHING',
            location: firstEntry.location,
            inService: false,
            destination: firstEntry.location,
        };
    }

    for (const [index, entry] of trainTimetable.entries()) {
        if (index !== 0 && entry.arrivalTime && compareTimes(entry.arrivalTime, time) > 0) {
            const previousEntry = trainTimetable[index - 1]!;
            if (compareTimes(entry.arrivalTime, time) > compareTimes(time, entryEndTime(previousEntry))) {
                return {
                    event: 'DEPARTED',
                    location: previousEntry.location,
                    inService: previousEntry.inService,
                    destination: previousEntry.destination,
                };
            }
            return {
                event: 'APPROACHING',
                location: entry.location,
                inService: previousEntry.inService,
                destination: entry.destination,
            };
        }
        if (entry.departureTime && compareTimes(entry.departureTime, time) > 0) {
            return {
                event: entry.arrivalTime ? 'ARRIVED' : 'TERMINATED',
                location: entry.location,
                inService: entry.inService,
                destination: entry.destination,
            }
        }
    }
    // If we reach here, the train has already departed from the last station
    const lastEntry = trainTimetable[trainTimetable.length - 1]!;
    return {
        event: lastEntry.departureTime && compareTimes(lastEntry.departureTime, time) <= 0 ? 'DEPARTED' : 'ARRIVED',
        location: lastEntry.location,
        inService: false,
        destination: lastEntry.destination,
    };
}

export interface ParsedLocation {
    stationCode: string;
    platformNumber?: number;
}

const LOCATION_REGEX = new RegExp(/^(?<station>[A-Z]{3})(_(?<platform>\d+))?$/);
export function parseLocationCode(location: string): ParsedLocation | undefined {
    const match = location.match(LOCATION_REGEX);
    if (match?.groups) {
        return {
            stationCode: match.groups.station!,
            platformNumber: match.groups.platform ? +match.groups.platform : undefined
        };
    }
}

export function parsedPlatformToLocationCode(platform: ParsedPlatform): string | undefined {
    const stationCode = getStationCode(platform.station);
    if (stationCode) return `${stationCode}_${platform.platformNumber}`;
}

const IGNORE_PLATFORM_STATIONS = ['APT', 'SHL', 'SJM', 'SSS', 'PJC'];

export function locationsMatch(location1: string, location2: string): boolean {
    if (location1 === location2) return true;
    const parsedLocation1 = parseLocationCode(location1);
    if (!parsedLocation1) return false;
    const parsedLocation2 = parseLocationCode(location2);
    if (!parsedLocation2) return false;
    if (
        parsedLocation1.platformNumber !== undefined &&
        parsedLocation2.platformNumber !== undefined &&
        parsedLocation1.platformNumber !== parsedLocation2.platformNumber &&
        !IGNORE_PLATFORM_STATIONS.includes(parsedLocation1.stationCode)
    ) return false;
    if (parsedLocation1.stationCode === parsedLocation2.stationCode) return true;
    return MONUMENT_STATION_CODES.includes(parsedLocation1.stationCode) &&
        MONUMENT_STATION_CODES.includes(parsedLocation2.stationCode);
}

export function calculateDelay(
    trainTimetable: TrainTimetable,
    time: number,
    location: string,
    departed: boolean
): number {
    if (!trainTimetable) return Infinity;
    let smallestTimeDifference = Infinity;
    for (const entry of trainTimetable) {
        if (!locationsMatch(entry.location, location)) continue;
        const entryTime = departed ? entry.departureTime : entry.arrivalTime;
        if (!entryTime) continue;
        const timeDifference = compareTimes(time, entryTime);
        if (Math.abs(timeDifference) < Math.abs(smallestTimeDifference)) {
            smallestTimeDifference = timeDifference;
        }
    }
    return smallestTimeDifference;
}

export function calculateDelayFromTimesApi(
    trainTimetable: TrainTimetable,
    lastEvent: TimesApiData['lastEvent'],
): number {
    const location = lastEvent.location;
    // The delay can't be known without the location, which is different to the train being untimetabled (Infinity)
    if (typeof location === "string") return NaN;
    const locationCode = parsedPlatformToLocationCode(location);
    if (!locationCode) return NaN;
    return calculateDelay(
        trainTimetable,
        secondsSinceMidnight(lastEvent.time),
        locationCode,
        ["DEPARTED", "READY_TO_START", "READY_TO_DEPART"].includes(
            lastEvent.type.toUpperCase().replace(' ', '_')
        )
    );
}

export function calculateDelayFromGeoApi(
    trainTimetable: TrainTimetable,
    lastSeen: GeoApiData['lastSeen'],
): number {
    // The delay can't be known without the location, which is different to the train being untimetabled (Infinity)
    if (typeof lastSeen === "string") return NaN;
    const locationCode = parsedPlatformToLocationCode(lastSeen);
    if (!locationCode) return NaN;
    return calculateDelay(
        trainTimetable,
        secondsSinceMidnight(lastSeen.time),
        locationCode,
        lastSeen.type === 'DEPARTED' || lastSeen.type === 'READY_TO_START'
    );
}
