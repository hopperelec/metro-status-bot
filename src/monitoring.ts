import {DEFAULT_MISSING_THRESHOLD, MULTIPLE_TRAINS_THRESHOLD} from "./constants";
import {
    alertNowActive,
    alertSubscriptions,
    announceDisappearedTrain,
    announceReappearedTrain,
    announceTrainOnWrongDayDisappeared,
    updateActivity,
    announceUnparseableLastSeen,
    announceTrainAtUnrecognisedStation,
    announceUnrecognisedDestinations,
    announceTrainOnWrongDay,
    announceTrainDuringNightHours,
    TrainEmbedData,
    proxy,
    announceHeartbeatError,
    announceHeartbeatWarnings,
    announceAllTrainsDisappeared,
    announceMultipleDisappearedTrains,
    announceMultipleReappearedTrains,
    announceUnparseableLastEventLocation,
    announceTrainAtStJamesP2,
    announceTrainAtUnrecognisedPlatform,
    announceTrainAtSouthShieldsP1
} from "./bot";
import {
    apiConstants,
    getStationCode,
    refreshCache,
    lastHistoryEntries, compareTimes,
    trainsWithHistory, weekTimetable, setLastHeartbeat, lastHeartbeat, getTodaysTimetable
} from "./cache";
import {
    ActiveTrainHistoryEntry,
    ActiveTrainHistoryStatus,
    CollatedTrain, FullNewTrainsHistoryPayload,
    ParsedLastSeen, ParsedTimesAPILocation, parseLastSeen, parseTimesAPILocation, PlatformNumber, TimesApiData,
    TrainStatusesApiData, TrainTimetable
} from "metro-api-client";
import {
    timeNumbersToStr,
    getDayType,
    getExpectedTrainState,
    getFlatTimetableForTRN,
    timeDateToStr,
    whenIsNextDay
} from "./timetable";

type TrainCheckData<Status = ActiveTrainHistoryStatus> = {
    trn: string;
    curr: {
        date: Date,
        status: Status
    };
    prev?: {
        date: Date,
        status: ActiveTrainHistoryStatus
    };
}

const missingTrains = new Map<string, {
    announced: true;
    whenToForget: Date;
} | {
    announced: false;
    prevStatus: Omit<ActiveTrainHistoryEntry, "active">;
    whenToAnnounce: Date;
}>;
const seenStationCodes = new Set<string>();

let embedDatas: Record<string, TrainEmbedData> = {};
async function getFullEmbedData({ trn, curr }: TrainCheckData): Promise<TrainEmbedData> {
    // So that `nextPlatforms` is only fetched once if needed
    let embedData = embedDatas[trn];
    if (embedData) return embedData;

    let fullStatus: CollatedTrain;
    if (curr.status.timesAPI) {
        // ActiveHistoryStatus is missing `nextPlatforms`, so we need to fetch it
        const response = await proxy.getTrain(trn, {
            props: ["status.timesAPI.nextPlatforms"],
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

// Doesn't announce on its own, in case I want to handle each API separately
function checkPlatform(
    trn: string,
    stationName: string,
    platform: PlatformNumber,
    time: string
) {
    switch (platform) {
        case 1:
            if (stationName === 'South Shields') return 'sss-p1';
            if (stationName === 'South Hylton') return 'unrecognised';
            return;
        case 2:
            if (stationName !== "St James") return;
            const trainTimetable = (getTodaysTimetable())[trn];
            if (!trainTimetable) return;
            const fullTimetable = getFlatTimetableForTRN(trainTimetable);
            if (
                trainTimetable.departure.place === "St James Platform 2" &&
                compareTimes(time, fullTimetable[0].time) <= 0
            ) return;
            if (
                trainTimetable.arrival.place === "St James Platform 2" &&
                compareTimes(time, fullTimetable[fullTimetable.length - 1].time) >= 0
            ) return;
            return "sjm-p2";
        case 3:
            if (stationName === "Sunderland") return;
            // fall-through
        case 4:
            if (stationName === "Monument") return;
            // fall-through
        default:
            return 'unrecognised';
    }
}

// Checks which depend on the times API, but don't depend on the statuses API
async function timesAPIChecks(
    checkData: TrainCheckData<{ timesAPI: TimesApiData }>,
    timesAPILocation?: ParsedTimesAPILocation
) {
    if (!timesAPILocation) {
        const { trn, prev } = checkData;
        await announceUnparseableLastEventLocation(
            await getFullEmbedData(checkData),
            { trn, ...prev }
        )
    }
}

// Checks which depend on the train statuses API, but don't depend on the times API
async function trainStatusesChecks(
    checkData: TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
    parsedLastSeen?: ParsedLastSeen
) {
    if (!parsedLastSeen) {
        await announceUnparseableLastSeen(await getFullEmbedData(checkData));
    }
}

async function shouldAnnounceUntimetabledActivity(
    checkData: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen
) {
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

    let timetableInTimes: TrainTimetable | undefined;
    if (dateInTimes) {
        timetableInTimes = weekTimetable[getDayType(dateInTimes)][trn];
        if (!timetableInTimes)
            return "wrong-day"
    }

    let timetableInStatuses: TrainTimetable | undefined;
    if (dateInStatuses) {
        timetableInStatuses = weekTimetable[getDayType(dateInStatuses)][trn];
        if (!timetableInStatuses)
            return "wrong-day"
    }

    if (timetableInTimes) {
        const expectedStateInTimes =
            getExpectedTrainState(timetableInTimes, timeDateToStr(dateInTimes)).state;
        if (expectedStateInTimes === "not-started" || expectedStateInTimes === "ended")
            return "night-hours";
    }

    if (timetableInStatuses) {
        const expectedStateInStatuses =
            getExpectedTrainState(timetableInStatuses, timeNumbersToStr(parsedLastSeen.hours, parsedLastSeen.minutes)).state;
        if (expectedStateInStatuses === "not-started" || expectedStateInStatuses === "ended")
            return "night-hours";
    }
}

function shouldAnnounceUnrecognisedStation(
    {prev}: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen,
    timesAPILocation?: ParsedTimesAPILocation
) {
    if (parsedLastSeen?.station !== timesAPILocation?.station) return false;
    if (parsedLastSeen) {
        const prevStatus = prev?.status?.trainStatusesAPI;
        if (
            !getStationCode(parsedLastSeen.station) && (
                !prevStatus ||
                parsedLastSeen.station !== parseLastSeen(prevStatus.lastSeen)?.station
            )
        ) return true;
    }
    if (timesAPILocation) {
        const prevStatus = prev?.status?.timesAPI;
        if (
            !getStationCode(timesAPILocation.station) && (
                !prevStatus ||
                timesAPILocation.station !== parseTimesAPILocation(prevStatus.lastEvent.location)?.station
            )
        ) return true;
    }
    return false;
}

function getUniqueDestinations(status?: ActiveTrainHistoryStatus) {
    const destinations = new Set<string>();
    if (status?.trainStatusesAPI) {
        destinations.add(status.trainStatusesAPI.destination);
    }
    if (status?.timesAPI) {
        for (const destination of status.timesAPI.plannedDestinations) {
            destinations.add(destination.name);
        }
    }
    return destinations;
}

function getNewUnrecognisedDestinations({curr, prev}: TrainCheckData) {
    const currDestinations = getUniqueDestinations(curr.status);
    const prevDestinations = getUniqueDestinations(prev?.status);
    const newUnrecognisedDestinations: string[] = []; // so that they stay in the same order
    for (const destination of currDestinations) {
        if (prevDestinations.has(destination)) continue;
        if (newUnrecognisedDestinations.includes(destination)) continue;
        if (!getStationCode(destination)) {
            newUnrecognisedDestinations.push(destination);
        }
    }
    return newUnrecognisedDestinations;
}

// Checks which can be done with either API
async function eitherAPIChecks(
    checkData: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen,
    timesAPILocation?: ParsedTimesAPILocation
) {
    const { trn, curr, prev } = checkData;

    const shouldBeActive = await shouldAnnounceUntimetabledActivity(checkData, parsedLastSeen);
    if (shouldBeActive === "wrong-day") {
        await announceTrainOnWrongDay(await getFullEmbedData(checkData));
    } else if (shouldBeActive === "night-hours") {
        await announceTrainDuringNightHours(await getFullEmbedData(checkData));
    }

    const newUnrecognisedDestinations = getNewUnrecognisedDestinations(checkData);
    if (newUnrecognisedDestinations.length) {
        await announceUnrecognisedDestinations(
            await getFullEmbedData(checkData),
            { trn, ...prev },
            newUnrecognisedDestinations
        );
    }

    if (shouldAnnounceUnrecognisedStation(checkData, parsedLastSeen, timesAPILocation)) {
        await announceTrainAtUnrecognisedStation(
            await getFullEmbedData(checkData),
            { trn, ...prev },
            parsedLastSeen.station // should be same as timesAPILocation.station
        );
        // Don't check the platform if the station is unrecognized
        return;
    }

    // --- Platform checks ---
    // Don't check the platform if each API is reporting a different platform
    if (parsedLastSeen && timesAPILocation && parsedLastSeen.platform !== timesAPILocation.platform) {
        return;
    }

    // Don't check the platform if the location hasn't changed
    if (prev?.status?.timesAPI) {
        if (curr.status.timesAPI?.lastEvent.location === prev.status.timesAPI.lastEvent.location) return;
    } else if (prev?.status?.trainStatusesAPI) {
        const parsedPrevLastSeen = parseLastSeen(prev.status.trainStatusesAPI.lastSeen);
        if (
            parsedLastSeen?.station === parsedPrevLastSeen?.station &&
            parsedLastSeen?.platform === parsedPrevLastSeen?.platform
        ) return;
    }

    const platformCheck = checkPlatform(
        trn,
        parsedLastSeen?.station ?? timesAPILocation.station,
        parsedLastSeen?.platform ?? timesAPILocation.platform,
        timeDateToStr(checkData.curr.date)
    );
    if (platformCheck === "sss-p1") {
        await announceTrainAtSouthShieldsP1(await getFullEmbedData(checkData));
    } else if (platformCheck === "sjm-p2") {
        await announceTrainAtStJamesP2(await getFullEmbedData(checkData));
    } else if (platformCheck === "unrecognised") {
        await announceTrainAtUnrecognisedPlatform(await getFullEmbedData(checkData));
    }
}

async function checkActiveTrain(checkData: TrainCheckData) {
    const status = checkData.curr.status;
    let parsedLastSeen: ParsedLastSeen | undefined;
    let timesAPILocation: ParsedTimesAPILocation | undefined;
    if (status.trainStatusesAPI) {
        parsedLastSeen = parseLastSeen(status.trainStatusesAPI.lastSeen);
        await trainStatusesChecks(
            checkData as TrainCheckData<{ trainStatusesAPI: TrainStatusesApiData }>,
            parsedLastSeen
        );
    }
    if (status.timesAPI) {
        timesAPILocation = parseTimesAPILocation(status.timesAPI.lastEvent.location);
        await timesAPIChecks(
            checkData as TrainCheckData<{ timesAPI: TimesApiData }>,
            timesAPILocation
        );
    }
    if (status.timesAPI || status.trainStatusesAPI) {
        await eitherAPIChecks(
            checkData,
            parsedLastSeen,
            timesAPILocation
        );
    }

    for (const subscription of alertSubscriptions) {
        const data = lastHistoryEntries[subscription.trn];
        if (data) await alertNowActive(subscription, await getFullEmbedData(checkData));
    }
}

async function handleDisappearedTrain(trn: string, prev: Omit<ActiveTrainHistoryEntry, "active">) {
    const dayType = getDayType(lastHeartbeat);
    const trainTimetable = weekTimetable[dayType][trn];
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

async function handleMultipleReappearedTrains(trns: Set<string>) {
    for (const trn of trns) {
        missingTrains.delete(trn);
    }
    await announceMultipleReappearedTrains(trns);
}

async function onNewTrainsHistory(payload: FullNewTrainsHistoryPayload) {
    setLastHeartbeat(payload.date);
    if (Object.keys(payload.trains).length === 0) return;

    const numberOfPreviouslyActiveTrains = Object.keys(lastHistoryEntries).length;
    const updatedActiveTrains: Record<string, ActiveTrainHistoryStatus> = {};
    const disappearedTrains: {
        trn: string,
        prev: Omit<ActiveTrainHistoryEntry, "active">,
    }[] = []
    const reappearedTrains: {
        trn: string,
        curr: Omit<ActiveTrainHistoryEntry, "active">,
    }[] = [];
    embedDatas = {};
    for (const [trn, trainData] of Object.entries(payload.trains)) {
        const historyEntry = {date: payload.date, ...trainData};
        if (historyEntry.active) {
            // I'm not sure why ActiveHistoryEntry isn't being narrowed from the `if`
            const activeHistoryEntry = historyEntry as ActiveTrainHistoryEntry;
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
                missingTrains.delete(trn);
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
                const response = await proxy.getTrainHistory(trn, {
                    time: { to: payload.date },
                    limit: 1,
                    active: true,
                    props: ["extract"],
                }) as { extract: [ActiveTrainHistoryEntry] };
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
            await announceReappearedTrain({trn, ...curr});
        }
    }
    await checkMissingTrains();

    const numberOfCurrentlyActiveTrains = Object.keys(lastHistoryEntries).length;
    if (numberOfCurrentlyActiveTrains !== numberOfPreviouslyActiveTrains) {
        await updateActivity(numberOfCurrentlyActiveTrains);
    }
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
    proxy.streamHistory({
        async onNewTrainHistoryEntries(payload: FullNewTrainsHistoryPayload) {
            await setConnected();
            await onNewTrainsHistory(payload);
        },
        async onHeartbeatError(payload) {
            await setConnected();
            await announceHeartbeatError(payload);
        },
        async onHeartbeatWarnings(payload) {
            await setConnected();
            await announceHeartbeatWarnings(payload);
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
