import {TrainDirection} from "metro-api-client";

export const HISTORY_PAGE_ROWS = 10;
export const DUE_TIMES_PAGE_ROWS = 4;
export const DEFAULT_MISSING_THRESHOLD = 2; // How many minutes a train must be missing before announcing it
export const MULTIPLE_TRAINS_THRESHOLD = 4; // How many trains must appear or disappear simultaneously to announce them as a group
export const TRAIN_DIRECTIONS: TrainDirection[] = ["in","out"];

export const API_CODES = {
    timesAPI: "the times API",
    trainStatusesAPI: "the train statuses API",
    gateway: "the gateway (a prerequisite of the train statuses API)",
}
