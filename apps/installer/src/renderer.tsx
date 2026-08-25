import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Overview = { release: { version: string; commit: string; codeSigning?: { signed: boolean; notarized: boolean } };
  unsigned: boolean; telemetry: boolean; sourceUrl: string | null; networkHosts: string[];
  secretPurposes: Record<string, string>; plan: Array<{ stage: string; progress: number }> };
type Configuration = { targetId: "test" | "staging" | "production"; deploymentName: string;
  profile: "cloud-base" | "cloud-base-dynamic"; productName: string; defaultDataPath: string;
  providers: { google: boolean; github: boolean; discord: boolean } };
type Provider = "google" | "github" | "discord";
type PlanItem = { stage: string; progress: number };

const text = {
  ja: {
    title: "セットアップ", install: "インストール", audit: "監査", language: "Language", back: "戻る", next: "次へ",
    loading: "セットアップを準備しています…", startupFailed: "セットアップを開始できませんでした",
    unsigned: "未署名のAlpha版", unsignedHelp: "実行前に配布元、ハッシュ、Build Provenanceを確認してください。",
    connectTitle: "Cloudflareへ接続", connectHelp: "最初に配置先アカウントへ接続します。接続が完了するまで設定入力はありません。",
    connect: "Cloudflareへ接続", connecting: "ブラウザで認証してください…", connected: "接続済み", notConnected: "未接続", failed: "接続できませんでした",
    authHelp: "ブラウザ側の認証を完了してから、もう一度実行してください。",
    locationTitle: "配置情報", locationHelp: "Cloudflare上に作る名前はテスト版で固定済みです。ローカル保存先には設定台帳、Export、回復情報を保存します。",
    existingDetected: "既存の実運用配置を検出しました。このSetupから安全に更新できます。",
    deploymentName: "Cloudflare上の配置名", profile: "構成", localPath: "ローカル保存先", choose: "フォルダーを選択",
    cloudBase: "Cloud Base（ベータ）", dynamic: "Cloud Base Dynamic（実験的）",
    ownerTitle: "Owner", ownerHelp: "この配置を利用する本人を指定します。通常入力するのはこのメールアドレスだけです。",
    ownerEmail: "Ownerメール", ownerEmailHelp: "Cloudflare Accessでログインするメールアドレスと同じ値です。",
    advanced: "詳細設定（通常は変更不要）", timezone: "タイムゾーン", gateway: "AI Gateway ID",
    accessTitle: "Cloudflare Access", accessHelp: "現在のAlpha版では、この1箇所だけCloudflare Dashboardで設定します。",
    accessSteps: "Zero Trust → Access → Applicationsで、この配置のAssistant Workerを保護するApplicationを作成し、Team DomainとAUDタグをコピーします。",
    openAccess: "Zero Trustを開く", teamDomain: "Team Domain", teamHelp: "例: example.cloudflareaccess.com。既存のTeam Domainは再利用できます。",
    audience: "Application AUDタグ", audienceHelp: "作成したAccess Application固有の値です。",
    reviewTitle: "確認", reviewHelp: "作成前の最終確認です。Secretは自動生成され、画面には表示されません。",
    secrets: "Secret保管", secretReady: "OSの保護領域を準備済み", secretPreparing: "保護領域を準備中…",
    passphrase: "回復用パスフレーズ", prepare: "保管場所を準備",
    optional: "Google・GitHub・Discord（後から設定可能）", optionalHelp: "初回には不要です。インストール後にも接続できます。",
    notImported: "未取込", importJson: "JSONを取り込む", githubCallback: "GitHub OAuth Callback URL", createGithub: "GitHub Appを作成",
    planned: "実行予定の詳細", dryRun: "Dry Runを保存", repair: "修復", update: "更新", create: "作成する", notStarted: "未開始",
    progress: "実行状況", elapsed: "経過時間",
    missing: "必須項目が未入力です。", build: "Build情報", network: "許可された通信先", generated: "生成するSecret",
    version: "Version", commit: "Commit", signing: "Code署名", signed: "検証済み", notSigned: "未署名", telemetry: "Telemetry",
    source: "Source Commitを開く", sbom: "SBOMを保存", maintenance: "保守・削除", remove: "配置を削除",
    copyError: "エラー全文をコピー", saveError: "エラーログを保存",
    removeHelp: "Owner Exportを確認後、このInstallerが作成した資源だけを削除します。", exportVerified: "Owner Exportを検証しました",
  },
  en: {
    title: "Setup", install: "Install", audit: "Audit", language: "Language", back: "Back", next: "Next",
    loading: "Preparing setup…", startupFailed: "Setup could not start", unsigned: "Unsigned alpha build",
    unsignedHelp: "Verify the source, hashes, and build provenance before running it.", connectTitle: "Connect Cloudflare",
    connectHelp: "Connect the destination account first. No configuration is requested until this succeeds.", connect: "Connect Cloudflare",
    connecting: "Complete authentication in your browser…", connected: "Connected", notConnected: "Not connected", failed: "Connection failed",
    authHelp: "Complete browser authentication and try again.", locationTitle: "Deployment", locationHelp: "The Cloudflare resource name is fixed in this test build. The local folder stores the ledger, exports, and recovery information.",
    existingDetected: "An existing operational deployment was detected. This Setup can update it safely.",
    deploymentName: "Cloudflare deployment name", profile: "Profile", localPath: "Local data folder", choose: "Choose folder",
    cloudBase: "Cloud Base (beta)", dynamic: "Cloud Base Dynamic (experimental)", ownerTitle: "Owner",
    ownerHelp: "Specify the person who will use this deployment. Normally, this email is the only value you enter.", ownerEmail: "Owner email",
    ownerEmailHelp: "Use the same email address used to sign in through Cloudflare Access.", advanced: "Advanced (normally unchanged)",
    timezone: "Time zone", gateway: "AI Gateway ID", accessTitle: "Cloudflare Access",
    accessHelp: "This is the only Dashboard step in the current alpha.", accessSteps: "In Zero Trust → Access → Applications, create an application protecting this deployment's Assistant Worker, then copy the Team Domain and AUD tag.",
    openAccess: "Open Zero Trust", teamDomain: "Team Domain", teamHelp: "Example: example.cloudflareaccess.com. An existing Team Domain can be reused.",
    audience: "Application AUD tag", audienceHelp: "This value is unique to the Access Application.", reviewTitle: "Review",
    reviewHelp: "Final review before creation. Secrets are generated automatically and never displayed.", secrets: "Secret storage",
    secretReady: "OS-protected storage is ready", secretPreparing: "Preparing protected storage…", passphrase: "Recovery passphrase", prepare: "Prepare storage",
    optional: "Google, GitHub, and Discord (set up later)", optionalHelp: "They are not required initially and can be connected after installation.",
    notImported: "Not imported", importJson: "Import JSON", githubCallback: "GitHub OAuth callback URL", createGithub: "Create GitHub App",
    planned: "Planned operation details", dryRun: "Save dry run", repair: "Repair", update: "Update", create: "Create", notStarted: "Not started",
    progress: "Progress", elapsed: "Elapsed",
    missing: "Required values are missing.", build: "Build identity", network: "Allowed network destinations", generated: "Generated secrets",
    version: "Version", commit: "Commit", signing: "Code signing", signed: "Verified", notSigned: "Unsigned", telemetry: "Telemetry",
    source: "Open source commit", sbom: "Save SBOM", maintenance: "Maintenance and removal", remove: "Remove deployment",
    copyError: "Copy full error", saveError: "Save error log",
    removeHelp: "After verifying an Owner Export, remove only resources created by this Installer.", exportVerified: "I verified the Owner Export",
  },
} as const;

function App() {
  const [locale, setLocale] = useState<"ja" | "en">("ja");
  const t = text[locale];
  const [overview, setOverview] = useState<Overview>();
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [config, setConfig] = useState<Configuration>();
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState<"setup" | "audit">("setup");
  const [cloudflare, setCloudflare] = useState<"idle" | "working" | "ready" | "failed">("idle");
  const [authError, setAuthError] = useState<string>();
  const [dataPath, setDataPath] = useState("");
  const [owner, setOwner] = useState({ ownerEmail: "", accessTeamDomain: "", accessAudience: "",
    ownerTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", aiGatewayId: "default" });
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultStatus, setVaultStatus] = useState("");
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [providers, setProviders] = useState({ google: false, github: false, discord: false });
  const [providerStatus, setProviderStatus] = useState<Record<Provider, string | undefined>>({ google: undefined, github: undefined, discord: undefined });
  const [githubCallbackUrl, setGithubCallbackUrl] = useState("");
  const [result, setResult] = useState<string>();
  const [startupError, setStartupError] = useState<string>();
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<string>();
  const [adoptedExisting, setAdoptedExisting] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ stage: string; progress: number; message: string;
    plan?: PlanItem[] }>();
  const [installStartedAt, setInstallStartedAt] = useState<number>();
  const [activeOperation, setActiveOperation] = useState<"install" | "update" | "repair" | "remove">();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const initializeVault = async (deploymentName: string) => {
    try {
      const value = await window.opapInstaller.initializeVault(passphrase ? { deploymentName, passphrase } : { deploymentName }) as { status: string; backend: string };
      setNeedsPassphrase(value.status === "passphrase-required"); setVaultReady(value.status === "ready"); setVaultStatus(`${value.status} (${value.backend})`);
    } catch (error) { setVaultStatus(error instanceof Error ? error.message : "failed"); }
  };
  useEffect(() => { void Promise.all([window.opapInstaller.getOverview(), window.opapInstaller.getConfiguration()]).then(([a, b]) => {
    const nextOverview = a as Overview; const next = b as Configuration; setOverview(nextOverview); setPlan(nextOverview.plan); setConfig(next); setDataPath(next.defaultDataPath); document.title = next.productName;
    setProviders(next.providers);
  }).catch((error: unknown) => setStartupError(error instanceof Error ? error.message : "Startup failed")); }, []);
  useEffect(() => { window.opapInstaller.onInstallProgress((value) => {
    if (value.plan) setPlan(value.plan);
    setInstallProgress((current) => current && value.progress < current.progress
      ? { ...value, progress: current.progress } : value);
  }); }, []);
  useEffect(() => {
    if (!config) return;
    void window.opapInstaller.getPlan(providers).then((value) => setPlan(value as PlanItem[]));
  }, [config, providers]);
  useEffect(() => {
    if (!installStartedAt) return;
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - installStartedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [installStartedAt]);

  if (startupError) return <main className="loading"><h2>{t.startupFailed}</h2><p>{startupError}</p></main>;
  if (!overview || !config) return <main className="loading">{t.loading}</main>;

  const authenticate = () => {
    setCloudflare("working"); setAuthError(undefined);
    void window.opapInstaller.authenticateCloudflare().then((value) => {
      const auth = value as { status: string; errorCode?: string; detail?: string;
        ownerBootstrap?: typeof owner; configuration?: Configuration; adoptedExisting?: boolean };
      if (auth.status === "authenticated") {
        if (auth.ownerBootstrap) setOwner(auth.ownerBootstrap);
        if (auth.configuration) {
          setConfig(auth.configuration); setDataPath(auth.configuration.defaultDataPath);
          setProviders(auth.configuration.providers); document.title = auth.configuration.productName;
          setVaultReady(false); void initializeVault(auth.configuration.deploymentName);
          void window.opapInstaller.getOverview().then((value) => setOverview(value as Overview));
        }
        setAdoptedExisting(auth.adoptedExisting === true);
        setCloudflare("ready"); setStep(1);
      }
      else { setCloudflare("failed"); setAuthError(auth.detail ?? auth.errorCode ?? "CLOUDFLARE_AUTH_FAILED"); }
    }).catch((error: unknown) => { setCloudflare("failed"); setAuthError(error instanceof Error ? error.message : "CLOUDFLARE_AUTH_FAILED"); });
  };
  const install = (action: "install" | "update" | "repair") => {
    if (activeOperation) return;
    setActiveOperation(action);
    setResult(`${action}…`); setInstallProgress({ stage: "preflight", progress: 0, message: "Starting setup" });
    setElapsedSeconds(0); setInstallStartedAt(Date.now());
    void window.opapInstaller.install({ deploymentName: config.deploymentName, profile: config.profile, localDataPath: dataPath,
      ...providers, ...owner, action }).then((value) => { const next = value as { status: string; errorCode?: string; detail?: string };
      setResult(next.detail ? `${next.status}: ${next.detail}` : next.errorCode ? `${next.status}: ${next.errorCode}` : next.status);
      if (next.status === "active") setInstallProgress({ stage: "complete", progress: 100, message: "Completed" });
    }).catch((error: unknown) => setResult(`failed: ${error instanceof Error ? error.message : "SETUP_FAILED"}`))
      .finally(() => { setInstallStartedAt(undefined); setActiveOperation(undefined); });
  };
  const canNext = [cloudflare === "ready", Boolean(dataPath), Boolean(owner.ownerEmail), Boolean(owner.accessTeamDomain && owner.accessAudience), true][step];
  const canInstall = !activeOperation && cloudflare === "ready" && vaultReady && dataPath && owner.ownerEmail && owner.accessTeamDomain && owner.accessAudience;
  const diagnostic = (value: string) => <div className="diagnostic"><pre>{value}</pre><div className="diagnostic-actions">
    <button onClick={() => void window.opapInstaller.copyDiagnostic(value)}>{t.copyError}</button>
    <button onClick={() => void window.opapInstaller.saveDiagnostic(value)}>{t.saveError}</button>
  </div></div>;

  const setupPages = [
    <section className="wizard-page" key="connect"><span className="step-number">1 / 5</span><h2>{t.connectTitle}</h2><p>{t.connectHelp}</p>
      <div className={`status-box ${cloudflare}`}><strong>{cloudflare === "ready" ? `✓ ${t.connected}` : cloudflare === "failed" ? t.failed : cloudflare === "working" ? t.connecting : t.notConnected}</strong>
        {cloudflare !== "ready" && <button className="primary" disabled={cloudflare === "working"} onClick={authenticate}>{cloudflare === "working" ? t.connecting : t.connect}</button>}</div>
      {cloudflare === "failed" && <div className="error"><p>{t.authHelp}</p>{diagnostic(authError ?? "CLOUDFLARE_AUTH_FAILED")}</div>}</section>,
    <section className="wizard-page" key="location"><span className="step-number">2 / 5</span><h2>{t.locationTitle}</h2><p>{t.locationHelp}</p>
      {adoptedExisting && <p className="notice"><strong>{t.existingDetected}</strong></p>}
      <dl className="summary"><dt>{t.deploymentName}</dt><dd><code>{config.deploymentName}</code></dd><dt>{t.profile}</dt><dd>{config.profile === "cloud-base" ? t.cloudBase : t.dynamic}</dd></dl>
      <label>{t.localPath}<div className="path-row"><input value={dataPath} readOnly/><button onClick={() => { void window.opapInstaller.selectDataPath(dataPath).then((value) => { if (value) setDataPath(value); }); }}>{t.choose}</button></div></label></section>,
    <section className="wizard-page" key="owner"><span className="step-number">3 / 5</span><h2>{t.ownerTitle}</h2><p>{t.ownerHelp}</p>
      <label>{t.ownerEmail}<input autoFocus type="email" value={owner.ownerEmail} placeholder="owner@example.com" onChange={(event) => setOwner({ ...owner, ownerEmail: event.target.value })}/><small>{t.ownerEmailHelp}</small></label>
      <details><summary>{t.advanced}</summary><div className="form-grid details-body"><label>{t.timezone}<input value={owner.ownerTimeZone} onChange={(event) => setOwner({ ...owner, ownerTimeZone: event.target.value })}/></label>
        <label>{t.gateway}<input value={owner.aiGatewayId} onChange={(event) => setOwner({ ...owner, aiGatewayId: event.target.value })}/></label></div></details></section>,
    <section className="wizard-page" key="access"><span className="step-number">4 / 5</span><h2>{t.accessTitle}</h2><p className="notice"><strong>{t.accessHelp}</strong><br/>{t.accessSteps}</p>
      <button onClick={() => void window.opapInstaller.openAccessDashboard()}>{t.openAccess}</button><div className="form-grid access-fields">
        <label>{t.teamDomain}<input value={owner.accessTeamDomain} placeholder="example.cloudflareaccess.com" onChange={(event) => setOwner({ ...owner, accessTeamDomain: event.target.value })}/><small>{t.teamHelp}</small></label>
        <label>{t.audience}<input value={owner.accessAudience} placeholder="Application AUD tag" onChange={(event) => setOwner({ ...owner, accessAudience: event.target.value })}/><small>{t.audienceHelp}</small></label></div></section>,
    <section className="wizard-page" key="review"><span className="step-number">5 / 5</span><h2>{t.reviewTitle}</h2><p>{t.reviewHelp}</p>
      <dl className="summary"><dt>{t.deploymentName}</dt><dd>{config.deploymentName}</dd><dt>{t.localPath}</dt><dd>{dataPath}</dd><dt>{t.ownerEmail}</dt><dd>{owner.ownerEmail}</dd><dt>{t.teamDomain}</dt><dd>{owner.accessTeamDomain}</dd></dl>
      <div className="status-box ready"><strong>{vaultReady ? `✓ ${t.secretReady}` : t.secretPreparing}</strong>{!vaultReady && <button onClick={() => void initializeVault(config.deploymentName)}>{t.prepare}</button>}</div>
      {vaultStatus && <small><code>{vaultStatus}</code></small>}
      {needsPassphrase && <label>{t.passphrase}<input type="password" minLength={12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)}/></label>}
      <details><summary>{t.optional}</summary><p>{t.optionalHelp}</p>{(["google", "github", "discord"] as Provider[]).map((provider) => <div className="provider-row" key={provider}>
        <label className="provider"><input type="checkbox" checked={providers[provider]} onChange={(event) => setProviders({ ...providers, [provider]: event.target.checked })}/><span>{provider}</span></label>
        <code>{providerStatus[provider] ?? t.notImported}</code><button onClick={() => { void window.opapInstaller.importProvider({ deploymentName: config.deploymentName, provider }).then((value) => { const next = value as { status: string; label?: string };
          setProviderStatus((current) => ({ ...current, [provider]: next.label ?? next.status })); if (next.status === "ready") setProviders((current) => ({ ...current, [provider]: true })); }); }}>{t.importJson}</button>
        {provider === "github" && <div className="provider-extra"><label>{t.githubCallback}<input value={githubCallbackUrl} onChange={(event) => setGithubCallbackUrl(event.target.value)}/></label><button disabled={!githubCallbackUrl} onClick={() => { void window.opapInstaller.createGitHubApp({ deploymentName: config.deploymentName, oauthCallbackUrl: githubCallbackUrl }); }}>{t.createGithub}</button></div>}</div>)}</details>
      <details><summary>{t.planned}</summary><ol>{plan.map((item) => <li key={item.stage}><span>{item.stage}</span><small>{item.progress}%</small></li>)}</ol></details>
      {installProgress && <section className="install-progress" aria-live="polite"><div><strong>{t.progress}: {installProgress.progress}%</strong>
        <span>{installProgress.message}</span><small>{t.elapsed}: {elapsedSeconds}s</small></div>
        <progress max="100" value={installProgress.progress}>{installProgress.progress}%</progress></section>}
      <div className="final-actions">{result?.startsWith("failed:")
        ? <div className="final-result">{diagnostic(result)}</div>
        : <code>{result ?? (canInstall ? t.notStarted : t.missing)}</code>}
        <button disabled={Boolean(activeOperation)} onClick={() => void window.opapInstaller.saveDryRun(overview)}>{t.dryRun}</button><button disabled={!canInstall} onClick={() => install("repair")}>{t.repair}</button><button className="primary" disabled={!canInstall} onClick={() => install(adoptedExisting ? "update" : "install")}>{adoptedExisting ? t.update : t.create}</button></div></section>,
  ];

  return <main><header><div><span className="eyebrow">OPEN PERSONAL AGENT</span><h1>{t.title}</h1></div><div className="tabs">
    <button onClick={() => setLocale(locale === "ja" ? "en" : "ja")}>{locale === "ja" ? "English" : "日本語"}</button>
    <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>{t.install}</button><button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>{t.audit}</button></div></header>
    {overview.unsigned && <section className="warning"><strong>{t.unsigned}</strong><span>{t.unsignedHelp}</span></section>}
    {tab === "setup" ? <section className="card wizard">{setupPages[step]}<nav className="wizard-nav"><button disabled={step === 0} onClick={() => setStep((value) => value - 1)}>{t.back}</button>
      {step < 4 && <button className="primary" disabled={!canNext} onClick={() => setStep((value) => value + 1)}>{t.next}</button>}</nav></section> : <>
      <section className="card"><h2>{t.build}</h2><dl><dt>{t.version}</dt><dd>{overview.release.version}</dd><dt>{t.commit}</dt><dd><code>{overview.release.commit}</code></dd><dt>{t.signing}</dt><dd>{overview.release.codeSigning?.signed ? t.signed : t.notSigned}</dd><dt>{t.telemetry}</dt><dd>{overview.telemetry ? "ON" : "OFF"}</dd></dl><div className="actions"><button onClick={() => void window.opapInstaller.openSource()}>{t.source}</button><button onClick={() => void window.opapInstaller.saveSbom()}>{t.sbom}</button></div></section>
      <section className="card"><h2>{t.network}</h2><div className="chips">{overview.networkHosts.map((host) => <code key={host}>{host}</code>)}</div></section>
      <section className="card"><h2>{t.generated}</h2><ul>{Object.entries(overview.secretPurposes).map(([name, purpose]) => <li key={name}><code>{name}</code><span>{purpose}</span></li>)}</ul></section>
      <section className="card danger"><h2>{t.maintenance}</h2><h3>{t.remove}</h3><p>{t.removeHelp}</p><label className="provider"><input type="checkbox" checked={exportConfirmed} onChange={(event) => setExportConfirmed(event.target.checked)}/><span>{t.exportVerified}</span></label>
        <button disabled={!exportConfirmed || Boolean(activeOperation)} onClick={() => { if (activeOperation) return; setActiveOperation("remove"); void window.opapInstaller.remove({ deploymentName: config.deploymentName, localDataPath: dataPath, exportConfirmed }).then((value) => {
           const next = value as { status: string; errorCode?: string; detail?: string };
           setMaintenanceResult(next.detail ? `${next.status}: ${next.detail}` : next.errorCode ? `${next.status}: ${next.errorCode}` : next.status);
        }).catch((error: unknown) => setMaintenanceResult(`failed: ${error instanceof Error ? error.message : "REMOVAL_FAILED"}`))
          .finally(() => setActiveOperation(undefined)); }}>{t.remove}</button>{maintenanceResult && (maintenanceResult.startsWith("failed:") ? diagnostic(maintenanceResult) : <p><code>{maintenanceResult}</code></p>)}</section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
