import {apiConstants, lastHeartbeat} from "./cache";

function getShiftedDayKey(date: Date) {
    const shifted = new Date(date.getTime() - apiConstants.NEW_DAY_HOUR * 60 * 60 * 1000);
    return `${shifted.getFullYear()}-${shifted.getMonth() + 1}-${shifted.getDate()}`;
}
export function isToday(date: Date): boolean {
    return getShiftedDayKey(lastHeartbeat) === getShiftedDayKey(date);
}

export function isInSharedStretch(stationCode?: string) {
    return stationCode &&
        apiConstants.LINES.yellow.includes(stationCode) &&
        apiConstants.LINES.green.includes(stationCode)
}
