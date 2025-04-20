import {
    ActiveHistoryEntry,
    ApiConstants, compareTimes as _compareTimes, FullTimetableResponseTable, FullTrainsResponse,
    MetroApiClient
} from "metro-api-client";
import {DayType, getDayType} from "./timetable";
import {updateActivity} from "./bot";

export let apiConstants: ApiConstants;
export let timetable: { [key in DayType]: Record<string, FullTimetableResponseTable<true>> };
export let timetabledTrns: Set<string> = new Set();
export let lastHeartbeat: Date;
export let lastHistoryEntries: Record<string, Omit<ActiveHistoryEntry, "active">> = {};
export let trainsWithHistory = new Set<string>();

export function setLastHeartbeat(date: Date) {
    lastHeartbeat = date;
}

export async function refreshCache(proxy: MetroApiClient) {
    apiConstants = await proxy.getConstants();

    // For the bot, we assume that the timetable is the same for all weekdays.
    // The proxy does not enforce this but, at least right now, it is true in the real world.
    timetable = {
        weekday: await proxy.getTimetable({ day: 0 }) as Record<string, FullTimetableResponseTable<true>>,
        saturday: await proxy.getTimetable({ day: 5 }) as Record<string, FullTimetableResponseTable<true>>,
        sunday: await proxy.getTimetable({ day: 6 }) as Record<string, FullTimetableResponseTable<true>>
    };
    timetabledTrns = new Set(Object.values(timetable).flatMap(dayTimetable => Object.keys(dayTimetable)));

    const trainsResponse = await proxy.getTrains() as FullTrainsResponse;
    lastHistoryEntries = Object.fromEntries(
        Object.entries(trainsResponse.trains).map(([trn, train]) => {
            return [trn, {
                date: train.lastChanged,
                active: true,
                status: train.status,
            }];
        })
    )
    lastHeartbeat = trainsResponse.lastChecked;

    const historySummary = await proxy.getHistorySummary();
    trainsWithHistory = new Set(Object.keys(historySummary.trains));
    await updateActivity(Object.keys(trainsResponse.trains).length);
}

export function getStationCode(station: string) {
    for (const [code, name] of Object.entries(apiConstants.STATION_CODES)) {
        if (name.toLowerCase() === station.toLowerCase()) {
            if (code in apiConstants.NIS_STATIONS) return;
            return code;
        }
    }
}

export function getDayTimetable(date?: Date) {
    return timetable[getDayType(date)];
}

export function compareTimes(a: string, b: string) {
    return _compareTimes(a, b, apiConstants.NEW_DAY_HOUR);
}