import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, type Locale, type Translate } from "./i18n.js";
import type { MessageKey } from "./locales/en.js";
import { useTheme } from "./theme.js";

type Tab = "conversation" | "tasks" | "memory" | "approvals" | "audit" | "providers" | "budget" | "connections";
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
    const title = typeof value === "object" && value !== null
      ? (value as ApiRecord)["title"]
      : undefined;
    throw new Error(typeof title === "string" ? title : requestFailed(response.status));
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

const localizedError = (reason: unknown, t: Translate, fallback: MessageKey): string =>
  reason instanceof Error ? reason.message : t(fallback);

export function App() {
  const { locale, setLocale, t } = useLocale();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("conversation");
  const [conversationId, setConversationId] = useState(
    () => localStorage.getItem("opap.conversationId") ?? "",
  );
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
  const loadSequence = useRef(0);
  const conversationList = useRef<HTMLElement>(null);
  const request = useCallback(
    (path: string, init?: RequestInit) =>
      api(path, (status) => t("errors.requestFailed", { status }), init),
    [t],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      let nextData: ApiRecord;
      if (tab === "conversation") {
        nextData = conversationId
          ? await request(`/v1/conversations/${encodeURIComponent(conversationId)}`)
          : {};
      } else if (tab === "tasks" || tab === "memory") {
        const resource = tab === "memory" ? "memories" : "tasks";
        nextData = conversationId
          ? await request(`/v1/${resource}?conversationId=${encodeURIComponent(conversationId)}`)
          : {};
      } else if (tab === "approvals") {
        nextData = await request("/v1/approvals");
      } else if (tab === "audit") {
        nextData = await request("/v1/audit");
      } else if (tab === "providers") {
        nextData = await request("/v1/settings/providers");
      } else if (tab === "connections") {
        nextData = await request("/v1/connections");
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
  }, [conversationId, request, t, tab]);

  useEffect(() => {
    void load();
  }, [load]);

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
          setTab("approvals");
          return;
        }
      } else if (tab === "tasks") {
        await request("/v1/tasks", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            title: formText(form, "title"),
            description: formText(form, "description"),
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
        setTab("conversation");
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

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingItem || !conversationId) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (tab === "tasks") {
        const taskId = display(editingItem["taskId"]);
        await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            title: formText(form, "title"),
            description: formText(form, "description"),
            status: formText(form, "status"),
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
  const activeTab = tabs.find((item) => item.id === tab);

  return <div className="shell">
    <aside>
      <div className="brand">
        <span className="mark">OP</span>
        <div><strong>Open Personal Agent</strong><small>{t("brand.subtitle")}</small></div>
      </div>
      <nav aria-label={t("app.navLabel")}>
        {tabs.map((item) =>
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        )}
      </nav>
      <label className="locale-switch">
        <span>{t("language.label")}</span>
        <select
          value={locale}
          onChange={(event) => setLocale(event.currentTarget.value as Locale)}
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
    <main>
      <header>
        <div>
          <p className="eyebrow">{t("app.workspace")}</p>
          <h1>{activeTab ? t(activeTab.labelKey) : ""}</h1>
        </div>
        <button className="quiet" onClick={() => void load()}>{t("app.refresh")}</button>
      </header>
      {error && <div role="alert" className="error">{error}</div>}
      {(tab === "conversation" || tab === "tasks" || tab === "memory") &&
        <p className="context">
          {t("conversation.context")} <code>{conversationId || t("conversation.notCreated")}</code>
        </p>}
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
        </>}
      {tab === "tasks" &&
        <form onSubmit={(event) => { void submit(event); }} className="memory-form">
          <input name="title" required maxLength={500} placeholder={t("tasks.placeholder")} />
          <textarea name="description" required maxLength={32768} placeholder={t("tasks.descriptionPlaceholder")} />
          <button disabled={busy || !conversationId}>{t("tasks.add")}</button>
        </form>}
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
            <form onSubmit={(event) => { void submit(event); }} className="memory-form budget-form">
              <label>{t("budget.nonAiHardLimit")}<input name="fraction" type="number" min="10" max="100" defaultValue="80" /></label>
              <label className="check"><input name="unlimited" type="checkbox" />{t("budget.disableNonAiStop")}</label>
              <label>{t("budget.aiMonthlyOverage")}<input name="aiBudget" type="number" min="0" step="0.5" defaultValue="5" /></label>
              <label className="check"><input name="aiUnlimited" type="checkbox" />{t("budget.unlimitedAi")}</label>
              <p className="warning">{t("budget.safetyWarning")}</p>
              <button disabled={busy}>{t("budget.update")}</button>
            </form>
            <pre className="policy">{JSON.stringify(data, null, 2)}</pre>
          </>
        : tab === "providers"
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
                    <article key={display(
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
                                <pre className="policy">{JSON.stringify(item["preview"], null, 2)}</pre>}
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
        <pre className="policy">{JSON.stringify(data, null, 2)}</pre>
      </>}
    </main>
  </div>;
}
