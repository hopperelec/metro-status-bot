import {
    ApiConstants, compareTimes as _compareTimes, DayTimetable, FullTrainsResponse, MetroApiClient, PlatformNumber,
} from "tnw-metro-api-client";
import {whenIsNextDay} from "./timetable";
import {proxy, updateActivity} from "./bot";
import {DatedTrainStatus} from "./train-status";

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
export let lastHistoryEntries: Record<string, DatedTrainStatus> = {};
export let trainsWithHistory = new Set<string>();

export async function refreshCache(proxy: MetroApiClient) {
    console.log("Refreshing cache...");
    await Promise.all([
        proxy.getConstants().then(constants => apiConstants = constants),

        refreshTodaysTimetable(),

        (proxy.getTrains() as Promise<FullTrainsResponse>).then(async trainsResponse => {
            lastHistoryEntries = Object.fromEntries(
                Object.entries(trainsResponse.trains).map(([trn, train]) => {
                    return [trn, {
                        date: train.statusLastChanged.startedAt,
                        status: train.status,
                    }];
                })
            );
            lastHeartbeat = trainsResponse.lastHeartbeat.startedAt;
            await updateActivity(Object.keys(trainsResponse.trains).length);
        }),

        proxy.getTrnsWithHistory().then(trns => trainsWithHistory = new Set(trns)),
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
        if (apiConstants.LOCATION_ABBREVIATIONS[code]!.toLowerCase() === station) {
            return code;
        }
    }
}

export function compareTimes(a: number, b: number) {
    return _compareTimes(a, b, apiConstants.NEW_DAY_HOUR);
}
