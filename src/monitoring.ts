import {DEFAULT_MISSING_THRESHOLD, MULTIPLE_TRAINS_THRESHOLD} from "./constants";
import {
    alertNowActive,
    alertSubscriptions,
    announceDisappearedTrain,
    announceReappearedTrain,
    announceTrainOnWrongDayDisappeared,
    updateActivity,
    announceUnparseableLastSeen,
    announceTrainAtStJamesP2,
    announceTrainAtUnrecognisedPlatform,
    announceTrainAtUnrecognisedStation,
    announceUnrecognisedDestination,
    announceTrainOnWrongDay,
    announceTrainDuringNightHours,
    TrainEmbedData,
    proxy,
    announceHeartbeatError,
    announceHeartbeatWarning,
    announceAllTrainsDisappeared,
    announceMultipleDisappearedTrains,
    announceMultipleReappearedTrains
} from "./bot";
import {
    apiConstants,
    getDayTimetable,
    getStationCode,
    refreshCache,
    lastHistoryEntries, compareTimes,
    trainsWithHistory, timetable, setLastHeartbeat, lastHeartbeat
} from "./cache";
import {
    ActiveHistoryEntry,
    ActiveHistoryStatus,
    CollatedTrain, FullNewHistoryPayload, FullTimetableResponseTable,
    ParsedLastSeen, parseLastSeen, PlatformNumber, TimesApiData,
    TrainStatusesApiData
} from "metro-api-client";
import {
    timeNumbersToStr,
    getDayType,
    getExpectedTrainState,
    getFlatTimetableForTRN,
    timeDateToStr,
    whenIsNextDay
} from "./timetable";

type TrainCheckData<Status = ActiveHistoryStatus> = {
    trn: string;
    curr: {
        date: Date,
        status: Status
    };
    prev?: {
        date: Date,
        status: ActiveHistoryStatus
    };
}

const missingTrains = new Map<string, {
    announced: true;
    whenToForget: Date;
} | {
    announced: false;
    prevStatus: Omit<ActiveHistoryEntry, "active">;
    whenToAnnounce: Date;
}>;
const seenStationCodes = new Set<string>();

let embedDatas: Record<string, TrainEmbedData> = {};
async function getFullEmbedData({ trn, curr }: TrainCheckData): Promise<TrainEmbedData> {
    // So that `nextStations` is only fetched once if needed
    let embedData = embedDatas[trn];
    if (embedData) return embedData;

    let fullStatus: CollatedTrain;
    if (curr.status.timesAPI) {
        // ActiveHistoryStatus is missing `nextStations`, so we need to fetch it
        const response = await proxy.getTrain(trn, {
            props: ["status.timesAPI.nextStations"],
        }) as {
            status: {
                timesAPI: {
                    nextPlatforms: TimesApiData["nextPlatforms"]
                }
            }
        };
        fullStatus = {
            ...curr,
            timesAPI: {
                ...curr.status.timesAPI,
                ...response.status.timesAPI,
            },
        };
    } else {
        // Nothing to add
        fullStatus = curr.status as CollatedTrain;
    }
    embedData = {
        trn,
        date: curr.date,
        status: fullStatus,
    }
    embedDatas[trn] = embedData
    return embedData;
}

// Doesn't announce on its own, in case I want to handle times API and statuses API separately
function checkPlatform(
    trn: string,
    station: string,
    platform: PlatformNumber,
    time: string
): "normal" | "unrecognised" | "st-james-p2" {
    let recognised = true;
    switch (platform) {
        case 1:
            recognised = station !== "SSS" && station !== "SHL";
            break;
        case 2:
            if (station === "STJ") {
                const trainTimetable = getDayTimetable()[trn];
                if (!trainTimetable) break;
                const fullTimetable = getFlatTimetableForTRN(trainTimetable);
                if (
                    trainTimetable.departure.place === "St James Platform 2" &&
                    compareTimes(time, fullTimetable[0].time) <= 0
                ) break;
                if (
                    trainTimetable.arrival.place === "St James Platform 2" &&
                    compareTimes(time, fullTimetable[fullTimetable.length - 1].time) >= 0
                ) break;
                return "st-james-p2";
            }
            break;
        case 3:
            recognised = ["MMT", "MTW", "MTE", "SUN"].includes(station);
            break;
        case 4:
            recognised = ["MMT", "MTW", "MTE"].includes(station);
            break;
        default:
            recognised = false;
    }
    return recognised ? "normal" : "unrecognised";
}

// Checks which depend on the train statuses API, but don't depend on the times API
async function trainStatusesChecks(
    checkData: TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
    parsedLastSeen?: ParsedLastSeen
) {
    // TODO: Do these checks really need to be exclusive to the train statuses API?
    const { trn, curr, prev } = checkData;
    const prevTrainStatus = prev?.status.trainStatusesAPI;
    const currTrainStatus = curr.status.trainStatusesAPI;
    const lastSeenChanged = !prevTrainStatus || currTrainStatus.lastSeen !== prevTrainStatus?.lastSeen;

    if (
        !getStationCode(currTrainStatus.destination) &&
        (!prev || currTrainStatus.destination !== prevTrainStatus?.destination)
    ) await announceUnrecognisedDestination(
        await getFullEmbedData(checkData),
        { trn, ...prev }
    );

    if (parsedLastSeen) {
        if (
            !getStationCode(parsedLastSeen.station) && (
                !prevTrainStatus || parsedLastSeen.station !== parseLastSeen(prevTrainStatus.lastSeen).station
            )
        ) await announceTrainAtUnrecognisedStation(
            await getFullEmbedData(checkData),
            { trn, ...prev },
            parsedLastSeen.station
        );
    } else if (lastSeenChanged) {
        await announceUnparseableLastSeen(
            await getFullEmbedData(checkData)
        );
    }
}

// Checks which depend on both APIs
async function bothAPIsChecks(
    checkData: TrainCheckData<{ timesAPI: TimesApiData, trainStatusesAPI: TrainStatusesApiData }>,
    parsedLastSeen?: ParsedLastSeen
) {
    // Currently, these checks are only about the last seen location
    if (!parsedLastSeen) return;
    const stationCode = getStationCode(parsedLastSeen.station);
    if (!stationCode) return;

    const { trn, curr, prev } = checkData;

    // If each API is reporting a different last seen location, don't trust it
    if (
        parsedLastSeen.station !== curr.status.timesAPI.lastEvent.station ||
        parsedLastSeen.platform !== curr.status.timesAPI.lastEvent.platform
    ) return;

    // If the last seen location has not changed, don't repeat announcements
    if (
        prev &&
        parsedLastSeen.station === prev.status.timesAPI.lastEvent.station &&
        parsedLastSeen.platform === prev.status.timesAPI.lastEvent.platform
    ) return;

    const platformCheck = checkPlatform(
        trn,
        stationCode,
        parsedLastSeen.platform,
        `${parsedLastSeen.hours}${parsedLastSeen.minutes}`
    );
    if (platformCheck === "unrecognised") {
        await announceTrainAtUnrecognisedPlatform(
            await getFullEmbedData(checkData)
        );
    } else if (platformCheck === "st-james-p2") {
        await announceTrainAtStJamesP2(
            await getFullEmbedData(checkData)
        );
    }
}

// Checks which can be done with either API
async function eitherAPIsChecks(
    checkData: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen
) {
    // These checks are about a train being present
    // (e.g.: on the wrong day or during night hours),
    // regardless of its current status

    const { trn, curr, prev } = checkData;

    // Don't repeat these announcements unless the train's current destination changes
    if (
        prev?.status &&
        curr.status.trainStatusesAPI?.destination === prev.status.trainStatusesAPI?.destination &&
        curr.status.timesAPI?.plannedDestinations[0].name === prev.status.timesAPI?.plannedDestinations[0].name
    ) return;

    const dateInTimes = curr.status.timesAPI?.lastEvent.time;

    let dateInStatuses: Date;
    if (parsedLastSeen) {
        dateInStatuses = new Date(curr.date);
        dateInStatuses.setHours(parsedLastSeen.hours);
        dateInStatuses.setMinutes(parsedLastSeen.minutes);
        if (parsedLastSeen.hours - curr.date.getHours() >= 12) {
            dateInStatuses.setDate(dateInStatuses.getDate() - 1);
        }
    }

    let timetableInTimes: FullTimetableResponseTable<true> | undefined;
    if (dateInTimes) {
        timetableInTimes = timetable[getDayType(dateInTimes)][trn];
        if (!timetableInTimes) {
            await announceTrainOnWrongDay(await getFullEmbedData(checkData));
            return;
        }
    }

    let timetableInStatuses: FullTimetableResponseTable<true> | undefined;
    if (dateInStatuses) {
        timetableInStatuses = timetable[getDayType(dateInStatuses)][trn];
        if (!timetableInStatuses) {
            await announceTrainOnWrongDay(await getFullEmbedData(checkData));
            return;
        }
    }

    if (timetableInTimes) {
        const expectedStateInTimes =
            getExpectedTrainState(timetableInTimes, timeDateToStr(dateInTimes)).state;
        if (expectedStateInTimes === "not-started" || expectedStateInTimes === "ended") {
            await announceTrainDuringNightHours(await getFullEmbedData(checkData))
            return;
        }
    }

    if (timetableInStatuses) {
        const expectedStateInStatuses =
            getExpectedTrainState(timetableInStatuses, timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes)).state;
        if (expectedStateInStatuses === "not-started" || expectedStateInStatuses === "ended") {
            await announceTrainDuringNightHours(await getFullEmbedData(checkData));
            return;
        }
    }
}

async function checkActiveTrain(checkData: TrainCheckData) {
    const status = checkData.curr.status;
    if (status.trainStatusesAPI) {
        const parsedLastSeen = parseLastSeen(status.trainStatusesAPI.lastSeen);
        await eitherAPIsChecks(checkData, parsedLastSeen);
        await trainStatusesChecks(
            checkData as TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
            parsedLastSeen);
        if (status.timesAPI) {
            await bothAPIsChecks(
                checkData as TrainCheckData<{ timesAPI: TimesApiData, trainStatusesAPI: TrainStatusesApiData }>,
                parsedLastSeen
            );
        }
    } else if (status.timesAPI) {
        await eitherAPIsChecks(checkData);
    }

    for (const subscription of alertSubscriptions) {
        const data = lastHistoryEntries[subscription.trn];
        if (data) await alertNowActive(subscription, await getFullEmbedData(checkData));
    }
}

async function handleDisappearedTrain(trn: string, prev: Omit<ActiveHistoryEntry, "active">) {
    const dayType = getDayType(lastHeartbeat);
    const trainTimetable = timetable[dayType][trn];
    if (!trainTimetable) {
        await announceTrainOnWrongDayDisappeared({trn, ...prev}, dayType);
        return;
    }

    if (getExpectedTrainState(trainTimetable, timeDateToStr(lastHeartbeat)).state !== "active") return;

    let missingThreshold = DEFAULT_MISSING_THRESHOLD;

    // TODO: Special cases for:
    // - disappearing at Pallion
    // - disappearing at the train's destination
    // - green line trains disappearing outside the shared stretch
    //   when they're timetabled to be on their last journey towards the shared stretch
    // Although some/all of these might not be needed with the times API

    const whenToAnnounce = new Date(lastHeartbeat.getTime() + missingThreshold * 60000);
    if (whenToAnnounce < lastHeartbeat) {
        await announceDisappearedTrain({trn, ...prev});
        missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
    } else {
        const fullTimetable = getFlatTimetableForTRN(trainTimetable);
        if (compareTimes(timeDateToStr(whenToAnnounce), fullTimetable[fullTimetable.length - 1].time) < 0) {
            missingTrains.set(trn, {
                announced: false,
                prevStatus: prev,
                whenToAnnounce
            });
        }
    }
}

async function handleMultipleDisappearedTrains(trns: Set<string>, isAllTrains: boolean) {
    const whenToForget = whenIsNextDay(lastHeartbeat);
    for (const trn of trns) {
        missingTrains.set(trn, { announced: true, whenToForget });
    }
    if (isAllTrains) {
        await announceAllTrainsDisappeared();
    } else {
        await announceMultipleDisappearedTrains(trns);
    }
}

async function checkMissingTrains() {
    for (const [trn, details] of missingTrains) {
        if (details.announced) {
            if (details.whenToForget < lastHeartbeat) missingTrains.delete(trn);
        } else if (details.announced === false && details.whenToAnnounce < lastHeartbeat) {
            await announceDisappearedTrain({trn, ...details.prevStatus});
            missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
        }
    }
}

async function handleReappearedTrain(trn: string, curr: Omit<ActiveHistoryEntry, "active">) {
    if (missingTrains.has(trn)) {
        missingTrains.delete(trn);
    } else {
        await announceReappearedTrain({trn, ...curr});
    }
}

async function handleMultipleReappearedTrains(trns: Set<string>) {
    for (const trn of trns) {
        missingTrains.delete(trn);
    }
    await announceMultipleReappearedTrains(trns);
}

async function onNewHistory(payload: FullNewHistoryPayload) {
    setLastHeartbeat(payload.date);
    if (Object.keys(payload.trains).length === 0) return;

    const numberOfPreviouslyActiveTrains = Object.keys(lastHistoryEntries).length;
    const updatedActiveTrains: Record<string, ActiveHistoryStatus> = {};
    const disappearedTrains: {
        trn: string,
        prev: Omit<ActiveHistoryEntry, "active">,
    }[] = []
    const reappearedTrains: {
        trn: string,
        curr: Omit<ActiveHistoryEntry, "active">,
    }[] = [];
    embedDatas = {};
    for (const [trn, trainData] of Object.entries(payload.trains)) {
        const historyEntry = {date: payload.date, ...trainData};
        if (historyEntry.active) {
            // I'm not sure why ActiveHistoryEntry isn't being narrowed from the `if`
            const activeHistoryEntry = historyEntry as ActiveHistoryEntry
            const activeHistoryStatus = activeHistoryEntry.status;
            await checkActiveTrain({
                trn,
                curr: activeHistoryEntry,
                prev: lastHistoryEntries[trn]
            });
            lastHistoryEntries[trn] = {
                date: payload.date,
                status: activeHistoryStatus
            };
            trainsWithHistory.add(trn);
            updatedActiveTrains[trn] = activeHistoryStatus;
            if (missingTrains.has(trn)) {
                reappearedTrains.push({ trn, curr: activeHistoryEntry });
            }
        } else {
            disappearedTrains.push({ trn, prev: lastHistoryEntries[trn] });
            delete lastHistoryEntries[trn];
        }
    }

    if (disappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        await handleMultipleDisappearedTrains(
            new Set(disappearedTrains.map(({ trn }) => trn)),
            disappearedTrains.length === numberOfPreviouslyActiveTrains
        );
    } else {
        for (const { trn } of disappearedTrains) {
            let prev = lastHistoryEntries[trn];
            if (!prev) {
                // This can occur if the bot was restarted between the previous entry and it going missing
                const response = await proxy.getHistory(trn, {
                    time: { to: payload.date },
                    limit: 1,
                    active: true,
                    props: ["extract"],
                }) as { extract: [ActiveHistoryEntry] };
                const { active, ...rest } = response.extract[0];
                prev = rest;
            }
            await handleDisappearedTrain(trn, prev);
        }
    }
    if (reappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        await handleMultipleReappearedTrains(
            new Set(reappearedTrains.map(({ trn }) => trn))
        );
    } else {
        for (const { trn, curr } of reappearedTrains) {
            await handleReappearedTrain(trn, curr);
        }
    }
    await checkMissingTrains();

    await updateActivity(Object.keys(lastHistoryEntries).length);
}

async function _refreshCache() {
    await refreshCache(proxy);
    for (const stationCode of Object.keys(apiConstants.STATION_CODES)) {
        seenStationCodes.add(stationCode);
        // TODO: Announce unrecognised stations from the times API
    }
}

export async function startMonitoring() {
    await _refreshCache();
    console.log("Connecting to stream...");
    let connectedOnce = false;
    let currentlyConnected = false;
    async function setConnected() {
        if (currentlyConnected) return;
        console.log("Successfully connected to stream!");
        currentlyConnected = true;
        if (connectedOnce) {
            await _refreshCache();
        } else {
            connectedOnce = true;
        }
    }
    proxy.stream({
        async onNewHistory(payload) {
            await setConnected();
            await onNewHistory(payload as FullNewHistoryPayload);
        },
        async onHeartbeatError(payload) {
            await setConnected();
            await announceHeartbeatError(payload);
        },
        async onHeartbeatWarning(payload) {
            await setConnected();
            await announceHeartbeatWarning(payload);
        },
        onConnect() {
            // This gets called if any response is received, even if it's an error page,
            // so wait until some valid data is received before setting currentlyConnected
        },
        onDisconnect() {
            // This gets called repeatedly if an error page is received,
            // so only log it if we were definitely connected previously
            if (currentlyConnected) {
                currentlyConnected = false;
                console.log("Stream disconnected, trying to reconnect...");
            }
        }
    })
}
