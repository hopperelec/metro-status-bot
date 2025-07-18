import {MULTIPLE_TRAINS_THRESHOLD} from "./constants";
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
    announceTrainAtSouthShieldsP1, AlertSubscription
} from "./bot";
import {
    apiConstants,
    getStationCode,
    refreshCache,
    lastHistoryEntries, compareTimes,
    trainsWithHistory, setLastHeartbeat, lastHeartbeat, getTodaysTimetable
} from "./cache";
import {
    ActiveTrainHistoryEntry,
    ActiveTrainHistoryStatus,
    CollatedTrain, FullNewTrainsHistoryPayload,
    ParsedLastSeen, ParsedTimesAPILocation, parseLastSeen, parseTimesAPILocation, PlatformNumber, TimesApiData,
    TrainStatusesApiData, TrainTimetable
} from "metro-api-client";
import {
    getExpectedTrainState,
    secondsSinceMidnight,
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
            ...curr.status,
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
async function checkPlatform(
    trn: string,
    stationName: string,
    platform: PlatformNumber,
    time: number
) {
    switch (platform) {
        case 1:
            if (stationName === 'South Shields') return 'sss-p1';
            if (stationName === 'South Hylton') return 'unrecognised';
            return;
        case 2:
            if (stationName !== "St James") return;
            const trainTimetable = (await getTodaysTimetable()).trains[trn];
            if (!trainTimetable) return;
            const firstEntry = trainTimetable[0];
            if (
                firstEntry.location === "SJM_2" && firstEntry.departureTime &&
                compareTimes(time, firstEntry.departureTime) <= 0
            ) return;
            const lastEntry = trainTimetable[trainTimetable.length - 1];
            if (
                lastEntry.location === "SJM_2" && lastEntry.arrivalTime &&
                compareTimes(time, lastEntry.arrivalTime) >= 0
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

function isNightHours(trainTimetable: TrainTimetable, time: number) {
    const firstEntry = trainTimetable[0];
    if (firstEntry.departureTime && compareTimes(time, firstEntry.departureTime) < 0) return true;
    const lastEntry = trainTimetable[trainTimetable.length - 1];
    return lastEntry.arrivalTime && compareTimes(time, lastEntry.arrivalTime) > 0;
}

async function shouldAnnounceUntimetabledActivity(
    checkData: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen
) {
    const { trn, curr, prev } = checkData;

    // Only announce when the train first becomes active
    if (prev?.status) return;

    const trainTimetable = (await getTodaysTimetable()).trains[trn];
    if (!trainTimetable) return "wrong-day";

    if (curr.status.timesAPI) {
        const dateInTimes = curr.status.timesAPI.lastEvent.time;
        const timeInTimes = secondsSinceMidnight(dateInTimes);
        if (isNightHours(trainTimetable, timeInTimes)) return "night-hours";
    }

    if (parsedLastSeen) {
        const dateInStatuses = new Date(curr.date);
        dateInStatuses.setHours(parsedLastSeen.hours);
        dateInStatuses.setMinutes(parsedLastSeen.minutes);
        if (parsedLastSeen.hours - curr.date.getHours() >= 12) {
            dateInStatuses.setDate(dateInStatuses.getDate() - 1);
        }
        const timeInStatuses = secondsSinceMidnight(dateInStatuses);
        if (isNightHours(trainTimetable, timeInStatuses)) return "night-hours";
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

    const platformCheck = await checkPlatform(
        trn,
        parsedLastSeen?.station ?? timesAPILocation.station,
        parsedLastSeen?.platform ?? timesAPILocation.platform,
        secondsSinceMidnight(checkData.curr.date)
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

    const fulfilledSubscriptions: AlertSubscription[] = [];
    for (const subscription of alertSubscriptions) {
        const data = lastHistoryEntries[subscription.trn];
        if (data) {
            await alertNowActive(subscription, await getFullEmbedData(checkData));
            fulfilledSubscriptions.push(subscription);
        }
    }
    for (const subscription of fulfilledSubscriptions) {
        alertSubscriptions.splice(alertSubscriptions.indexOf(subscription), 1);
    }
}

async function handleDisappearedTrain(trn: string, prev: Omit<ActiveTrainHistoryEntry, "active">) {
    const trainTimetable = (await getTodaysTimetable()).trains[trn];
    if (trainTimetable) {
        if (getExpectedTrainState(trainTimetable, secondsSinceMidnight(lastHeartbeat)).inService) {
            await announceDisappearedTrain({trn, ...prev});
            missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
        }
    } else {
        await announceTrainOnWrongDayDisappeared({trn, ...prev});
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

const ongoingErrors = new Set<string>();
const lastErrors = new Set<string>();

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
            for (const error of ongoingErrors) {
                if (!lastErrors.has(error)) {
                    ongoingErrors.delete(error);
                }
            }
            lastErrors.clear();
        },
        async onHeartbeatError(payload) {
            await setConnected();
            if (payload.api === "timesAPI") {
                if (payload.message === "Unexpected end of JSON input") {
                    if (payload.date.getHours() === 3 && payload.date.getMinutes() < 10) {
                        // The times API seems to restart at 3AM,
                        // and it can sometimes take several minutes
                        // for it to come back online.
                        return;
                    }
                } else if (payload.message === "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") {
                    // This is usually a Cloudflare "Timed out" error page.
                    // This happens relatively often, so just ignore it.
                    return;
                }
            }
            lastErrors.add(payload.message);
            if (!ongoingErrors.has(payload.message)) {
                ongoingErrors.add(payload.message)
                await announceHeartbeatError(payload);
            }
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
