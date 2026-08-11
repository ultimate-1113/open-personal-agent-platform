import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, type Locale, type Translate } from "./i18n.js";
import type { MessageKey } from "./locales/en.js";
import { useTheme } from "./theme.js";

type Tab = "conversation" | "tasks" | "memory" | "approvals" | "audit" | "providers" | "budget" | "connections";
type ApiRecord = Record<string, unknown>;

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
  const loadSequence = useRef(0);
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
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
      } else if (tab === "tasks") {
        await request("/v1/tasks", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ conversationId, title: formText(form, "title") }),
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
      setError(localizedError(reason, t, "errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await request(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ decision }),
      });
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

  const collection = tab === "tasks"
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
              ? rows(data["connections"])
            : [];
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
            aria-label={t("conversation.messageLabel")}
            placeholder={t("conversation.placeholder")}
            maxLength={32768}
          />
          <button disabled={busy}>
            {conversationId ? t("conversation.send") : t("conversation.create")}
          </button>
        </form>}
      {tab === "connections" &&
        <section className="connection-actions">
          <div><strong>Google</strong><p>{t("connections.googleHelp")}</p></div>
          <button disabled={busy} onClick={() => void connectGoogle()}>
            {t("connections.connectGoogle")}
          </button>
        </section>}
      {tab === "tasks" &&
        <form onSubmit={(event) => { void submit(event); }} className="inline-form">
          <input name="title" required maxLength={500} placeholder={t("tasks.placeholder")} />
          <button disabled={busy || !conversationId}>{t("tasks.add")}</button>
        </form>}
      {tab === "memory" &&
        <form onSubmit={(event) => { void submit(event); }} className="memory-form">
          <input name="key" required maxLength={200} placeholder={t("memory.keyPlaceholder")} />
          <textarea name="value" maxLength={32768} placeholder={t("memory.valuePlaceholder")} />
          <button disabled={busy || !conversationId}>{t("memory.save")}</button>
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
          : <section className="cards" aria-live="polite">
              {collection.length === 0
                ? <div className="empty">
                    <strong>{t("empty.title")}</strong>
                    <span>{t("empty.body")}</span>
                  </div>
                : collection.map((item, index) =>
                    <article key={display(
                      item["taskId"] ?? item["key"] ?? item["approvalId"] ??
                        item["eventId"] ?? item["messageId"],
                      String(index),
                    )}>
                      <div>
                        <strong>{display(
                          item["title"] ?? item["key"] ?? item["eventType"] ??
                            item["capabilityId"] ?? item["role"],
                          t("item.fallback"),
                        )}</strong>
                        <p>{display(item["value"] ?? item["content"] ?? item["status"] ?? item["outcome"])}</p>
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
                      {tab === "connections" && item["status"] === "active" &&
                        <div className="actions">
                          <button className="danger" disabled={busy} onClick={() => void disconnect(display(item["connection_id"]))}>
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
