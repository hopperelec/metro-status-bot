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
    todaysTimetable = await proxy.getTimetable({ date: lastHeartbeat });
}

export async function getTodaysTimetable() {
    if (whenToRefreshTimetable < lastHeartbeat) {
        whenToRefreshTimetable = whenIsNextDay(lastHeartbeat);
        await refreshTodaysTimetable();
    }
    return todaysTimetable;
}

export let apiConstants: ApiConstants;
export let lastHistoryEntries: Record<string, Omit<ActiveTrainHistoryEntry, "active">> = {};
export let trainsWithHistory = new Set<string>();

export async function refreshCache(proxy: MetroApiClient) {
    console.log("Refreshing cache...");
    await Promise.all([
        proxy.getConstants().then(constants => apiConstants = constants),

        refreshTodaysTimetable(),

        proxy.getTrains().then(async (trainsResponse: FullTrainsResponse) => {
            lastHistoryEntries = Object.fromEntries(
                Object.entries(trainsResponse.trains).map(([trn, train]) => {
                    return [trn, {
                        date: train.lastChanged,
                        active: true,
                        status: train.status,
                    }];
                })
            );
            lastHeartbeat = trainsResponse.lastChecked;
            await updateActivity(Object.keys(trainsResponse.trains).length);
        }),

        proxy.getHistorySummary().then(historySummary => {
            trainsWithHistory = new Set(Object.keys(historySummary.trains));
        }),
    ]);
    whenToRefreshTimetable = whenIsNextDay(lastHeartbeat);
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
