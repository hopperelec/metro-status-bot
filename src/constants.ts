export const HISTORY_PAGE_ROWS = 10;
export const DUE_TIMES_PAGE_ROWS = 4;
export const MULTIPLE_TRAINS_THRESHOLD = 4; // How many trains must appear or disappear simultaneously to announce them as a group
export const MAX_PLANNED_DESTINATIONS = 5; // Maximum number of planned destinations to show

// For some reason, trains disappear after departing Fellgate towards a station in the shared stretch,
// and until they reach Pelaw.
// This defines how long such a train needs to be missing before announcing its disappearance.
export const DEPARTED_FGT_TO_SHARED_DELAY = 5 * 60 * 1000; // 5 minutes

// The times API seems to restart at 3AM, and it can sometimes take several minutes for it to come back online.
// During this time, the proxy will send "Unexpected end of JSON input" errors for the times API.
// This defines the time window during which we should ignore those errors.
export const TIMES_API_RESTART_TIME = {
    from: 3 * 60 * 60 * 1000, // 3 AM
    to: (3 * 60 + 10) * 60 * 1000, // 3:10 AM
}

export const MONUMENT_STATION_CODES = ["MMT","MTS","MTW","MTN","MTE"];
