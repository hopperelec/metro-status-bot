import {apiConstants, compareTimes, getStationCode} from "./cache";
import {
    DayTimetable,
    ExpectedTrainState,
    parseLastSeen, parseTimesAPILocation,
    TimesApiData, TrainStatusesApiData,
    TrainTimetable,
    TrainTimetableEntry
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
    let index = 0;
    let state: ExpectedTrainState;
    let entry: TrainTimetableEntry;
    while (index < trainTimetable.length) {
        entry = trainTimetable[index];
        if (entry.arrivalTime && compareTimes(entry.arrivalTime, time) > 0) {
            // There should always be a previous entry because the first entry should not have an arrival time
            const previousEntry = trainTimetable[index - 1];
            if (compareTimes(entry.arrivalTime, time) > compareTimes(time, previousEntry.departureTime)) {
                state = {
                    event: 'DEPARTED',
                    location: previousEntry.location,
                    inService: previousEntry.inService,
                    destination: previousEntry.destination,
                };
            } else {
                state = {
                    event: 'APPROACHING',
                    location: entry.location,
                    inService: previousEntry.inService,
                    destination: entry.destination,
                };
            }
        } else if (entry.departureTime && compareTimes(entry.departureTime, time) > 0) {
            state = {
                event: 'ARRIVED',
                location: entry.location,
                inService: entry.inService,
                destination: entry.destination,
            }
        }
        if (state) break;
        index++;
    }
    if (!state) {
        // If we reach here, the train has already departed from the last station
        const lastEntry = trainTimetable[trainTimetable.length - 1];
        return {
            event: lastEntry.departureTime && compareTimes(lastEntry.departureTime, time) <= 0 ? 'DEPARTED' : 'ARRIVED',
            location: lastEntry.location,
            inService: lastEntry.inService,
            destination: lastEntry.destination,
        };
    }
    return state;
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

export function locationsMatch(location: string, destination: string) {
    if (location === destination) return true;
    const parsedLocation = parseLocation(location);
    const parsedDestination = parseLocation(destination);
    if (!parsedLocation || !parsedDestination) return false;
    if (
        parsedLocation.platform !== undefined &&
        parsedDestination.platform !== undefined &&
        parsedLocation.platform !== parsedDestination.platform
    ) return false;
    if (parsedLocation.station === parsedDestination.station) return true;
    return MONUMENT_STATION_CODES.includes(parsedLocation.station) &&
        MONUMENT_STATION_CODES.includes(parsedDestination.station);
}

export function calculateDifferenceToTimetable(
    trainTimetable: TrainTimetable,
    time: number,
    location: string,
    departed: boolean,
    destinationStationCode: string
) {
    let smallestTimeDifference = Infinity;
    for (const entry of trainTimetable) {
        if (!locationsMatch(entry.location, location)) continue;
        if (!locationsMatch(entry.destination, destinationStationCode)) continue;
        const entryTime = departed ? entry.departureTime : entry.arrivalTime;
        if (!entryTime) continue;
        const timeDifference = compareTimes(entryTime, time);
        if (Math.abs(timeDifference) < Math.abs(smallestTimeDifference)) {
            smallestTimeDifference = timeDifference;
        }
    }
    return smallestTimeDifference;
}

export function calculateDifferenceToTimetableFromTimesAPI(
    trainTimetable: TrainTimetable,
    apiData: TimesApiData,
) {
    const parsedLocation = parseTimesAPILocation(apiData.lastEvent.location);
    if (parsedLocation) return calculateDifferenceToTimetable(
        trainTimetable,
        secondsSinceMidnight(apiData.lastEvent.time),
        `${getStationCode(parsedLocation.station)}_${parsedLocation.platform}`,
        ["DEPARTED", "READY_TO_START", "READY_TO_DEPART"].includes(
            apiData.lastEvent.type.toUpperCase().replace(' ', '_')
        ),
        getStationCode(apiData.plannedDestinations[0].name)
    );
}

export function calculateDifferenceToTimetableFromTrainStatusesAPI(
    trainTimetable: TrainTimetable,
    apiData: TrainStatusesApiData
) {
    const parsedLastSeen = parseLastSeen(apiData.lastSeen);
    if (parsedLastSeen) return calculateDifferenceToTimetable(
        trainTimetable,
        parsedLastSeen.hours * 3600 + parsedLastSeen.minutes * 60,
        `${getStationCode(parsedLastSeen.station)}_${parsedLastSeen.platform}`,
        parsedLastSeen.state === 'Departed' || parsedLastSeen.state === 'Ready to start',
        getStationCode(apiData.destination)
    );
}
