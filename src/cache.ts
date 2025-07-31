import {
    ActiveTrainHistoryEntry,
    ApiConstants, compareTimes as _compareTimes, DayTimetable, FullTrainsResponse,
    MetroApiClient, PlatformNumber,
} from "metro-api-client";
import {whenIsNextDay} from "./timetable";
import {proxy, updateActivity} from "./bot";

export let lastHeartbeat: Date;
export function setLastHeartbeat(date: Date) {
    lastHeartbeat = date;
}

let whenToRefreshTimetable: Date
let todaysTimetable: DayTimetable;

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
export let lastHistoryEntries: Record<string, Omit<ActiveTrainHistoryEntry, "active">> = {};
export let trainsWithHistory = new Set<string>();

export async function refreshCache(proxy: MetroApiClient) {
    console.log("Refreshing cache...");
    apiConstants = await proxy.getConstants();

    await refreshTodaysTimetable();

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

export function getStationCode(station: string, platform?: PlatformNumber) {
    station = station.toLowerCase();
    if (station === "monument") {
        if (platform === 1 || platform === 2) return "MTS";
        if (platform === 3 || platform === 4) return "MTW";
    }
    for (const code of apiConstants.PASSENGER_STOPS) {
        if (apiConstants.LOCATION_ABBREVIATIONS[code].toLowerCase() === station) {
            return code;
        }
    }
}

export function compareTimes(a: number, b: number) {
    return _compareTimes(a, b, apiConstants.NEW_DAY_HOUR);
}
