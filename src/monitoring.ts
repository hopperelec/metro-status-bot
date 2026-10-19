import {
    DEPARTED_FELLGATE_TO_SHARED_DELAY,
    LATE_START_THRESHOLD,
    MULTIPLE_TRAINS_THRESHOLD,
    TIMES_API_RESTART_TIME
} from "./constants";
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
    announceHeartbeatWarning,
    announceAllTrainsDisappeared,
    announceMultipleDisappearedTrains,
    announceMultipleReappearedTrains,
    announceUnparseableLastEventLocation,
    announceTrainAtUnrecognisedPlatform,
    announceTrainAtSouthShieldsP1,
    announceECS,
    announceTrainAtSunderlandP1orP4,
    announceTrainTeleported,
    announceTrainUsingJJC,
    announceTrainAppearedLate,
    ActiveTrainEmbedData,
    renderTimesApiLocation
} from "./rendering";
import {proxy, updateActivity} from "./bot";
import {
    apiConstants, getStationCode, refreshCache, lastHistoryEntries,
    trainsWithHistory, setLastHeartbeat, lastHeartbeat, getTodaysTimetable
} from "./cache";
import {
    CollatedTrain,
    GeoApiData,
    HeartbeatError,
    HeartbeatTimes,
    MetroApiError,
    ParsedGeoApiLastSeen,
    ParsedPlatform,
    PlatformNumber,
    SubscriptionRequest,
    TimesApiData,
} from "tnw-metro-api-client";
import {
    getExpectedTrainState,
    isNightHours,
    parsedPlatformToLocationCode,
    secondsSinceMidnight,
    whenIsNextDay
} from "./timetable";
import {isInSharedStretch} from "./utils";
import {isAdjacent, isJesmondJunction} from "./network-graph";
import {DatedTrainStatus, TrainStatus} from "./train-status";

type TrainCheckData<Status = CollatedTrain> = {
    trn: string;
    curr: {
        date: Date,
        status: Status
    };
    prev?: DatedTrainStatus;
}

type ActiveTrainAnnouncer = (fullEmbedData: ActiveTrainEmbedData) => Promise<void>;

const missingTrains = new Map<string, {
    announced: true;
    whenToForget: Date;
} | {
    announced: false;
    prevStatus: DatedTrainStatus;
    whenToAnnounce: Date;
}>;

async function getFullEmbedData({ trn, curr }: TrainCheckData): Promise<ActiveTrainEmbedData> {
    return {
        trn,
        date: curr.date,
        status: curr.status,
        timetable: (await getTodaysTimetable()).trains[trn],
    };
}

/** Gets where the Geo API last saw a train, if it could be parsed */
function getGeoApiLastSeen(geoApiData?: Pick<GeoApiData, "lastSeen">): ParsedGeoApiLastSeen | undefined {
    const lastSeen = geoApiData?.lastSeen;
    return typeof lastSeen === "string" ? undefined : lastSeen;
}

/** Gets the platform of a train's last event on the Times API, if it could be parsed */
function getTimesApiPlatform(timesApiData?: Pick<TimesApiData, "lastEvent">): ParsedPlatform | undefined {
    const location = timesApiData?.lastEvent.location;
    return typeof location === "string" ? undefined : location;
}

function checkPlatform(
    stationName: string,
    platformNumber: PlatformNumber,
    time: number
) {
    switch (platformNumber) {
        case 1:
            if (stationName === 'South Hylton') return 'unrecognised';
            if (stationName === 'Sunderland') return 'sun-p14';
            if (stationName === 'South Shields') {
                // For some reason, any trains at South Shields Platform 2 after midnight appear at Platform 1 on the API.
                // This is clearly a bug in the API because trains at Platform 2 at midnight will seemingly teleport to Platform 1 with the same arrival time.
                // So don't announce trains at South Shields Platform 1 after midnight.
                if (time >= apiConstants.NEW_DAY_HOUR * 3600) return 'sss-p1';
            }
            return;
        case 2:
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

// Checks which depend on the Times API, but don't depend on the Geo API
async function timesApiChecks(
    checkData: TrainCheckData<{ timesAPI: TimesApiData }>,
    timesApiPlatform?: ParsedPlatform
): Promise<ActiveTrainAnnouncer[]> {
    if (!timesApiPlatform) {
        const { trn, prev } = checkData;
        return [fullEmbedData => announceUnparseableLastEventLocation(fullEmbedData, { trn, ...prev })];
    }
    return [];
}

// Checks which depend on the Geo API, but don't depend on the Times API
async function geoApiChecks(
    checkData: TrainCheckData<{ geoAPI: GeoApiData }>,
    geoApiLastSeen?: ParsedGeoApiLastSeen
): Promise<ActiveTrainAnnouncer[]> {
    if (!geoApiLastSeen) {
        const { trn, prev } = checkData;
        return [fullEmbedData => announceUnparseableLastSeen(fullEmbedData, { trn, ...prev })];
    }
    return [];
}

async function checkIfTimetabled(checkData: TrainCheckData, geoApiLastSeen?: ParsedGeoApiLastSeen) {
    const { trn, curr, prev } = checkData;

    // Only announce when the train first becomes active
    if (prev?.status) return;

    const trainTimetable = (await getTodaysTimetable()).trains[trn];
    if (!trainTimetable) return "wrong-day";

    if (curr.status.timesAPI && isNightHours(trainTimetable, curr.status.timesAPI.lastEvent.time)) return "night-hours";

    if (geoApiLastSeen && isNightHours(trainTimetable, geoApiLastSeen.time)) return "night-hours";

    if (trainTimetable.every(entry => !entry.inService)) return "ecs";
}

function shouldAnnounceUnrecognisedStation(
    {prev}: TrainCheckData,
    geoApiPlatform?: ParsedPlatform,
    timesApiPlatform?: ParsedPlatform
) {
    // If the APIs disagree on the station, it isn't clear which one to announce
    if (geoApiPlatform && timesApiPlatform && geoApiPlatform.station !== timesApiPlatform.station) return false;
    if (geoApiPlatform) {
        const prevGeoApiPlatform = getGeoApiLastSeen(prev?.status?.geoAPI);
        if (
            !getStationCode(geoApiPlatform.station) &&
            geoApiPlatform.station !== prevGeoApiPlatform?.station
        ) return true;
    }
    if (timesApiPlatform) {
        const prevTimesApiPlatform = getTimesApiPlatform(prev?.status?.timesAPI);
        if (
            !getStationCode(timesApiPlatform.station) &&
            timesApiPlatform.station !== prevTimesApiPlatform?.station
        ) return true;
    }
    return false;
}

function getUniqueDestinations(status?: TrainStatus) {
    const destinations = new Set<string>();
    if (status?.geoAPI) {
        destinations.add(status.geoAPI.destination);
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

type TimedPlatform = ParsedPlatform & { time: Date };

type Teleport = { currLocationCode: string; prevLocationCode: string };

/** Checks whether a train moved between two non-adjacent platforms */
function teleportBetween(curr: TimedPlatform, prev: TimedPlatform): Teleport | undefined {
    const currLocationCode = parsedPlatformToLocationCode(curr);
    if (!currLocationCode) return;
    const prevLocationCode = parsedPlatformToLocationCode(prev);
    if (!prevLocationCode) return;
    if (currLocationCode === prevLocationCode) return;

    const timeDelta = curr.time.getTime() - prev.time.getTime();
    const isAdjacentMove =
        (timeDelta >= 0 && isAdjacent(prevLocationCode, currLocationCode)) ||
        (timeDelta <= 0 && isAdjacent(currLocationCode, prevLocationCode));
    if (!isAdjacentMove) return { currLocationCode, prevLocationCode };
}

function hasTeleported(
    geoApiLastSeen?: ParsedGeoApiLastSeen,
    timesApiPlatform?: ParsedPlatform,
    timesApiTime?: Date,
    prevGeoApiLastSeen?: ParsedGeoApiLastSeen,
    prevTimesApiPlatform?: ParsedPlatform,
    prevTimesApiTime?: Date,
): Teleport | false {
    if (geoApiLastSeen && prevGeoApiLastSeen) {
        const teleport = teleportBetween(geoApiLastSeen, prevGeoApiLastSeen);
        if (teleport) return teleport;
    }
    if (timesApiPlatform && timesApiTime && prevTimesApiPlatform && prevTimesApiTime) {
        const teleport = teleportBetween(
            { ...timesApiPlatform, time: timesApiTime },
            { ...prevTimesApiPlatform, time: prevTimesApiTime }
        );
        if (teleport) return teleport;
    }
    return false;
}

// Checks which can be done with either API
async function eitherApiChecks(
    checkData: TrainCheckData,
    geoApiLastSeen?: ParsedGeoApiLastSeen,
    timesApiPlatform?: ParsedPlatform
): Promise<ActiveTrainAnnouncer[]> {
    const { trn, curr, prev } = checkData;
    const announcements: ActiveTrainAnnouncer[] = [];
    let shouldCheckPlatform = true;

    const checkPromises: Promise<void>[] = [
        checkIfTimetabled(checkData, geoApiLastSeen).then((shouldBeActive) => {
            if (shouldBeActive === "wrong-day") {
                announcements.push(announceTrainOnWrongDay)
            } else if (shouldBeActive === "night-hours") {
                announcements.push(announceTrainDuringNightHours);
            } else if (shouldBeActive === "ecs") {
                announcements.push(announceECS);
            }
        }),
    ];

    // Check if this is the first time it has been active today ...
    if (prev && whenIsNextDay(prev.date).getDate() !== whenIsNextDay(curr.date).getDate()) {
        checkPromises.push(
            getTodaysTimetable().then(async dayTimetable => {
                // ... and if it is significantly later than its first timetabled passenger departure
                const trainTimetable = dayTimetable.trains[trn];
                if (!trainTimetable) return;
                const firstInServiceDepartureTime = trainTimetable.find(
                    entry => entry.inService && entry.departureTime !== undefined
                )?.departureTime;
                if (firstInServiceDepartureTime === undefined) return;
                const delay = secondsSinceMidnight(curr.date) - firstInServiceDepartureTime;
                if (delay > LATE_START_THRESHOLD) {
                    announcements.push(fullEmbedData => announceTrainAppearedLate(fullEmbedData, delay));
                }
            })
        )
    }

    const newUnrecognisedDestinations = getNewUnrecognisedDestinations(checkData);
    if (newUnrecognisedDestinations.length) {
        announcements.push((fullEmbedData) => announceUnrecognisedDestinations(
            fullEmbedData,
            { trn, ...prev },
            newUnrecognisedDestinations
        ));
    }

    if (shouldAnnounceUnrecognisedStation(checkData, geoApiLastSeen, timesApiPlatform)) {
        announcements.push((fullEmbedData) => announceTrainAtUnrecognisedStation(
            fullEmbedData,
            { trn, ...prev },
            (geoApiLastSeen?.station ?? timesApiPlatform?.station)!
        ));
        // Don't check the platform if the station is unrecognised
        shouldCheckPlatform = false;
    }

    // Don't check the platform if each API is reporting a different platform
    if (geoApiLastSeen && timesApiPlatform && geoApiLastSeen.platformNumber !== timesApiPlatform.platformNumber) {
        shouldCheckPlatform = false;
    }

    if (prev?.status) {
        const prevGeoApiLastSeen = getGeoApiLastSeen(prev.status.geoAPI);
        const prevTimesApiPlatform = getTimesApiPlatform(prev.status.timesAPI);

        const teleport = hasTeleported(
            geoApiLastSeen,
            timesApiPlatform,
            curr.status.timesAPI?.lastEvent.time,
            prevGeoApiLastSeen,
            prevTimesApiPlatform,
            prev.status.timesAPI?.lastEvent.time
        );
        if (teleport) {
            if (isJesmondJunction(teleport.prevLocationCode, teleport.currLocationCode)) {
                announcements.push(fullEmbedData => announceTrainUsingJJC(
                    fullEmbedData,
                    { trn, ...prev }
                ));
            } else {
                announcements.push(fullEmbedData => announceTrainTeleported(
                    fullEmbedData,
                    { trn, ...prev },
                    teleport.prevLocationCode,
                    teleport.currLocationCode
                ));
            }
        }

        // Don't check the platform if the location hasn't changed
        if (prev.status.timesAPI) {
            if (
                curr.status.timesAPI &&
                renderTimesApiLocation(curr.status.timesAPI.lastEvent.location) ===
                    renderTimesApiLocation(prev.status.timesAPI.lastEvent.location)
            ) {
                shouldCheckPlatform = false;
            }
        } else if (prev.status.geoAPI) {
            if (
                geoApiLastSeen?.station === prevGeoApiLastSeen?.station &&
                geoApiLastSeen?.platformNumber === prevGeoApiLastSeen?.platformNumber
            ) shouldCheckPlatform = false;
        }
    }

    const platformNumber = timesApiPlatform?.platformNumber ?? geoApiLastSeen?.platformNumber;
    const stationName = geoApiLastSeen?.station ?? timesApiPlatform?.station;
    // If neither API's location could be parsed, there's nothing to check (and it is already announced as unparseable)
    if (shouldCheckPlatform && platformNumber !== undefined && stationName !== undefined) {
        const platformCheck = checkPlatform(
            stationName,
            platformNumber as PlatformNumber,
            secondsSinceMidnight(checkData.curr.date)
        );
        if (platformCheck === "sss-p1") {
            announcements.push(announceTrainAtSouthShieldsP1);
        } else if (platformCheck === 'sun-p14') {
            announcements.push(fullEmbedData => announceTrainAtSunderlandP1orP4(fullEmbedData, platformNumber as 1 | 4));
        } else if (platformCheck === "unrecognised") {
            announcements.push(announceTrainAtUnrecognisedPlatform);
        }
    }

    await Promise.all(checkPromises);
    return announcements;
}

async function checkActiveTrain(checkData: TrainCheckData) {
    const status = checkData.curr.status;
    const checkPromises: Promise<ActiveTrainAnnouncer[]>[] = [];

    const geoApiLastSeen = getGeoApiLastSeen(status.geoAPI);
    if (status.geoAPI) {
        checkPromises.push(
            geoApiChecks(
                checkData as TrainCheckData<{ geoAPI: GeoApiData }>,
                geoApiLastSeen
            )
        );
    }

    const timesApiPlatform = getTimesApiPlatform(status.timesAPI);
    if (status.timesAPI) {
        checkPromises.push(
            timesApiChecks(
                checkData as TrainCheckData<{ timesAPI: TimesApiData }>,
                timesApiPlatform
            )
        );
    }

    if (status.timesAPI || status.geoAPI) {
        checkPromises.push(eitherApiChecks(checkData, geoApiLastSeen, timesApiPlatform));
    }

    const announcements = (await Promise.all(checkPromises)).flat();
    if (announcements.length > 0) {
        const fullEmbedData = await getFullEmbedData(checkData);
        await Promise.all(announcements.map(announcer => announcer(fullEmbedData)));
    }
}

async function handleDisappearedTrain(trn: string, prev?: DatedTrainStatus) {
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
        await announceAllTrainsDisappeared(trns);
    } else {
        await announceMultipleDisappearedTrains(trns);
    }
}

async function checkMissingTrains() {
    await Promise.all(
        [...missingTrains].map(async ([trn, details]) => {
            if (details.announced) {
                if (details.whenToForget < lastHeartbeat) missingTrains.delete(trn);
            } else if (details.whenToAnnounce < lastHeartbeat) {
                await announceDisappearedTrain({
                    trn,
                    timetable: (await getTodaysTimetable()).trains[trn],
                    ...details.prevStatus
                });
                missingTrains.set(trn, { announced: true, whenToForget: whenIsNextDay(lastHeartbeat) });
            }
        })
    );
}

function isDepartedFellgateToShared(status: TrainStatus): boolean {
    return (
        status.timesAPI !== undefined &&
        typeof status.timesAPI.lastEvent.location !== "string" &&
        status.timesAPI.lastEvent.location.station === "Fellgate" &&
        status.timesAPI.lastEvent.type === "DEPARTED" &&
        status.timesAPI.plannedDestinations[0] &&
        isInSharedStretch(getStationCode(status.timesAPI.plannedDestinations[0].name))
    ) || (
        status.geoAPI !== undefined &&
        typeof status.geoAPI.lastSeen !== "string" &&
        status.geoAPI.lastSeen.station === "Fellgate" &&
        status.geoAPI.lastSeen.type === "DEPARTED" &&
        isInSharedStretch(getStationCode(status.geoAPI.destination))
    )
}

/** Gets a train's status from the heartbeat before a time, for when it isn't already known */
async function getStatusBefore(trn: string, date: Date): Promise<DatedTrainStatus | undefined> {
    const snapshot = await proxy.getSnapshot(new Date(date.getTime() - 1), { trns: [trn] });
    if (!snapshot) return;
    const status = { timesAPI: snapshot.timesApiTrains[trn], geoAPI: snapshot.geoApiTrains[trn] };
    if (!status.timesAPI && !status.geoAPI) return;
    return { date: snapshot.heartbeat.startedAt, status };
}

/** How trains changed during a heartbeat */
interface TrainChanges {
    heartbeat: HeartbeatTimes;
    /** The new status of each train which became active or whose status changed, by TRN */
    changedTrains: Record<string, CollatedTrain>;
    /** TRNs of trains which are no longer active */
    inactiveTrains: Set<string>;
}

async function onTrainChanges(payload: TrainChanges) {
    const date = payload.heartbeat.startedAt;
    setLastHeartbeat(date);
    if (Object.keys(payload.changedTrains).length === 0 && payload.inactiveTrains.size === 0) return;

    const numberOfPreviouslyActiveTrains = Object.keys(lastHistoryEntries).length;

    const disappearedTrains: {
        trn: string,
        prev?: DatedTrainStatus,
    }[] = []
    const reappearedTrains: {
        trn: string,
        curr: DatedTrainStatus,
    }[] = [];
    await Promise.all([
        ...Object.entries(payload.changedTrains).map(async ([trn, status]) => {
            const curr = { date, status };
            await checkActiveTrain({
                trn,
                curr,
                prev: lastHistoryEntries[trn]
            });
            lastHistoryEntries[trn] = curr;
            trainsWithHistory.add(trn);
            if (missingTrains.has(trn)) {
                reappearedTrains.push({ trn, curr });
            }
        }),
        ...[...payload.inactiveTrains].map(async trn => {
            // The previous status can be unknown if the bot was restarted between it changing and the train going missing
            const prev = lastHistoryEntries[trn] ?? await getStatusBefore(trn, date);
            disappearedTrains.push({ trn, prev });
            delete lastHistoryEntries[trn];
        })
    ]);

    const promises: Promise<void>[] = [];
    if (disappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        promises.push(
            handleMultipleDisappearedTrains(
                new Set(disappearedTrains.map(({ trn }) => trn)),
                disappearedTrains.length === numberOfPreviouslyActiveTrains
            )
        );
    } else {
        for (const train of disappearedTrains) {
            if (train.prev && isDepartedFellgateToShared(train.prev.status)) {
                // See comment on `DEPARTED_FELLGATE_TO_SHARED_DELAY` for explanation
                missingTrains.set(train.trn, {
                    announced: false,
                    prevStatus: train.prev,
                    whenToAnnounce: new Date(train.prev.date.getTime() + DEPARTED_FELLGATE_TO_SHARED_DELAY)
                });
                continue;
            }
            promises.push(handleDisappearedTrain(train.trn, train.prev));
        }
    }
    if (reappearedTrains.length >= MULTIPLE_TRAINS_THRESHOLD) {
        promises.push(
            announceMultipleReappearedTrains(
                new Set(reappearedTrains.map(({ trn }) => trn))
            )
        );
    } else {
        for (const { trn, curr } of reappearedTrains) {
            const missingEntry = missingTrains.get(trn);
            if (missingEntry && !missingEntry.announced) {
                // Its disappearance hadn't been announced yet, so don't announce its reappearance
                continue;
            }
            promises.push(getTodaysTimetable().then(dayTimetable =>
                announceReappearedTrain({ trn, timetable: dayTimetable.trains[trn], ...curr })
            ));
        }
    }
    for (const { trn } of reappearedTrains) {
        // This needs to be done after the announcements, so the missingEntry can be checked
        missingTrains.delete(trn);
    }
    promises.push(checkMissingTrains());

    const numberOfCurrentlyActiveTrains = Object.keys(lastHistoryEntries).length;
    if (numberOfCurrentlyActiveTrains !== numberOfPreviouslyActiveTrains) {
        promises.push(updateActivity(numberOfCurrentlyActiveTrains));
    }

    await Promise.all(promises);
}

const ongoingErrors = new Set<string>();
const lastErrors = new Set<string>();

function shouldAnnounceError(error: HeartbeatError) {
    if (ongoingErrors.has(error.message)) return false;
    if (error.api !== "TIMES") return true;
    if (error.message === "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") {
        // This is usually a Cloudflare "Timed out" error page.
        // This happens relatively often, so just ignore it.
        return false;
    }
    if (error.message === "Unexpected end of JSON input") {
        const time = secondsSinceMidnight(error.heartbeat.startedAt);
        if (time >= TIMES_API_RESTART_TIME.from && time <= TIMES_API_RESTART_TIME.to) {
            return false;
        }
    }
    return true;
}

const SUBSCRIPTIONS: SubscriptionRequest[] = [
    { id: "trains", topic: "trains" },
    { id: "errors", topic: "heartbeat-errors" },
    { id: "warnings", topic: "heartbeat-warnings" },
    // Each train is sent as a separate event, so we need the heartbeat events to know when all the trains have been sent
    { id: "heartbeats", topic: "heartbeats" },
];

export async function startMonitoring() {
    await refreshCache(proxy);

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

    let currentToken: string | undefined;
    let stream: { close(): void } | undefined;

    async function connect(): Promise<void> {
        stream?.close();
        stream = undefined;
        currentToken = undefined;
        console.log("Creating subscription token...");
        try {
            const { token } = await proxy.createSubscriptionToken(SUBSCRIPTIONS);
            currentToken = token;
            stream = streamForToken(token);
        } catch (e) {
            console.error("Failed to create subscription token, retrying in 10 seconds:", e);
            setTimeout(connect, 10 * 1000);
        }
    }

    /** Checks whether the token is still valid and, if not, reconnects */
    async function checkToken(token: string): Promise<void> {
        try {
            await proxy.getSubscriptions(token);
        } catch (e) {
            // Other errors (e.g. the proxy being unreachable) are left to the stream to retry.
            // Several checks can be pending at once, since the stream keeps retrying, so only the first should reconnect.
            if (e instanceof MetroApiError && e.status === 404 && token === currentToken) {
                console.log("Subscription token no longer exists");
                await connect();
            }
        }
    }

    function streamForToken(token: string): { close(): void } {
        console.log("Connecting to stream...");
        // Train changes are collected until the heartbeat ends, so that they can be handled together
        let pendingChanges: TrainChanges | undefined;
        return proxy.streamSubscriptions(token, {
            onTrain(message) {
                if (pendingChanges?.heartbeat.startedAt.getTime() !== message.heartbeat.startedAt.getTime()) {
                    pendingChanges = { heartbeat: message.heartbeat, changedTrains: {}, inactiveTrains: new Set() };
                }
                if (message.status) {
                    pendingChanges.changedTrains[message.trn] = message.status;
                } else {
                    pendingChanges.inactiveTrains.add(message.trn);
                }
            },
            async onHeartbeatEnd({ heartbeat }) {
                const changes: TrainChanges = pendingChanges?.heartbeat.startedAt.getTime() === heartbeat.startedAt.getTime()
                    ? pendingChanges
                    : { heartbeat, changedTrains: {}, inactiveTrains: new Set() };
                pendingChanges = undefined;
                await Promise.all([
                    setConnected(),
                    onTrainChanges(changes)
                ]);
                for (const error of ongoingErrors) {
                    if (!lastErrors.has(error)) {
                        ongoingErrors.delete(error);
                    }
                }
                lastErrors.clear();
            },
            async onHeartbeatError(payload) {
                const promises: Promise<void>[] = [setConnected()];
                lastErrors.add(payload.message);
                if (shouldAnnounceError(payload)) {
                    ongoingErrors.add(payload.message)
                    promises.push(announceHeartbeatError(payload));
                }
                await Promise.all(promises);
            },
            async onHeartbeatWarning(payload) {
                await Promise.all([
                    setConnected(),
                    announceHeartbeatWarning(payload)
                ]);
            },
            onStreamClosed({ reason }) {
                // Nothing else should be using the token, so this is unexpected
                console.warn(`Stream was closed by the proxy (${reason})`);
                currentlyConnected = false;
                connect().then();
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
                checkToken(token).then();
            }
        });
    }

    await connect();
}
