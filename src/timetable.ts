import {apiConstants, compareTimes, getStationCode} from "./cache";
import {
    DayTimetable,
    ExpectedTrainState,
    parseLastSeen, parseTimesAPILocation,
    TimesApiData,
    TrainTimetable,
} from "metro-api-client";
import {MONUMENT_STATION_CODES} from "./constants";

export function whenIsNextDay(date?: Date) {
    let nextDay = new Date(date);
    nextDay.setHours(apiConstants.NEW_DAY_HOUR);
    if (nextDay < date) nextDay.setDate(nextDay.getDate() + 1);
    return nextDay;
}

export function secondsSinceMidnight(date?: Date) {
    if (!date) date = new Date();
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

export function getTimetabledTrains(timetable: DayTimetable, time: number) {
    return Object.entries(timetable.trains)
        .filter(([_,trainTimetable]) => getExpectedTrainState(trainTimetable, time).inService)
        .map(([trn]) => trn);
}

export function getExpectedTrainState(trainTimetable: TrainTimetable, time: number): ExpectedTrainState {
    for (const [index, entry] of trainTimetable.entries()) {
        if (entry.arrivalTime && compareTimes(entry.arrivalTime, time) > 0) {
            // There should always be a previous entry because the first entry should not have an arrival time
            const previousEntry = trainTimetable[index - 1];
            if (compareTimes(entry.arrivalTime, time) > compareTimes(time, previousEntry.departureTime)) {
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
    const lastEntry = trainTimetable[trainTimetable.length - 1];
    return {
        event: lastEntry.departureTime && compareTimes(lastEntry.departureTime, time) <= 0 ? 'DEPARTED' : 'ARRIVED',
        location: lastEntry.location,
        inService: lastEntry.inService,
        destination: lastEntry.destination,
    };
}

const LOCATION_REGEX = new RegExp(/^(?<station>[A-Z]{3})(_(?<platform>\d+))?$/);
export function parseLocation(location: string) {
    const match = location.match(LOCATION_REGEX);
    if (match?.groups) {
        return {
            station: match.groups.station,
            platform: match.groups.platform ? +match.groups.platform : undefined
        };
    }
}

const IGNORE_PLATFORM_STATIONS = ['APT', 'SHL', 'SJM', 'SSS', 'PJC'];

export function locationsMatch(location1: string, location2: string) {
    if (location1 === location2) return true;
    const parsedLocation1 = parseLocation(location1);
    const parsedLocation2 = parseLocation(location2);
    if (!parsedLocation1 || !parsedLocation2) return false;
    if (
        parsedLocation1.platform !== undefined &&
        parsedLocation2.platform !== undefined &&
        parsedLocation1.platform !== parsedLocation2.platform &&
        !IGNORE_PLATFORM_STATIONS.includes(parsedLocation1.station)
    ) return false;
    if (parsedLocation1.station === parsedLocation2.station) return true;
    return MONUMENT_STATION_CODES.includes(parsedLocation1.station) &&
        MONUMENT_STATION_CODES.includes(parsedLocation2.station);
}

export function calculateDelay(
    trainTimetable: TrainTimetable,
    time: number,
    location: string,
    departed: boolean
) {
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

export function calculateDelayFromTimesAPI(
    trainTimetable: TrainTimetable,
    lastEvent: TimesApiData['lastEvent'],
) {
    const parsedLocation = parseTimesAPILocation(lastEvent.location);
    if (parsedLocation) return calculateDelay(
        trainTimetable,
        secondsSinceMidnight(lastEvent.time),
        `${getStationCode(parsedLocation.station)}_${parsedLocation.platform}`,
        ["DEPARTED", "READY_TO_START", "READY_TO_DEPART"].includes(
            lastEvent.type.toUpperCase().replace(' ', '_')
        )
    );
}

export function calculateDelayFromTrainStatusesAPI(
    trainTimetable: TrainTimetable,
    lastSeen: string,
) {
    const parsedLastSeen = parseLastSeen(lastSeen);
    if (parsedLastSeen) return calculateDelay(
        trainTimetable,
        parsedLastSeen.hours * 3600 + parsedLastSeen.minutes * 60,
        `${getStationCode(parsedLastSeen.station)}_${parsedLastSeen.platform}`,
        parsedLastSeen.state === 'Departed' || parsedLastSeen.state === 'Ready to start'
    );
}
