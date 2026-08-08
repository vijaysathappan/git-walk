import React, { useEffect, useState } from "react";
import {
  addDatasetMember,
  clearAIConfig,
  clearAuth,
  downloadDataset,
  generateAIInsight,
  getAIModels,
  getClientId,
  getDatasetData,
  getDatasetHistory,
  getDatasetMembers,
  getDatasets,
  getKpis,
  getStoredAuth,
  heartbeatPresence,
  leaveDatasetPresence,
  requestLoginCode,
  rollbackChangeSet,
  saveAIConfig,
  uploadAndProvision,
  verifyLoginCode,
} from "./services/api";
import "./styles.css";

function LoginPage({ onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [devOtp, setDevOtp] = useState("");

  const requestCode = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await requestLoginCode(email);
      setDevOtp(result.dev_otp || "");
      setPhase("code");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const auth = await verifyLoginCode(email, code);
      onAuthenticated(auth);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="brand-mark">GW</div>
        <p className="eyebrow">GIT WALK FOR EXCEL</p>
        <h1>Walk every spreadsheet change with confidence.</h1>
        <p className="login-copy">
          Clone Excel data, review the diff, commit with confidence, and pull your
          team's latest work without losing local changes.
        </p>
        <div className="story-grid">
          <div><strong>Diff</strong><span>before every commit</span></div>
          <div><strong>Pull</strong><span>with safe rebase</span></div>
          <div><strong>100%</strong><span>cell lineage</span></div>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">SECURE WORKSPACE</p>
          <h2>{phase === "email" ? "Sign in with email" : "Check your inbox"}</h2>
          <p className="muted">
            {phase === "email"
              ? "No password to remember. We will send a six-digit access code."
              : `Enter the code sent to ${email}.`}
          </p>
          <form onSubmit={phase === "email" ? requestCode : verifyCode}>
            {phase === "email" ? (
              <label>
                Work email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                  required
                  autoFocus
                />
              </label>
            ) : (
              <label>
                Verification code
                <input
                  className="otp-input"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  required
                  autoFocus
                />
              </label>
            )}
            {devOtp ? <div className="dev-code">Development code: {devOtp}</div> : null}
            {error ? <div className="error-banner">{error}</div> : null}
            <button className="primary-button" disabled={busy}>
              {busy ? "Working..." : phase === "email" ? "Send secure code" : "Enter workspace"}
            </button>
          </form>
          {phase === "code" ? (
            <button className="text-button" onClick={() => setPhase("email")}>Use another email</button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function KpiCard({ label, value, note, tone = "cyan" }) {
  return (
    <article className={`kpi-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function DataTable({ data }) {
  if (!data?.columns?.length) return <div className="empty-state">No rows to display.</div>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr>{data.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {data.rows.map((row, rowIndex) => (
            <tr key={row[0] ?? rowIndex}>
              {row.map((value, columnIndex) => (
                <td key={`${rowIndex}-${columnIndex}`}>{value == null ? <span className="null-value">NULL</span> : String(value)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function groupCommits(history) {
  const grouped = new Map();
  for (const item of history || []) {
    if (!grouped.has(item.batch_id)) {
      grouped.set(item.batch_id, { ...item, changes: [] });
    }
    grouped.get(item.batch_id).changes.push(item);
  }
  return [...grouped.values()];
}

export default function App() {
  const [auth, setAuth] = useState(getStoredAuth());
  const [datasets, setDatasets] = useState([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [kpis, setKpis] = useState({});
  const [tab, setTab] = useState("data");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [aiModels, setAiModels] = useState({ models: [] });
  const [aiQuestion, setAiQuestion] = useState("Summarize the highest-risk recent changes and recommended reviews.");
  const [aiModel, setAiModel] = useState("");
  const [aiInsight, setAiInsight] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState("viewer");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [activeUsers, setActiveUsers] = useState([]);
  const [browserClientId] = useState(() => getClientId("browser"));
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiConfigModel, setAiConfigModel] = useState("openai/gpt-4.1-mini");
  const [showAISetup, setShowAISetup] = useState(false);

  const loadDatasets = async () => {
    const result = await getDatasets();
    setDatasets(result.datasets);
    if (!selectedTable && result.datasets.length) setSelectedTable(result.datasets[0].table_id);
  };

  const refresh = async (silent = false) => {
    if (!selectedTable) return;
    if (!silent) setLoading(true);
    try {
      const [tableData, auditData, metricData] = await Promise.all([
        getDatasetData(selectedTable, 100, 0),
        getDatasetHistory(selectedTable, 200),
        getKpis(selectedTable),
      ]);
      setData(tableData);
      setHistory(auditData.history);
      setKpis(metricData);
      setLastRefresh(new Date());
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!auth) return;
    loadDatasets().catch((err) => setError(err.message));
    getAIModels().then((models) => {
      setAiModels(models);
      setAiModel(models.default_model || models.models[0] || "");
      setAiConfigModel(models.default_model || "openai/gpt-4.1-mini");
      setShowAISetup(!models.configured);
    }).catch(() => {});
  }, [auth]);

  useEffect(() => {
    if (!auth || !selectedTable) return;
    refresh();
    getDatasetMembers(selectedTable)
      .then((result) => setMembers(result.members))
      .catch((err) => setError(err.message));
    const timer = setInterval(() => refresh(true), 2000);
    return () => clearInterval(timer);
  }, [auth, selectedTable]);

  useEffect(() => {
    if (!auth || !selectedTable) return undefined;
    let active = true;
    const heartbeat = async () => {
      try {
        const result = await heartbeatPresence(
          selectedTable, browserClientId, "browser", document.hidden ? "idle" : "viewing"
        );
        if (active) setActiveUsers(result.active_users || []);
      } catch (err) {
        if (active) setError(err.message);
      }
    };
    heartbeat();
    const timer = setInterval(heartbeat, 15000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", heartbeat);
      leaveDatasetPresence(selectedTable, browserClientId).catch(() => {});
    };
  }, [auth, browserClientId, selectedTable]);

  if (!auth) return <LoginPage onAuthenticated={setAuth} />;

  const selectedDataset = datasets.find((item) => item.table_id === selectedTable);
  const commits = groupCommits(history);
  const latestRisk = commits[0]?.risk_score || 0;

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadAndProvision(selectedFile);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await loadDatasets();
      setSelectedTable(result.tableId);
      setSelectedFile(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleRollback = async (batchId) => {
    if (!window.confirm(`Revert change set ${batchId}? This creates a new audited version.`)) return;
    try {
      await rollbackChangeSet(selectedTable, batchId);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const askAI = async () => {
    setAiBusy(true);
    setAiInsight("");
    try {
      const result = await generateAIInsight({ table_id: selectedTable, model: aiModel, question: aiQuestion });
      setAiInsight(result.insight);
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  };

  const configureAI = async (event) => {
    event.preventDefault();
    setAiBusy(true);
    setError("");
    try {
      await saveAIConfig(aiApiKey.trim(), aiConfigModel.trim());
      const models = await getAIModels();
      setAiModels(models);
      setAiModel(models.default_model || aiConfigModel.trim());
      setAiApiKey("");
      setShowAISetup(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  };

  const disconnectAI = async () => {
    setAiBusy(true);
    try {
      await clearAIConfig();
      const models = await getAIModels();
      setAiModels(models);
      setShowAISetup(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  };

  const grantAccess = async (event) => {
    event.preventDefault();
    if (!memberEmail.trim()) return;
    setInviteBusy(true);
    setError("");
    try {
      await addDatasetMember(selectedTable, memberEmail.trim(), memberRole);
      const result = await getDatasetMembers(selectedTable);
      setMembers(result.members);
      setMemberEmail("");
    } catch (err) {
      setError(err.message);
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <div className="product-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark small">GW</div><div><strong>Git Walk</strong><span>Spreadsheet version control</span></div></div>
        <nav>
          {[["data", "Repository"], ["history", "Commits"], ["analytics", "Insights"], ["ai", "AI copilot"]].map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="user-avatar">{auth.user.email.slice(0, 2).toUpperCase()}</span>
          <div><strong>{auth.user.email}</strong><small>{auth.user.user_id}</small></div>
          <button className="logout" title="Sign out" onClick={() => { clearAuth(); setAuth(null); }}>Exit</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">GIT WALK / REPOSITORY</p>
            <h1>{selectedDataset?.original_filename || "Dataset workspace"}</h1>
          </div>
          <div className="topbar-actions">
            <div className="active-users" title={activeUsers.map((user) => user.email).join("\n") || "No active users"}>
              <div className="avatar-stack">
                {activeUsers.slice(0, 4).map((user, index) => (
                  <span key={user.user_id} style={{ "--avatar-index": index }}>
                    {user.email.slice(0, 2).toUpperCase()}<i />
                  </span>
                ))}
              </div>
              <div><strong>{activeUsers.length} active</strong><small>{activeUsers.some((user) => user.surfaces.includes("excel")) ? "Excel connected" : "Viewing repository"}</small></div>
            </div>
            <select value={selectedTable} onChange={(event) => setSelectedTable(event.target.value)}>
              {datasets.map((dataset) => <option key={dataset.table_id} value={dataset.table_id}>{dataset.table_id}</option>)}
            </select>
            <button className="secondary-button" onClick={() => refresh()} disabled={!selectedTable}>Refresh</button>
          </div>
        </header>

        {error ? <div className="error-banner global"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div> : null}

        <section className="status-rail">
          <span><i className="live-dot" /> main</span>
          <span>HEAD <strong>v{data?.version || 0}</strong></span>
          <span>{data?.total || 0} records</span>
          <span>{activeUsers.length} collaborator{activeUsers.length === 1 ? "" : "s"} online</span>
          <span>{lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Waiting for data"}</span>
        </section>

        <section className="kpi-grid">
          <KpiCard label="Commits" value={kpis.commits || 0} note="On the main data branch" />
          <KpiCard label="Cells changed" value={kpis.successes || 0} note={`${kpis.contributors || 0} contributors`} tone="green" />
          <KpiCard label="Impact risk" value={`${latestRisk}/100`} note={`Peak ${kpis.max_risk || 0}`} tone={latestRisk > 60 ? "red" : "amber"} />
          <KpiCard label="Data quality" value={`${Math.max(0, 100 - Math.round(((kpis.no_changes || 0) / Math.max(kpis.cell_events || 1, 1)) * 100))}%`} note="Effective updates" tone="ink" />
        </section>

        {tab === "data" ? (
          <>
            <section className="panel upload-strip">
              <div><p className="eyebrow">NEW REPOSITORY</p><h3>Clone an Excel workbook into Git Walk</h3></div>
              <label className="file-picker"><input type="file" accept=".xlsx" onChange={(event) => setSelectedFile(event.target.files[0] || null)} /><span>{selectedFile?.name || "Choose .xlsx"}</span></label>
              <button className="primary-button compact" onClick={handleUpload} disabled={!selectedFile || uploading}>{uploading ? "Provisioning..." : "Upload and connect"}</button>
            </section>
            <section className="panel access-strip">
              <div>
                <p className="eyebrow">ACCESS CONTROL</p>
                <h3>{members.length} workspace member{members.length === 1 ? "" : "s"}</h3>
                <div className="member-chips">
                  {members.slice(0, 5).map((member) => (
                    <span key={member.user_id} title={`${member.email} / ${member.role}`}>
                      {member.email.slice(0, 2).toUpperCase()} <small>{member.role}</small>
                    </span>
                  ))}
                </div>
              </div>
              {selectedDataset?.owner_user_id === auth.user.user_id ? (
                <form className="access-form" onSubmit={grantAccess}>
                  <input
                    type="email"
                    value={memberEmail}
                    onChange={(event) => setMemberEmail(event.target.value)}
                    placeholder="Existing user's email"
                    required
                  />
                  <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button className="secondary-button" disabled={inviteBusy}>
                    {inviteBusy ? "Granting..." : "Grant access"}
                  </button>
                </form>
              ) : <span className="pill">Shared with you</span>}
            </section>
            <section className="panel">
              <div className="panel-header"><div><p className="eyebrow">MAIN / LATEST</p><h2>Repository records</h2></div><div className="button-group"><button onClick={() => downloadDataset(selectedTable, "csv")}>CSV</button><button onClick={() => downloadDataset(selectedTable, "xlsx")}>Excel</button></div></div>
              {loading ? <div className="loading-state">Loading governed data...</div> : <DataTable data={data} />}
            </section>
          </>
        ) : null}

        {tab === "history" ? (
          <section className="panel">
            <div className="panel-header"><div><p className="eyebrow">MAIN / HISTORY</p><h2>Commit graph</h2></div><span className="pill">{commits.length} commits</span></div>
            <div className="commit-list">
              {commits.map((commit) => (
                <article className="commit-card" key={commit.batch_id}>
                  <div className="commit-node" />
                  <div className="commit-main">
                    <div className="commit-title"><strong>{commit.commit_message}</strong><span className={`risk-badge risk-${commit.risk_score > 60 ? "high" : commit.risk_score > 30 ? "medium" : "low"}`}>Risk {commit.risk_score}</span></div>
                    <p>{commit.user_email} committed {commit.changes.length} cell event(s) in version {commit.version}</p>
                    <small>{commit.batch_id} / {new Date(commit.created_at).toLocaleString()}</small>
                    <div className="change-preview">{commit.changes.slice(0, 4).map((change) => <span key={change.audit_id}>{change.column_name} [{change.row_id}]: <del>{String(change.old_value)}</del> <ins>{String(change.new_value)}</ins></span>)}</div>
                  </div>
                  <button className="secondary-button" onClick={() => handleRollback(commit.batch_id)}>Revert</button>
                </article>
              ))}
              {!commits.length ? <div className="empty-state">No commits yet. Excel edits will appear here.</div> : null}
            </div>
          </section>
        ) : null}

        {tab === "analytics" ? (
          <div className="analytics-grid">
            <section className="panel radar-panel"><p className="eyebrow">INNOVATION LAYER</p><h2>Change Impact Radar</h2><div className="risk-orbit" style={{ "--risk": `${latestRisk * 3.6}deg` }}><div><strong>{latestRisk}</strong><span>risk score</span></div></div><p className="muted">Volume, breadth, and sensitive-column signals combine into a review priority score.</p></section>
            <section className="panel"><p className="eyebrow">TEAM VELOCITY</p><h2>Top contributors</h2><div className="contributors">{(kpis.top_contributors || []).map((user) => <div key={user.user_id}><span>{user.email}</span><div><i style={{ width: `${Math.min(100, user.commits * 12)}%` }} /></div><strong>{user.commits}</strong></div>)}</div></section>
            <section className="panel wide"><p className="eyebrow">MANAGER SCORECARD</p><h2>Operational health</h2><div className="scorecard"><div><span>Successful updates</span><strong>{kpis.successes || 0}</strong></div><div><span>No-op validations</span><strong>{kpis.no_changes || 0}</strong></div><div><span>Average risk</span><strong>{kpis.avg_risk || 0}</strong></div><div><span>Active datasets</span><strong>{kpis.datasets || 0}</strong></div></div></section>
          </div>
        ) : null}

        {tab === "ai" ? (
          <section className="panel ai-panel">
            <div className="ai-heading"><div><p className="eyebrow">GIT WALK INTELLIGENCE</p><h2>Repository copilot</h2></div><span className={`pill ${aiModels.configured ? "ready" : ""}`}>{aiModels.configured ? `Connected ${aiModels.masked_key || ""}` : "Connect OpenRouter"}</span></div>
            <p className="muted">Generate commit summaries, detect risky spreadsheet changes, and prepare manager-ready repository reports.</p>
            {showAISetup ? (
              <form className="ai-setup" onSubmit={configureAI}>
                <div className="secret-heading"><div><strong>Connect your OpenRouter account</strong><span>Your key is encrypted before it is stored.</span></div><span className="security-chip">User scoped</span></div>
                <label>OpenRouter API key<input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="sk-or-v1-..." autoComplete="off" required /></label>
                <label>Default model<input value={aiConfigModel} onChange={(event) => setAiConfigModel(event.target.value)} placeholder="provider/model" required /></label>
                <button className="primary-button" disabled={aiBusy}>{aiBusy ? "Saving securely..." : "Save and connect"}</button>
              </form>
            ) : (
              <>
                <div className="ai-connection"><span><i className="live-dot" /> OpenRouter connected as {aiModels.masked_key}</span><div><button className="text-button inline" onClick={() => setShowAISetup(true)}>Replace key</button><button className="text-button inline danger" onClick={disconnectAI}>Disconnect</button></div></div>
                <div className="ai-controls"><select value={aiModel} onChange={(event) => setAiModel(event.target.value)}>{aiModels.models.map((model) => <option key={model}>{model}</option>)}</select><textarea value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} /><button className="primary-button" onClick={askAI} disabled={aiBusy}>{aiBusy ? "Analyzing repository..." : "Generate insight"}</button></div>
              </>
            )}
            {aiInsight ? <div className="ai-response">{aiInsight}</div> : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
