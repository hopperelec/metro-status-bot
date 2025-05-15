import {apiConstants, compareTimes, getDayTimetable} from "./cache";
import {ExpectedTrainState, TrainTimetable} from "metro-api-client";
import {TRAIN_DIRECTIONS} from "./constants";

export type DayType =  'weekday' | 'saturday' | 'sunday';

export function getDayType(date: Date): DayType {
    const dateCopy = new Date(date);
    if (dateCopy.getHours() < apiConstants.NEW_DAY_HOUR) {
        dateCopy.setDate(dateCopy.getDate() - 1);
    }
    const day = dateCopy.getDay();
    if (day === 0) return "sunday";
    if (day === 6) return "saturday";
    return "weekday";
}

export function whenIsNextDay(date?: Date) {
    let nextDay = new Date(date);
    nextDay.setHours(apiConstants.NEW_DAY_HOUR);
    if (nextDay < date) nextDay.setDate(nextDay.getDate() + 1);
    return nextDay;
}

export function timeNumbersToStr(hours: number, minutes: number, seconds?: number) {
    const hoursStr = hours.toString().padStart(2, "0");
    const minutesStr = minutes.toString().padStart(2, "0");
    const secondsStr = (seconds || 30).toString().padStart(2, "0");
    return `${hoursStr}${minutesStr}${secondsStr}`;
}

export function timeDateToStr(date: Date) {
    return timeNumbersToStr(date.getHours(), date.getMinutes(), date.getSeconds());
}

export function getTimetabledTrains(date?: Date) {
    const timeStr = timeDateToStr(date);
    return Object.entries(getDayTimetable(date))
        .filter(([_,trainTimetable]) => {
            return getExpectedTrainState(trainTimetable, timeStr).state === "active";
        })
        .map(([trn]) => trn);
}

export function getFlatTimetableForTRN(trainTimetable: TrainTimetable, includeForms = false) {
    let sortedRoutes = TRAIN_DIRECTIONS
        .flatMap(direction =>
            trainTimetable[direction].map(
                route => {
                    const sortedStations = Object.entries(route.stations)
                        .sort((a, b) => compareTimes(a[1], b[1]));
                    const withoutForms = sortedStations.filter(([station]) => station !== "FORMS");
                    const destination = withoutForms.length
                        ? withoutForms[withoutForms.length - 1][0]
                        : "Not In Service";
                    return sortedStations
                        .map(([station, time]) => ({
                            station,
                            time,
                            direction,
                            route: route.code,
                            destination
                        }))
                }
            )
        )
        .filter(route => route.length)
        .sort((route1, route2) => compareTimes(route1[0].time, route2[0].time));
    if (!includeForms) {
        // This is done after sorting, so that sorting will work on routes only containing FORMS
        sortedRoutes = sortedRoutes.map(route => route.filter(({ station }) => station !== "FORMS"));
    }
    return sortedRoutes.flat();
}

export function getExpectedTrainState(trainTimetable: TrainTimetable, time: string): ExpectedTrainState {
    // The proxy tells us the expected train state in the `/train/:trn` endpoint.
    // However, we are already caching the full timetable locally.
    // So, we will figure it out locally.
    if (compareTimes(time, trainTimetable.departure.time) < 0) return {
        station1: trainTimetable.departure.place,
        station2: trainTimetable.departure.place,
        destination: trainTimetable.departure.place,
        state: 'not-started'
    };
    if (compareTimes(time, trainTimetable.arrival.time) >= 0) return {
        station1: trainTimetable.arrival.place,
        station2: trainTimetable.arrival.place,
        destination: trainTimetable.arrival.place,
        state: 'ended'
    };
    const fullTimetable = getFlatTimetableForTRN(trainTimetable, true);

    const firstEntry = fullTimetable[0];
    if (compareTimes(time, firstEntry.time) < 0) return {
        station1: trainTimetable.departure.place,
        station2: firstEntry.station === "FORMS" ? fullTimetable[1].station : firstEntry.station,
        destination: firstEntry.station,
        state: 'starting'
    };

    const lastEntry = fullTimetable[fullTimetable.length - 1];
    if (compareTimes(time, lastEntry.time) >= 0) return {
        station1: lastEntry.station === "FORMS" ? fullTimetable[fullTimetable.length - 2].station : lastEntry.station,
        station2: trainTimetable.arrival.place,
        destination: trainTimetable.arrival.place,
        state: 'ending'
    };

    let nextEntryIndex = fullTimetable.findIndex(({ time: t }) => compareTimes(time, t) <= 0);
    const nextEntry = fullTimetable[nextEntryIndex];
    let prevEntryIndex = nextEntryIndex - 1;
    const prevEntry = fullTimetable[prevEntryIndex];

    let station1 = prevEntry.station;
    if (station1 === "FORMS") {
        if (prevEntryIndex-- === -1) {
            return {
                station1: trainTimetable.departure.place,
                station2: nextEntry.station,
                destination: prevEntry.destination,
                state: 'starting'
            }
        }
        station1 = fullTimetable[prevEntryIndex].station;
    }

    let station2 = nextEntry.station;
    if (station2 === "FORMS") {
        if (nextEntryIndex++ === fullTimetable.length) {
            return {
                station1: prevEntry.station,
                station2: trainTimetable.arrival.place,
                destination: nextEntry.destination,
                state: 'ending'
            }
        }
        station2 = fullTimetable[nextEntryIndex].station;
    }

    return {
        station1,
        station2,
        destination: prevEntry.destination,
        state: apiConstants.NIS_STATIONS.includes(station1) || apiConstants.NIS_STATIONS.includes(station2)
            ? 'nis'
            : 'active'
    }
}

export function expectedTrainStateToString({ station1, station2, destination, state }: ExpectedTrainState) {
    const station1String = apiConstants.STATION_CODES[station1] || station1;
    const station2String = apiConstants.STATION_CODES[station2] || station2;
    let locationString: string;
    if (station1 === station2) {
        locationString = `at ${station1String}`;
    } else {
        locationString = `between ${station1String} and ${station2String}`;
    }
    if (state === "not-started")
        return `stored ${locationString}, ready to leave in the morning.`;
    if (state === "ended")
        return `stored ${locationString}, finished for the day.`;
    if (state === "starting")
        return `${locationString}, preparing to start service.`;
    if (state === "ending")
        return `${locationString}, ending service.`;
    if (state === "nis")
        return `Not In Service ${locationString}.`;
    if (station1 === destination) return `terminated at ${station1String}.`;
    if (station1 === "FORMS") {
        if (station2 === destination) return `terminated at but about to leave ${station2String}.`;
        return `about to leave ${station2String} for ${destination}.`;
    }
    const destinationString = apiConstants.STATION_CODES[destination] || destination;
    return `${locationString} heading to ${destinationString}.`;
}

export function calculateDifferenceToTimetable(
    trainTimetable: TrainTimetable,
    time: string,
    station: string,
    destination: string
) {
    if (!apiConstants.STATION_CODES[station] || !apiConstants.STATION_CODES[destination]) return Infinity;
    let smallestTimeDifference = Infinity;
    for (const direction of TRAIN_DIRECTIONS) {
        for (const route of trainTimetable[direction]) {
            const withoutForms = Object.entries(route.stations)
                .filter(([station]) => station !== "FORMS");
            if (withoutForms.length) {
                withoutForms.sort((a, b) => compareTimes(a[1], b[1]));
                if (withoutForms[withoutForms.length - 1][0] !== destination) continue;
            }
            const stationTime = route.stations[station];
            if (!stationTime) continue;
            const timeDifference = compareTimes(time, stationTime);
            if (Math.abs(timeDifference) < Math.abs(smallestTimeDifference)) {
                smallestTimeDifference = timeDifference;
            }
        }
    }
    return smallestTimeDifference;
}

export function differenceToTimetableToString(difference: number) {
    if (difference === Infinity) return "not running to timetable."
    if (Math.abs(difference) <= 60) return "on time.";
    if (difference > 120) return `running ${Math.round(difference/60)} minutes late.`;
    if (difference > 0) return `running ${difference} seconds late.`;
    if (difference < -120) return `${Math.round(-difference/60)} minutes early.`;
    return `${-difference} seconds early.`;
}
