export const HISTORY_PAGE_ROWS = 10;
export const DUE_TIMES_PAGE_ROWS = 4;
export const MULTIPLE_TRAINS_THRESHOLD = 4; // How many trains must appear or disappear simultaneously to announce them as a group
export const MAX_PLANNED_DESTINATIONS = 5; // Maximum number of planned destinations to show

// For some reason, trains disappear after departing Fellgate towards a station in the shared stretch,
// and until they reach Pelaw.
// This defines how long such a train needs to be missing before announcing its disappearance.
export const DEPARTED_FGT_TO_SHARED_DELAY = 5; // minutes

export const API_CODES = {
    timesAPI: "the times API",
    trainStatusesAPI: "the train statuses API",
    gateway: "the gateway (a prerequisite of the train statuses API)",
}

export const MONUMENT_STATION_CODES = ["MMT","MTS","MTW","MTN","MTE"];
