export type TaskSchedule =
  | { kind: "none" }
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[] }
  | { kind: "monthly"; time: string; timeZone: string; dayOfMonth: number };

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const validTime = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);

const validTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

export const isTaskSchedule = (value: unknown): value is TaskSchedule => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const schedule = value as Record<string, unknown>;
  if (schedule["kind"] === "none") return true;
  if (schedule["kind"] === "once") {
    return typeof schedule["at"] === "string" && Number.isFinite(Date.parse(schedule["at"]));
  }
  if (!validTime(schedule["time"]) || !validTimeZone(schedule["timeZone"])) return false;
  if (schedule["kind"] === "daily") return true;
  if (schedule["kind"] === "weekly") {
    return Array.isArray(schedule["weekdays"]) && schedule["weekdays"].length > 0 &&
      schedule["weekdays"].length <= 7 &&
      new Set(schedule["weekdays"]).size === schedule["weekdays"].length &&
      schedule["weekdays"].every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  }
  return schedule["kind"] === "monthly" && Number.isInteger(schedule["dayOfMonth"]) &&
    Number(schedule["dayOfMonth"]) >= 1 && Number(schedule["dayOfMonth"]) <= 31;
};

const partsInZone = (instant: Date, timeZone: string): LocalDateTime => {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values["year"] ?? 0,
    month: values["month"] ?? 0,
    day: values["day"] ?? 0,
    hour: values["hour"] ?? 0,
    minute: values["minute"] ?? 0,
  };
};

const sameLocalTime = (left: LocalDateTime, right: LocalDateTime): boolean =>
  left.year === right.year && left.month === right.month && left.day === right.day &&
  left.hour === right.hour && left.minute === right.minute;

const localToEpoch = (local: LocalDateTime, timeZone: string): number | undefined => {
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let candidate = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = partsInZone(new Date(candidate), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    candidate -= represented - desired;
  }
  return sameLocalTime(partsInZone(new Date(candidate), timeZone), local) ? candidate : undefined;
};

const timeParts = (time: string): { hour: number; minute: number } => ({
  hour: Number(time.slice(0, 2)),
  minute: Number(time.slice(3, 5)),
});

const dateAfterDays = (local: LocalDateTime, days: number): Pick<LocalDateTime, "year" | "month" | "day"> => {
  const value = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
};

export const nextTaskRunAt = (schedule: TaskSchedule, after: Date): string | undefined => {
  if (schedule.kind === "none") return undefined;
  if (schedule.kind === "once") {
    const epoch = Date.parse(schedule.at);
    return epoch > after.getTime() ? new Date(epoch).toISOString() : undefined;
  }

  const localAfter = partsInZone(after, schedule.timeZone);
  const clock = timeParts(schedule.time);
  const maxDays = schedule.kind === "monthly" ? 800 : schedule.kind === "weekly" ? 15 : 3;
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = dateAfterDays(localAfter, offset);
    if (schedule.kind === "weekly") {
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (!schedule.weekdays.includes(weekday)) continue;
    }
    if (schedule.kind === "monthly" && date.day !== schedule.dayOfMonth) continue;
    const candidate = localToEpoch({ ...date, ...clock }, schedule.timeZone);
    if (candidate !== undefined && candidate > after.getTime()) return new Date(candidate).toISOString();
  }
  return undefined;
};
