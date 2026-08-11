import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type Tab = "conversation" | "tasks" | "memory" | "approvals" | "audit" | "providers" | "budget";
type ApiRecord = Record<string, unknown>;

const tabs: readonly { id: Tab; label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
  { id: "approvals", label: "Approvals" },
  { id: "audit", label: "Audit" },
  { id: "providers", label: "Models" },
  { id: "budget", label: "Budget" },
];

const api = async (path: string, init?: RequestInit): Promise<ApiRecord> => {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const title = typeof value === "object" && value !== null
      ? (value as ApiRecord)["title"]
      : undefined;
    throw new Error(typeof title === "string" ? title : `Request failed (${response.status})`);
  }
  return typeof value === "object" && value !== null ? value as ApiRecord : {};
};

const rows = (value: unknown): ApiRecord[] =>
  Array.isArray(value) ? value.filter((item): item is ApiRecord => typeof item === "object" && item !== null) : [];

const formText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const display = (value: unknown, fallback = ""): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;

export function App() {
  const [tab, setTab] = useState<Tab>("conversation");
  const [conversationId, setConversationId] = useState(() => localStorage.getItem("opap.conversationId") ?? "");
  const [data, setData] = useState<ApiRecord>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      let nextData: ApiRecord;
      if (tab === "conversation") {
        nextData = conversationId ? await api(`/v1/conversations/${encodeURIComponent(conversationId)}`) : {};
      } else if (tab === "tasks" || tab === "memory") {
        const resource = tab === "memory" ? "memories" : "tasks";
        nextData = conversationId ? await api(`/v1/${resource}?conversationId=${encodeURIComponent(conversationId)}`) : {};
      } else if (tab === "approvals") nextData = await api("/v1/approvals");
      else if (tab === "audit") nextData = await api("/v1/audit");
      else if (tab === "providers") nextData = await api("/v1/settings/providers");
      else {
        const [policy, usage] = await Promise.all([
          api("/v1/settings/budgets"),
          api("/v1/usage?period=current-billing-cycle"),
        ]);
        nextData = { policy, usage };
      }
      if (sequence === loadSequence.current) setData(nextData);
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(reason instanceof Error ? reason.message : "読み込みに失敗しました");
      }
    }
  }, [conversationId, tab]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    try {
      if (tab === "conversation") {
        const content = formText(form, "content");
        const created = await api(
          conversationId
            ? `/v1/conversations/${encodeURIComponent(conversationId)}/messages`
            : "/v1/conversations",
          {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ content }),
        });
        if (!conversationId) {
          const id = display(created["conversationId"]);
          setConversationId(id);
          localStorage.setItem("opap.conversationId", id);
        }
      } else if (tab === "tasks") {
        await api("/v1/tasks", {
          method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ conversationId, title: formText(form, "title") }),
        });
      } else if (tab === "memory") {
        await api("/v1/memories", {
          method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            conversationId,
            key: formText(form, "key"),
            value: formText(form, "value"),
          }),
        });
      } else if (tab === "budget") {
        const unlimited = form.get("unlimited") === "on";
        const aiUnlimited = form.get("aiUnlimited") === "on";
        await api("/v1/settings/budgets", {
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
          throw new Error("Workers AIへの通常データ送信を明示的に許可してください");
        }
        await api("/v1/settings/providers", {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ providers: [
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
          ] }),
        });
      }
      formElement.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await api(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "承認判断に失敗しました");
    } finally { setBusy(false); }
  };

  const collection = tab === "tasks" ? rows(data["tasks"])
    : tab === "memory" ? rows(data["memories"])
      : tab === "approvals" ? rows(data["approvals"])
        : tab === "audit" ? rows(data["events"])
          : tab === "conversation" ? rows(data["messages"])
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

  return <div className="shell">
    <aside>
      <div className="brand"><span className="mark">OP</span><div><strong>Open Personal Agent</strong><small>Private control plane</small></div></div>
      <nav aria-label="管理画面">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </nav>
      <div className="status"><span /> Owner plane connected</div>
    </aside>
    <main>
      <header><div><p className="eyebrow">OWNER WORKSPACE</p><h1>{tabs.find((item) => item.id === tab)?.label}</h1></div><button className="quiet" onClick={() => void load()}>Refresh</button></header>
      {error && <div role="alert" className="error">{error}</div>}
      {(tab === "conversation" || tab === "tasks" || tab === "memory") && <p className="context">Conversation <code>{conversationId || "未作成"}</code></p>}
      {tab === "conversation" && <form onSubmit={(event) => { void submit(event); }} className="composer"><textarea name="content" required aria-label="メッセージ" placeholder="エージェントへ依頼する…" maxLength={32768} /><button disabled={busy}>{conversationId ? "Send" : "Create conversation"}</button></form>}
      {tab === "tasks" && <form onSubmit={(event) => { void submit(event); }} className="inline-form"><input name="title" required maxLength={500} placeholder="タスク名" /><button disabled={busy || !conversationId}>Add task</button></form>}
      {tab === "memory" && <form onSubmit={(event) => { void submit(event); }} className="memory-form"><input name="key" required maxLength={200} placeholder="キー" /><textarea name="value" maxLength={32768} placeholder="覚えておく内容" /><button disabled={busy || !conversationId}>Save memory</button></form>}
      {tab === "budget" ? <><form onSubmit={(event) => { void submit(event); }} className="memory-form budget-form"><label>非AI Hard Limit (%)<input name="fraction" type="number" min="10" max="100" defaultValue="80" /></label><label className="check"><input name="unlimited" type="checkbox" /> 非AIの費用停止を解除</label><label>AI月間超過予算 (USD)<input name="aiBudget" type="number" min="0" step="0.5" defaultValue="5" /></label><label className="check"><input name="aiUnlimited" type="checkbox" /> AI予算を無制限にする</label><p className="warning">無制限を選んでも、Capability呼出回数やPlugin実行時間などの安全上限は解除されません。</p><button disabled={busy}>Update budget</button></form><pre className="policy">{JSON.stringify(data, null, 2)}</pre></> : tab === "providers" ? null : <section className="cards" aria-live="polite">
        {collection.length === 0 ? <div className="empty"><strong>まだ項目はありません</strong><span>この画面で作成・更新された項目がここに表示されます。</span></div> : collection.map((item, index) => <article key={display(item["taskId"] ?? item["key"] ?? item["approvalId"] ?? item["eventId"] ?? item["messageId"], String(index))}>
          <div><strong>{display(item["title"] ?? item["key"] ?? item["eventType"] ?? item["capabilityId"] ?? item["role"], "Item")}</strong><p>{display(item["value"] ?? item["content"] ?? item["status"] ?? item["outcome"])}</p></div>
          {tab === "approvals" && item["status"] === "pending" && <div className="actions"><button disabled={busy} onClick={() => void decide(String(item["approvalId"]), "approved")}>Approve</button><button className="danger" disabled={busy} onClick={() => void decide(String(item["approvalId"]), "rejected")}>Reject</button></div>}
        </article>)}
      </section>}
      {tab === "providers" && <><form key={`${activeProviderId}:${workersAiAllowed}`} onSubmit={(event) => { void submit(event); }} className="memory-form budget-form"><label>Model provider<select name="providerId" defaultValue={activeProviderId}><option value="provider:mock-local">Mock Local Provider</option><option value="provider:workers-ai">Workers AI (cloud)</option></select></label><label className="check"><input name="allowCloud" type="checkbox" defaultChecked={workersAiAllowed} /> Allow normal Owner data to be sent to Workers AI</label><p className="warning">Secret data is always denied. Sensitive cloud transfer remains unavailable until per-run approval is connected.</p><button disabled={busy}>Update model</button></form><pre className="policy">{JSON.stringify(data, null, 2)}</pre></>}
    </main>
  </div>;
}
