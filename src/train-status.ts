import {GeoApiData, HistoricTimesApiData, TimesApiData} from "metro-api-client";

/** A train's status, either current or historic */
export interface TrainStatus {
    timesAPI?: TimesApiData | HistoricTimesApiData;
    geoAPI?: GeoApiData;
}

/** A train's status, as of a date */
export interface DatedTrainStatus {
    date: Date;
    status: TrainStatus;
}
