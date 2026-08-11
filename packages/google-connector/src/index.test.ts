import { describe, expect, it, vi } from "vitest";
import {
  GoogleApiError,
  createCalendarEvent,
  createGmailDraft,
  listCalendarEvents,
  searchDrive,
  searchGmail,
  sendGmailMessage,
} from "./index.js";

const response = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

const calledUrl = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>): URL => {
  const target = fetcher.mock.calls[0]?.[0];
  if (!(target instanceof URL)) throw new Error("Expected connector to call fetch with a URL");
  return target;
};

describe("Google connector", () => {
  it("bounds Gmail results and maps identifiers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next",
    }));
    await expect(searchGmail({ query: "from:example.com", maxResults: 500 }, {
      accessToken: "token", fetcher,
    })).resolves.toEqual({
      messages: [{ messageId: "m1", threadId: "t1" }], nextPageToken: "next",
    });
    const requestUrl = calledUrl(fetcher);
    expect(requestUrl.searchParams.get("maxResults")).toBe("50");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer token" });
  });

  it("uses primary calendar and chronological event order", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }));
    await listCalendarEvents({ timeMin: "2026-08-11T00:00:00.000Z" }, {
      accessToken: "token", fetcher,
    });
    const requestUrl = calledUrl(fetcher);
    expect(requestUrl.pathname).toContain("/calendars/primary/events");
    expect(requestUrl.searchParams.get("orderBy")).toBe("startTime");
  });

  it("requests only bounded Drive metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ files: [] }));
    await searchDrive({ query: "trashed = false" }, { accessToken: "token", fetcher });
    const requestUrl = calledUrl(fetcher);
    expect(requestUrl.searchParams.get("fields")).toContain("files(id,name,mimeType");
  });

  it("does not expose provider error bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ secret: "provider body" }, 403));
    await expect(searchGmail({ query: "" }, { accessToken: "token", fetcher }))
      .rejects.toEqual(new GoogleApiError(403, "gmail.search"));
  });

  it("creates a draft without sending it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "draft-1" }));
    await createGmailDraft({ to: "recipient@example.com", subject: "確認", body: "本文" }, {
      accessToken: "token", fetcher,
    });
    const target = calledUrl(fetcher);
    expect(target.pathname.endsWith("/drafts")).toBe(true);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(typeof init?.body === "string" ? init.body : "").toContain("\"raw\"");
  });

  it("sends an approved Gmail message through messages.send", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "message-1" }));
    await sendGmailMessage({ to: "recipient@example.com", subject: "確認", body: "本文" }, {
      accessToken: "token", fetcher,
    });
    const target = calledUrl(fetcher);
    expect(target.pathname.endsWith("/messages/send")).toBe(true);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(typeof init?.body === "string" ? init.body : "").toContain("\"raw\"");
  });

  it("creates calendar events without attendee notifications", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "event-1" }));
    await createCalendarEvent({
      summary: "確認予定",
      start: "2026-08-12T10:00:00+09:00",
      end: "2026-08-12T10:30:00+09:00",
    }, { accessToken: "token", fetcher });
    const target = calledUrl(fetcher);
    expect(target.searchParams.get("sendUpdates")).toBe("none");
  });
});
