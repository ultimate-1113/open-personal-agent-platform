import { describe, expect, it } from "vitest";

import { isTaskSchedule, nextTaskRunAt } from "./schedule.js";

describe("task scheduling", () => {
  it("schedules every morning in the selected time zone", () => {
    expect(nextTaskRunAt({ kind: "daily", time: "08:00", timeZone: "Asia/Tokyo" },
      new Date("2026-08-13T00:00:00.000Z"))).toBe("2026-08-13T23:00:00.000Z");
  });

  it("supports multiple weekdays without using fixed 24-hour intervals", () => {
    expect(nextTaskRunAt({ kind: "weekly", time: "18:30", timeZone: "Asia/Tokyo", weekdays: [1, 5] },
      new Date("2026-08-13T12:00:00.000Z"))).toBe("2026-08-14T09:30:00.000Z");
  });

  it("supports a fixed UTC offset time zone", () => {
    expect(nextTaskRunAt({ kind: "daily", time: "08:00", timeZone: "+09:00" },
      new Date("2026-08-13T00:00:00.000Z"))).toBe("2026-08-13T23:00:00.000Z");
  });

  it("skips months that do not contain the selected day", () => {
    expect(nextTaskRunAt({ kind: "monthly", time: "09:00", timeZone: "Asia/Tokyo", dayOfMonth: 31 },
      new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-10-31T00:00:00.000Z");
  });

  it("validates time zones, clock values, and weekday uniqueness", () => {
    expect(isTaskSchedule({ kind: "weekly", time: "08:00", timeZone: "Asia/Tokyo", weekdays: [1, 3] })).toBe(true);
    expect(isTaskSchedule({ kind: "weekly", time: "25:00", timeZone: "invalid", weekdays: [1, 1] })).toBe(false);
  });
});
