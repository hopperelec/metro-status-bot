import {
    ActiveTrainHistoryEntry,
    ApiConstants, compareTimes as _compareTimes, FullTrainsResponse,
    MetroApiClient, TrainTimetable
} from "metro-api-client";
import {DayType, getDayType, whenIsNextDay} from "./timetable";
import {proxy, updateActivity} from "./bot";

const EXAMPLE_WEEKDAY = new Date(2024, 0, 8);
const EXAMPLE_SATURDAY = new Date(2024, 0, 6);
const EXAMPLE_SUNDAY = new Date(2024, 0, 7);

export let lastHeartbeat: Date;
export function setLastHeartbeat(date: Date) {
    lastHeartbeat = date;
}

let whenToRefreshTimetable: Date
let todaysTimetable: Record<string, TrainTimetable>;

async function refreshTodaysTimetable() {
    const date = new Date();
    whenToRefreshTimetable = whenIsNextDay(date);
    todaysTimetable = await proxy.getTimetable({ date });
}

export async function getTodaysTimetable() {
    if (whenToRefreshTimetable < new Date()) {
        await refreshTodaysTimetable();
    }
    return todaysTimetable;
}

export let apiConstants: ApiConstants;
export let weekTimetable: { [key in DayType]: Record<string, TrainTimetable> };
export let timetabledTrns: Set<string> = new Set();
export let lastHistoryEntries: Record<string, Omit<ActiveTrainHistoryEntry, "active">> = {};
export let trainsWithHistory = new Set<string>();

export async function refreshCache(proxy: MetroApiClient) {
    console.log("Refreshing cache...");
    apiConstants = await proxy.getConstants();

    weekTimetable = {
        weekday: await proxy.getTimetable({ date: EXAMPLE_WEEKDAY }),
        saturday: await proxy.getTimetable({ date: EXAMPLE_SATURDAY }),
        sunday: await proxy.getTimetable({ date: EXAMPLE_SUNDAY })
    };
    await refreshTodaysTimetable();
    timetabledTrns = new Set(Object.values(weekTimetable).flatMap(dayTimetable => Object.keys(dayTimetable)));

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

export function getDayTimetable(date: Date) {
    return weekTimetable[getDayType(date)];
}

export function compareTimes(a: string, b: string) {
    return _compareTimes(a, b, apiConstants.NEW_DAY_HOUR);
}
