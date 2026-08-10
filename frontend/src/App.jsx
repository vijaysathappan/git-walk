import React, { useEffect, useState } from "react";
import {
  addDatasetMember,
  clearAIConfig,
  clearAuth,
  checkRepositoryName,
  createMergeRequest,
  deleteBranch,
  deleteRepository,
  downloadDataset,
  downloadRepositoryBranch,
  generateAIInsight,
  getAIModels,
  getAuditEvents,
  getBranchCommits,
  getBranchDivergence,
  getBranchMetrics,
  getBranchState,
  getCommitDetail,
  getCellTraceability,
  getClientId,
  getDatasetData,
  getDatasetHistory,
  getCategories,
  createCategory,
  getMyWorkingCopies,
  getRepository,
  getRepositoryBranches,
  getRepositorySheetData,
  getWorkspaceState,
  getDatasets,
  getKpis,
  getMergeRequest,
  getMergeRequests,
  getOperationalMetrics,
  getRepositoryInsights,
  getSecurityPosture,
  getStoredAuth,
  getStableCellHistory,
  getWorkbookBlame,
  heartbeatPresence,
  leaveDatasetPresence,
  logout,
  requestLoginCode,
  resolveMergeConflict,
  reviewMergeRequest,
  rollbackChangeSet,
  mergeMergeRequest,
  revertSemanticCommit,
  revokeDatasetMember,
  saveAIConfig,
  syncBranchWithMain,
  moveRepositoryToCategory,
  uploadAndProvision,
  verifyLoginCode,
  workOnWorkbook,
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
  const [tab, setTab] = useState("home");
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
  const [invitations, setInvitations] = useState([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState("viewer");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [activeUsers, setActiveUsers] = useState([]);
  const [browserClientId] = useState(() => getClientId("browser"));
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiConfigModel, setAiConfigModel] = useState("openai/gpt-4.1-mini");
  const [showAISetup, setShowAISetup] = useState(false);
  const [categories, setCategories] = useState([]);
  const [repository, setRepository] = useState(null);
  const [branches, setBranches] = useState([]);
  const [workingCopies, setWorkingCopies] = useState([]);
  const [selectedBranchTable, setSelectedBranchTable] = useState("");
  const [workingCopyBusy, setWorkingCopyBusy] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState("CAT_HOME");
  const [branchState, setBranchState] = useState(null);
  const [semanticCommits, setSemanticCommits] = useState([]);
  const [semanticMetrics, setSemanticMetrics] = useState({});
  const [lineageRowId, setLineageRowId] = useState("");
  const [lineageColumnId, setLineageColumnId] = useState("");
  const [cellLineage, setCellLineage] = useState([]);
  const [mergeRequests, setMergeRequests] = useState([]);
  const [selectedMergeRequestId, setSelectedMergeRequestId] = useState("");
  const [mergeRequestDetail, setMergeRequestDetail] = useState(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeTitle, setMergeTitle] = useState("");
  const [mergeDescription, setMergeDescription] = useState("");
  const [branchDivergence, setBranchDivergence] = useState(null);
  const [auditLedger, setAuditLedger] = useState({ events: [], integrity: {} });
  const [operationalMetrics, setOperationalMetrics] = useState({ metrics: {}, security_events: {} });
  const [repositoryInsights, setRepositoryInsights] = useState(null);
  const [securityPosture, setSecurityPosture] = useState(null);
  const [workbookBlame, setWorkbookBlame] = useState({ cells: [] });
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [selectedSheetId, setSelectedSheetId] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryDescription, setRepositoryDescription] = useState("");
  const [repositoryClassification, setRepositoryClassification] = useState("internal");
  const [repositoryRetention, setRepositoryRetention] = useState("3 years");
  const [selectedCommit, setSelectedCommit] = useState(null);

  const viewTableId = selectedBranchTable || selectedTable;
  const selectedBranch = branches.find((branch) => branch.data_table_id === viewTableId) || null;
  const selectedMergeSummary = mergeRequests.find(
    (request) => request.merge_request_id === selectedMergeRequestId
  );
  const selectedSemanticSheet = branchState?.sheets?.find(
    (sheet) => sheet.sheet_id === selectedSheetId
  ) || branchState?.sheets?.[0] || null;
  const filteredDatasets = datasets.filter((dataset) => {
    const query = repoSearch.trim().toLowerCase();
    return !query || `${dataset.repository_name} ${dataset.table_id}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    const expireSession = () => setAuth(null);
    window.addEventListener("gitwalk:auth-expired", expireSession);
    return () => window.removeEventListener("gitwalk:auth-expired", expireSession);
  }, []);

  const loadDatasets = async () => {
    const result = await getDatasets();
    setDatasets(result.datasets);
    if (!selectedTable && result.datasets.length) setSelectedTable(result.datasets[0].table_id);
  };

  const loadFoundation = async () => {
    const [categoryResult, workingCopyResult] = await Promise.all([
      getCategories(),
      getMyWorkingCopies(),
    ]);
    setCategories(categoryResult.categories || []);
    setWorkingCopies(workingCopyResult.working_copies || []);
  };

  const loadMergeRequests = async () => {
    if (!selectedTable) return;
    const result = await getMergeRequests(selectedTable);
    setMergeRequests(result.merge_requests || []);
    setSelectedMergeRequestId((current) => current
      || result.merge_requests?.[0]?.merge_request_id || "");
  };

  const refresh = async (silent = false) => {
    if (!viewTableId) return;
    if (!silent) setLoading(true);
    try {
      const branchForView = branches.find((branch) => branch.data_table_id === viewTableId);
      const tablePromise = branchForView && selectedSheetId
        ? getRepositorySheetData(selectedTable, branchForView.branch_id, selectedSheetId, 100, 0)
        : getDatasetData(viewTableId, 100, 0);
      const [tableData, auditData, metricData] = await Promise.all([
        tablePromise,
        getDatasetHistory(viewTableId, 200),
        getKpis(viewTableId),
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
    loadFoundation().catch((err) => setError(err.message));
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
    const timer = setInterval(() => refresh(true), 2000);
    return () => clearInterval(timer);
  }, [auth, selectedTable, selectedBranchTable, selectedSheetId]);

  useEffect(() => {
    if (!auth || !selectedTable) return;
    setSelectedBranchTable("");
    Promise.all([
      getRepository(selectedTable),
      getRepositoryBranches(selectedTable),
    ]).then(([repositoryResult, branchResult]) => {
      setRepository(repositoryResult);
      setBranches(branchResult.branches || []);
      setSelectedSheetId((current) => repositoryResult.sheets?.some((sheet) => sheet.sheet_id === current)
        ? current : repositoryResult.sheets?.[0]?.sheet_id || "");
    }).catch((err) => setError(err.message));
  }, [auth, selectedTable]);

  useEffect(() => {
    if (!auth || !selectedTable) return;
    loadMergeRequests().catch((err) => setError(err.message));
  }, [auth, selectedTable, data?.version]);

  useEffect(() => {
    if (!auth || !selectedMergeRequestId) {
      setMergeRequestDetail(null);
      return;
    }
    getMergeRequest(selectedMergeRequestId)
      .then(setMergeRequestDetail)
      .catch((err) => setError(err.message));
  }, [auth, selectedMergeRequestId, selectedMergeSummary?.updated_at]);

  useEffect(() => {
    if (!auth || !selectedBranch?.branch_id || selectedBranch.branch_type !== "USER") {
      setBranchDivergence(null);
      return;
    }
    getBranchDivergence(selectedBranch.branch_id)
      .then(setBranchDivergence)
      .catch((err) => setError(err.message));
  }, [auth, selectedBranch?.branch_id, selectedBranch?.head_commit_id]);

  useEffect(() => {
    if (!auth || !selectedBranch?.branch_id) {
      setBranchState(null);
      setSemanticCommits([]);
      setSemanticMetrics({});
      return;
    }
    let cancelled = false;
    Promise.all([
      getBranchState(selectedBranch.branch_id),
      getBranchCommits(selectedBranch.branch_id, 100),
      getBranchMetrics(selectedBranch.branch_id),
    ]).then(([state, commitResult, metrics]) => {
      if (cancelled) return;
      setBranchState(state);
      setSemanticCommits(commitResult.commits || []);
      setSemanticMetrics(metrics || {});
      const sheet = state.sheets?.[0];
      setSelectedSheetId((current) => state.sheets?.some((item) => item.sheet_id === current)
        ? current : sheet?.sheet_id || "");
      setLineageRowId((current) => sheet?.rows?.some((row) => row.row_id === current)
        ? current : sheet?.rows?.[0]?.row_id || "");
      setLineageColumnId((current) => sheet?.columns?.some((column) => column.column_id === current)
        ? current : sheet?.columns?.[0]?.column_id || "");
    }).catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [auth, selectedBranch?.branch_id, data?.version]);

  useEffect(() => {
    if (!auth || !selectedTable) return;
    Promise.all([
      getAuditEvents(selectedTable),
      getOperationalMetrics(24),
      getRepositoryInsights(selectedTable),
      getSecurityPosture(),
    ]).then(([audit, operations, insights, posture]) => {
      setAuditLedger(audit);
      setOperationalMetrics(operations);
      setRepositoryInsights(insights);
      setSecurityPosture(posture);
    }).catch((err) => setError(err.message));
  }, [auth, selectedTable, data?.version, selectedMergeSummary?.updated_at]);

  useEffect(() => {
    if (!auth || !selectedBranch?.branch_id) {
      setWorkbookBlame({ cells: [] });
      return;
    }
    getWorkbookBlame(selectedBranch.branch_id, selectedSemanticSheet?.sheet_id || "", 5000)
      .then(setWorkbookBlame)
      .catch((err) => setError(err.message));
  }, [auth, selectedBranch?.branch_id, branchState?.head_commit_id, selectedSemanticSheet?.sheet_id]);

  useEffect(() => {
    const sheet = selectedSemanticSheet;
    if (!selectedBranch?.branch_id || !sheet?.sheet_id || !lineageRowId || !lineageColumnId) {
      setCellLineage([]);
      return;
    }
    getStableCellHistory(
      selectedBranch.branch_id, sheet.sheet_id, lineageRowId, lineageColumnId, 50
    ).then((result) => setCellLineage(result.history || []))
      .catch((err) => setError(err.message));
  }, [branchState, lineageColumnId, lineageRowId, selectedBranch?.branch_id, selectedSemanticSheet?.sheet_id]);

  useEffect(() => {
    if (!selectedSemanticSheet) return;
    setLineageRowId((current) => selectedSemanticSheet.rows?.some((row) => row.row_id === current)
      ? current : selectedSemanticSheet.rows?.[0]?.row_id || "");
    setLineageColumnId((current) => selectedSemanticSheet.columns?.some((column) => column.column_id === current)
      ? current : selectedSemanticSheet.columns?.[0]?.column_id || "");
  }, [selectedSemanticSheet?.sheet_id]);

  useEffect(() => {
    if (!auth || !selectedTable) return undefined;
    let cancelled = false;
    const applyWorkspace = (result) => {
      if (cancelled) return;
      setMembers(result.members || []);
      setInvitations(result.invitations || []);
      setActiveUsers(result.active_users || []);
    };
    const watch = async () => {
      let result = await getWorkspaceState(selectedTable, 0, 0);
      applyWorkspace(result);
      let revision = result.revision || 0;
      while (!cancelled) {
        try {
          result = await getWorkspaceState(selectedTable, revision, 20);
          applyWorkspace(result);
          revision = result.revision || revision;
        } catch (err) {
          if (!cancelled) await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    };
    watch().catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
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
    if (!selectedFile || !repositoryName.trim()) return;
    setUploading(true);
    setError("");
    try {
      const availability = await checkRepositoryName(repositoryName.trim());
      if (!availability.available) throw new Error(availability.reason || "Repository name is unavailable");
      const result = await uploadAndProvision(selectedFile, {
        repository_name: repositoryName.trim(),
        description: repositoryDescription.trim(),
        data_classification: repositoryClassification,
        retention_policy: repositoryRetention.trim(),
        business_owner: auth.user.email,
      });
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
      setRepositoryName("");
      setRepositoryDescription("");
      setTab("data");
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleBranchDownload = async () => {
    if (!selectedBranch?.branch_id) return;
    try {
      await downloadRepositoryBranch(selectedTable, selectedBranch.branch_id);
    } catch (err) { setError(err.message); }
  };

  const handleDeleteBranch = async (branch) => {
    if (!window.confirm(`Delete branch ${branch.branch_name}? Its signed local copies will be revoked.`)) return;
    try {
      await deleteBranch(branch.branch_id);
      setSelectedBranchTable("");
      const result = await getRepositoryBranches(selectedTable);
      setBranches(result.branches || []);
      await loadFoundation();
    } catch (err) { setError(err.message); }
  };

  const handleDeleteRepository = async () => {
    if (!window.confirm(`Delete repository ${repository?.repository_name}? This revokes every branch checkout.`)) return;
    try {
      await deleteRepository(selectedTable);
      setSelectedTable("");
      setRepository(null);
      await loadDatasets();
      setTab("home");
    } catch (err) { setError(err.message); }
  };

  const inspectCommit = async (commitId) => {
    try { setSelectedCommit(await getCommitDetail(commitId)); }
    catch (err) { setError(err.message); }
  };

  const handleRollback = async (batchId) => {
    if (!window.confirm(`Revert change set ${batchId}? This creates a new audited version.`)) return;
    try {
      await rollbackChangeSet(viewTableId, batchId);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleWorkOnWorkbook = async () => {
    if (!selectedTable) return;
    setWorkingCopyBusy(true);
    setError("");
    try {
      await workOnWorkbook(selectedTable);
      await loadFoundation();
      const result = await getRepositoryBranches(selectedTable);
      setBranches(result.branches || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorkingCopyBusy(false);
    }
  };

  const refreshMergeRequest = async (mergeRequestId = selectedMergeRequestId) => {
    await loadMergeRequests();
    if (mergeRequestId) setMergeRequestDetail(await getMergeRequest(mergeRequestId));
  };

  const handleCreateMergeRequest = async (event) => {
    event.preventDefault();
    const source = selectedBranch?.branch_type === "USER"
      ? selectedBranch : branches.find((branch) => branch.branch_type === "USER" && branch.status === "ACTIVE");
    const target = branches.find((branch) => branch.branch_type === "MAIN");
    if (!source || !target) { setError("Create and select an active personal branch first."); return; }
    setMergeBusy(true); setError("");
    try {
      const result = await createMergeRequest({
        source_branch_id: source.branch_id,
        target_branch_id: target.branch_id,
        title: mergeTitle.trim(),
        description: mergeDescription.trim() || null,
      });
      setMergeTitle(""); setMergeDescription("");
      setSelectedMergeRequestId(result.merge_request_id);
      setMergeRequestDetail(result);
      await loadMergeRequests();
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const handleResolveConflict = async (conflict, resolutionType) => {
    let customValue = null;
    if (resolutionType === "CUSTOM") {
      const entered = window.prompt("Enter the custom resolved value as text:", "");
      if (entered == null) return;
      customValue = entered;
    }
    setMergeBusy(true); setError("");
    try {
      const result = await resolveMergeConflict(
        mergeRequestDetail.merge_request_id, conflict.conflict_id,
        { resolution_type: resolutionType, custom_value: customValue }
      );
      setMergeRequestDetail(result);
      await loadMergeRequests();
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const handleReviewMergeRequest = async (decision) => {
    const comment = window.prompt(
      decision === "APPROVED" ? "Approval note:" : "Reason for rejection:", ""
    );
    if (comment == null) return;
    setMergeBusy(true); setError("");
    try {
      const result = await reviewMergeRequest(
        mergeRequestDetail.merge_request_id, decision, comment
      );
      setMergeRequestDetail(result);
      await loadMergeRequests();
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const handleMergeRequest = async () => {
    if (!window.confirm("Merge this approved branch into protected main?")) return;
    setMergeBusy(true); setError("");
    try {
      await mergeMergeRequest(mergeRequestDetail.merge_request_id);
      setSelectedBranchTable("");
      await Promise.all([refresh(), loadFoundation(), loadMergeRequests()]);
      const branchResult = await getRepositoryBranches(selectedTable);
      setBranches(branchResult.branches || []);
      setMergeRequestDetail(await getMergeRequest(mergeRequestDetail.merge_request_id));
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const handleSyncMain = async () => {
    if (!selectedBranch || selectedBranch.branch_type !== "USER") return;
    setMergeBusy(true); setError("");
    try {
      await syncBranchWithMain(selectedBranch.branch_id);
      const branchResult = await getRepositoryBranches(selectedTable);
      setBranches(branchResult.branches || []);
      setBranchDivergence(await getBranchDivergence(selectedBranch.branch_id));
      await refresh();
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const handleSemanticRevert = async (commitId) => {
    if (!window.confirm(`Create an inverse commit for ${commitId}?`)) return;
    setMergeBusy(true); setError("");
    try {
      await revertSemanticCommit(commitId);
      await refresh();
    } catch (err) { setError(err.message); } finally { setMergeBusy(false); }
  };

  const addBusinessArea = async (event) => {
    event.preventDefault();
    if (!categoryName.trim()) return;
    try {
      await createCategory(categoryName.trim(), "", categoryParent);
      setCategoryName("");
      await loadFoundation();
    } catch (err) {
      setError(err.message);
    }
  };

  const changeBusinessArea = async (categoryId) => {
    try {
      await moveRepositoryToCategory(selectedTable, categoryId);
      setRepository(await getRepository(selectedTable));
      await loadDatasets();
    } catch (err) {
      setError(err.message);
    }
  };

  const askAI = async () => {
    setAiBusy(true);
    setAiInsight("");
    try {
      const result = await generateAIInsight({
        table_id: selectedTable,
        branch_id: selectedBranch?.branch_id || null,
        merge_request_id: selectedMergeRequestId || null,
        model: aiModel,
        question: aiQuestion,
      });
      setAiInsight(result.insight);
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  };

  const inspectBlameCell = async (cell) => {
    if (!selectedBranch?.branch_id) return;
    try {
      setSelectedTrace(await getCellTraceability(
        selectedBranch.branch_id, cell.sheet_id, cell.row_id, cell.column_id
      ));
    } catch (err) {
      setError(err.message);
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
      setMemberEmail("");
    } catch (err) {
      setError(err.message);
    } finally {
      setInviteBusy(false);
    }
  };

  const revokeAccess = async (email) => {
    if (!window.confirm(`Revoke workspace access for ${email}?`)) return;
    try {
      await revokeDatasetMember(selectedTable, email);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="product-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark small">GW</div><div><strong>Git Walk</strong><span>Spreadsheet version control</span></div></div>
        <nav>
          {[["home", "Repositories"], ["new", "New repository"], ["data", "Repository data"], ["branches", "Branches"], ["merges", "Merge requests"], ["history", "History & lineage"], ["analytics", "Insights + AI"], ["audit", "Audit ledger"], ["settings", "Settings"]].map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="user-avatar">{auth.user.email.slice(0, 2).toUpperCase()}</span>
          <div><strong>{auth.user.email}</strong><small>{auth.user.user_id}</small></div>
          <button className="logout" title="Sign out" onClick={async () => { await logout().catch(() => clearAuth()); setAuth(null); }}>Exit</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{tab === "home" ? "GIT WALK / COMMAND CENTER" : "GIT WALK / REPOSITORY"}</p>
            <h1>{tab === "home" ? "Repository workspaces" : repository?.repository_name || selectedDataset?.original_filename || "Repository workspace"}</h1>
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
            <input className="repo-search" list="repository-options" value={repoSearch} onChange={(event) => {
              const value = event.target.value;
              setRepoSearch(value);
              const match = datasets.find((item) => item.table_id === value || item.repository_name === value);
              if (match) setSelectedTable(match.table_id);
            }} placeholder="Search repositories" />
            <datalist id="repository-options">{datasets.map((dataset) => <option key={dataset.table_id} value={dataset.repository_name}>{dataset.table_id}</option>)}</datalist>
            <select value={selectedTable} onChange={(event) => setSelectedTable(event.target.value)}>
              {filteredDatasets.map((dataset) => <option key={dataset.table_id} value={dataset.table_id}>{dataset.repository_name} / {dataset.table_id}</option>)}
            </select>
            {selectedTable ? <select className="branch-selector" value={viewTableId} onChange={(event) => setSelectedBranchTable(event.target.value === selectedTable ? "" : event.target.value)}>
              {branches.map((branch) => <option key={branch.branch_id} value={branch.data_table_id}>{branch.branch_name}</option>)}
            </select> : null}
            <button className="primary-button compact" onClick={handleWorkOnWorkbook} disabled={!selectedTable || workingCopyBusy}>{workingCopyBusy ? "Preparing branch..." : "Open branch in Excel"}</button>
            <button className="secondary-button" onClick={() => refresh()} disabled={!selectedTable}>Refresh</button>
          </div>
        </header>

        {error ? <div className="error-banner global"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div> : null}

        <section className="status-rail">
          <span><i className="live-dot" /> {branches.find((branch) => branch.data_table_id === viewTableId)?.branch_name || "main"}</span>
          <span>HEAD <strong>v{data?.version || 0}</strong></span>
          <span>{data?.total || 0} records</span>
          <span>{activeUsers.length} collaborator{activeUsers.length === 1 ? "" : "s"} online</span>
          <span>{lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Waiting for data"}</span>
        </section>

        <section className="kpi-grid">
          <KpiCard label="Commits" value={semanticMetrics.commits ?? kpis.commits ?? 0} note={`On ${selectedBranch?.branch_name || "main"}`} />
          <KpiCard label="Semantic changes" value={semanticMetrics.changes ?? kpis.successes ?? 0} note={`${semanticMetrics.changed_sheets || 0} sheets touched`} tone="green" />
          <KpiCard label="Active branches" value={branches.filter((branch) => branch.status === "ACTIVE").length} note={`${workingCopies.length} signed working copies`} tone="amber" />
          <KpiCard label="Review queue" value={mergeRequests.filter((request) => !["MERGED", "CLOSED"].includes(request.status)).length} note={`${members.length} repository members`} tone="ink" />
        </section>

        {tab === "home" ? (
          <div className="home-grid">
            <section className="panel home-hero">
              <div><p className="eyebrow">MY WORKSPACES</p><h2>Business areas</h2><p className="muted">Navigate workbook repositories by the business context they belong to.</p></div>
              <div className="category-grid">
                {categories.filter((item) => item.category_id !== "CAT_HOME").map((category) => (
                  <article key={category.category_id}>
                    <span className="category-path">{category.parent_category_id === "CAT_HOME" ? "ROOT" : "NESTED"}</span>
                    <strong>{category.name}</strong>
                    <small>{category.repository_count} repositories / {category.child_count} subareas</small>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel repository-launchpad">
              <div className="panel-header"><div><p className="eyebrow">OPEN REPOSITORIES</p><h2>Continue your work</h2></div><span className="pill">{datasets.length} repositories</span></div>
              <div className="repository-card-grid">
                {datasets.map((dataset) => (
                  <button key={dataset.table_id} onClick={() => { setSelectedTable(dataset.table_id); setTab("data"); }}>
                    <span className="repo-icon">XL</span>
                    <span><strong>{dataset.repository_name || dataset.original_filename}</strong><small>{dataset.category_name} / {dataset.row_count} rows</small></span>
                    <b>{dataset.my_branch ? "Branch ready" : "View main"}</b>
                  </button>
                ))}
                {!datasets.length ? <div className="empty-state">Upload an Excel workbook to create your first repository.</div> : null}
              </div>
            </section>

            <section className="panel my-work-panel">
              <div className="panel-header"><div><p className="eyebrow">MY WORK</p><h2>Active working copies</h2></div><span className="pill ready">{workingCopies.length} active</span></div>
              <div className="working-copy-list">
                {workingCopies.slice(0, 6).map((copy) => <article key={copy.working_copy_id}><i /><div><strong>{copy.repository_name}</strong><small>{copy.branch_name}</small></div><span>HEAD {String(copy.head_commit_id || "").slice(0, 12)}</span></article>)}
                {!workingCopies.length ? <div className="empty-state">Choose Work on Workbook to create a signed personal branch.</div> : null}
              </div>
            </section>

            <section className="panel recent-panel">
              <div className="panel-header"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>Latest commits</h2></div></div>
              <div className="recent-activity">
                {commits.slice(0, 5).map((commit) => <article key={commit.batch_id}><span>{commit.user_email.slice(0, 2).toUpperCase()}</span><div><strong>{commit.commit_message}</strong><small>{commit.user_email} / v{commit.version}</small></div><time>{new Date(commit.created_at).toLocaleTimeString()}</time></article>)}
                {!commits.length ? <div className="empty-state">No commit activity yet.</div> : null}
              </div>
            </section>
          </div>
        ) : null}

        {tab === "new" ? (
          <section className="panel repository-create-panel">
            <div className="repository-create-copy"><p className="eyebrow">CREATE / REPOSITORY</p><h2>Initialize a governed Excel repository</h2><p className="muted">The authenticated creator becomes owner. Every worksheet is versioned, and main accepts changes only through owner-approved merge requests.</p></div>
            <div className="repository-create-grid">
              <label>Repository name<input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="quarterly-revenue-model" maxLength={120} /></label>
              <label>Source workbook<span className="file-picker"><input type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files[0] || null; setSelectedFile(file); if (file && !repositoryName) setRepositoryName(file.name.replace(/\.xlsx$/i, "")); }} /><span>{selectedFile?.name || "Choose .xlsx"}</span></span></label>
              <label className="wide">Purpose and audit context<textarea value={repositoryDescription} onChange={(event) => setRepositoryDescription(event.target.value)} placeholder="What business process does this repository govern?" /></label>
              <label>Data classification<select value={repositoryClassification} onChange={(event) => setRepositoryClassification(event.target.value)}><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option><option value="public">Public</option></select></label>
              <label>Retention policy<input value={repositoryRetention} onChange={(event) => setRepositoryRetention(event.target.value)} placeholder="3 years" /></label>
            </div>
            <div className="repository-create-footer"><span>Owner: <strong>{auth.user.email}</strong></span><button className="primary-button compact" onClick={handleUpload} disabled={!selectedFile || !repositoryName.trim() || uploading}>{uploading ? "Creating repository..." : "Create repository and download branch"}</button></div>
          </section>
        ) : null}

        {tab === "data" ? (
          <>
            <section className="panel workspace-access">
              <div className="workspace-access-head">
                <div><p className="eyebrow">REAL-TIME WORKSPACE</p><h2>{members.length} member{members.length === 1 ? "" : "s"} <span>{invitations.length ? `+ ${invitations.length} pending` : ""}</span></h2><p>Repository roles and live Excel/browser presence update automatically.</p></div>
                <div className="workspace-live"><i />Live access ledger</div>
              </div>
              {selectedDataset?.owner_user_id === auth.user.user_id ? <form className="workspace-invite" onSubmit={grantAccess}><input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="Invite collaborator by email" required /><select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="viewer">Viewer</option><option value="editor">Editor</option></select><button className="primary-button compact" disabled={inviteBusy}>{inviteBusy ? "Inviting..." : "Invite to workspace"}</button></form> : <div className="shared-notice">Shared with you as {members.find((member) => member.user_id === auth.user.user_id)?.role || "viewer"}</div>}
              <div className="workspace-member-list">
                {members.map((member) => { const presence = activeUsers.find((user) => user.user_id === member.user_id); return <article key={member.user_id}><span className="workspace-avatar">{member.email.slice(0,2).toUpperCase()}<i className={presence ? "online" : ""} /></span><div><strong>{member.display_name || member.email}</strong><small>{member.email}{presence ? ` / active in ${presence.surfaces.join(" + ")}` : " / offline"}</small></div><b className={`role-chip ${member.role}`}>{member.role}</b>{member.role !== "owner" && selectedDataset?.owner_user_id === auth.user.user_id ? <button className="revoke-button" onClick={() => revokeAccess(member.email)}>Revoke</button> : null}</article>; })}
                {invitations.map((invite) => <article key={invite.invitation_id} className="pending-member"><span className="workspace-avatar pending">@</span><div><strong>{invite.email}</strong><small>Invitation activates automatically after OTP sign-in</small></div><b className="role-chip pending">{invite.role} / pending</b>{selectedDataset?.owner_user_id === auth.user.user_id ? <button className="revoke-button" onClick={() => revokeAccess(invite.email)}>Cancel</button> : null}</article>)}
              </div>
            </section>
            <section className="panel">
              <div className="panel-header"><div><p className="eyebrow">{selectedBranchTable ? "BRANCH / LATEST" : "MAIN / LATEST"}</p><h2>{selectedSemanticSheet?.name || "Repository records"}</h2></div><div className="button-group"><button onClick={() => downloadDataset(data?.table_id || viewTableId, "csv")}>Current sheet CSV</button><button onClick={handleBranchDownload}>Complete branch Excel</button></div></div>
              <div className="sheet-tabs">{(branchState?.sheets || repository?.sheets || []).map((sheet) => <button key={sheet.sheet_id} className={selectedSheetId === sheet.sheet_id ? "active" : ""} onClick={() => setSelectedSheetId(sheet.sheet_id)}>{sheet.name || sheet.sheet_name}<small>{sheet.rows?.length ?? ""}</small></button>)}</div>
              {loading ? <div className="loading-state">Loading governed data...</div> : <DataTable data={data} />}
            </section>
          </>
        ) : null}

        {tab === "branches" ? (
          <div className="branch-stage">
            <section className="panel branch-command">
              <div className="branch-command-copy">
                <p className="eyebrow">REPOSITORY / BRANCH INTELLIGENCE</p>
                <h2>{selectedBranch?.branch_name || "main"}</h2>
                <p>Every workbook edit is represented as a stable semantic delta, independent of its Excel address.</p>
                <div className="branch-head-line"><span>BASE <code>{selectedBranch?.base_commit_id || "ROOT"}</code></span><i /><span>HEAD <code>{branchState?.head_commit_id || selectedBranch?.head_commit_id || "ROOT"}</code></span></div>
              </div>
              {selectedBranch?.branch_type === "USER" ? <div className="divergence-strip"><span><b>{branchDivergence?.ahead || 0}</b> commits ahead</span><span><b>{branchDivergence?.behind || 0}</b> commits behind main</span></div> : null}
              <div className="branch-actions"><button className="primary-button compact" onClick={handleWorkOnWorkbook} disabled={workingCopyBusy || selectedBranch?.status === "MERGED"}>{workingCopyBusy ? "Issuing..." : selectedBranch?.status === "MERGED" ? "Workspace merged" : "Open in Excel"}</button><button className="secondary-button" onClick={handleBranchDownload}>Download full branch</button>{selectedBranch?.branch_type === "USER" && selectedBranch?.status === "ACTIVE" ? <button className="secondary-button" onClick={handleSyncMain} disabled={mergeBusy}>Sync main</button> : null}<button className="secondary-button" onClick={() => setTab("history")}>Commit history</button>{selectedBranch?.branch_type === "USER" && selectedBranch?.status === "ACTIVE" ? <button className="secondary-button" onClick={() => setTab("merges")}>Open merge request</button> : null}</div>
              <div className="branch-signal-grid">
                <div><strong>{semanticMetrics.commits || 0}</strong><span>commits</span></div>
                <div><strong>{semanticMetrics.changed_sheets || 0}</strong><span>sheets</span></div>
                <div><strong>{semanticMetrics.changed_rows || 0}</strong><span>rows</span></div>
                <div><strong>{semanticMetrics.changed_cells || 0}</strong><span>cells</span></div>
                <div><strong>{semanticMetrics.formula_changes || 0}</strong><span>formulas</span></div>
              </div>
            </section>
            <section className="panel branch-switchboard">
              <div className="panel-header"><div><p className="eyebrow">BRANCH MAP</p><h2>Protected workspaces</h2></div><span className="pill">{branches.length} branches</span></div>
              <div className="branch-list">
                {branches.map((branch) => (
                  <article key={branch.branch_id} className={`${branch.branch_type === "MAIN" ? "main-branch" : "user-branch"} ${selectedBranch?.branch_id === branch.branch_id ? "selected" : ""}`}>
                    <div className="branch-glyph"><i /><span /></div>
                    <div><div className="branch-title"><strong>{branch.branch_name}</strong><b className={branch.status === "MERGED" ? "merged" : ""}>{branch.branch_type === "MAIN" ? "Protected" : branch.status === "MERGED" ? "Merged" : "Personal"}</b></div><p>{branch.created_by_email || "Git Walk system"} / updated {new Date(branch.updated_at).toLocaleString()}</p><small>{branch.branch_id} / HEAD {branch.head_commit_id}</small></div>
                    <div className="branch-stats"><strong>{branch.active_copies}</strong><span>working copies</span></div>
                    <div className="branch-row-actions"><button className="secondary-button" onClick={() => setSelectedBranchTable(branch.data_table_id === selectedTable ? "" : branch.data_table_id)}>{selectedBranch?.branch_id === branch.branch_id ? "Selected" : "Inspect"}</button>{branch.branch_type === "USER" && (branch.created_by === auth.user.user_id || repository?.capabilities?.delete_repository) ? <button className="danger-button" onClick={() => handleDeleteBranch(branch)}>Delete</button> : null}</div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {tab === "merges" ? (
          <div className="merge-stage">
            <aside className="merge-rail">
              <section className="panel merge-create">
                <p className="eyebrow">MAKER / NEW REQUEST</p>
                <h2>Propose workbook changes</h2>
                <p className="muted">Submit your personal branch to a checker. Protected main is never modified directly.</p>
                <form onSubmit={handleCreateMergeRequest}>
                  <label>Source branch<select value={selectedBranch?.branch_type === "USER" ? selectedBranch.branch_id : ""} disabled><option value={selectedBranch?.branch_type === "USER" ? selectedBranch.branch_id : ""}>{selectedBranch?.branch_type === "USER" ? selectedBranch.branch_name : "Select a personal branch above"}</option></select></label>
                  <label>Request title<input value={mergeTitle} onChange={(event) => setMergeTitle(event.target.value)} placeholder="Correct settlement mapping" required minLength={3} /></label>
                  <label>Review context<textarea value={mergeDescription} onChange={(event) => setMergeDescription(event.target.value)} placeholder="Explain why this change is needed and what the checker should verify." /></label>
                  <button className="primary-button" disabled={mergeBusy || selectedBranch?.branch_type !== "USER" || selectedBranch?.status !== "ACTIVE"}>{mergeBusy ? "Preparing semantic review..." : "Create merge request"}</button>
                </form>
              </section>
              <section className="panel merge-inbox">
                <div className="panel-header"><div><p className="eyebrow">REVIEW QUEUE</p><h2>Requests</h2></div><span className="pill">{mergeRequests.length}</span></div>
                <div className="merge-request-list">
                  {mergeRequests.map((request) => <button key={request.merge_request_id} className={selectedMergeRequestId === request.merge_request_id ? "active" : ""} onClick={() => setSelectedMergeRequestId(request.merge_request_id)}><span className={`mr-state state-${request.status.toLowerCase()}`} /><div><strong>{request.title}</strong><small>{request.source_branch_name} to main</small></div><b>{request.open_conflicts ? `${request.open_conflicts} conflicts` : request.status}</b></button>)}
                  {!mergeRequests.length ? <div className="empty-state compact">No merge requests in this repository.</div> : null}
                </div>
              </section>
            </aside>

            <section className="panel merge-review">
              {!mergeRequestDetail ? <div className="empty-state">Select or create a merge request.</div> : <>
                <div className="merge-review-hero">
                  <div><p className="eyebrow">{mergeRequestDetail.merge_request_id}</p><h2>{mergeRequestDetail.title}</h2><p>{mergeRequestDetail.description || "No additional review context."}</p></div>
                  <span className={`merge-status status-${mergeRequestDetail.status.toLowerCase()}`}>{mergeRequestDetail.status.replaceAll("_", " ")}</span>
                </div>
                <div className="merge-path"><div><span>SOURCE</span><strong>{mergeRequestDetail.source_branch_name}</strong><code>{String(mergeRequestDetail.source_head_commit_id).slice(0, 18)}</code></div><i /><div><span>TARGET</span><strong>{mergeRequestDetail.target_branch_name}</strong><code>{String(mergeRequestDetail.target_head_commit_id).slice(0, 18)}</code></div></div>
                <div className="merge-score-grid">
                  <div><span>Ahead</span><strong>{mergeRequestDetail.divergence?.ahead || 0}</strong></div><div><span>Behind</span><strong>{mergeRequestDetail.divergence?.behind || 0}</strong></div><div><span>Conflicts</span><strong>{mergeRequestDetail.conflicts?.filter((item) => item.status === "OPEN").length || 0}</strong></div><div><span>Validation</span><strong className={mergeRequestDetail.validation_status === "PASSED" ? "good" : "bad"}>{mergeRequestDetail.validation_status}</strong></div>
                </div>
                <div className="change-impact-strip"><span><b>{mergeRequestDetail.change_summary?.cells || 0}</b> cells</span><span><b>{mergeRequestDetail.change_summary?.formulas || 0}</b> formulas</span><span><b>{mergeRequestDetail.change_summary?.rows_added || 0}</b> rows added</span><span><b>{mergeRequestDetail.change_summary?.rows_deleted || 0}</b> rows deleted</span><span><b>{mergeRequestDetail.change_summary?.columns || 0}</b> column operations</span><span><b>{mergeRequestDetail.change_summary?.sheets || 0}</b> sheets</span></div>

                <section className="review-block diff-block">
                  <div className="review-block-title"><div><p className="eyebrow">SEMANTIC DIFFERENCE</p><h3>Workbook changes</h3></div><span>{mergeRequestDetail.change_summary?.total || 0} operations</span></div>
                  <div className="semantic-diff-table">{(mergeRequestDetail.changes || []).slice(0, 100).map((change, index) => <article key={`${change.operation_type}-${change.row_id}-${change.column_id}-${index}`}><b>{change.operation_type}</b><code>{change.sheet_id} / {change.row_id || "sheet"} / {change.column_id || "structure"}</code><span><del>{JSON.stringify(change.old_formula ?? change.old_value ?? null)}</del><i>to</i><ins>{JSON.stringify(change.new_formula ?? change.new_value ?? null)}</ins></span></article>)}</div>
                </section>

                <section className="review-block validation-block">
                  <div className="review-block-title"><div><p className="eyebrow">AUTOMATED GATES</p><h3>Workbook validation</h3></div><span>{mergeRequestDetail.validation?.error_count || 0} errors / {mergeRequestDetail.validation?.warning_count || 0} warnings</span></div>
                  <div className="validation-results">
                    {(mergeRequestDetail.validation?.results || []).map((result) => <article key={result.validation_result_id} className={result.severity.toLowerCase()}><b>{result.severity}</b><div><strong>{result.rule_code.replaceAll("_", " ")}</strong><p>{result.message}</p></div></article>)}
                    {!mergeRequestDetail.validation?.results?.length ? <article className="passed"><b>PASS</b><div><strong>All deterministic gates passed</strong><p>Workbook structure, types, formulas, keys, and row-volume checks are clear.</p></div></article> : null}
                  </div>
                </section>

                {mergeRequestDetail.conflicts?.length ? <section className="review-block conflict-block">
                  <div className="review-block-title"><div><p className="eyebrow">EXCEL-NATIVE RESOLUTION</p><h3>Merge conflicts</h3></div><span>{mergeRequestDetail.conflicts.filter((item) => item.status === "OPEN").length} unresolved</span></div>
                  <div className="conflict-list">{mergeRequestDetail.conflicts.map((conflict, index) => <article key={conflict.conflict_id} className={conflict.status === "RESOLVED" ? "resolved" : ""}><header><span>Conflict {index + 1}</span><strong>{conflict.conflict_type.replaceAll("_", " ")}</strong><code>{conflict.row_id || conflict.column_id || conflict.sheet_id}</code></header><div className="conflict-choices"><div><span>BASE</span><pre>{JSON.stringify(conflict.base_state?.value, null, 2)}</pre></div><div className="main-choice"><span>MAIN</span><pre>{JSON.stringify(conflict.main_state?.value, null, 2)}</pre></div><div className="branch-choice"><span>BRANCH</span><pre>{JSON.stringify(conflict.branch_state?.value, null, 2)}</pre></div></div>{conflict.status === "OPEN" ? <footer><button onClick={() => handleResolveConflict(conflict, "KEEP_MAIN")} disabled={mergeBusy}>Keep main</button><button onClick={() => handleResolveConflict(conflict, "ACCEPT_BRANCH")} disabled={mergeBusy}>Accept branch</button><button onClick={() => handleResolveConflict(conflict, "CUSTOM")} disabled={mergeBusy}>Custom value</button></footer> : <footer className="resolution-note">Resolved as {conflict.resolution_type} by {conflict.resolved_by}</footer>}</article>)}</div>
                </section> : null}

                <section className="review-block approval-block">
                  <div className="review-block-title"><div><p className="eyebrow">OWNER CONTROL</p><h3>Protected-main decision</h3></div><span>{mergeRequestDetail.reviews?.filter((item) => item.decision === "APPROVED").length || 0} owner approvals</span></div>
                  <div className="review-ledger">{(mergeRequestDetail.reviews || []).map((review) => <article key={review.review_id}><span>{review.reviewer_email?.slice(0,2).toUpperCase()}</span><div><strong>{review.reviewer_email}</strong><p>{review.comment_text || "No comment"}</p></div><b className={review.decision.toLowerCase()}>{review.decision}</b></article>)}</div>
                  {mergeRequestDetail.status !== "MERGED" ? repository?.capabilities?.review ? <div className="review-actions"><button className="reject" disabled={mergeBusy} onClick={() => handleReviewMergeRequest("REJECTED")}>Reject</button><button className="approve" disabled={mergeBusy || mergeRequestDetail.validation_status !== "PASSED" || mergeRequestDetail.conflicts?.some((item) => item.status === "OPEN")} onClick={() => handleReviewMergeRequest("APPROVED")}>Approve as owner</button><button className="merge" disabled={mergeBusy || mergeRequestDetail.status !== "APPROVED" || !mergeRequestDetail.heads_current} onClick={handleMergeRequest}>Merge into main</button></div> : <div className="shared-notice">Waiting for the repository owner to review and merge this request.</div> : <div className="merged-banner"><strong>Merged safely into main</strong><span>Commit {mergeRequestDetail.merge_commit_id}; the source working copy is revoked.</span></div>}
                </section>
              </>}
            </section>
          </div>
        ) : null}

        {tab === "settings" ? (
          <div className="settings-grid">
            <section className="panel">
              <p className="eyebrow">REPOSITORY IDENTITY</p><h2>Foundation metadata</h2>
              <dl className="metadata-list"><div><dt>Repository</dt><dd>{repository?.repository_id}</dd></div><div><dt>Main branch</dt><dd>{repository?.default_branch_id}</dd></div><div><dt>Main protection</dt><dd>{repository?.main_protected ? "Enforced" : "Pending first checkout"}</dd></div><div><dt>Stable sheets</dt><dd>{repository?.sheets?.length || 0}</dd></div></dl>
            </section>
            <section className="panel">
              <p className="eyebrow">BUSINESS NAVIGATION</p><h2>Repository category</h2>
              <label>Business area<select value={repository?.category_id || "CAT_UNSORTED"} onChange={(event) => changeBusinessArea(event.target.value)}>{categories.filter((category) => category.category_id !== "CAT_HOME").map((category) => <option key={category.category_id} value={category.category_id}>{category.name}</option>)}</select></label>
              <form className="category-form" onSubmit={addBusinessArea}><select value={categoryParent} onChange={(event) => setCategoryParent(event.target.value)}>{categories.map((category) => <option key={category.category_id} value={category.category_id}>Under {category.name}</option>)}</select><input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="New business area" required /><button className="secondary-button">Create area</button></form>
            </section>
            <section className="panel wide settings-sheets"><p className="eyebrow">STABLE SHEET IDs</p><h2>Repository worksheets</h2><div>{(repository?.sheets || []).map((sheet) => <article key={sheet.sheet_id}><span>{sheet.sheet_order + 1}</span><strong>{sheet.sheet_name}</strong><code>{sheet.sheet_id}</code></article>)}</div></section>
            <section className="panel wide security-posture"><div className="panel-header"><div><p className="eyebrow">SECURITY POSTURE / {securityPosture?.environment || "LOADING"}</p><h2>Production controls</h2></div><span className="pill ready">{Object.values(securityPosture?.controls || {}).filter(Boolean).length} enforced</span></div><div className="control-grid">{Object.entries(securityPosture?.controls || {}).map(([name, enabled]) => <article key={name} className={enabled ? "enabled" : "disabled"}><i>{enabled ? "ON" : "OFF"}</i><strong>{name.replaceAll("_", " ")}</strong></article>)}</div><div className="limit-strip"><span>Upload {Math.round((securityPosture?.upload_limits?.bytes || 0) / 1048576)} MB</span><span>{securityPosture?.upload_limits?.rows || 0} rows</span><span>{securityPosture?.upload_limits?.columns || 0} columns</span><span>{securityPosture?.upload_limits?.sheets || 0} sheets</span><span>{securityPosture?.upload_limits?.timeout_seconds || 0}s processing budget</span></div></section>
            {repository?.capabilities?.delete_repository ? <section className="panel wide danger-zone"><div><p className="eyebrow">OWNER / DANGER ZONE</p><h2>Delete repository</h2><p className="muted">Removes the repository from active work and revokes every signed branch checkout. Immutable audit evidence is retained.</p></div><button className="danger-button" onClick={handleDeleteRepository}>Delete {repository.repository_name}</button></section> : null}
          </div>
        ) : null}

        {tab === "history" ? (
          <div className="history-stage">
            <section className="panel semantic-history">
              <div className="panel-header"><div><p className="eyebrow">{selectedBranch?.branch_name?.toUpperCase() || "MAIN"} / COMMIT DAG</p><h2>Semantic commit graph</h2><p className="muted">Immutable deltas from the selected branch, newest first.</p></div><span className="pill">{semanticCommits.length} commits</span></div>
              <div className="commit-list">
                {semanticCommits.map((commit) => (
                  <article className="commit-card semantic" key={commit.commit_id}>
                    <div className="commit-node" />
                    <div className="commit-main">
                      <div className="commit-title"><strong>{commit.message}</strong><span className="commit-hash">{String(commit.commit_hash || "").slice(0, 9)}</span></div>
                      <p>{commit.author_email || commit.author_user_id} committed {commit.change_count} semantic operation(s)</p>
                      <small>{commit.commit_id} / parent {commit.parent_commit_id || "root"} / {new Date(commit.created_at).toLocaleString()}</small>
                      <div className="operation-chips"><span>{commit.cell_changes || 0} cells</span><span>{commit.formula_changes || 0} formulas</span><span>{commit.row_changes || 0} rows</span><span>{commit.column_changes || 0} columns</span><span>{commit.changed_sheets || 0} sheets</span></div>
                    </div>
                    <div className="commit-actions"><div className="dag-version">v{commit.dataset_version}</div><button onClick={() => inspectCommit(commit.commit_id)}>View diff</button>{commit.status !== "CHECKPOINT" && selectedBranch?.status === "ACTIVE" ? <button title="Create an inverse commit" onClick={() => handleSemanticRevert(commit.commit_id)} disabled={mergeBusy}>Revert</button> : null}</div>
                  </article>
                ))}
                {!semanticCommits.length ? <div className="empty-state">No semantic commits yet. Commit from the Excel taskpane to begin this graph.</div> : null}
              </div>
            </section>
            {selectedCommit ? <section className="panel commit-diff-panel"><div className="panel-header"><div><p className="eyebrow">COMMIT / {selectedCommit.commit_id}</p><h2>{selectedCommit.message}</h2><p className="muted">{selectedCommit.author_email} / {new Date(selectedCommit.created_at).toLocaleString()}</p></div><button className="secondary-button" onClick={() => setSelectedCommit(null)}>Close diff</button></div><div className="commit-file-list">{(selectedCommit.changes || []).map((change) => <article key={change.change_id}><header><strong>{change.operation_type.replaceAll("_", " ")}</strong><span>{change.previous_cell_reference || change.new_cell_reference || change.row_id || change.column_id || change.sheet_id}</span></header><div className="value-diff"><pre className="removed">- {JSON.stringify(change.old_value ?? change.old_formula ?? null)}</pre><pre className="added">+ {JSON.stringify(change.new_value ?? change.new_formula ?? null)}</pre></div><footer><code>{change.sheet_id}</code><span>{change.row_id || "sheet"}</span><span>{change.column_id || "structure"}</span></footer></article>)}</div></section> : null}
            <section className="panel lineage-panel">
              <div className="lineage-title"><div><p className="eyebrow">CELL LINEAGE / FOUNDATION</p><h2>Cell history</h2></div><span className="identity-shield">Stable identity</span></div>
              <p className="muted">Follow one logical cell even when its row or column moves in Excel.</p>
              <div className="lineage-selectors">
                <label>Worksheet<select value={selectedSheetId} onChange={(event) => setSelectedSheetId(event.target.value)}>{(branchState?.sheets || []).map((sheet) => <option key={sheet.sheet_id} value={sheet.sheet_id}>{sheet.name}</option>)}</select></label>
                <label>Stable row<select value={lineageRowId} onChange={(event) => setLineageRowId(event.target.value)}>{(selectedSemanticSheet?.rows || []).map((row) => <option key={row.row_id} value={row.row_id}>Row {row.position + 1} / {row.row_id}</option>)}</select></label>
                <label>Stable column<select value={lineageColumnId} onChange={(event) => setLineageColumnId(event.target.value)}>{(selectedSemanticSheet?.columns || []).map((column) => <option key={column.column_id} value={column.column_id}>{column.name} / {column.column_id}</option>)}</select></label>
              </div>
              <div className="lineage-stream">
                {cellLineage.map((event) => <article key={event.change_id}><span className="lineage-operation">{event.operation_type.replace("CELL_", "")}</span><div><strong>{event.message}</strong><small>{event.author_email} / {new Date(event.created_at).toLocaleString()}</small><code>{JSON.stringify(event.old_value)} -&gt; {JSON.stringify(event.new_value)}</code></div></article>)}
                {!cellLineage.length ? <div className="empty-state compact">No history for this stable cell yet.</div> : null}
              </div>
            </section>
            <section className="panel workbook-blame-panel">
              <div className="panel-header"><div><p className="eyebrow">WHO CHANGED WHAT / CURRENT HEAD</p><h2>Repository cell attribution</h2><p className="muted">Every visible value is attributed to its last semantic commit, author, merge request, and stable Excel coordinate.</p></div><span className="pill ready">{workbookBlame.cells?.length || 0} attributed cells</span></div>
              <div className="blame-table-wrap">
                <table className="blame-table"><thead><tr><th>Cell identity</th><th>Current value</th><th>Last author</th><th>Commit</th><th>Changed</th><th /></tr></thead><tbody>
                  {(workbookBlame.cells || []).slice(0, 500).map((cell) => <tr key={`${cell.sheet_id}-${cell.row_id}-${cell.column_id}`}><td><strong>{cell.column_name}</strong><small>{cell.sheet_name} / row {cell.row_position + 1}</small></td><td><code>{cell.formula || JSON.stringify(cell.value)}</code></td><td>{cell.last_author_email || cell.last_author_user_id}</td><td><span className="trace-commit">{String(cell.last_commit_id || "initial").slice(0, 14)}</span>{cell.merge_request_id ? <small>{cell.merge_request_id}</small> : null}</td><td>{new Date(cell.last_modified_at).toLocaleString()}</td><td><button className="trace-button" onClick={() => inspectBlameCell(cell)}>Trace</button></td></tr>)}
                </tbody></table>
              </div>
              {workbookBlame.truncated ? <p className="blame-note">Showing the first 5,000 cells. Select a sheet or use the traceability API for larger workbooks.</p> : null}
            </section>
            {selectedTrace ? <section className="panel traceability-card"><button className="trace-close" onClick={() => setSelectedTrace(null)}>Close</button><p className="eyebrow">VALUE PROVENANCE</p><h2>{selectedTrace.column_name} / {selectedTrace.row_id}</h2><div className="trace-current"><span>Current</span><strong>{selectedTrace.formula || JSON.stringify(selectedTrace.value)}</strong></div><div className="trace-facts"><div><span>Author</span><strong>{selectedTrace.last_author_email || selectedTrace.last_author_user_id}</strong></div><div><span>Commit</span><strong>{selectedTrace.last_commit_id}</strong></div><div><span>Merge request</span><strong>{selectedTrace.merge_request_id || "Not merged through an MR"}</strong></div><div><span>Modified</span><strong>{new Date(selectedTrace.last_modified_at).toLocaleString()}</strong></div></div><div className="trace-history">{(selectedTrace.history || []).map((event) => <article key={event.change_id}><i /><div><strong>{event.operation_type.replaceAll("_", " ")}</strong><span>{event.author_email} / {event.message}</span><code>{JSON.stringify(event.old_value)} to {JSON.stringify(event.new_value)}</code></div></article>)}</div></section> : null}
          </div>
        ) : null}

        {tab === "analytics" ? (
          <div className="stage4-insights">
            <section className="insight-hero"><div><p className="eyebrow">GOVERNANCE INTELLIGENCE / 24 HOURS</p><h2>Repository pulse</h2><p>Version activity, workflow control, data quality, and platform reliability in one decision surface.</p></div><div className="pulse-score"><span>Merge success</span><strong>{repositoryInsights?.workflow?.merge_success_rate ?? 100}%</strong><small>{repositoryInsights?.workflow?.merged || 0} controlled merges</small></div></section>
            <div className="insight-domain-grid">
              <section className="panel insight-domain version"><p className="eyebrow">VERSION CONTROL</p><h3>{repositoryInsights?.version_control?.commits || 0} commits</h3><div><span>Semantic changes<strong>{repositoryInsights?.version_control?.changes || 0}</strong></span><span>Formula changes<strong>{repositoryInsights?.version_control?.formula_changes || 0}</strong></span><span>Reverts<strong>{repositoryInsights?.version_control?.reverts || 0}</strong></span><span>Most changed<strong>{repositoryInsights?.version_control?.most_changed_sheet || "No changes"}</strong></span></div></section>
              <section className="panel insight-domain workflow"><p className="eyebrow">WORKFLOW</p><h3>{repositoryInsights?.workflow?.active_branches || 0} active branches</h3><div><span>Conflict rate<strong>{repositoryInsights?.workflow?.conflict_rate || 0}%</strong></span><span>Review time<strong>{repositoryInsights?.workflow?.average_review_hours || 0}h</strong></span><span>Branch lifetime<strong>{repositoryInsights?.workflow?.average_branch_lifetime_days || 0}d</strong></span><span>Open copies<strong>{repositoryInsights?.workflow?.active_working_copies || 0}</strong></span><span>Merge requests<strong>{repositoryInsights?.workflow?.merge_requests || 0}</strong></span></div></section>
              <section className="panel insight-domain quality"><p className="eyebrow">DATA QUALITY</p><h3>{repositoryInsights?.data_quality?.failed_runs || 0} failed runs</h3><div><span>Validation runs<strong>{repositoryInsights?.data_quality?.validation_runs || 0}</strong></span><span>Errors<strong>{repositoryInsights?.data_quality?.errors || 0}</strong></span><span>Warnings<strong>{repositoryInsights?.data_quality?.warnings || 0}</strong></span><span>Workbook size<strong>{repositoryInsights?.workbook?.rows || 0} rows</strong></span></div></section>
            </div>
            <section className="panel slo-panel"><div className="panel-header"><div><p className="eyebrow">PLATFORM OBSERVABILITY</p><h2>Service-level signals</h2></div><span className="pill">{operationalMetrics.samples || 0} samples</span></div><div className="slo-grid">{Object.entries(operationalMetrics.metrics || {}).map(([name, metric]) => <article key={name}><span>{name.replaceAll("_", " ")}</span><strong>{metric.average}{name.includes("latency") || name.includes("time") ? " ms" : ""}</strong><small>p95 {metric.p95} / {metric.failures} failed</small><i style={{ "--health": `${Math.max(8, 100 - metric.failures * 10)}%` }} /></article>)}{!Object.keys(operationalMetrics.metrics || {}).length ? <div className="empty-state">Operational samples appear as requests, uploads, commits, validations, and merges run.</div> : null}</div></section>
            <section className="panel wide"><p className="eyebrow">TEAM VELOCITY</p><h2>Top contributors</h2><div className="contributors">{(kpis.top_contributors || []).map((user) => <div key={user.user_id}><span>{user.email}</span><div><i style={{ width: `${Math.min(100, user.commits * 12)}%` }} /></div><strong>{user.commits}</strong></div>)}</div></section>
          </div>
        ) : null}

        {tab === "audit" ? (
          <div className="audit-stage">
            <section className="audit-seal"><div className={auditLedger.integrity?.valid ? "seal valid" : "seal broken"}>{auditLedger.integrity?.valid ? "VERIFIED" : "CHECK"}</div><div><p className="eyebrow">IMMUTABLE EVIDENCE CHAIN</p><h2>{auditLedger.integrity?.event_count || 0} sealed events</h2><p>{auditLedger.integrity?.valid ? "Every event hash and predecessor link verifies from GENESIS to the current ledger head." : "The ledger integrity check requires attention."}</p></div><code>{String(auditLedger.integrity?.head_hash || auditLedger.integrity?.event_id || "GENESIS").slice(0, 36)}</code></section>
            <section className="panel audit-stream-panel"><div className="panel-header"><div><p className="eyebrow">REPOSITORY ACTIVITY</p><h2>Audit ledger</h2></div><span className="pill ready">Append only</span></div><div className="audit-stream">{(auditLedger.events || []).map((event) => <article key={event.event_id} className={`audit-${event.status.toLowerCase()}`}><div className="audit-glyph"><i /></div><div className="audit-copy"><header><strong>{event.event_type.replaceAll("_", " ")}</strong><span>{event.actor_type}</span><time>{new Date(event.created_at).toLocaleString()}</time></header><p>{event.failure_reason || Object.entries(event.event_payload || {}).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" / ") || "Recorded without additional payload"}</p><footer><code>{event.event_id}</code><span>request {event.request_id}</span><span>trace {event.trace_id}</span>{event.commit_id ? <b>{event.commit_id}</b> : null}{event.merge_request_id ? <b>{event.merge_request_id}</b> : null}</footer></div></article>)}{!auditLedger.events?.length ? <div className="empty-state">Stage 4 events will appear as users work with this repository.</div> : null}</div></section>
          </div>
        ) : null}

        {tab === "analytics" ? (
          <section className="panel ai-panel">
            <div className="ai-heading"><div><p className="eyebrow">SEMANTIC INTELLIGENCE / OPENROUTER</p><h2>Repository copilot</h2></div><span className={`pill ${aiModels.configured ? "ready" : ""}`}>{aiModels.configured ? `Connected ${aiModels.masked_key || ""}` : "Connect OpenRouter"}</span></div>
            <p className="muted">Reason over stable cell lineage, formulas, commit history, validation results, and merge conflicts to explain change blast radius before main is updated.</p>
            <div className="ai-prompt-chips"><button onClick={() => setAiQuestion("Prepare an owner review brief for open merge requests. Highlight old and new values, formula impact, anomalies, and a merge recommendation.")}>Owner review brief</button><button onClick={() => setAiQuestion("Detect unusual value, formula, row, and sheet changes in recent commits. Explain likely business impact with evidence.")}>Detect anomalies</button><button onClick={() => setAiQuestion("Create a manager-ready release note for the selected branch, grouped by worksheet and contributor.")}>Release narrative</button></div>
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
