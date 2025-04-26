import {
    ActiveTrainHistoryEntry,
    ApiConstants, compareTimes as _compareTimes, FullTrainsResponse,
    MetroApiClient, TrainTimetable
} from "metro-api-client";
import {DayType, getDayType} from "./timetable";
import {updateActivity} from "./bot";

const EXAMPLE_WEEKDAY = new Date(2024, 0, 1);
const EXAMPLE_SATURDAY = new Date(2024, 0, 6);
const EXAMPLE_SUNDAY = new Date(2024, 0, 7);

export let apiConstants: ApiConstants;
export let timetable: { [key in DayType]: Record<string, TrainTimetable> };
export let timetabledTrns: Set<string> = new Set();
export let lastHeartbeat: Date;
export let lastHistoryEntries: Record<string, Omit<ActiveTrainHistoryEntry, "active">> = {};
export let trainsWithHistory = new Set<string>();

export function setLastHeartbeat(date: Date) {
    lastHeartbeat = date;
}

export async function refreshCache(proxy: MetroApiClient) {
    console.log("Refreshing cache...");
    apiConstants = await proxy.getConstants();

    // The proxy does not enforce this, since it might change in the future,
    // but right now the proxy uses the same timetable for all weekdays, saturdays and sundays.
    // So, for simplicity, the bot will assume that is the case.
    timetable = {
        weekday: await proxy.getTimetable({ date: EXAMPLE_WEEKDAY }),
        saturday: await proxy.getTimetable({ date: EXAMPLE_SATURDAY }),
        sunday: await proxy.getTimetable({ date: EXAMPLE_SUNDAY })
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