import {DEFAULT_MISSING_THRESHOLD, MULTIPLE_TRAINS_THRESHOLD, STREAM_RETRY_TIMEOUT} from "./constants";
import {
    alertNowActive,
    alertSubscriptions,
    announceDisappearedTrain,
    announceReappearedTrain,
    announceTrainOnWrongDayDisappeared,
    updateActivity,
    announceTrainInStatusesButNotTimes,
    announceUnparseableLastSeen,
    announceAPIsDisagree,
    announceTrainAtStJamesP2,
    announceTrainAtUnrecognisedPlatform,
    announceTrainAtUnrecognisedStation,
    announceUnrecognisedDestination,
    announceTrainInTimesButNotStatuses,
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
async function getFullEmbedData(trn: string, date: Date, curr: ActiveHistoryStatus) {
    // So that `nextStations` is only fetched once if needed
    let embedData = embedDatas[trn];
    if (!embedData) {
        let fullStatus: CollatedTrain;
        if (curr.timesAPI) {
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
                    ...curr.timesAPI,
                    ...response.status.timesAPI,
                },
            };
        } else {
            // Nothing to add
            fullStatus = curr as CollatedTrain;
        }
        embedData = {
            trn,
            date,
            status: fullStatus,
        }
        embedDatas[trn] = embedData
    }
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
    { trn, curr, prev }: TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
    parsedLastSeen?: ParsedLastSeen
) {
    const prevTrainStatus = prev?.status.trainStatusesAPI;
    const currTrainStatus = curr.status.trainStatusesAPI;
    const lastSeenChanged = !prevTrainStatus || currTrainStatus.lastSeen !== prevTrainStatus?.lastSeen;

    if (
        !getStationCode(currTrainStatus.destination) &&
        (!prev || currTrainStatus.destination !== prevTrainStatus?.destination)
    ) await announceUnrecognisedDestination(
        await getFullEmbedData(trn, curr.date, curr.status),
        { trn, ...prev }
    );

    if (parsedLastSeen) {
        if (
            !getStationCode(parsedLastSeen.station) && (
                !prevTrainStatus || parsedLastSeen.station !== parseLastSeen(prevTrainStatus.lastSeen).station
            )
        ) await announceTrainAtUnrecognisedStation(
            await getFullEmbedData(trn, curr.date, curr.status),
            { trn, ...prev },
            parsedLastSeen.station
        );
    } else if (lastSeenChanged) {
        await announceUnparseableLastSeen(
            await getFullEmbedData(trn, curr.date, curr.status)
        );
    }
}

// Checks which depend on both APIs
async function bothAPIsChecks(
    { trn, curr, prev }: TrainCheckData<{ timesAPI: TimesApiData, trainStatusesAPI: TrainStatusesApiData }>,
    parsedLastSeen?: ParsedLastSeen
) {
    if (!parsedLastSeen) return;
    const stationCode = getStationCode(parsedLastSeen.station);
    if (!stationCode) return;

    const lastSeenChanged = !prev ||
        curr.status.trainStatusesAPI.lastSeen !== prev.status.trainStatusesAPI?.lastSeen;
    const equalLocation = (
        parsedLastSeen.station === curr.status.timesAPI.lastEvent.station &&
        parsedLastSeen.platform === curr.status.timesAPI.lastEvent.platform
    );

    if (
        (
            // The APIs disagree on something
            !equalLocation ||
            parsedLastSeen.hours !== curr.status.timesAPI.lastEvent.time.getHours() ||
            parsedLastSeen.minutes !== curr.status.timesAPI.lastEvent.time.getMinutes() ||
            parsedLastSeen.state.toUpperCase().replaceAll(" ","_") !== curr.status.timesAPI.lastEvent.type
        ) && (
            // Something changed
            lastSeenChanged ||
            curr.status.timesAPI.lastEvent.time.getTime() !== prev.status.timesAPI?.lastEvent.time.getTime() ||
            curr.status.timesAPI.lastEvent.type !== prev.status.timesAPI?.lastEvent.type
        )
    ) await announceAPIsDisagree(
        await getFullEmbedData(trn, curr.date, curr.status)
    );

    if (equalLocation && lastSeenChanged) {
        const platformCheck = checkPlatform(
            trn,
            stationCode,
            parsedLastSeen.platform,
            `${parsedLastSeen.hours}${parsedLastSeen.minutes}`
        );
        if (platformCheck === "unrecognised") {
            await announceTrainAtUnrecognisedPlatform(
                await getFullEmbedData(trn, curr.date, curr.status)
            );
        } else if (platformCheck === "st-james-p2") {
            await announceTrainAtStJamesP2(
                await getFullEmbedData(trn, curr.date, curr.status)
            );
        }
    }
}

// Checks which can be done with either API
async function eitherAPIsChecks(
    { trn, curr, prev }: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen
) {
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
            await announceTrainOnWrongDay(await getFullEmbedData(trn, curr.date, curr.status));
            return;
        }
    }

    let timetableInStatuses: FullTimetableResponseTable<true> | undefined;
    if (dateInStatuses) {
        timetableInStatuses = timetable[getDayType(dateInStatuses)][trn];
        if (!timetableInStatuses) {
            await announceTrainOnWrongDay(await getFullEmbedData(trn, curr.date, curr.status));
            return;
        }
    }

    if (timetableInTimes) {
        const expectedStateInTimes =
            getExpectedTrainState(timetableInTimes, timeDateToStr(dateInTimes)).state;
        if (expectedStateInTimes === "not-started" || expectedStateInTimes === "ended") {
            await announceTrainDuringNightHours(await getFullEmbedData(trn, curr.date, curr.status))
            return;
        }
    }

    if (timetableInStatuses) {
        const expectedStateInStatuses =
            getExpectedTrainState(timetableInStatuses, timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes)).state;
        if (expectedStateInStatuses === "not-started" || expectedStateInStatuses === "ended") {
            await announceTrainDuringNightHours(await getFullEmbedData(trn, curr.date, curr.status));
            return;
        }
    }
}

async function checkActiveTrain(checkData: TrainCheckData) {
    const { trn, curr, prev } = checkData;
    if (curr.status.trainStatusesAPI) {
        const parsedLastSeen = parseLastSeen(curr.status.trainStatusesAPI.lastSeen);
        await eitherAPIsChecks(checkData, parsedLastSeen);
        await trainStatusesChecks(
            checkData as TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
            parsedLastSeen);
        if (curr.status.timesAPI) {
            await bothAPIsChecks(
                checkData as TrainCheckData<{ timesAPI: TimesApiData, trainStatusesAPI: TrainStatusesApiData }>,
                parsedLastSeen
            );
        } else if (!prev || prev.status.timesAPI) {
            await announceTrainInStatusesButNotTimes(await getFullEmbedData(trn, curr.date, curr.status));
        }
    } else if (curr.status.timesAPI) {
        await eitherAPIsChecks(checkData);
        if (!prev || prev.status.trainStatusesAPI) {
            await announceTrainInTimesButNotStatuses(await getFullEmbedData(trn, curr.date, curr.status));
        }
    }

    for (const subscription of alertSubscriptions) {
        const data = lastHistoryEntries[subscription.trn];
        if (data) await alertNowActive(subscription, await getFullEmbedData(trn, curr.date, curr.status));
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
                // TODO: Fix this, `response.extract[0]` is undefined and I'm not sure why
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

export async function startMonitoring() {
    await refreshCache(proxy);
    for (const stationCode of Object.keys(apiConstants.STATION_CODES)) {
        seenStationCodes.add(stationCode);
    }
    proxy.stream({
        onNewHistory,
        onHeartbeatError: announceHeartbeatError,
        onHeartbeatWarning: announceHeartbeatWarning,
        onDisconnect() {
            setTimeout(startMonitoring, STREAM_RETRY_TIMEOUT);
        }
    })
}