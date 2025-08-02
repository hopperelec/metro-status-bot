import {DEPARTED_FGT_TO_SHARED_DELAY, MULTIPLE_TRAINS_THRESHOLD, TIMES_API_RESTART_TIME} from "./constants";
import {
    announceDisappearedTrain,
    announceReappearedTrain,
    announceTrainOnWrongDayDisappeared,
    announceUnparseableLastSeen,
    announceTrainAtUnrecognisedStation,
    announceUnrecognisedDestinations,
    announceTrainOnWrongDay,
    announceTrainDuringNightHours,
    announceHeartbeatError,
    announceHeartbeatWarnings,
    announceAllTrainsDisappeared,
    announceMultipleDisappearedTrains,
    announceMultipleReappearedTrains,
    announceUnparseableLastEventLocation,
    announceTrainAtStJamesP2,
    announceTrainAtUnrecognisedPlatform,
    announceTrainAtSouthShieldsP1,
    announceECS,
    announceTrainsAtBothPlatformsStJames,
    announceTrainAtSunderlandP1orP4
} from "./rendering";
import {proxy, updateActivity} from "./bot";
import {
    apiConstants, getStationCode, refreshCache, lastHistoryEntries, compareTimes,
    trainsWithHistory, setLastHeartbeat, lastHeartbeat, getTodaysTimetable
} from "./cache";
import {
    ActiveTrainHistoryEntry,
    ActiveTrainHistoryStatus,
    CollatedTrain,
    FullNewTrainsHistoryPayload,
    FullTrainsResponse,
    ParsedLastSeen,
    ParsedTimesAPILocation,
    parseLastSeen,
    parseTimesAPILocation,
    PlatformNumber,
    TimesApiData,
    TrainHistoryEntry,
    TrainStatusesApiData,
} from "metro-api-client";
import {getExpectedTrainState, isNightHours, secondsSinceMidnight, whenIsNextDay} from "./timetable";
import {TrainEmbedData} from "./rendering";
import {isInSharedStretch} from "./utils";

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

let embedDataCache: Record<string, TrainEmbedData> = {};
async function getFullEmbedData({ trn, curr }: TrainCheckData): Promise<TrainEmbedData> {
    // So that `nextPlatforms` is only fetched once if needed
    let embedData = embedDataCache[trn];
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
        timetable: (await getTodaysTimetable()).trains[trn],
    }
    embedDataCache[trn] = embedData
    return embedData;
}

async function checkPlatform(
    trn: string,
    stationName: string,
    platform: PlatformNumber,
    time: number
) {
    switch (platform) {
        case 1:
            if (stationName === 'South Hylton') return 'unrecognised';
            if (stationName === 'Sunderland') return 'sun-p14';
            if (stationName === 'South Shields') {
                // For some reason, any trains at South Shields platform 2 after midnight appear at platform 1 on the API.
                // This is clearly a bug in the API because trains at platform 2 at midnight will seemingly teleport to platform 1 with the same arrival time.
                // So don't announce trains at South Shields platform 1 after midnight.
                if (time >= apiConstants.NEW_DAY_HOUR * 3600) return 'sss-p1';
            }
            return;
        case 2:
            if (stationName === 'St James') {
                const trainTimetable = (await getTodaysTimetable()).trains[trn];
                if (!trainTimetable) return;
                const firstEntry = trainTimetable[0];
                if (
                    firstEntry.location === 'SJM_2' && firstEntry.departureTime &&
                    compareTimes(time, firstEntry.departureTime) <= 0
                ) return;
                const lastEntry = trainTimetable[trainTimetable.length - 1];
                if (
                    lastEntry.location === 'SJM_2' && lastEntry.arrivalTime &&
                    compareTimes(time, lastEntry.arrivalTime) >= 0
                ) return;
                return "sjm-p2";
            }
            return;
        case 3:
            if (stationName === 'Monument' || stationName === 'Sunderland') return;
            return 'unrecognised';
        case 4:
            if (stationName === 'Monument') return;
            if (stationName === 'Sunderland') return 'sun-p24';
            return 'unrecognised';
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
        const { trn, prev } = checkData;
        await announceUnparseableLastSeen(
            await getFullEmbedData(checkData),
            { trn, ...prev }
        );
    }
}

async function checkIfTimetabled(
    checkData: TrainCheckData,
    parsedLastSeen?: ParsedLastSeen
) {
    const { trn, curr, prev } = checkData;

    // Only announce when the train first becomes active
    if (prev?.status) return;

    const trainTimetable = (await getTodaysTimetable()).trains[trn];
    if (!trainTimetable) return "wrong-day";

    if (curr.status.timesAPI && isNightHours(trainTimetable, curr.status.timesAPI.lastEvent.time)) return "night-hours";

    if (parsedLastSeen) {
        const dateInStatuses = new Date(curr.date);
        dateInStatuses.setHours(parsedLastSeen.hours);
        dateInStatuses.setMinutes(parsedLastSeen.minutes);
        if (parsedLastSeen.hours - curr.date.getHours() >= 12) {
            dateInStatuses.setDate(dateInStatuses.getDate() - 1);
        }
        if (isNightHours(trainTimetable, dateInStatuses)) return "night-hours";
    }

    if (trainTimetable.every(entry => !entry.inService)) return "ecs";
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

    const shouldBeActive = await checkIfTimetabled(checkData, parsedLastSeen);
    if (shouldBeActive === "wrong-day") {
        await announceTrainOnWrongDay(await getFullEmbedData(checkData));
    } else if (shouldBeActive === "night-hours") {
        await announceTrainDuringNightHours(await getFullEmbedData(checkData));
    } else if (shouldBeActive === "ecs") {
        await announceECS(await getFullEmbedData(checkData));
    }

    const newUnrecognisedDestinations = getNewUnrecognisedDestinations(checkData);
    if (newUnrecognisedDestinations.length) {
        await announceUnrecognisedDestinations(
            await getFullEmbedData(checkData),
            { trn, ...prev },
            newUnrecognisedDestinations
        );
    }

    let shouldCheckPlatform = true;

    if (shouldAnnounceUnrecognisedStation(checkData, parsedLastSeen, timesAPILocation)) {
        await announceTrainAtUnrecognisedStation(
            await getFullEmbedData(checkData),
            { trn, ...prev },
            parsedLastSeen.station // should be same as timesAPILocation.station
        );
        // Don't check the platform if the station is unrecognized
        shouldCheckPlatform = false;
    }

    // --- Platform checks ---
    // Don't check the platform if each API is reporting a different platform
    if (parsedLastSeen && timesAPILocation && parsedLastSeen.platform !== timesAPILocation.platform) {
        shouldCheckPlatform = false;
    }

    // Don't check the platform if the location hasn't changed
    if (prev?.status?.timesAPI) {
        if (curr.status.timesAPI?.lastEvent.location === prev.status.timesAPI.lastEvent.location) {
            shouldCheckPlatform = false;
        }
    } else if (prev?.status?.trainStatusesAPI) {
        const parsedPrevLastSeen = parseLastSeen(prev.status.trainStatusesAPI.lastSeen);
        if (
            parsedLastSeen?.station === parsedPrevLastSeen?.station &&
            parsedLastSeen?.platform === parsedPrevLastSeen?.platform
        ) shouldCheckPlatform = false;
    }

    if (shouldCheckPlatform) {
        const platformNumber = timesAPILocation?.platform ?? parsedLastSeen?.platform;
        const platformCheck = await checkPlatform(
            trn,
            parsedLastSeen?.station ?? timesAPILocation.station,
            platformNumber,
            secondsSinceMidnight(checkData.curr.date)
        );
        if (platformCheck === "sss-p1") {
            // For some reason, any trains at South Shields platform 2 after midnight appear at platform 1 on the API.
            // This is clearly a bug in the API because trains at platform 2 at midnight will seemingly teleport to platform 1 with the same arrival time.
            // So don't announce trains at South Shields platform 1 after midnight.
            if (curr.date.getHours() >= apiConstants.NEW_DAY_HOUR) {
                await announceTrainAtSouthShieldsP1(await getFullEmbedData(checkData));
            }
        } else if (platformCheck === "sjm-p2") {
            const fullEmbedData = await getFullEmbedData(checkData);
            // Check if there is a train at St James platform 1
            const trains = await proxy.getTrains() as FullTrainsResponse;
            const sjmP1Train = Object.entries(trains.trains).find(
                ([_, train]) => {
                    if (train.status.timesAPI?.lastEvent.location === "St James Platform 1") return true;
                    const parsedLastSeen = parseLastSeen(train.status.trainStatusesAPI?.lastSeen);
                    return parsedLastSeen?.station === "SJM" && parsedLastSeen?.platform === 1;
                }
            );
            if (sjmP1Train) {
                await announceTrainsAtBothPlatformsStJames(
                    fullEmbedData,
                    {
                        trn: sjmP1Train[0],
                        date: sjmP1Train[1].lastChanged,
                        status: sjmP1Train[1].status
                    }
                );
            } else {
                await announceTrainAtStJamesP2(fullEmbedData);
            }
        } else if (platformCheck === 'sun-p14') {
            await announceTrainAtSunderlandP1orP4(await getFullEmbedData(checkData), platformNumber as 1 | 4);
        } else if (platformCheck === "unrecognised") {
            await announceTrainAtUnrecognisedPlatform(await getFullEmbedData(checkData));
        }
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
}

async function handleDisappearedTrain(trn: string, prev: Omit<ActiveTrainHistoryEntry, "active">) {
    const trainTimetable = (await getTodaysTimetable()).trains[trn];
    if (trainTimetable) {
        if (getExpectedTrainState(trainTimetable, secondsSinceMidnight(lastHeartbeat)).inService) {
            await announceDisappearedTrain({trn, timetable: trainTimetable, ...prev});
            missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
        }
    } else {
        await announceTrainOnWrongDayDisappeared({trn, timetable: trainTimetable, ...prev});
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
            await announceDisappearedTrain({
                trn,
                timetable: (await getTodaysTimetable()).trains[trn],
                ...details.prevStatus
            });
            missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
        }
    }
}

function isDepartedFGTtoShared(status: ActiveTrainHistoryStatus) {
    if (
        status.timesAPI?.lastEvent.location.startsWith("Fellgate Platform ") &&
        status.timesAPI?.lastEvent.type === "DEPARTED" &&
        isInSharedStretch(getStationCode(status.timesAPI?.plannedDestinations[0].name))
    ) return true;
    if (!status.trainStatusesAPI) return false;
    const parsedLastSeen = parseLastSeen(status.trainStatusesAPI.lastSeen);
    return parsedLastSeen?.station === "FGT" &&
        parsedLastSeen.state === "Departed" &&
        isInSharedStretch(getStationCode(status.trainStatusesAPI.destination))
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
    for (const [trn, trainData] of Object.entries(payload.trains)) {
        const historyEntry = {date: payload.date, ...trainData} as TrainHistoryEntry;
        if (historyEntry.active) {
            const activeHistoryStatus = historyEntry.status;
            await checkActiveTrain({
                trn,
                curr: historyEntry,
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
                reappearedTrains.push({ trn, curr: historyEntry });
            }
        } else {
            let prev = lastHistoryEntries[trn];
            if (!prev) {
                // This can occur if the bot was restarted between the previous entry and it going missing
                const response = await proxy.getTrainHistory(trn, {
                    time: { to: payload.date },
                    limit: 1,
                    active: true,
                    props: ["extract"],
                }) as { extract: [ActiveTrainHistoryEntry] };
                prev = response.extract[0];
            }
            disappearedTrains.push({ trn, prev });
            delete lastHistoryEntries[trn];
        }
    }

    if (disappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        await handleMultipleDisappearedTrains(
            new Set(disappearedTrains.map(({ trn }) => trn)),
            disappearedTrains.length === numberOfPreviouslyActiveTrains
        );
    } else {
        for (const train of disappearedTrains) {
            if (isDepartedFGTtoShared(train.prev.status)) {
                // See comment on `DEPARTED_FGT_TO_SHARED_DELAY` for explanation
                missingTrains.set(train.trn, {
                    announced: false,
                    prevStatus: train.prev,
                    whenToAnnounce: new Date(train.prev.date.getTime() + DEPARTED_FGT_TO_SHARED_DELAY)
                });
                continue;
            }
            await handleDisappearedTrain(train.trn, train.prev);
        }
    }
    if (reappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        await announceMultipleReappearedTrains(
            new Set(reappearedTrains.map(({ trn }) => trn))
        );
    } else {
        for (const { trn, curr } of reappearedTrains) {
            const missingEntry = missingTrains.get(trn);
            if (missingEntry && !missingEntry.announced) {
                // Its disappearance hadn't been announced yet, so don't announce its reappearance
                continue;
            }
            await announceReappearedTrain({
                trn,
                timetable: (await getTodaysTimetable()).trains[trn],
                ...curr
            });
        }
    }
    for (const { trn } of reappearedTrains) {
        missingTrains.delete(trn);
    }
    await checkMissingTrains();

    const numberOfCurrentlyActiveTrains = Object.keys(lastHistoryEntries).length;
    if (numberOfCurrentlyActiveTrains !== numberOfPreviouslyActiveTrains) {
        await updateActivity(numberOfCurrentlyActiveTrains);
    }

    // All the announcements for this heartbeat have been made, so the cached embed data is no longer needed
    embedDataCache = {};
}

const ongoingErrors = new Set<string>();
const lastErrors = new Set<string>();

export async function startMonitoring() {
    await refreshCache(proxy);
    console.log("Connecting to stream...");
    let connectedOnce = false;
    let currentlyConnected = false;
    async function setConnected() {
        if (currentlyConnected) return;
        console.log("Successfully connected to stream!");
        currentlyConnected = true;
        if (connectedOnce) {
            await refreshCache(proxy);
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
                    const time = secondsSinceMidnight(payload.date);
                    if (time >= TIMES_API_RESTART_TIME.from && time <= TIMES_API_RESTART_TIME.to) return;
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
