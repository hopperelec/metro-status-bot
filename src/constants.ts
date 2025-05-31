import {TrainDirection} from "metro-api-client";

export const HISTORY_PAGE_ROWS = 10;
export const DUE_TIMES_PAGE_ROWS = 4;
export const MULTIPLE_TRAINS_THRESHOLD = 4; // How many trains must appear or disappear simultaneously to announce them as a group
export const TRAIN_DIRECTIONS: TrainDirection[] = ["in","out"];
export const MAX_PLANNED_DESTINATIONS = 5; // Maximum number of planned destinations to show

export const API_CODES = {
    timesAPI: "the times API",
    trainStatusesAPI: "the train statuses API",
    gateway: "the gateway (a prerequisite of the train statuses API)",
}
