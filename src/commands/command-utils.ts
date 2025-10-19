export const TRN_OPTION = {
    name: 'trn',
    description: "Train Running Number (e.g., T104, with or without the leading 'T')",
    required: true,
    type: 3, // string
    autocomplete: true,
}

const STATION_REGEX = new RegExp(/^([A-Z]{3})( - .+)?/i);
export function parseStationOption(station: string) {
    const match = station.match(STATION_REGEX);
    return match?.[1];
}

const T1xx_REGEX = new RegExp(/^T1\d\d$/i);
export function normalizeTRN(trn: string) {
    trn = trn.trim();
    // Remove the leading 'T' if included
    return T1xx_REGEX.test(trn) ? trn.slice(1) : trn;
}

const TIME_REGEX = new RegExp(/^(\d\d):(\d\d)(?::(\d\d))?$/);
export function parseTimeOption(time: string) {
    const timeMatch = time.match(TIME_REGEX);
    if (!timeMatch) throw new Error("Invalid time format. Please use HH:MM[:SS] format.");
    const hours = +timeMatch[1];
    if (hours < 0 || hours > 23) throw new Error("Invalid hour; it must be between 00 and 23.");
    const minutes = +timeMatch[2];
    if (minutes < 0 || minutes > 59) throw new Error("Invalid minute; it must be between 00 and 59.");
    const seconds = timeMatch[3] ? +timeMatch[3] : 0;
    if (seconds < 0 || seconds > 59) throw new Error("Invalid second; it must be between 00 and 59.");
    return { hours, minutes, seconds };
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export function parseDateOption(date: string) {
    if (!DATE_REGEX.test(date)) throw new Error("Invalid date format. Please use YYYY-MM-DD format.");
    const [year, month, day] = date.split('-').map(Number);
    const parsedDate = new Date(year, month - 1, day);
    if (isNaN(parsedDate.getTime())) throw new Error("Invalid date.");
    return parsedDate;
}
