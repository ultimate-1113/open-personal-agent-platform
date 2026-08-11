export type GoogleRequestOptions = {
  accessToken: string;
  fetcher?: typeof fetch;
};

export class GoogleApiError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`Google ${operation} failed (${status})`);
    this.name = "GoogleApiError";
  }
}

const googleJson = async (
  url: URL,
  operation: string,
  options: GoogleRequestOptions,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await (options.fetcher ?? fetch)(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new GoogleApiError(response.status, operation);
  return response.json();
};

export type GmailMessageSummary = {
  messageId: string;
  threadId: string;
};

export async function searchGmail(
  input: { query: string; maxResults?: number },
  options: GoogleRequestOptions,
): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  if (input.query) url.searchParams.set("q", input.query);
  url.searchParams.set("maxResults", String(Math.min(Math.max(input.maxResults ?? 20, 1), 50)));
  const value = await googleJson(url, "gmail.search", options) as Record<string, unknown>;
  const messages = Array.isArray(value["messages"])
    ? value["messages"].flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const row = item as Record<string, unknown>;
        return typeof row["id"] === "string" && typeof row["threadId"] === "string"
          ? [{ messageId: row["id"], threadId: row["threadId"] }]
          : [];
      })
    : [];
  return {
    messages,
    ...(typeof value["nextPageToken"] === "string"
      ? { nextPageToken: value["nextPageToken"] }
      : {}),
  };
}

export async function getGmailMessage(
  messageId: string,
  options: GoogleRequestOptions,
): Promise<unknown> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "full");
  return googleJson(url, "gmail.get", options);
}

export async function listCalendarEvents(
  input: { calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number },
  options: GoogleRequestOptions,
): Promise<unknown> {
  const calendarId = input.calendarId ?? "primary";
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(Math.min(Math.max(input.maxResults ?? 20, 1), 50)));
  url.searchParams.set("timeMin", input.timeMin ?? new Date().toISOString());
  if (input.timeMax) url.searchParams.set("timeMax", input.timeMax);
  return googleJson(url, "calendar.events.list", options);
}

export async function searchDrive(
  input: { query?: string; pageSize?: number },
  options: GoogleRequestOptions,
): Promise<unknown> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  if (input.query) url.searchParams.set("q", input.query);
  url.searchParams.set("pageSize", String(Math.min(Math.max(input.pageSize ?? 20, 1), 50)));
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))");
  return googleJson(url, "drive.files.list", options);
}

const base64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Url = (value: Uint8Array): string =>
  base64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const encodedHeader = (value: string): string =>
  `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;

export async function createGmailDraft(
  input: { to: string; subject: string; body: string },
  options: GoogleRequestOptions,
): Promise<unknown> {
  const message = [
    `To: ${input.to}`,
    `Subject: ${encodedHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ].join("\r\n");
  return googleJson(
    new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts"),
    "gmail.drafts.create",
    options,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: base64Url(new TextEncoder().encode(message)) } }),
    },
  );
}

export async function createCalendarEvent(
  input: {
    calendarId?: string;
    summary: string;
    description?: string;
    start: string;
    end: string;
    timeZone?: string;
  },
  options: GoogleRequestOptions,
): Promise<unknown> {
  const calendarId = input.calendarId ?? "primary";
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("sendUpdates", "none");
  return googleJson(url, "calendar.events.create", options, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: input.summary,
      ...(input.description === undefined ? {} : { description: input.description }),
      start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
    }),
  });
}
