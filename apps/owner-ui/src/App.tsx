import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { isLocale, useLocale, type Locale, type Translate } from "./i18n.js";
import type { MessageKey } from "./locales/en.js";
import { useTheme } from "./theme.js";

type Tab = "conversation" | "tasks" | "memory" | "approvals" | "audit" | "providers" | "budget" | "connections" | "knowledge" | "plugins";
type ApprovalFilter = "pending" | "approved" | "all";
type ConnectorApprovalMode = "manual" | "open" | "auto-read";
type ApiRecord = Record<string, unknown>;

const storedConnectorApprovalMode = (): ConnectorApprovalMode => {
  const value = localStorage.getItem("opap.connectorApprovalMode");
  return value === "open" || value === "auto-read" ? value : "manual";
};

const tabs: readonly { id: Tab; labelKey: MessageKey }[] = [
  { id: "conversation", labelKey: "tab.conversation" },
  { id: "tasks", labelKey: "tab.tasks" },
  { id: "memory", labelKey: "tab.memory" },
  { id: "approvals", labelKey: "tab.approvals" },
  { id: "audit", labelKey: "tab.audit" },
  { id: "providers", labelKey: "tab.providers" },
  { id: "budget", labelKey: "tab.budget" },
  { id: "connections", labelKey: "tab.connections" },
  { id: "knowledge", labelKey: "tab.knowledge" },
  { id: "plugins", labelKey: "tab.plugins" },
];

const api = async (
  path: string,
  requestFailed: (status: number) => string,
  init?: RequestInit,
): Promise<ApiRecord> => {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = record(value);
    const summary = [problem["title"], problem["code"]]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    const detail = [problem["detail"], problem["message"]]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    throw new Error(summary ? `${summary}${detail && detail !== summary ? `: ${detail}` : ""}`
      : requestFailed(response.status));
  }
  return typeof value === "object" && value !== null ? value as ApiRecord : {};
};

const rows = (value: unknown): ApiRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is ApiRecord => typeof item === "object" && item !== null)
    : [];

const formText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const display = (value: unknown, fallback = ""): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;

const record = (value: unknown): ApiRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as ApiRecord : {};

const stringItems = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => display(item)).filter(Boolean) : [];

const StructuredValue = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) {
    const items = value as unknown[];
    return items.length === 0 ? <span className="structured-empty">—</span> :
      <ul className="structured-list">{items.map((item, index) =>
        <li key={`${index}:${display(item)}`}><StructuredValue value={item} /></li>)}</ul>;
  }
  if (typeof value === "object" && value !== null) {
    return <dl className="structured-data">{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}>
      <dt>{key}</dt><dd><StructuredValue value={item} /></dd>
    </div>)}</dl>;
  }
  return <span>{display(value, "—") || "—"}</span>;
};

const localizedNumber = (value: unknown, locale: Locale): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(locale) : "—";

const shortenedIdentifier = (value: unknown): string => {
  const identifier = display(value);
  return identifier.length > 12 ? `…${identifier.slice(-6)}` : identifier;
};

const localizedError = (reason: unknown, t: Translate, fallback: MessageKey): string =>
  reason instanceof Error ? reason.message : t(fallback);

const knowledgeProviderLabel = (value: unknown, t: Translate): string =>
  value === "google" || value === "google-drive" ? t("knowledge.googleDrive")
    : value === "github" ? t("knowledge.github") : display(value);

const modelProviderLabel = (value: unknown, t: Translate): string =>
  value === "provider:workers-ai" ? t("providers.workersAi")
    : value === "provider:mock-local" ? t("providers.mockLocal") : display(value);

const modelPolicyLabel = (value: string, t: Translate): string => {
  const labels: Record<string, MessageKey> = {
    public: "providers.valuePublic", owner: "providers.valueOwner",
    "delegated-principal": "providers.valueDelegated",
    normal: "providers.valueNormal", sensitive: "providers.valueSensitive", secret: "providers.valueSecret",
  };
  return labels[value] ? t(labels[value]) : value;
};

const defaultTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";

const fixedOffsetTimeZones = (): string[] => Array.from({ length: 105 }, (_, index) => {
  const totalMinutes = -12 * 60 + index * 15;
  if (totalMinutes === 0) return "UTC";
  const sign = totalMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(totalMinutes);
  return `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")}`;
});

const supportedTimeZones = (): string[] => {
  const extendedIntl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const zones = extendedIntl.supportedValuesOf?.("timeZone") ?? [
    "Africa/Cairo", "America/Los_Angeles", "America/New_York", "Asia/Singapore",
    "Asia/Tokyo", "Australia/Sydney", "Europe/London", "Europe/Paris",
  ];
  return [...new Set([...fixedOffsetTimeZones(), ...zones])];
};

const timeZoneOptions = supportedTimeZones();

const lastTabStorageKey = "opap.lastTab";
const isTab = (value: string | null): value is Tab =>
  tabs.some((candidate) => candidate.id === value);

const initialTab = (): Tab => {
  const requested = new URLSearchParams(window.location.search).get("tab");
  if (isTab(requested)) return requested;
  const stored = localStorage.getItem(lastTabStorageKey);
  return isTab(stored) ? stored : "conversation";
};

const scheduleFromForm = (form: FormData, ownerTimeZone: string): ApiRecord | undefined => {
  const kind = formText(form, "scheduleKind");
  if (kind === "once") {
    const value = formText(form, "onceAt");
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) ? { kind, at: new Date(epoch).toISOString() } : undefined;
  }
  const time = formText(form, "scheduleTime");
  const timeZone = ownerTimeZone;
  if (kind === "daily") return { kind, time, timeZone };
  if (kind === "weekly") {
    return { kind, time, timeZone, weekdays: form.getAll("weekdays").map(Number) };
  }
  if (kind === "monthly") {
    return { kind, time, timeZone, dayOfMonth: Number(form.get("dayOfMonth")) };
  }
  return undefined;
};

const localDateTimeValue = (value: unknown): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const scheduleRecord = (item?: ApiRecord): ApiRecord =>
  item && typeof item["schedule"] === "object" && item["schedule"] !== null
    ? item["schedule"] as ApiRecord : { kind: "once" };

function TaskScheduleFields({ item, t, ownerTimeZone }: { item?: ApiRecord; t: Translate; ownerTimeZone: string }) {
  const schedule = scheduleRecord(item);
  const weekdays = Array.isArray(schedule["weekdays"])
    ? schedule["weekdays"].filter((day): day is number => typeof day === "number") : [];
  return <details className="task-schedule-fields" open>
    <summary>{t("tasks.schedule")}</summary>
    <label>{t("tasks.repeat")}
      <select name="scheduleKind" defaultValue={display(schedule["kind"], "once")}>
        <option value="once">{t("tasks.repeatOnce")}</option>
        <option value="daily">{t("tasks.repeatDaily")}</option>
        <option value="weekly">{t("tasks.repeatWeekly")}</option>
        <option value="monthly">{t("tasks.repeatMonthly")}</option>
      </select>
    </label>
    <label>{t("tasks.onceAt")}
      <input name="onceAt" type="datetime-local" defaultValue={localDateTimeValue(schedule["at"])} />
    </label>
    <label>{t("tasks.time")}
      <input name="scheduleTime" type="time" defaultValue={display(schedule["time"], "08:00")} />
    </label>
    <small>{t("tasks.usingTimeZone", { timeZone: ownerTimeZone })}</small>
    <fieldset>
      <legend>{t("tasks.weekdays")}</legend>
      {[0, 1, 2, 3, 4, 5, 6].map((day) => <label className="check" key={day}>
        <input name="weekdays" type="checkbox" value={day} defaultChecked={weekdays.includes(day)} />
        {t(`tasks.weekday${day}` as MessageKey)}
      </label>)}
    </fieldset>
    <label>{t("tasks.dayOfMonth")}
      <input name="dayOfMonth" type="number" min="1" max="31"
        defaultValue={display(schedule["dayOfMonth"], "1")} />
    </label>
    {item && <label className="check">
      <input name="taskEnabled" type="checkbox" defaultChecked={item?.["enabled"] !== false} />
      {t("tasks.enabled")}
    </label>}
  </details>;
}

export function App() {
  const { locale, setLocale, t } = useLocale();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [conversationId, setConversationId] = useState(
    () => localStorage.getItem("opap.conversationId") ?? "",
  );
  const [conversationRegistryReady, setConversationRegistryReady] = useState(false);
  const [data, setData] = useState<ApiRecord>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingItem, setEditingItem] = useState<ApiRecord>();
  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>("pending");
  const [connectorApprovalMode, setConnectorApprovalMode] = useState<ConnectorApprovalMode>(
    storedConnectorApprovalMode,
  );
  const [workersAiActive, setWorkersAiActive] = useState(false);
  const [approvalToolQueries, setApprovalToolQueries] = useState<Record<string, string>>({});
  const [approvalToolSelections, setApprovalToolSelections] = useState<Record<string, string>>({});
  const [discordLinkCode, setDiscordLinkCode] = useState<ApiRecord>();
  const [discordCodeCopied, setDiscordCodeCopied] = useState(false);
  const [ownerTimeZone, setOwnerTimeZone] = useState(defaultTimeZone);
  const [ownerTimeZoneDraft, setOwnerTimeZoneDraft] = useState(defaultTimeZone);
  const [pluginInspection, setPluginInspection] = useState<ApiRecord>();
  const [pluginInvocationResults, setPluginInvocationResults] = useState<Record<string, ApiRecord>>({});
  const [openPluginTestId, setOpenPluginTestId] = useState("");
  const loadSequence = useRef(0);
  const preferencesLoaded = useRef(false);
  const conversationList = useRef<HTMLElement>(null);
  const request = useCallback(
    (path: string, init?: RequestInit) =>
      api(path, (status) => t("errors.requestFailed", { status }), init),
    [t],
  );

  const navigateTab = useCallback((nextTab: Tab) => {
    localStorage.setItem(lastTabStorageKey, nextTab);
    if (nextTab !== tab) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("tab", nextTab);
      window.history.pushState({ tab: nextTab }, "", nextUrl);
      setTab(nextTab);
    }
  }, [tab]);

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("tab") !== tab) {
      currentUrl.searchParams.set("tab", tab);
      window.history.replaceState({ tab }, "", currentUrl);
    }
    localStorage.setItem(lastTabStorageKey, tab);
    const restoreHistoryTab = () => {
      const requested = new URLSearchParams(window.location.search).get("tab");
      const restoredTab = isTab(requested) ? requested : "conversation";
      localStorage.setItem(lastTabStorageKey, restoredTab);
      setTab(restoredTab);
      setMobileMenuOpen(false);
    };
    window.addEventListener("popstate", restoreHistoryTab);
    return () => window.removeEventListener("popstate", restoreHistoryTab);
  }, []);

  useEffect(() => {
    if (preferencesLoaded.current) return;
    preferencesLoaded.current = true;
    let active = true;
    void request("/v1/settings/preferences").then((preferences) => {
      if (!active) return;
      if (isLocale(preferences["locale"])) setLocale(preferences["locale"]);
      if (typeof preferences["timeZone"] === "string") {
        setOwnerTimeZone(preferences["timeZone"]);
        setOwnerTimeZoneDraft(preferences["timeZone"]);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [request, setLocale]);

  const syncLatestConversation = useCallback(async () => {
    const registry = await request("/v1/conversations");
    const latest = rows(registry["conversations"])[0];
    const latestId = latest && typeof latest["conversationId"] === "string"
      ? latest["conversationId"] : "";
    if (!latestId) return;
    setConversationId((current) => {
      if (current === latestId) return current;
      localStorage.setItem("opap.conversationId", latestId);
      return latestId;
    });
  }, [request]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      let nextData: ApiRecord;
      if (!conversationRegistryReady &&
        (tab === "conversation" || tab === "tasks" || tab === "memory")) {
        if (sequence === loadSequence.current) setData({});
        return;
      }
      if (tab === "conversation") {
        nextData = conversationId
          ? await request(`/v1/conversations/${encodeURIComponent(conversationId)}`)
          : {};
      } else if (tab === "tasks") {
        const [tasks, preferences] = await Promise.all([
          conversationId ? request(`/v1/tasks?conversationId=${encodeURIComponent(conversationId)}`) : Promise.resolve({}),
          request("/v1/settings/preferences"),
        ]);
        if (sequence === loadSequence.current && typeof preferences["timeZone"] === "string") {
          setOwnerTimeZone(preferences["timeZone"]);
          setOwnerTimeZoneDraft(preferences["timeZone"]);
        }
        nextData = tasks;
      } else if (tab === "memory") {
        nextData = conversationId
          ? await request(`/v1/memories?conversationId=${encodeURIComponent(conversationId)}`)
          : {};
      } else if (tab === "approvals") {
        nextData = await request("/v1/approvals");
      } else if (tab === "audit") {
        nextData = await request("/v1/audit");
      } else if (tab === "providers") {
        nextData = await request("/v1/settings/providers");
      } else if (tab === "connections") {
        nextData = await request("/v1/connections");
      } else if (tab === "knowledge") {
        nextData = await request("/v1/delegated-sources");
      } else if (tab === "plugins") {
        nextData = await request("/v1/plugins");
      } else {
        const [policy, usage] = await Promise.all([
          request("/v1/settings/budgets"),
          request("/v1/usage?period=current-billing-cycle"),
        ]);
        nextData = { policy, usage };
      }
      if (sequence === loadSequence.current) setData(nextData);
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(localizedError(reason, t, "errors.load"));
      }
    }
  }, [conversationId, conversationRegistryReady, request, t, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void syncLatestConversation();
    };
    void syncLatestConversation().finally(() => setConversationRegistryReady(true));
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [syncLatestConversation]);

  useEffect(() => {
    if (tab !== "conversation" || !conversationId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [conversationId, load, tab]);

  useEffect(() => {
    void request("/v1/settings/providers").then((settings) => {
      setWorkersAiActive(rows(settings["providers"]).some((provider) =>
        provider["providerId"] === "provider:workers-ai" && provider["enabled"] === true));
    }).catch(() => setWorkersAiActive(false));
  }, [request]);

  useEffect(() => {
    if (tab !== "conversation") return;
    const element = conversationList.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [data, tab]);

  useEffect(() => {
    setEditingItem(undefined);
  }, [tab]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const optimisticMessageId = tab === "conversation" ? `optimistic:${crypto.randomUUID()}` : undefined;
    if (optimisticMessageId) {
      const content = formText(form, "content");
      setData((current) => ({
        ...current,
        messages: [...rows(current["messages"]), {
          messageId: optimisticMessageId,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
        }],
      }));
      formElement.reset();
    }
    setBusy(true);
    setError("");
    try {
      if (tab === "conversation") {
        const content = formText(form, "content");
        const created = await request(
          conversationId
            ? `/v1/conversations/${encodeURIComponent(conversationId)}/messages`
            : "/v1/conversations",
          {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ content }),
          },
        );
        if (!conversationId) {
          const id = display(created["conversationId"]);
          setConversationId(id);
          localStorage.setItem("opap.conversationId", id);
        }
        const assistant = typeof created["assistant"] === "object" && created["assistant"] !== null
          ? created["assistant"] as ApiRecord : {};
        const assistantContent = display(assistant["content"]);
        const approvalMatch = assistantContent.match(/\((approval:[0-9a-f-]{36})\)/u);
        const approvalId = approvalMatch?.[1];
        const isConnectorReadApproval = assistantContent.includes("Connector結果のクラウド送信");
        if (workersAiActive && approvalId && connectorApprovalMode === "auto-read" &&
          isConnectorReadApproval) {
          await request(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ decision: "approved" }),
          });
        } else if (workersAiActive && approvalId &&
          (connectorApprovalMode === "open" || connectorApprovalMode === "auto-read")) {
          navigateTab("approvals");
          return;
        }
      } else if (tab === "tasks") {
        const schedule = scheduleFromForm(form, ownerTimeZone);
        if (!schedule) throw new Error(t("errors.invalidTaskSchedule"));
        let taskConversationId = conversationId;
        if (!taskConversationId) {
          const createdConversation = await request("/v1/conversations", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: "{}",
          });
          taskConversationId = display(createdConversation["conversationId"]);
          if (!taskConversationId) throw new Error(t("errors.save"));
          setConversationId(taskConversationId);
          localStorage.setItem("opap.conversationId", taskConversationId);
        }
        await request("/v1/tasks", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId: taskConversationId,
            title: formText(form, "title"),
            description: formText(form, "description"),
            schedule,
            enabled: true,
          }),
        });
      } else if (tab === "memory") {
        await request("/v1/memories", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            key: formText(form, "key"),
            value: formText(form, "value"),
          }),
        });
      } else if (tab === "budget") {
        const unlimited = form.get("unlimited") === "on";
        const aiUnlimited = form.get("aiUnlimited") === "on";
        await request("/v1/settings/budgets", {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            nonAi: unlimited
              ? { mode: "unlimited" }
              : { mode: "included-fraction", fraction: Number(form.get("fraction")) / 100 },
            ai: { monthlyOverageUsd: aiUnlimited ? null : Number(form.get("aiBudget")) },
            pricingCatalogVersion: "cloudflare-2026-08",
          }),
        });
      } else if (tab === "providers") {
        const activeProviderId = formText(form, "providerId");
        const allowCloud = form.get("allowCloud") === "on";
        if (activeProviderId === "provider:workers-ai" && !allowCloud) {
          throw new Error(t("errors.cloudConsent"));
        }
        await request("/v1/settings/providers", {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            providers: [
              {
                providerId: "provider:mock-local",
                enabled: activeProviderId === "provider:mock-local",
                allowedVisibilities: ["owner"],
                allowedSensitivities: ["normal"],
              },
              {
                providerId: "provider:workers-ai",
                enabled: activeProviderId === "provider:workers-ai",
                allowedVisibilities: allowCloud ? ["owner"] : [],
                allowedSensitivities: allowCloud ? ["normal"] : [],
              },
            ],
          }),
        });
      }
      formElement.reset();
      await load();
    } catch (reason) {
      if (optimisticMessageId) {
        setData((current) => ({
          ...current,
          messages: rows(current["messages"]).filter((message) =>
            message["messageId"] !== optimisticMessageId),
        }));
      }
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      const result = await request(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ decision }),
      });
      if (result["capabilityId"] === "model.connector-results.send") {
        navigateTab("conversation");
        return;
      }
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.approval"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (approvalId: string, executionStatus: "succeeded" | "failed") => {
    const confirmationKey = executionStatus === "succeeded"
      ? "approvals.reconcileSucceededConfirm" : "approvals.reconcileFailedConfirm";
    if (!window.confirm(t(confirmationKey))) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ executionStatus }),
      });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.approval"));
    } finally {
      setBusy(false);
    }
  };

  const changeApprovalTool = async (item: ApiRecord) => {
    const approvalId = display(item["approvalId"]);
    const preview = typeof item["preview"] === "object" && item["preview"] !== null
      ? item["preview"] as ApiRecord : {};
    const current = Array.isArray(preview["toolIds"]) && typeof preview["toolIds"][0] === "string"
      ? preview["toolIds"][0] : "";
    const toolId = approvalToolSelections[approvalId] ?? current;
    if (!toolId || toolId === current) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/approvals/${encodeURIComponent(approvalId)}/tool`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ toolId }),
      });
      setApprovalToolQueries((values) => ({ ...values, [approvalId]: "" }));
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.approval"));
    } finally {
      setBusy(false);
    }
  };

  const connectGoogle = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request("/v1/connections/google/start", { method: "POST" });
      const authorizationUrl = display(result["authorizationUrl"]);
      if (!authorizationUrl) throw new Error(t("errors.connection"));
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
      setBusy(false);
    }
  };

  const connectGitHub = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request("/v1/connections/github/start", { method: "POST" });
      const authorizationUrl = display(result["authorizationUrl"]);
      if (!authorizationUrl) throw new Error(t("errors.connection"));
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
      setBusy(false);
    }
  };

  const disconnect = async (connectionId: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`/v1/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const connectDelegatedSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const provider = formText(form, "provider");
    const resourceIds = formText(form, "resourceIds").split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
    setBusy(true); setError("");
    try {
      const result = await request(`/v1/connections/delegated/${encodeURIComponent(provider)}/start`, {
        method: "POST", body: JSON.stringify({ resourceIds }),
      });
      const authorizationUrl = display(result["authorizationUrl"]);
      if (!authorizationUrl) throw new Error(t("errors.connection"));
      window.location.assign(authorizationUrl);
    } catch (reason) { setError(localizedError(reason, t, "errors.connection")); setBusy(false); }
  };

  const saveDelegatedSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const values = formText(form, "aclValues").split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
    const resourceIds = formText(form, "resourceIds").split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
    const sourceId = formText(form, "sourceId");
    const cloudAllowed = form.get("cloudAllowed") === "on";
    const [claim, operator] = formText(form, "aclRule").split(":");
    setBusy(true); setError("");
    try {
      await request("/v1/delegated-sources", { method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
          sourceId, sourceType: formText(form, "sourceType"), connectionId: formText(form, "connectionId"),
          resourceIds, acl: { issuer: formText(form, "issuer"), audience: formText(form, "audience"),
            rules: [{ claim, operator, values }] },
          informationPolicy: { subjectPrincipalIds: [], visibility: "delegated-principal",
            sensitivity: formText(form, "sensitivity"), trust: "external", allowedAudienceIds: [],
            allowedDestinationIds: cloudAllowed ? ["provider:workers-ai"] : [], retention: { mode: "none" } },
          cachePolicy: { enabled: form.get("cacheEnabled") === "on", ttlSeconds: Number(form.get("cacheTtl")) },
          sourceVersion: 1, enabled: true,
        }),
      });
      formElement.reset(); await load();
    } catch (reason) { setError(localizedError(reason, t, "errors.save")); }
    finally { setBusy(false); }
  };

  const disconnectDelegatedSource = async (connectionId: string) => {
    if (!window.confirm(t("knowledge.disconnectConfirm"))) return;
    setBusy(true); setError("");
    try {
      await request(`/v1/connections/delegated/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
      await load();
    } catch (reason) { setError(localizedError(reason, t, "errors.connection")); }
    finally { setBusy(false); }
  };

  const deleteDelegatedSource = async (sourceId: string) => {
    if (!window.confirm(t("knowledge.deleteConfirm"))) return;
    setBusy(true); setError("");
    try { await request(`/v1/delegated-sources/${encodeURIComponent(sourceId)}`, { method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() } }); await load(); }
    catch (reason) { setError(localizedError(reason, t, "errors.save")); }
    finally { setBusy(false); }
  };

  const toggleDelegatedSourceCache = async (source: ApiRecord) => {
    const sourceId = display(source["sourceId"]);
    const current = typeof source["cachePolicy"] === "object" && source["cachePolicy"] !== null
      ? source["cachePolicy"] as ApiRecord : {};
    setBusy(true); setError("");
    try {
      await request(`/v1/delegated-sources/${encodeURIComponent(sourceId)}`, { method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ ...source,
          cachePolicy: { enabled: current["enabled"] !== true,
            ttlSeconds: Number(current["ttlSeconds"] ?? 60) },
        }) });
      await load();
    } catch (reason) { setError(localizedError(reason, t, "errors.save")); }
    finally { setBusy(false); }
  };

  const createDiscordLinkCode = async () => {
    if (!conversationId) {
      setError(t("connections.discordConversationRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setDiscordCodeCopied(false);
    try {
      setDiscordLinkCode(await request("/v1/connections/discord/link-code", {
        method: "POST", body: JSON.stringify({ conversationId }),
      }));
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const copyDiscordLinkCode = async () => {
    const code = display(discordLinkCode?.["code"]);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setDiscordCodeCopied(true);
    } catch (reason) {
      setError(localizedError(reason, t, "connections.discordCopyFailed"));
    }
  };

  const syncDiscordCommands = async () => {
    setBusy(true);
    setError("");
    try {
      await request("/v1/connections/discord/commands/sync", { method: "POST" });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const disconnectDiscord = async () => {
    if (!window.confirm(t("connections.discordDisconnectConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      await request("/v1/connections/discord", { method: "DELETE" });
      setDiscordLinkCode(undefined);
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const saveOwnerTimeZone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const timeZone = formText(form, "ownerTimeZone");
    setBusy(true);
    setError("");
    try {
      const saved = await request("/v1/settings/preferences", { method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ timeZone }),
      });
      setOwnerTimeZone(display(saved["timeZone"], timeZone));
      setOwnerTimeZoneDraft(display(saved["timeZone"], timeZone));
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const saveOwnerLocale = async (nextLocale: Locale) => {
    const previousLocale = locale;
    setLocale(nextLocale);
    setBusy(true);
    setError("");
    try {
      const saved = await request("/v1/settings/preferences", { method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ locale: nextLocale }),
      });
      if (isLocale(saved["locale"])) setLocale(saved["locale"]);
    } catch (reason) {
      setLocale(previousLocale);
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const updateDiscordDestination = async (destination: ApiRecord,
    displayPolicy: string, commandPolicy: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`/v1/connections/discord/destinations/${encodeURIComponent(display(destination["destinationId"]))}`, {
        method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({
          guildId: destination["guildId"], channelId: destination["channelId"],
          displayPolicy, commandPolicy,
        }),
      });
      navigateTab("approvals");
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const revokeDiscordDestination = async (destinationId: string) => {
    if (!window.confirm(t("connections.discordDestinationRevokeConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/connections/discord/destinations/${encodeURIComponent(destinationId)}`, {
        method: "DELETE",
      });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.connection"));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingItem || !conversationId) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (tab === "tasks") {
        const taskId = display(editingItem["taskId"]);
        const schedule = scheduleFromForm(form, ownerTimeZone);
        if (!schedule) throw new Error(t("errors.invalidTaskSchedule"));
        await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            title: formText(form, "title"),
            description: formText(form, "description"),
            status: formText(form, "status"),
            schedule,
            enabled: form.get("taskEnabled") === "on",
          }),
        });
      } else if (tab === "memory") {
        await request("/v1/memories", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            key: display(editingItem["key"]),
            value: formText(form, "value"),
          }),
        });
      }
      setEditingItem(undefined);
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (item: ApiRecord) => {
    if (!conversationId || !window.confirm(t("items.deleteConfirm"))) return;
    const isTask = tab === "tasks";
    const id = display(isTask ? item["taskId"] : item["key"]);
    setBusy(true);
    setError("");
    try {
      await request(`/v1/${isTask ? "tasks" : "memories"}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ conversationId }),
      });
      if (editingItem === item) setEditingItem(undefined);
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const inspectPlugin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("archive");
    if (!(file instanceof File)) return;
    setBusy(true);
    setError("");
    try {
      setPluginInspection(await request("/v1/plugins/inspections", {
        method: "POST",
        headers: { "Content-Type": "application/gzip", "Idempotency-Key": crypto.randomUUID() },
        body: file,
      }));
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const installPlugin = async () => {
    const inspectionId = display(pluginInspection?.["inspectionId"]);
    if (!inspectionId) return;
    setBusy(true);
    setError("");
    try {
      await request("/v1/plugins", { method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ inspectionId }) });
      setPluginInspection(undefined);
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const invokePlugin = async (event: FormEvent<HTMLFormElement>, installationId: string) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let input: unknown;
    try {
      input = JSON.parse(formText(form, "input")) as unknown;
    } catch {
      setError(t("plugins.inputInvalid"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request(`/v1/plugins/${encodeURIComponent(installationId)}/invoke`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ toolId: formText(form, "toolId"), input }),
      });
      setPluginInvocationResults((current) => ({ ...current, [installationId]: result }));
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const updatePlugin = async (installationId: string) => {
    const inspectionId = display(pluginInspection?.["inspectionId"]);
    if (!inspectionId || !installationId) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/plugins/${encodeURIComponent(installationId)}/versions`, { method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ inspectionId }) });
      setPluginInspection(undefined);
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const rollbackPlugin = async (installationId: string, versionId: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`/v1/plugins/${encodeURIComponent(installationId)}/rollback`, { method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ versionId }) });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const setPluginEnabled = async (installationId: string, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await request(`/v1/plugins/${encodeURIComponent(installationId)}`, { method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ enabled }) });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const removePlugin = async (installationId: string) => {
    if (!window.confirm(t("plugins.removeConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/plugins/${encodeURIComponent(installationId)}`, { method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() } });
      await load();
    } catch (reason) {
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };


  const unfilteredCollection = tab === "tasks"
    ? rows(data["tasks"])
    : tab === "memory"
      ? rows(data["memories"])
      : tab === "approvals"
        ? rows(data["approvals"])
        : tab === "audit"
          ? rows(data["events"])
          : tab === "conversation"
            ? rows(data["messages"])
            : tab === "connections"
              ? rows(data["connections"]).filter((connection) => connection["status"] === "active")
            : [];
  const collection = tab === "approvals" && approvalFilter !== "all"
    ? unfilteredCollection.filter((approval) => approval["status"] === approvalFilter)
    : unfilteredCollection;
  const providerRows = rows(data["providers"]);
  const activeProviderId = display(
    providerRows.find((provider) => provider["enabled"] === true)?.["providerId"],
    "provider:mock-local",
  );
  const workersAiAllowed = providerRows.some((provider) =>
    provider["providerId"] === "provider:workers-ai" &&
    Array.isArray(provider["allowedVisibilities"]) &&
    provider["allowedVisibilities"].includes("owner")
  );
  const activeGoogleConnections = tab === "connections"
    ? collection.filter((connection) =>
        connection["providerId"] === "google" && connection["status"] === "active")
    : [];
  const activeGitHubConnections = tab === "connections"
    ? collection.filter((connection) =>
        connection["providerId"] === "github" && connection["status"] === "active")
    : [];
  const discord = typeof data["discord"] === "object" && data["discord"] !== null
    ? data["discord"] as ApiRecord : {};
  const discordLink = typeof discord["link"] === "object" && discord["link"] !== null
    ? discord["link"] as ApiRecord : undefined;
  const discordInstallUrls = typeof discord["installUrls"] === "object" && discord["installUrls"] !== null
    ? discord["installUrls"] as ApiRecord : {};
  const discordDestinations = rows(discord["destinations"]);
  const hasGuildDestination = discordDestinations.some((destination) => destination["kind"] === "guild-channel");
  const delegatedConnections = tab === "knowledge" ? rows(data["connections"])
    .filter((connection) => connection["status"] === "active") : [];
  const delegatedSources = tab === "knowledge" ? rows(data["sources"])
    .filter((source) => source["enabled"] !== false) : [];
  const plugins = tab === "plugins" ? rows(data["plugins"])
    .filter((plugin) => plugin["status"] !== "removed") : [];
  const activeTab = tabs.find((item) => item.id === tab);

  const budgetPolicy = record(data["policy"]);
  const nonAiBudgetPolicy = record(budgetPolicy["nonAi"]);
  const aiBudgetPolicy = record(budgetPolicy["ai"]);
  const budgetUsage = record(data["usage"]);
  const budgetResources = rows(budgetUsage["resources"]);
  const budgetAiUsage = record(budgetUsage["ai"]);

  return <div className="shell">
    <div className="brand mobile-brand">
      <span className="mark">OP</span>
      <div><strong>Open Personal Agent</strong><small>{t("brand.subtitle")}</small></div>
    </div>
    {mobileMenuOpen && <button className="mobile-menu-backdrop" aria-label={t("menu.close")}
      onClick={() => setMobileMenuOpen(false)} />}
    <button className="mobile-theme-toggle" type="button" role="switch" aria-checked={theme === "dark"}
      aria-label={theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
      onClick={toggleTheme}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button>
    <button className="mobile-menu-toggle" type="button" aria-expanded={mobileMenuOpen}
      aria-controls="owner-navigation" aria-label={t(mobileMenuOpen ? "menu.close" : "menu.open")}
      onClick={() => setMobileMenuOpen((open) => !open)}>
      <span className={`menu-icon ${mobileMenuOpen ? "close" : "hamburger"}`} aria-hidden="true" />
    </button>
    <aside id="owner-navigation" className={mobileMenuOpen ? "mobile-open" : ""}>
      <div className="brand sidebar-brand">
        <span className="mark">OP</span>
        <div><strong>Open Personal Agent</strong><small>{t("brand.subtitle")}</small></div>
      </div>
      <nav aria-label={t("app.navLabel")}>
        {tabs.map((item) =>
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => { navigateTab(item.id); setMobileMenuOpen(false); }}
          >
            {t(item.labelKey)}
          </button>
        )}
      </nav>
      <label className="locale-switch">
        <span>{t("language.label")}</span>
        <select
          value={locale}
          disabled={busy}
          onChange={(event) => { void saveOwnerLocale(event.currentTarget.value as Locale); }}
        >
          <option value="ja">{t("language.ja")}</option>
          <option value="en">{t("language.en")}</option>
        </select>
      </label>
      <div className="theme-switch">
        <span>{t("theme.label")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={theme === "dark"}
          aria-label={theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
          onClick={toggleTheme}
        >
          <span aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
          {theme === "dark" ? t("theme.dark") : t("theme.light")}
        </button>
      </div>
      <div className="status"><span />{t("app.connected")}</div>
    </aside>
    <main className={`workspace workspace-${tab}`}>
      <header>
        <div>
          <p className="eyebrow">{t("app.workspace")}</p>
          <h1>{activeTab ? t(activeTab.labelKey) : ""}</h1>
        </div>
        <button className="quiet" onClick={() => void load()}>{t("app.refresh")}</button>
      </header>
      {error && <div role="alert" className="error">{error}</div>}
      {tab === "conversation" &&
        <form onSubmit={(event) => { void submit(event); }} className="composer">
          <textarea
            name="content"
            required
            disabled={busy}
            aria-label={t("conversation.messageLabel")}
            placeholder={t("conversation.placeholder")}
            maxLength={32768}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!busy) event.currentTarget.form?.requestSubmit();
            }}
          />
          <small className="composer-hint">{t("conversation.keyboardHint")}</small>
          <div className="composer-actions">
            {workersAiActive && <select
              value={connectorApprovalMode}
              aria-label={t("conversation.approvalMode")}
              onChange={(event) => {
                const mode = event.currentTarget.value as ConnectorApprovalMode;
                setConnectorApprovalMode(mode);
                localStorage.setItem("opap.connectorApprovalMode", mode);
              }}
            >
              <option value="manual">{t("conversation.approvalManual")}</option>
              <option value="open">{t("conversation.approvalOpen")}</option>
              <option value="auto-read">{t("conversation.approvalAutoRead")}</option>
            </select>}
            <button disabled={busy}>
              {conversationId ? t("conversation.send") : t("conversation.create")}
            </button>
          </div>
        </form>}
      {tab === "approvals" && <div className="filter-bar">
        <label>{t("approvals.filter")}
          <select value={approvalFilter}
            onChange={(event) => setApprovalFilter(event.currentTarget.value as ApprovalFilter)}>
            <option value="all">{t("approvals.filterAll")}</option>
            <option value="pending">{t("approvals.filterPending")}</option>
            <option value="approved">{t("approvals.filterApproved")}</option>
          </select>
        </label>
      </div>}
      {tab === "connections" &&
        <>
          <section className="connection-actions">
            <div><strong>Google</strong><p>{t("connections.googleHelp")}</p></div>
            <button disabled={busy} onClick={() => void connectGoogle()}>
              {t(activeGoogleConnections.length > 0 ? "connections.addGoogleAccount" : "connections.connectGoogle")}
            </button>
          </section>
          <section className="connection-actions">
            <div><strong>GitHub</strong><p>{t("connections.githubHelp")}</p></div>
            <button disabled={busy} onClick={() => void connectGitHub()}>
              {t(activeGitHubConnections.length > 0 ? "connections.addGitHubAccount" : "connections.connectGitHub")}
            </button>
          </section>
          <section className="connection-actions discord-connection">
            <div>
              <strong>Discord</strong>
              <p>{t("connections.discordHelp")}</p>
              {discordLink && <p>{t("connections.discordLinkedUser")}: {display(
                discordLink["displayName"] ?? discordLink["discordUserId"],
              )}</p>}
              {discordLinkCode && <div className="link-code">
                <strong>{t("connections.discordLinkCode")}</strong>
                <div className="link-code-value">
                  <code>{display(discordLinkCode["code"])}</code>
                  <button type="button" className="quiet" onClick={() => void copyDiscordLinkCode()}>
                    {t(discordCodeCopied ? "connections.discordCodeCopied" : "connections.discordCopyCode")}
                  </button>
                </div>
                <small>{t("connections.discordLinkCodeExpiry")}: {display(discordLinkCode["expiresAt"])}</small>
              </div>}
              {discordDestinations.length > 0 && <div className="destination-list">
                {discordDestinations.map((destination) => <form key={display(destination["destinationId"])}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void updateDiscordDestination(destination,
                      formText(form, "displayPolicy"), formText(form, "commandPolicy"));
                  }}>
                  <span title={display(destination["channelId"])}>{destination["kind"] === "dm"
                    ? t("connections.discordDirectMessage")
                    : `${t("connections.discordGuildChannel")} ${shortenedIdentifier(destination["channelId"])}`}</span>
                  {destination["kind"] === "guild-channel" && <>
                    <select name="displayPolicy" defaultValue={display(destination["displayPolicy"])}>
                      <option value="metadata-only">metadata-only</option>
                      <option value="full-preview">full-preview</option>
                    </select>
                    <select name="commandPolicy" defaultValue={display(destination["commandPolicy"])}>
                      <option value="approved-only">approved-only</option>
                      <option value="owner-any">owner-any</option>
                      <option value="dm-only">dm-only</option>
                    </select>
                    <button disabled={busy}>{t("connections.discordRequestPolicyChange")}</button>
                  </>}
                  <button type="button" className="danger" disabled={busy}
                    onClick={() => void revokeDiscordDestination(display(destination["destinationId"]))}>
                    {t("connections.discordRevokeDestination")}
                  </button>
                </form>)}
              </div>}
            </div>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void syncDiscordCommands()}>
                {t("connections.discordSyncCommands")}
              </button>
              {!discordLink && <button type="button" disabled={busy || !conversationId}
                onClick={() => void createDiscordLinkCode()}>
                {t("connections.discordGenerateCode")}
              </button>}
              {((!discordLink && typeof discordInstallUrls["user"] === "string") ||
                (!hasGuildDestination && typeof discordInstallUrls["guild"] === "string")) &&
                <details className="install-options">
                  <summary>{t("connections.discordInstallOptions")}</summary>
                  <div>
                    {!discordLink && typeof discordInstallUrls["user"] === "string" &&
                      <a className="button-link" href={display(discordInstallUrls["user"])} target="_blank" rel="noreferrer">
                        {t("connections.discordUserInstall")}
                      </a>}
                    {!hasGuildDestination && typeof discordInstallUrls["guild"] === "string" &&
                      <a className="button-link" href={display(discordInstallUrls["guild"])} target="_blank" rel="noreferrer">
                        {t("connections.discordGuildInstall")}
                      </a>}
                  </div>
                </details>}
              {discordLink && <button type="button" className="danger" disabled={busy}
                onClick={() => void disconnectDiscord()}>{t("connections.disconnect")}</button>}
            </div>
          </section>
        </>}
      {tab === "knowledge" && <>
        <form className="memory-form" onSubmit={(event) => { void connectDelegatedSource(event); }}>
          <strong>{t("knowledge.connectTitle")}</strong>
          <label>{t("knowledge.provider")}<select name="provider"><option value="google">{t("knowledge.googleDrive")}</option>
            <option value="github">{t("knowledge.github")}</option></select></label>
          <label>{t("knowledge.resourceIds")}<textarea name="resourceIds" required
            placeholder={t("knowledge.resourceIdsHelp")} /></label>
          <button disabled={busy}>{t("knowledge.connect")}</button>
        </form>
        <form className="memory-form" onSubmit={(event) => { void saveDelegatedSource(event); }}>
          <strong>{t("knowledge.createTitle")}</strong>
          <label>{t("knowledge.sourceId")}<input name="sourceId" required placeholder="source:delegated-docs" /></label>
          <label>{t("knowledge.type")}<select name="sourceType"><option value="google-drive">{t("knowledge.googleDrive")}</option>
            <option value="github">{t("knowledge.github")}</option></select></label>
          <label>{t("knowledge.connection")}<select name="connectionId" required>
            <option value="">—</option>{delegatedConnections.map((connection) =>
              <option key={display(connection["connectionId"])} value={display(connection["connectionId"])}>
                {knowledgeProviderLabel(connection["providerId"], t)} · {display(connection["accountLabel"])}</option>)}</select></label>
          <label>{t("knowledge.resourceIds")}<textarea name="resourceIds" required /></label>
          <label>{t("knowledge.issuer")}<input name="issuer" type="url" required /></label>
          <label>{t("knowledge.audience")}<input name="audience" required /></label>
          <label>{t("knowledge.rule")}<select name="aclRule"><option value="subject:equals">{t("knowledge.subjectEquals")}</option>
            <option value="subject:in">{t("knowledge.subjectIn")}</option><option value="email:equals">{t("knowledge.emailEquals")}</option>
            <option value="email:domain">{t("knowledge.emailDomain")}</option><option value="group:in">{t("knowledge.groupIn")}</option></select></label>
          <label>{t("knowledge.values")}<textarea name="aclValues" required /></label>
          <label>{t("knowledge.sensitivity")}<select name="sensitivity"><option value="normal">{t("knowledge.normal")}</option>
            <option value="sensitive">{t("knowledge.sensitive")}</option><option value="secret">{t("knowledge.secret")}</option></select></label>
          <label className="check"><input name="cloudAllowed" type="checkbox" />{t("knowledge.cloudAllowed")}</label>
          <label className="check"><input name="cacheEnabled" type="checkbox" />{t("knowledge.cache")}</label>
          <label>{t("knowledge.cacheTtl")}<input name="cacheTtl" type="number" min="1" max="60" defaultValue="60" /></label>
          <button disabled={busy || delegatedConnections.length === 0}>{t("knowledge.save")}</button>
        </form>
        <section className="cards">{delegatedConnections.map((connection) =>
          <article key={display(connection["connectionId"])}><div>
            <strong>{knowledgeProviderLabel(connection["providerId"], t)}</strong>
            <p>{display(connection["accountLabel"], display(connection["connectionId"]))}</p></div>
            <button className="danger" disabled={busy}
              onClick={() => void disconnectDelegatedSource(display(connection["connectionId"]))}>
              {t("connections.disconnect")}</button></article>)}</section>
        <section className="cards">{delegatedSources.length === 0 ? <div className="empty"><strong>{t("empty.title")}</strong></div>
          : delegatedSources.map((source) => <article className="knowledge-source-card" key={display(source["sourceId"])}>
            <details><summary><span><strong>{display(source["sourceId"])}</strong>
              <small>{knowledgeProviderLabel(source["sourceType"], t)} · v{display(source["sourceVersion"])} · {t("knowledge.cacheState")}: {
                typeof source["cachePolicy"] === "object" && source["cachePolicy"] !== null &&
                (source["cachePolicy"] as ApiRecord)["enabled"] === true ? t("knowledge.enabled") : t("knowledge.disabled")}</small>
            </span><span className="details-label">{t("knowledge.details")}</span></summary>
              <div className="knowledge-source-details">
                <div className="resource-list"><span>{t("knowledge.resources")}</span>
                  {stringItems(source["resourceIds"]).length === 0 ? <strong>—</strong> :
                    <ul>{stringItems(source["resourceIds"]).map((resourceId) => <li key={resourceId}>{resourceId}</li>)}</ul>}
                </div>
                <div className="inline-actions"><button disabled={busy}
                  onClick={() => void toggleDelegatedSourceCache(source)}>{t("knowledge.toggleCache")}</button>
                <button className="danger" disabled={busy} onClick={() => void deleteDelegatedSource(display(source["sourceId"]))}>
                  {t("items.delete")}</button></div>
              </div>
            </details></article>)}</section>
      </>}
      {tab === "plugins" && <>
        <form className="memory-form" onSubmit={(event) => { void inspectPlugin(event); }}>
          <strong>{t("plugins.inspectTitle")}</strong>
          <p>{t("plugins.experimentalHelp")}</p>
          <label>{t("plugins.archive")}<input name="archive" type="file"
            accept="application/gzip,.tgz" required /></label>
          <button disabled={busy}>{t("plugins.inspect")}</button>
        </form>
        {pluginInspection && <section className="connection-actions"><div>
          <strong>{display((pluginInspection["manifest"] as ApiRecord | undefined)?.["id"])}</strong>
          <p>{t("plugins.inspectionAccepted")} · {display(pluginInspection["archiveSha256"])}</p>
          <small>{t("plugins.expires")}: {display(pluginInspection["expiresAt"])}</small>
        </div><div className="actions"><button disabled={busy} onClick={() => void installPlugin()}>{t("plugins.install")}</button>
          {plugins.map((plugin) => <button key={display(plugin["installationId"])} disabled={busy}
            onClick={() => void updatePlugin(display(plugin["installationId"]))}>
            {t("plugins.update")} {display(plugin["pluginId"])}</button>)}</div></section>}
        <section className="cards">{plugins.length === 0
          ? <div className="empty"><strong>{t("empty.title")}</strong></div>
          : plugins.map((plugin) => {
            const installationId = display(plugin["installationId"]);
            const tools = rows(record(plugin["manifest"])["tools"]);
            return <article key={installationId} className="plugin-card"><div>
            <strong>{display(plugin["pluginId"])}</strong>
            <p>v{display(plugin["version"])} · {display(plugin["status"])}</p>
            <small>{t("plugins.capabilities")}: {Array.isArray(plugin["grantedCapabilityIds"])
              ? plugin["grantedCapabilityIds"].join(", ") || t("plugins.none") : t("plugins.none")}</small>
            {rows(plugin["versions"]).filter((version) => version["status"] === "superseded")
              .map((version) => <button key={display(version["versionId"])} className="quiet" disabled={busy}
                onClick={() => void rollbackPlugin(display(plugin["installationId"]), display(version["versionId"]))}>
                {t("plugins.rollback")} v{display(version["version"])}</button>)}
          </div><div className="inline-actions">
            {plugin["status"] === "active" && tools.length > 0 && <button type="button" disabled={busy}
              aria-expanded={openPluginTestId === installationId}
              onClick={() => setOpenPluginTestId((current) => current === installationId ? "" : installationId)}>
              {t("plugins.runTool")}
            </button>}
            <button disabled={busy} onClick={() => void setPluginEnabled(installationId,
              plugin["status"] !== "active")}>{t(plugin["status"] === "active" ? "plugins.disable" : "plugins.enable")}</button>
            <button className="danger" disabled={busy}
              onClick={() => void removePlugin(installationId)}>{t("items.delete")}</button>
          </div>
          {openPluginTestId === installationId && plugin["status"] === "active" && tools.length > 0 &&
            <form className="plugin-invoke-form plugin-invoke-expanded"
              onSubmit={(event) => { void invokePlugin(event, installationId); }}>
              <label>{t("plugins.tool")}<select name="toolId" required>{tools.map((tool) =>
                <option key={display(tool["id"])} value={display(tool["id"])}>{display(tool["id"])}</option>)}</select></label>
              <label>{t("plugins.input")}<textarea name="input" defaultValue="{}" spellCheck={false} required /></label>
              <button disabled={busy}>{t("plugins.run")}</button>
              {pluginInvocationResults[installationId] && <div className="plugin-result">
                <strong>{t("plugins.result")}</strong>
                <StructuredValue value={pluginInvocationResults[installationId]} />
              </div>}
            </form>}
          </article>;
          })}</section>
      </>}
      {tab === "tasks" &&
        <>
        <form onSubmit={(event) => { void saveOwnerTimeZone(event); }} className="memory-form compact-form">
          <label>{t("tasks.ownerTimeZone")}
            <input name="ownerTimeZone" value={ownerTimeZoneDraft}
              onChange={(event) => setOwnerTimeZoneDraft(event.currentTarget.value)} list="common-time-zones" required />
          </label>
          <datalist id="common-time-zones">
            {timeZoneOptions.map((timeZone) =>
              <option key={timeZone} value={timeZone}
                label={timeZone.startsWith("+") || timeZone.startsWith("-") ? `UTC${timeZone}` : timeZone} />)}
          </datalist>
          <button disabled={busy}>{t("tasks.saveTimeZone")}</button>
        </form>
        <form onSubmit={(event) => { void submit(event); }} className="memory-form">
          <input name="title" required maxLength={500} placeholder={t("tasks.placeholder")} />
          <textarea name="description" required maxLength={32768} placeholder={t("tasks.descriptionPlaceholder")} />
          <TaskScheduleFields t={t} ownerTimeZone={ownerTimeZone} />
          <button disabled={busy}>{t("tasks.add")}</button>
        </form></>}
      {tab === "memory" &&
        <form onSubmit={(event) => { void submit(event); }} className="memory-form">
          <input name="key" required maxLength={200} placeholder={t("memory.keyPlaceholder")} />
          <textarea name="value" maxLength={32768} placeholder={t("memory.valuePlaceholder")} />
          <button disabled={busy || !conversationId}>{t("memory.save")}</button>
        </form>}
      {(tab === "tasks" || tab === "memory") && editingItem &&
        <form onSubmit={(event) => { void saveEdit(event); }} className="memory-form edit-form">
          <strong>{t(tab === "tasks" ? "tasks.editTitle" : "memory.editTitle")}</strong>
          {tab === "tasks"
            ? <>
                <input name="title" required maxLength={500} defaultValue={display(editingItem["title"])} />
                <textarea name="description" required maxLength={32768}
                  defaultValue={display(editingItem["description"])} />
                <select name="status" defaultValue={display(editingItem["status"], "pending")}>
                  <option value="pending">{t("tasks.statusPending")}</option>
                  <option value="in-progress">{t("tasks.statusInProgress")}</option>
                  <option value="completed">{t("tasks.statusCompleted")}</option>
                </select>
                <TaskScheduleFields item={editingItem} t={t} ownerTimeZone={ownerTimeZone} />
              </>
            : <>
                <label>{t("memory.keyLabel")}<input value={display(editingItem["key"])} disabled /></label>
                <textarea name="value" maxLength={32768} defaultValue={display(editingItem["value"])} />
              </>}
          <div className="actions">
            <button disabled={busy}>{t("items.save")}</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setEditingItem(undefined)}>
              {t("items.cancel")}
            </button>
          </div>
        </form>}
      {tab === "budget"
        ? <>
            <form key={JSON.stringify(budgetPolicy)} onSubmit={(event) => { void submit(event); }} className="memory-form budget-form">
              <label>{t("budget.nonAiHardLimit")}<input name="fraction" type="number" min="10" max="100"
                defaultValue={typeof nonAiBudgetPolicy["fraction"] === "number" ? nonAiBudgetPolicy["fraction"] * 100 : 80} /></label>
              <label className="check"><input name="unlimited" type="checkbox"
                defaultChecked={nonAiBudgetPolicy["mode"] === "unlimited"} />{t("budget.disableNonAiStop")}</label>
              <label>{t("budget.aiMonthlyOverage")}<input name="aiBudget" type="number" min="0" step="0.5"
                defaultValue={typeof aiBudgetPolicy["monthlyOverageUsd"] === "number" ? aiBudgetPolicy["monthlyOverageUsd"] : 5} /></label>
              <label className="check"><input name="aiUnlimited" type="checkbox"
                defaultChecked={aiBudgetPolicy["monthlyOverageUsd"] === null} />{t("budget.unlimitedAi")}</label>
              <p className="warning">{t("budget.safetyWarning")}</p>
              <button disabled={busy}>{t("budget.update")}</button>
            </form>
            <section className="budget-summary">
              <div className="summary-grid">
                <article><small>{t("budget.nonAiPolicy")}</small><strong>{nonAiBudgetPolicy["mode"] === "unlimited"
                  ? t("budget.unlimited") : `${localizedNumber(
                    typeof nonAiBudgetPolicy["fraction"] === "number" ? nonAiBudgetPolicy["fraction"] * 100 : undefined,
                    locale)}%`}</strong></article>
                <article><small>{t("budget.aiPolicy")}</small><strong>{aiBudgetPolicy["monthlyOverageUsd"] === null
                  ? t("budget.unlimited") : `$${localizedNumber(aiBudgetPolicy["monthlyOverageUsd"], locale)}`}</strong></article>
                <article><small>{t("budget.billingPeriod")}</small><strong>{display(budgetUsage["currentPeriod"], "—")}</strong></article>
                <article><small>{t("budget.catalog")}</small><strong>{display(budgetPolicy["pricingCatalogVersion"], "—")}</strong></article>
              </div>
              <h2>{t("budget.resourceUsage")}</h2>
              <div className="table-scroll"><table><thead><tr><th>{t("budget.resource")}</th><th>{t("budget.used")}</th>
                <th>{t("budget.reserved")}</th><th>{t("budget.hardLimit")}</th><th>{t("budget.mode")}</th></tr></thead>
                <tbody>{budgetResources.map((resource) => <tr key={display(resource["resource"])}>
                  <td>{display(resource["resource"])}</td><td>{localizedNumber(resource["used"], locale)}</td>
                  <td>{localizedNumber(resource["reserved"], locale)}</td><td>{localizedNumber(resource["hardLimit"], locale)}</td>
                  <td>{display(resource["mode"], "—")}</td></tr>)}</tbody></table></div>
              {Object.keys(budgetAiUsage).length > 0 && <div className="ai-usage">
                <strong>{t("budget.aiUsage")}</strong>
                <span>{t("budget.neurons")}: {localizedNumber(budgetAiUsage["used"], locale)}</span>
                <span>{t("budget.overageUsed")}: ${localizedNumber(budgetAiUsage["overageUsedUsd"], locale)}</span>
              </div>}
            </section>
          </>
          : tab === "providers" || tab === "knowledge"
          ? null
          : <section
              className={`cards${tab === "conversation" ? " conversation-list" : ""}`}
              aria-live="polite"
              ref={tab === "conversation" ? conversationList : undefined}
            >
              {collection.length === 0
                ? <div className="empty">
                    <strong>{t("empty.title")}</strong>
                    <span>{t("empty.body")}</span>
                  </div>
                : collection.map((item, index) =>
                    <article className={tab === "approvals" ? "approval-card" : undefined} key={display(
                      item["taskId"] ?? item["key"] ?? item["approvalId"] ?? item["connectionId"] ??
                        item["eventId"] ?? item["messageId"],
                      String(index),
                    )}>
                      <div>
                        {tab === "connections"
                          ? <>
                              <strong>{t("connections.destination")}: {display(item["providerId"], t("connections.unknownService"))}</strong>
                              <p>{t("connections.account")}: {display(
                                item["accountLabel"] ?? item["connectionId"],
                                t("connections.unknownAccount"),
                              )}</p>
                            </>
                          : tab === "tasks"
                            ? <>
                                <strong>{display(item["title"], t("item.fallback"))}</strong>
                                <p>{display(item["description"], t("tasks.noDescription"))}</p>
                                <small>{t("tasks.statusLabel")}: {display(item["status"])}</small>
                                {typeof item["nextRunAt"] === "string" &&
                                  <small>{t("tasks.nextRunAt")}: {new Date(item["nextRunAt"]).toLocaleString(locale)}</small>}
                                {typeof item["lastRunAt"] === "string" &&
                                  <small>{t("tasks.lastRunAt")}: {new Date(item["lastRunAt"]).toLocaleString(locale)} · {
                                    display(item["lastRunStatus"])}</small>}
                              </>
                            : <>
                              <strong>{display(
                                item["title"] ?? item["key"] ?? item["eventType"] ??
                                  item["capabilityId"] ?? item["role"],
                                t("item.fallback"),
                              )}</strong>
                              <p>{display(item["value"] ?? item["content"] ?? item["status"] ?? item["outcome"])}
                                {tab === "approvals" && typeof item["executionStatus"] === "string" &&
                                  ` · ${t(item["executionStatus"] === "succeeded"
                                    ? "approvals.executionSucceeded"
                                    : item["executionStatus"] === "failed"
                                      ? "approvals.executionFailed"
                                      : item["executionStatus"] === "unknown"
                                        ? "approvals.executionUnknown"
                                        : "approvals.executionPending")}`}
                              </p>
                              {tab === "approvals" && typeof item["executionErrorCode"] === "string" &&
                                <small>{item["executionErrorCode"]}</small>}
                              {tab === "approvals" && item["status"] === "pending" &&
                                item["capabilityId"] === "model.connector-results.send" && (() => {
                                  const approvalId = display(item["approvalId"]);
                                  const preview = typeof item["preview"] === "object" && item["preview"] !== null
                                    ? item["preview"] as ApiRecord : {};
                                  const available = Array.isArray(preview["availableToolIds"])
                                    ? preview["availableToolIds"].filter((tool): tool is string => typeof tool === "string")
                                    : [];
                                  const current = Array.isArray(preview["toolIds"]) &&
                                    typeof preview["toolIds"][0] === "string" ? preview["toolIds"][0] : "";
                                  const query = approvalToolQueries[approvalId] ?? "";
                                  const visible = available.filter((tool) =>
                                    tool.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
                                  return available.length > 0 && <div className="approval-tool-picker">
                                    <input type="search" value={query} placeholder={t("approvals.toolSearch")}
                                      onChange={(event) => setApprovalToolQueries((values) =>
                                        ({ ...values, [approvalId]: event.currentTarget.value }))} />
                                    <select value={approvalToolSelections[approvalId] ?? current}
                                      aria-label={t("approvals.toolSelection")}
                                      onChange={(event) => setApprovalToolSelections((values) =>
                                        ({ ...values, [approvalId]: event.currentTarget.value }))}>
                                      {!visible.includes(approvalToolSelections[approvalId] ?? current) &&
                                        <option value={approvalToolSelections[approvalId] ?? current}>
                                          {approvalToolSelections[approvalId] ?? current}
                                        </option>}
                                      {visible.map((tool) => <option key={tool} value={tool}>{tool}</option>)}
                                    </select>
                                    <button type="button" className="quiet" disabled={busy ||
                                      (approvalToolSelections[approvalId] ?? current) === current}
                                      onClick={() => void changeApprovalTool(item)}>
                                      {t("approvals.changeTool")}
                                    </button>
                                  </div>;
                                })()}
                              {tab === "approvals" && typeof item["preview"] === "object" &&
                                item["preview"] !== null &&
                                <div className="structured-panel"><StructuredValue value={item["preview"]} /></div>}
                              </>}
                      </div>
                      {tab === "approvals" && item["status"] === "pending" &&
                        <div className="actions">
                          <button disabled={busy} onClick={() => void decide(String(item["approvalId"]), "approved")}>
                            {t("approvals.approve")}
                          </button>
                          <button className="danger" disabled={busy} onClick={() => void decide(String(item["approvalId"]), "rejected")}>
                            {t("approvals.reject")}
                          </button>
                        </div>}
                      {tab === "approvals" && item["executionStatus"] === "unknown" &&
                        <div className="actions">
                          <button disabled={busy} onClick={() => void reconcile(
                            String(item["approvalId"]), "succeeded")}>{t("approvals.confirmExecuted")}</button>
                          <button className="danger" disabled={busy} onClick={() => void reconcile(
                            String(item["approvalId"]), "failed")}>{t("approvals.confirmNotExecuted")}</button>
                        </div>}
                      {(tab === "tasks" || tab === "memory") &&
                        <div className="actions">
                          <button disabled={busy} onClick={() => setEditingItem(item)}>{t("items.edit")}</button>
                          <button className="danger" disabled={busy} onClick={() => void deleteItem(item)}>
                            {t("items.delete")}
                          </button>
                        </div>}
                      {tab === "connections" && item["status"] === "active" &&
                        <div className="actions">
                          <button className="danger" disabled={busy} onClick={() => void disconnect(display(item["connectionId"]))}>
                            {t("connections.disconnect")}
                          </button>
                        </div>}
                    </article>
                  )}
            </section>}
      {tab === "providers" && <>
        <form
          key={`${activeProviderId}:${workersAiAllowed}`}
          onSubmit={(event) => { void submit(event); }}
          className="memory-form budget-form"
        >
          <label>{t("providers.label")}
            <select name="providerId" defaultValue={activeProviderId}>
              <option value="provider:mock-local">{t("providers.mockLocal")}</option>
              <option value="provider:workers-ai">{t("providers.workersAi")}</option>
            </select>
          </label>
          <label className="check">
            <input name="allowCloud" type="checkbox" defaultChecked={workersAiAllowed} />
            {t("providers.allowNormal")}
          </label>
          <p className="warning">{t("providers.warning")}</p>
          <button disabled={busy}>{t("providers.update")}</button>
        </form>
        <section className="provider-summary cards">
          {providerRows.map((provider) => <article key={display(provider["providerId"])}>
            <div>
              <strong>{modelProviderLabel(provider["providerId"], t)}</strong>
              <p>{provider["enabled"] === true ? t("providers.enabled") : t("providers.disabled")}</p>
              <div className="provider-permissions">
                <span>{t("providers.visibility")}</span>
                <ul>{stringItems(provider["allowedVisibilities"]).map((item) =>
                  <li key={item}>{modelPolicyLabel(item, t)}</li>)}</ul>
              </div>
              <div className="provider-permissions">
                <span>{t("providers.sensitivity")}</span>
                <ul>{stringItems(provider["allowedSensitivities"]).map((item) =>
                  <li key={item}>{modelPolicyLabel(item, t)}</li>)}</ul>
              </div>
            </div>
          </article>)}
        </section>
      </>}
    </main>
  </div>;
}
