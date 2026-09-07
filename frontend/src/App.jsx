import React, { useEffect, useState } from "react";
import InformationFabric from "./components/InformationFabric";
import AICommandCenter from "./components/AICommandCenter";
import {
  addDatasetMember,
  addOrganizationMember,
  addSecurityGroupMember,
  clearAIConfig,
  clearAuth,
  checkRepositoryName,
  createMergeRequest,
  createAccessPolicy,
  createRoleAssignment,
  createSecurityGroup,
  createServiceAccount,
  deleteBranch,
  deleteRepository,
  downloadDataset,
  downloadRepositoryBranch,
  generateAIInsight,
  getEucAssets,
  getEucInventory,
  getAIModels,
  getAuditEvents,
  getBranchCommits,
  getBranchDivergence,
  getBranchMetrics,
  getBranchState,
  getCommitDetail,
  getCellTraceability,
  getCheckoutOptions,
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
  getRepositoryStorage,
  getSecurityPosture,
  getSecurityAdminOverview,
  getStoredAuth,
  getStableCellHistory,
  getWorkbookChangeActivity,
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
  revokeRoleAssignment,
  saveAIConfig,
  syncBranchWithMain,
  moveRepositoryToCategory,
  migrateRepositoryStorage,
  runStorageGC,
  analyzeEuc,
  analyzeEucMigration,
  buildEucDependencyGraph,
  buildEucIntelligence,
  exportEucInventory,
  getEucBrokenDependencies,
  getEucCellLineage,
  getEucDependencyCycles,
  getEucDependencyHotspots,
  getEucDependencyImpact,
  getEucDependencyOverview,
  getEucDependencySheets,
  getEucComplexity,
  getEucControls,
  getEucFinding,
  getEucFindings,
  getEucIntelligence,
  getEucRiskExplanation,
  getEucMigration,
  getEucMigrationBlockers,
  getEucMigrationComponents,
  getEucMigrationControls,
  getEucMigrationReadiness,
  getEucMigrationTarget,
  getEucMigrationValidation,
  getEucMigrationWaves,
  approveEucApplicationModel,
  buildEucApplicationModel,
  downloadEucApplicationGeneration,
  generateEucApplication,
  getEucApplicationComponents,
  getEucApplicationGeneration,
  getEucApplicationLineage,
  getEucApplicationManifest,
  getEucApplicationModel,
  reviewEucApplicationComponent,
  uploadEuc,
  updateEucFindingStatus,
  updateOrganizationUserStatus,
  overrideEucMigrationComponent,
  uploadAndProvision,
  verifyLoginCode,
  workOnWorkbook,
  getEucStorageSetting,
  saveEucStorageSetting,
} from "./services/api";
import "./styles.css";

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function DependencyWorkspace({ eucId, inventory, onError }) {
  const [overview, setOverview] = useState(null);
  const [sheetGraph, setSheetGraph] = useState({ nodes: [], edges: [] });
  const [hotspots, setHotspots] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [broken, setBroken] = useState([]);
  const [sheetId, setSheetId] = useState("");
  const [cellAddress, setCellAddress] = useState("A1");
  const [lineage, setLineage] = useState(null);
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await getEucDependencyOverview(eucId);
    setOverview(next);
    if (next.status === "NOT_BUILT") {
      setSheetGraph({ nodes: [], edges: [] });
      setHotspots([]); setCycles([]); setBroken([]);
      return;
    }
    const [sheets, hotspotResult, cycleResult, brokenResult] = await Promise.all([
      getEucDependencySheets(eucId), getEucDependencyHotspots(eucId),
      getEucDependencyCycles(eucId), getEucBrokenDependencies(eucId),
    ]);
    setSheetGraph(sheets);
    setHotspots(hotspotResult.hotspots || []);
    setCycles(cycleResult.cycles || []);
    setBroken(brokenResult.references || []);
    setSheetId((current) => current || sheets.nodes?.[0]?.sheet_id || "");
  };

  useEffect(() => {
    setOverview(null); setLineage(null); setImpact(null); setSheetId("");
    load().catch((error) => onError(error.message));
  }, [eucId]);

  const build = async () => {
    setBusy(true);
    try {
      await buildEucDependencyGraph(eucId);
      await load();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  const inspect = async (targetSheet = sheetId, targetCell = cellAddress) => {
    if (!targetSheet || !targetCell.trim()) return;
    setBusy(true);
    try {
      const [nextLineage, nextImpact] = await Promise.all([
        getEucCellLineage(eucId, targetSheet, targetCell.trim().toUpperCase()),
        getEucDependencyImpact(eucId, targetSheet, targetCell.trim().toUpperCase()),
      ]);
      setLineage(nextLineage); setImpact(nextImpact);
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  if (!overview) return <div className="dependency-loading">Loading dependency evidence...</div>;
  if (overview.status === "NOT_BUILT") return <div className="dependency-empty"><div><span>STAGE 2.2</span><h3>Turn formulas into a navigable system map.</h3><p>Build a deterministic dependency graph from the completed inventory. No workbook code, macros, or connections are executed.</p></div><button onClick={build} disabled={busy}>{busy ? "Building graph..." : "Build dependency intelligence"}</button></div>;

  const metrics = overview.metrics || {};
  const sheetNames = Object.fromEntries((sheetGraph.nodes || []).map((sheet) => [sheet.sheet_id, sheet.name]));
  return <div className="dependency-workspace">
    <header className="dependency-command"><div><p className="eyebrow">FORMULA & DEPENDENCY INTELLIGENCE / {overview.engine_version}</p><h3>Calculation topology</h3><p>{overview.freshness === "CURRENT" ? "Aligned with the repository head" : "Source advanced since this graph was built"} / deterministic manifest <code>{overview.graph_manifest_hash?.slice(0, 12)}</code></p></div><button onClick={build} disabled={busy}>{busy ? "Rebuilding..." : "Rebuild graph"}</button></header>
    <div className="dependency-kpis">
      <article><span>Graph</span><strong>{Number(metrics.node_count || 0).toLocaleString()}</strong><small>{Number(metrics.edge_count || 0).toLocaleString()} physical edges</small></article>
      <article><span>Coverage</span><strong>{metrics.dependency_coverage ?? 0}%</strong><small>{metrics.static_resolvability?.dynamic || 0}% dynamic</small></article>
      <article><span>Calc depth</span><strong>{metrics.maximum_calculation_depth || 0}</strong><small>{metrics.calculation_components || 0} components</small></article>
      <article className={metrics.cycle_count ? "attention" : ""}><span>Integrity</span><strong>{metrics.cycle_count || 0}</strong><small>{metrics.broken_count || 0} broken / {metrics.formula_pattern_breaks || 0} pattern breaks</small></article>
    </div>
    <section className="sheet-flow"><div className="dependency-section-head"><div><p className="eyebrow">SHEET GRAPH</p><h3>Workbook calculation flow</h3></div><span>{sheetGraph.edges?.length || 0} cross-sheet paths</span></div><div className="sheet-flow-nodes">{(sheetGraph.nodes || []).map((sheet) => <article key={sheet.sheet_id} className={`role-${sheet.role?.toLowerCase()}`}><i /><div><strong>{sheet.name}</strong><small>{sheet.role} / {sheet.formula_count} formulas</small></div><b>{sheet.used_cells}</b></article>)}</div><div className="sheet-flow-edges">{(sheetGraph.edges || []).map((edge) => <div key={`${edge.source_sheet_id}-${edge.target_sheet_id}`}><span>{sheetNames[edge.source_sheet_id]}</span><i>depends on</i><span>{sheetNames[edge.target_sheet_id]}</span><b>{Number(edge.edge_weight).toLocaleString()}</b></div>)}{!sheetGraph.edges?.length ? <p>No cross-sheet formula paths. In-sheet dependencies remain available in lineage.</p> : null}</div></section>
    <section className="lineage-console"><div className="lineage-query"><p className="eyebrow">CELL EXPLORER</p><h3>Trace before you change</h3><div><select value={sheetId} onChange={(event) => setSheetId(event.target.value)}>{(sheetGraph.nodes || []).map((sheet) => <option key={sheet.sheet_id} value={sheet.sheet_id}>{sheet.name}</option>)}</select><input value={cellAddress} onChange={(event) => setCellAddress(event.target.value)} placeholder="B14" /><button onClick={() => inspect()} disabled={busy}>Trace + impact</button></div><p>References use Excel addresses, while persisted identity remains stable across row and column movement.</p></div>{impact ? <div className="impact-readout"><div><span>Downstream</span><strong>{impact.total_downstream}</strong></div><div><span>Sheets reached</span><strong>{impact.affected_sheet_count}</strong></div><div><span>Maximum depth</span><strong>{impact.maximum_depth}</strong></div><div><span>Technical criticality</span><strong>{impact.technical_criticality}</strong></div></div> : <div className="impact-placeholder">Select a formula or precedent cell to reveal blast radius.</div>}
      {lineage ? <div className="lineage-results">{["upstream", "downstream"].map((direction) => <div key={direction}><h4>{direction}</h4>{(lineage.directions?.[direction]?.nodes || []).map((node) => <button key={node.node_id} onClick={() => { setSheetId(node.sheet_id || sheetId); setCellAddress(node.cell_address || cellAddress); if (node.sheet_id && node.cell_address) inspect(node.sheet_id, node.cell_address); }}><span>{node.display_name}</span><b>depth {node.depth}</b><em>{node.node_role}</em></button>)}{!lineage.directions?.[direction]?.nodes?.length ? <p>No {direction} nodes.</p> : null}</div>)}</div> : null}
    </section>
    <div className="dependency-lower-grid"><section><div className="dependency-section-head"><div><p className="eyebrow">TECHNICAL HOTSPOTS</p><h3>High fan-out logic</h3></div></div>{hotspots.slice(0, 12).map((node, index) => <button className="hotspot-row" key={node.node_id} onClick={() => { if (node.sheet_id && node.cell_address) { setSheetId(node.sheet_id); setCellAddress(node.cell_address); inspect(node.sheet_id, node.cell_address); } }}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{node.display_name}</strong><small>{node.downstream_count} downstream / depth {node.max_downstream_depth}</small></span><em>{node.technical_criticality}</em></button>)}</section><section><div className="dependency-section-head"><div><p className="eyebrow">RESOLUTION HEALTH</p><h3>Review queue</h3></div></div><div className="resolution-health"><article><strong>{cycles.length}</strong><span>circular groups</span></article><article><strong>{broken.length}</strong><span>unresolved references</span></article><article><strong>{metrics.dynamic_count || 0}</strong><span>dynamic targets</span></article></div>{broken.slice(0, 6).map((item) => <div className="broken-row" key={item.edge_id}><strong>{item.source_name}</strong><span>{item.resolution_status}</span></div>)}</section></div>
  </div>;
}

function IntelligenceWorkspace({ eucId, onError }) {
  const [overview, setOverview] = useState(null);
  const [complexity, setComplexity] = useState(null);
  const [risk, setRisk] = useState(null);
  const [controls, setControls] = useState(null);
  const [findings, setFindings] = useState([]);
  const [view, setView] = useState("findings");
  const [profile, setProfile] = useState("DEFAULT");
  const [severity, setSeverity] = useState("");
  const [selectedFinding, setSelectedFinding] = useState(null);
  const [actionStatus, setActionStatus] = useState("ACKNOWLEDGED");
  const [actionReason, setActionReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await getEucIntelligence(eucId);
    setOverview(next);
    if (next.status === "NOT_BUILT") {
      setComplexity(null); setRisk(null); setControls(null); setFindings([]);
      return;
    }
    const [complexityResult, riskResult, controlResult, findingResult] = await Promise.all([
      getEucComplexity(eucId), getEucRiskExplanation(eucId),
      getEucControls(eucId), getEucFindings(eucId, { severity }),
    ]);
    setComplexity(complexityResult); setRisk(riskResult); setControls(controlResult);
    setFindings(findingResult.items || []);
  };

  useEffect(() => {
    setOverview(null); setSelectedFinding(null);
    load().catch((error) => onError(error.message));
  }, [eucId]);

  useEffect(() => {
    if (overview?.status && overview.status !== "NOT_BUILT") {
      getEucFindings(eucId, { severity }).then((result) => setFindings(result.items || []))
        .catch((error) => onError(error.message));
    }
  }, [severity]);

  const build = async () => {
    setBusy(true);
    try { await buildEucIntelligence(eucId, profile); await load(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  const openFinding = async (findingId) => {
    setBusy(true);
    try { setSelectedFinding(await getEucFinding(eucId, findingId)); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  const applyFindingAction = async () => {
    if (!selectedFinding || !actionReason.trim()) return;
    setBusy(true);
    try {
      const updated = await updateEucFindingStatus(
        eucId, selectedFinding.finding_id, actionStatus, actionReason.trim(),
        actionStatus === "ACCEPTED_RISK" ? new Date(Date.now() + 90 * 86400000).toISOString() : null,
      );
      setSelectedFinding(updated); setActionReason(""); await load();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  if (!overview) return <div className="intelligence-loading">Loading control intelligence...</div>;
  if (overview.status === "NOT_BUILT") return <div className="intelligence-onboarding">
    <div><span>STAGE 2.3 / CONTROL INTELLIGENCE</span><h3>Translate spreadsheet machinery into defensible decisions.</h3><p>Score complexity, separate inherent from residual risk, measure control coverage, and generate evidence-linked findings. The engine is deterministic and never executes workbook code.</p></div>
    <div><label>Scoring profile<select value={profile} onChange={(event) => setProfile(event.target.value)}>{(overview.available_profiles || ["DEFAULT"]).map((item) => <option key={item}>{item}</option>)}</select></label><button onClick={build} disabled={busy}>{busy ? "Building evidence..." : "Run control intelligence"}</button></div>
  </div>;

  const scores = overview.scores || {};
  const activeComponents = view === "complexity" ? complexity?.components : risk?.components;
  return <div className="intelligence-workspace">
    <header className="intelligence-command">
      <div><p className="eyebrow">RISK & CONTROL INTELLIGENCE / {overview.engine_version}</p><h3>Decision assurance map</h3><p><b className={overview.freshness === "CURRENT" ? "current" : "stale"}>{overview.freshness}</b> source / rules {overview.ruleset_version} / manifest <code>{overview.result_manifest_hash?.slice(0, 12)}</code></p></div>
      <div><select value={profile} onChange={(event) => setProfile(event.target.value)}><option>DEFAULT</option><option>FINANCIAL_MODEL</option><option>REGULATORY_REPORTING</option><option>OPERATIONS</option><option>PLANNING</option><option>ANALYTICS</option></select><button onClick={build} disabled={busy}>{busy ? "Analyzing..." : "Re-run analysis"}</button></div>
    </header>
    <div className="assurance-scoreboard">
      {[['complexity', 'Complexity', scores.complexity, 'Structural burden'], ['inherent', 'Inherent risk', scores.inherent_risk, 'Before controls'], ['control', 'Control strength', scores.control_strength, 'Native + Git Walk'], ['residual', 'Residual risk', scores.residual_risk, 'After controls']].map(([tone, label, value, caption]) => <article key={tone} className={`score-${tone}`}><span>{label}</span><strong>{Math.round(value || 0)}</strong><div><i style={{ width: `${value || 0}%` }} /></div><small>{caption} / {(overview.classifications?.[tone === 'inherent' ? 'inherent_risk' : tone === 'control' ? 'control_strength' : tone === 'residual' ? 'residual_risk' : 'complexity'] || '').replaceAll('_', ' ')}</small></article>)}
    </div>
    <nav className="intelligence-tabs">{[["findings", `Findings ${findings.length}`], ["complexity", "Complexity"], ["risk", "Risk model"], ["controls", "Controls"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>

    {view === "findings" ? <div className="finding-layout">
      <section className="finding-register">
        <header><div><p className="eyebrow">EVIDENCE REGISTER</p><h3>Issues that require a decision</h3></div><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All severities</option><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option><option>INFO</option></select></header>
        <div className="finding-count-strip">{["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((item) => <span key={item} className={`sev-${item.toLowerCase()}`}><b>{overview.finding_counts?.[item] || 0}</b>{item}</span>)}</div>
        <div className="finding-list">{findings.map((finding) => <button key={finding.finding_id} className={selectedFinding?.finding_id === finding.finding_id ? "active" : ""} onClick={() => openFinding(finding.finding_id)}><i className={`sev-${finding.severity.toLowerCase()}`}>{finding.severity.slice(0, 1)}</i><div><strong>{finding.title}</strong><small>{finding.rule_id.replaceAll("_", " ")} / {finding.sheet_id || "workbook"}{finding.cell_address ? `!${finding.cell_address}` : ""}</small></div><span>{finding.status.replaceAll("_", " ")}</span></button>)}{!findings.length ? <div className="empty-state compact">No findings match this evidence filter.</div> : null}</div>
      </section>
      <aside className={`finding-evidence ${selectedFinding ? "open" : ""}`}>{selectedFinding ? <>
        <header><span className={`severity-badge sev-${selectedFinding.severity.toLowerCase()}`}>{selectedFinding.severity}</span><button onClick={() => setSelectedFinding(null)}>Close</button></header>
        <p className="eyebrow">{selectedFinding.rule_id}</p><h3>{selectedFinding.title}</h3><p>{selectedFinding.description}</p>
        <dl><div><dt>Where</dt><dd>{selectedFinding.sheet_id || "Workbook"}{selectedFinding.cell_address ? ` / ${selectedFinding.cell_address}` : ""}</dd></div><div><dt>Confidence</dt><dd>{Math.round(selectedFinding.confidence * 100)}%</dd></div><div><dt>Impact</dt><dd>{selectedFinding.dependency_impact?.downstream || 0} downstream / {selectedFinding.dependency_impact?.sheets || 0} sheets</dd></div><div><dt>Evidence hash</dt><dd><code>{selectedFinding.evidence_manifest_hash?.slice(0, 16)}</code></dd></div></dl>
        <div className="finding-proof"><span>Observed evidence</span><pre>{JSON.stringify(selectedFinding.evidence?.evidence || {}, null, 2)}</pre></div>
        <div className="finding-remediation"><span>Recommended control</span><strong>{selectedFinding.remediation_code?.replaceAll("_", " ")}</strong></div>
        <div className="finding-action"><select value={actionStatus} onChange={(event) => setActionStatus(event.target.value)}><option>ACKNOWLEDGED</option><option>IN_REVIEW</option><option>REMEDIATION_PLANNED</option><option>ACCEPTED_RISK</option><option>RESOLVED</option><option>FALSE_POSITIVE</option><option>SUPPRESSED</option></select><textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} placeholder="Record the evidence-backed decision..." /><button onClick={applyFindingAction} disabled={busy || !actionReason.trim()}>Record decision</button></div>
      </> : <div className="finding-placeholder"><span>01</span><h3>Select a finding</h3><p>Inspect what happened, where it occurred, why it matters, the dependency blast radius, and the immutable evidence behind the rule.</p></div>}</aside>
    </div> : null}

    {view === "complexity" || view === "risk" ? <section className="score-explain">
      <header><div><p className="eyebrow">WEIGHTED CONTRIBUTION MODEL</p><h3>{view === "complexity" ? "Why this workbook is complex" : "Why this workbook carries risk"}</h3></div><strong>{Math.round(view === "complexity" ? complexity?.score || 0 : risk?.score || 0)}<small>/100</small></strong></header>
      <div>{(activeComponents || []).map((component) => <article key={component.dimension}><div><strong>{component.dimension.replaceAll("_", " ")}</strong><span>{component.classification.replaceAll("_", " ")}</span></div><div className="contribution-track"><i style={{ width: `${component.raw_score}%` }} /><b style={{ left: `${Math.min(96, component.raw_score)}%` }}>{Math.round(component.raw_score)}</b></div><p>{component.explanation}</p><small>Weight {Math.round(component.weight * 100)}% / contribution {component.contribution}</small></article>)}</div>
      {view === "risk" ? <footer><span>Inherent <b>{risk?.inherent_risk}</b></span><i>minus {risk?.control_reduction} control reduction</i><span>Residual <b>{risk?.residual_risk}</b></span></footer> : null}
    </section> : null}

    {view === "controls" ? <section className="control-deck">
      <header><div><p className="eyebrow">CONTROL COVERAGE</p><h3>Protection you can prove</h3></div><div><span>Workbook native <b>{Math.round(controls?.summary?.native_control_strength || 0)}</b></span><span>Git Walk governance <b>{Math.round(controls?.summary?.governance_score || 0)}</b></span></div></header>
      <div>{(controls?.controls || []).map((control) => <article key={control.control_code}><span className={`source-${control.control_source.toLowerCase()}`}>{control.control_source}</span><h4>{control.control_name}</h4><p>{control.control_category} / {control.control_count} observed control{control.control_count === 1 ? "" : "s"}</p><div><i style={{ width: `${control.weighted_coverage_score}%` }} /></div><footer><strong>{Math.round(control.weighted_coverage_score)}% coverage</strong><em>{control.effectiveness}</em></footer></article>)}</div>
    </section> : null}
  </div>;
}

function MigrationWorkspace({ eucId, onError }) {
  const [overview, setOverview] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [blockers, setBlockers] = useState([]);
  const [components, setComponents] = useState([]);
  const [waves, setWaves] = useState([]);
  const [target, setTarget] = useState({ architecture: { components: [], edges: [] }, mappings: [] });
  const [controls, setControls] = useState([]);
  const [validation, setValidation] = useState([]);
  const [view, setView] = useState("overview");
  const [mode, setMode] = useState("");
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [overrideMode, setOverrideMode] = useState("RETAIN_IN_EXCEL");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await getEucMigration(eucId);
    setOverview(next);
    if (next.status === "NOT_BUILT") return;
    const [ready, blockerResult, componentResult, waveResult, targetResult, controlResult, validationResult] = await Promise.all([
      getEucMigrationReadiness(eucId), getEucMigrationBlockers(eucId), getEucMigrationComponents(eucId),
      getEucMigrationWaves(eucId), getEucMigrationTarget(eucId), getEucMigrationControls(eucId),
      getEucMigrationValidation(eucId),
    ]);
    setReadiness(ready); setBlockers(blockerResult.blockers || []); setComponents(componentResult.items || []);
    setWaves(waveResult.items || []); setTarget(targetResult); setControls(controlResult.items || []);
    setValidation(validationResult.items || []);
  };

  useEffect(() => {
    setOverview(null); setSelectedUnit(null); setView("overview");
    load().catch((error) => onError(error.message));
  }, [eucId]);

  useEffect(() => {
    if (overview?.status && overview.status !== "NOT_BUILT") {
      getEucMigrationComponents(eucId, { mode }).then((result) => setComponents(result.items || []))
        .catch((error) => onError(error.message));
    }
  }, [mode]);

  const analyze = async () => {
    setBusy(true);
    try { await analyzeEucMigration(eucId); await load(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  const applyOverride = async () => {
    if (!selectedUnit || !overrideReason.trim()) return;
    setBusy(true);
    try {
      const updated = await overrideEucMigrationComponent(
        eucId, selectedUnit.unit_id, overrideMode, overrideReason.trim(),
      );
      setSelectedUnit(updated); setOverrideReason("");
      const result = await getEucMigrationComponents(eucId, { mode }); setComponents(result.items || []);
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  if (!overview) return <div className="migration-loading">Loading migration evidence...</div>;
  if (overview.status === "NOT_BUILT") return <div className="migration-onboarding"><div><span>STAGE 2.4 / MIGRATION INTELLIGENCE</span><h3>Convert workbook evidence into an executable modernization blueprint.</h3><p>Classify every migration unit, resolve blockers, order dependent domains, preserve controls, map target technology, and define historical parity tests. This produces a blueprint only; it does not generate or retire an application.</p></div><button onClick={analyze} disabled={busy}>{busy ? "Building blueprint..." : "Analyze migration path"}</button></div>;

  const coverage = overview.coverage || {};
  const summary = overview.summary || {};
  const blockerCounts = summary.blockers?.by_severity || {};
  const validationCounts = summary.validation?.by_type || {};
  return <div className="migration-workspace">
    <header className="migration-command"><div><p className="eyebrow">MIGRATION BLUEPRINT / {overview.engine_version}</p><h3>{overview.strategy?.replaceAll("_", " ")}</h3><p><b className={overview.freshness === "CURRENT" ? "current" : "stale"}>{overview.freshness}</b> source / {overview.ruleset_version} / blueprint <code>{overview.blueprint_manifest_hash?.slice(0, 12)}</code></p></div><button onClick={analyze} disabled={busy}>{busy ? "Replanning..." : "Rebuild blueprint"}</button></header>
    <section className="migration-hero-score"><div className="readiness-dial" style={{ "--readiness": `${overview.readiness.score * 3.6}deg` }}><div><strong>{Math.round(overview.readiness.score)}</strong><span>/ 100</span></div></div><div><p className="eyebrow">MIGRATION READINESS</p><h3>{overview.readiness.classification.replaceAll("_", " ")}</h3><p>{summary.strategy?.reason}</p></div><div className="migration-effort"><span>Estimated effort</span><strong>{overview.effort_class}</strong><small>{summary.effort?.points || 0} relative points</small></div></section>
    <div className="migration-coverage">{[["AUTO_MIGRATABLE", "Auto", "auto"], ["ASSISTED_MIGRATION", "Human assisted", "assisted"], ["MANUAL_REENGINEERING", "Manual", "manual"], ["UNSUPPORTED", "Unsupported", "unsupported"]].map(([key, label, tone]) => <article key={key} className={`coverage-${tone}`}><span>{label}</span><strong>{Math.round(coverage[key] || 0)}%</strong><div><i style={{ width: `${coverage[key] || 0}%` }} /></div></article>)}</div>
    <nav className="migration-tabs">{[["overview", "Overview"], ["readiness", "Readiness"], ["blockers", `Blockers ${blockers.length}`], ["components", `Components ${overview.unit_count}`], ["target", "Target architecture"], ["waves", "Waves"], ["controls", "Controls"], ["validation", "Validation"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>

    {view === "overview" ? <div className="migration-overview-grid">
      <section><p className="eyebrow">MAJOR BLOCKERS</p><h3>What must move first</h3><div className="blocker-radar">{["CRITICAL", "HIGH", "MEDIUM"].map((severity) => <article key={severity}><strong>{blockerCounts[severity] || 0}</strong><span>{severity}</span></article>)}</div>{blockers.slice(0, 4).map((item) => <button key={item.blocker_id} onClick={() => setView("blockers")}><b>{item.blocker_type.replaceAll("_", " ")}</b><span>{item.affected_component}</span><em>{item.effort_class}</em></button>)}</section>
      <section><p className="eyebrow">EXECUTION PATH</p><h3>{waves.length} governed waves</h3><div className="mini-wave-map">{waves.map((wave) => <article key={wave.wave_number}><span>W{wave.wave_number}</span><div><strong>{wave.wave_name}</strong><small>{wave.unit_count} units / {wave.effort_class}</small></div></article>)}</div></section>
      <section><p className="eyebrow">CONTROL PRESERVATION</p><h3>Do not lose assurance</h3><div className="preservation-summary">{Object.entries(summary.control_preservation || {}).map(([key, value]) => <span key={key}><b>{value}</b>{key.replaceAll("_", " ")}</span>)}</div></section>
      <section><p className="eyebrow">HISTORICAL PARITY</p><h3>{summary.validation?.historical_commits || 0} versions planned</h3><p>Replay prior semantic commits against target outputs to validate behavior across time, not only today&apos;s workbook.</p><strong>{summary.validation?.total || 0} acceptance tests</strong></section>
    </div> : null}

    {view === "readiness" ? <section className="readiness-board"><header><div><p className="eyebrow">EXPLAINABLE READINESS</p><h3>Why this migration can or cannot proceed</h3></div><strong>{Math.round(readiness?.score || 0)}</strong></header><div>{(readiness?.dimensions || []).map((item) => <article key={item.dimension}><div><strong>{item.dimension.replaceAll("_", " ")}</strong><b>{Math.round(item.score)}</b></div><div><i style={{ width: `${item.score}%` }} /></div><p>{item.explanation}</p><small>Weight {Math.round(item.weight * 100)}% / contribution {item.contribution}</small></article>)}</div></section> : null}

    {view === "blockers" ? <section className="migration-blockers"><header><div><p className="eyebrow">BLOCKER REGISTER</p><h3>Evidence before execution</h3></div><span>{overview.critical_blocker_count} critical</span></header>{blockers.map((item, index) => <article key={item.blocker_id}><span className={`blocker-index severity-${item.severity.toLowerCase()}`}>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.blocker_type.replaceAll("_", " ")}</strong><small>{item.category} / {item.affected_component}</small><p>{item.migration_effect}</p></div><div><span>Remediation</span><p>{item.remediation}</p></div><em>{item.severity}<b>{item.effort_class}</b></em></article>)}</section> : null}

    {view === "components" ? <div className="migration-component-layout"><section className="migration-components"><header><div><p className="eyebrow">MIGRATION UNIT MATRIX</p><h3>Engine recommendation and owner decision</h3></div><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">All modes</option><option>AUTO_MIGRATABLE</option><option>ASSISTED_MIGRATION</option><option>MANUAL_REENGINEERING</option><option>RETAIN_IN_EXCEL</option><option>UNSUPPORTED</option><option>RETIRE</option></select></header><div className="migration-component-table"><div><span>Component</span><span>Type</span><span>Difficulty</span><span>Mode</span><span>Wave</span></div>{components.map((unit) => <button key={unit.unit_id} className={selectedUnit?.unit_id === unit.unit_id ? "active" : ""} onClick={() => { setSelectedUnit(unit); setOverrideMode(unit.effective_mode); }}><span><strong>{unit.source_name}</strong><small>{unit.target_component}</small></span><span>{unit.source_type.replaceAll("_", " ")}</span><span>{unit.difficulty}</span><span className={`mode-${unit.effective_mode.toLowerCase()}`}>{unit.effective_mode.replaceAll("_", " ")}{unit.manual_mode ? <small>overridden</small> : null}</span><span>W{unit.wave_number}</span></button>)}</div></section><aside className={selectedUnit ? "unit-decision open" : "unit-decision"}>{selectedUnit ? <><button onClick={() => setSelectedUnit(null)}>Close</button><p className="eyebrow">MANUAL DECISION / AUDITED</p><h3>{selectedUnit.source_name}</h3><dl><div><dt>Engine</dt><dd>{selectedUnit.engine_mode.replaceAll("_", " ")}</dd></div><div><dt>Target</dt><dd>{selectedUnit.target_type.replaceAll("_", " ")}</dd></div><div><dt>Weight</dt><dd>{selectedUnit.migration_weight}</dd></div><div><dt>Wave</dt><dd>{selectedUnit.wave_number}</dd></div></dl><p>{selectedUnit.rationale}</p><select value={overrideMode} onChange={(event) => setOverrideMode(event.target.value)}>{["AUTO_MIGRATABLE", "ASSISTED_MIGRATION", "MANUAL_REENGINEERING", "RETAIN_IN_EXCEL", "UNSUPPORTED", "RETIRE"].map((item) => <option key={item}>{item}</option>)}</select><textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Explain the domain decision without overwriting the engine evidence..." /><button className="record-override" onClick={applyOverride} disabled={busy || !overrideReason.trim()}>Record override</button>{selectedUnit.override_reason ? <small>Current decision: {selectedUnit.override_reason}</small> : null}</> : <div><span>24</span><h3>Select a migration unit</h3><p>Inspect its engine recommendation, target mapping, weight, sequence, and any domain-owner override.</p></div>}</aside></div> : null}

    {view === "target" ? <section className="target-architecture"><header><div><p className="eyebrow">TARGET OPERATING MODEL</p><h3>Decompose the workbook, not its problems</h3></div><span>{target.architecture?.strategy?.replaceAll("_", " ")}</span></header><div className="architecture-canvas">{(target.architecture?.components || []).map((item, index) => <article key={item.id} style={{ "--node-index": index }}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.name}</strong><small>{item.unit_count} units / {item.target_types.join(" + ")}</small></div></article>)}</div><div className="architecture-edges">{(target.architecture?.edges || []).map((edge) => <span key={`${edge.source}-${edge.target}`}><b>{edge.source.replaceAll("_", " ")}</b><i>→</i><b>{edge.target.replaceAll("_", " ")}</b></span>)}</div></section> : null}

    {view === "waves" ? <section className="migration-waves"><header><p className="eyebrow">DEPENDENCY-ORDERED DELIVERY</p><h3>Foundation before presentation</h3></header><div>{waves.map((wave) => <article key={wave.wave_number}><div><span>WAVE</span><strong>{wave.wave_number}</strong></div><section><h4>{wave.wave_name}</h4><p>{wave.objective}</p><footer><span>{wave.unit_count} migration units</span><b>{wave.effort_class} effort</b></footer></section></article>)}</div></section> : null}

    {view === "controls" ? <section className="migration-control-map"><header><p className="eyebrow">CONTROL PRESERVATION MATRIX</p><h3>Equivalent or stronger by design</h3></header>{controls.map((item) => <article key={item.control_mapping_id}><div><strong>{item.source_control_name}</strong><small>{item.source_control_code}</small></div><span>→</span><div><strong>{item.target_control}</strong><small>{item.rationale}</small></div><em className={`preserve-${item.preservation_status.toLowerCase()}`}>{item.preservation_status.replaceAll("_", " ")}</em></article>)}</section> : null}

    {view === "validation" ? <section className="migration-validation"><header><div><p className="eyebrow">PARITY & ACCEPTANCE PLAN</p><h3>Prove behavior across versions</h3></div><span>{validation.length} tests / {summary.validation?.historical_commits || 0} commits</span></header><div className="validation-kpis">{Object.entries(validationCounts).map(([key, value]) => <article key={key}><strong>{value}</strong><span>{key.replaceAll("_", " ")}</span></article>)}</div><div className="validation-list">{validation.map((item) => <article key={item.validation_id}><span>{item.priority}</span><div><strong>{item.validation_type.replaceAll("_", " ")}</strong><small>{item.source_output} → {item.target_output}</small></div><div><b>{item.comparison_method.replaceAll("_", " ")}</b><small>{item.historical_replay_count} historical versions</small></div></article>)}</div></section> : null}
  </div>;
}

function NativeModelWorkspace({ eucId, onError }) {
  const [overview, setOverview] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [components, setComponents] = useState([]);
  const [lineage, setLineage] = useState([]);
  const [generation, setGeneration] = useState(null);
  const [view, setView] = useState("overview");
  const [componentType, setComponentType] = useState("");
  const [selected, setSelected] = useState(null);
  const [reviewReason, setReviewReason] = useState("Confirmed against the source workbook and migration blueprint.");
  const [lineageQuery, setLineageQuery] = useState("");
  const [generationMode, setGenerationMode] = useState("MODEL_ONLY");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await getEucApplicationModel(eucId);
    setOverview(next);
    if (next.status === "NOT_BUILT") {
      setManifest(null); setComponents([]); setLineage([]); setGeneration(null);
      return;
    }
    const [air, componentResult, lineageResult, generationResult] = await Promise.all([
      getEucApplicationManifest(eucId), getEucApplicationComponents(eucId),
      getEucApplicationLineage(eucId), getEucApplicationGeneration(eucId),
    ]);
    setManifest(air); setComponents(componentResult.items || []);
    setLineage(lineageResult.items || []); setGeneration(generationResult);
  };

  useEffect(() => {
    setOverview(null); setView("overview"); setSelected(null);
    load().catch((error) => onError(error.message));
  }, [eucId]);

  const run = async (action) => {
    setBusy(true);
    try { await action(); await load(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  const build = () => run(() => buildEucApplicationModel(eucId));
  const approve = () => run(() => approveEucApplicationModel(eucId));
  const generate = () => run(() => generateEucApplication(eucId, generationMode));
  const review = (decision) => {
    if (!selected || !reviewReason.trim()) return;
    run(() => reviewEucApplicationComponent(eucId, selected.component_id, decision, reviewReason.trim()))
      .then(() => setSelected(null));
  };
  const filterComponents = async (type) => {
    setComponentType(type);
    try { setComponents((await getEucApplicationComponents(eucId, type)).items || []); }
    catch (error) { onError(error.message); }
  };
  const searchLineage = async () => {
    try { setLineage((await getEucApplicationLineage(eucId, lineageQuery.trim())).items || []); }
    catch (error) { onError(error.message); }
  };

  if (!overview) return <div className="native-loading">Loading native application evidence...</div>;
  if (overview.status === "NOT_BUILT") return <div className="native-onboarding"><div><span>STAGE 2.5 / EUC MODERNIZATION COMPILER</span><h3>Turn the governed workbook into a native application model.</h3><p>Build technology-neutral AIR for domains, data, calculations, APIs, screens, workflows, controls, and tests. Every inferred object retains source provenance and must pass review before scaffold generation.</p></div><div><b>2.1</b><i>Inventory</i><b>2.2</b><i>Graph</i><b>2.3</b><i>Risk</i><b>2.4</b><i>Plan</i><b className="active">2.5</b><i>Build</i><button onClick={build} disabled={busy}>{busy ? "Compiling AIR..." : "Build native model"}</button></div></div>;

  const counts = overview.summary?.counts || {};
  const validation = manifest?.validation || { errors: [], warnings: [], checks: {} };
  const displayed = components;
  const statusTone = ["APPROVED", "CODE_GENERATED"].includes(overview.status) ? "ready" : overview.status === "VALIDATION_FAILED" ? "blocked" : "review";
  return <div className="native-workspace">
    <header className="native-command"><div><p className="eyebrow">APPLICATION INTERMEDIATE REPRESENTATION / {overview.air_version}</p><h3>{manifest?.application?.name || "Native application"}</h3><p><code>{overview.manifest_hash?.slice(0, 14)}</code> / source {overview.source_commit_id || "uncommitted"} / deterministic compiler input</p></div><div><span className={`native-status ${statusTone}`}>{overview.status.replaceAll("_", " ")}</span><button onClick={build} disabled={busy}>{busy ? "Working..." : "Rebuild AIR"}</button></div></header>

    <section className="native-score"><div className="confidence-orbit" style={{ "--confidence": `${overview.migration_confidence * 3.6}deg` }}><div><strong>{Math.round(overview.migration_confidence)}</strong><span>confidence</span></div></div><div><p className="eyebrow">EVIDENCE-BASED MIGRATION CONFIDENCE</p><h3>{overview.migration_confidence >= 90 ? "Ready for governed review" : "Model needs engineering attention"}</h3><p>Coverage, dependency resolution, inference confidence, blocker state, and AIR validation contribute to this score.</p></div><div className="native-gates"><span><b>{overview.raw_coverage}%</b>source mapped</span><span><b>{overview.criticality_weighted_coverage}%</b>critical logic</span><span><b>{overview.review_required_count}</b>reviews open</span><span><b>{overview.validation_error_count}</b>hard errors</span></div></section>

    <nav className="native-tabs">{[["overview", "Model overview"], ["components", "Architecture"], ["lineage", "Source mapping"], ["validation", "Validation"], ["generation", "Generation"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>

    {view === "overview" ? <>
      <section className="native-count-grid">{[["Domains", counts.domains, "DM"], ["Entities", counts.entities, "DB"], ["Calculations", counts.calculations, "FX"], ["Services", counts.services, "SV"], ["APIs", counts.apis, "AP"], ["Screens", counts.screens, "UI"], ["Workflows", counts.workflows, "WF"], ["Controls", counts.controls, "CT"]].map(([label, value, icon]) => <article key={label}><span>{icon}</span><div><strong>{value || 0}</strong><small>{label}</small></div></article>)}</section>
      <div className="native-overview-grid"><section><p className="eyebrow">DOMAIN MAP</p><h3>From workbook zones to software boundaries</h3><div className="domain-map">{(manifest?.domains || []).map((domain, index) => <article key={domain.component_id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{domain.name}</strong><small>{domain.generation_policy.replaceAll("_", " ")} / {Math.round(domain.confidence * 100)}%</small></div></article>)}</div></section><section className="screen-preview"><p className="eyebrow">GENERATED EXPERIENCE MODEL</p><h3>Purpose before pixels</h3>{(manifest?.screens || []).slice(0, 4).map((screen) => <article key={screen.component_id}><div><span>{screen.screen_type.replaceAll("_", " ")}</span><strong>{screen.name}</strong></div><small>{screen.components.join(" / ")}</small></article>)}</section></div>
    </> : null}

    {view === "components" ? <div className="native-component-layout"><section className="native-components"><header><div><p className="eyebrow">CANONICAL AIR OBJECTS</p><h3>Review the compiler&apos;s semantic decisions</h3></div><select value={componentType} onChange={(event) => filterComponents(event.target.value)}><option value="">All components</option>{["DOMAIN", "ENTITY", "RELATIONSHIP", "CALCULATION", "BUSINESS_RULE", "SERVICE", "API", "SCREEN", "WORKFLOW", "INTEGRATION", "CONTROL", "ROLE", "TEST"].map((type) => <option key={type}>{type}</option>)}</select></header><div className="native-component-table"><div><span>Component</span><span>Type</span><span>Confidence</span><span>Generation</span><span>Review</span></div>{displayed.map((item) => <button key={item.component_id} className={selected?.component_id === item.component_id ? "active" : ""} onClick={() => setSelected(item)}><span><strong>{item.name}</strong><small>{item.component_id}</small></span><span>{item.component_type.replaceAll("_", " ")}</span><span><i style={{ width: `${item.confidence * 100}%` }} /><b>{Math.round(item.confidence * 100)}%</b></span><span>{item.generation_policy.replaceAll("_", " ")}</span><em className={`review-${item.review_state.toLowerCase()}`}>{item.review_state.replaceAll("_", " ")}</em></button>)}</div></section><aside className={selected ? "native-review open" : "native-review"}>{selected ? <><button onClick={() => setSelected(null)}>Close</button><p className="eyebrow">HUMAN SEMANTIC GATE</p><h3>{selected.name}</h3><dl><div><dt>Source</dt><dd>{selected.provenance?.source_type}</dd></div><div><dt>Location</dt><dd>{selected.provenance?.sheet || selected.provenance?.source_range || "Workbook"}</dd></div><div><dt>Confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd></div><div><dt>Policy</dt><dd>{selected.generation_policy}</dd></div></dl><p>Confirm only after this target meaning matches the workbook&apos;s intended business behavior. Rejected components remain in lineage but are excluded from generation.</p><textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /><div><button onClick={() => review("REJECTED")} disabled={busy}>Reject mapping</button><button onClick={() => review("CONFIRMED")} disabled={busy}>Confirm mapping</button></div></> : <div><span>AIR</span><h3>Select a component</h3><p>Inspect confidence, provenance, generation policy, and the human review state.</p></div>}</aside></div> : null}

    {view === "lineage" ? <section className="native-lineage"><header><div><p className="eyebrow">SOURCE → TARGET DIGITAL THREAD</p><h3>Explain every generated decision</h3></div><div><input value={lineageQuery} onChange={(event) => setLineageQuery(event.target.value)} placeholder="Search sheet, formula, component, or API" /><button onClick={searchLineage}>Trace</button></div></header><div>{lineage.map((item) => <article key={item.lineage_id}><div><span>{item.source_type.replaceAll("_", " ")}</span><strong>{item.source_location || item.source_id}</strong><small>{item.source_id}</small></div><i>→</i><div><span>{item.target_type.replaceAll("_", " ")}</span><strong>{item.target_path || item.target_id}</strong><small>{item.target_id}</small></div><em>{Math.round(item.confidence * 100)}%</em></article>)}</div></section> : null}

    {view === "validation" ? <section className="native-validation"><header><div><p className="eyebrow">HARD GENERATION GATE</p><h3>{validation.valid ? "AIR structure is valid" : "Generation is blocked"}</h3></div><strong className={validation.valid ? "valid" : "invalid"}>{validation.valid ? "PASS" : "FAIL"}</strong></header><div className="native-checks">{Object.entries(validation.checks || {}).map(([key, passed]) => <article key={key}><span>{passed ? "OK" : "!"}</span><strong>{key.replaceAll("_", " ")}</strong></article>)}</div><div className="native-issues">{[...(validation.errors || []), ...(validation.warnings || [])].map((item, index) => <article key={`${item.code}-${index}`}><span>{(validation.errors || []).includes(item) ? "ERROR" : "REVIEW"}</span><div><strong>{item.code.replaceAll("_", " ")}</strong><p>{item.message}</p></div><code>{item.component_id || "MODEL"}</code></article>)}{!validation.errors?.length && !validation.warnings?.length ? <div className="empty-state">All deterministic AIR checks passed.</div> : null}</div></section> : null}

    {view === "generation" ? <section className="native-generation"><div className="generation-console"><p className="eyebrow">TARGET COMPILER</p><h3>Emit a governed application artifact</h3><label>Target profile<select value="WEB_POSTGRES_FASTAPI_REACT" disabled><option>WEB_POSTGRES_FASTAPI_REACT</option></select></label><label>Generation mode<select value={generationMode} onChange={(event) => setGenerationMode(event.target.value)}><option>MODEL_ONLY</option><option>SCAFFOLD</option></select></label><div className="generation-gate"><span className={overview.validation_error_count ? "off" : "on"}>Validation clean</span><span className={overview.review_required_count ? "off" : "on"}>Human review complete</span><span className={["APPROVED", "CODE_GENERATED"].includes(overview.status) ? "on" : "off"}>Owner approved</span></div><button onClick={generate} disabled={busy || (generationMode === "SCAFFOLD" && !["APPROVED", "CODE_GENERATED"].includes(overview.status))}>{busy ? "Generating..." : generationMode === "MODEL_ONLY" ? "Export model package" : "Generate application scaffold"}</button>{overview.status === "GENERATED" && !overview.review_required_count ? <button className="approve-model" onClick={approve} disabled={busy}>Owner approve AIR</button> : null}</div><div className="generation-artifact"><p className="eyebrow">LATEST IMMUTABLE ARTIFACT</p>{generation?.status && generation.status !== "NOT_GENERATED" ? <><span className={`native-status ${generation.status === "COMPLETED" ? "ready" : "review"}`}>{generation.status}</span><h3>{generation.application_version || generation.generation_run_id}</h3><dl><div><dt>Mode</dt><dd>{generation.generation_mode}</dd></div><div><dt>Files</dt><dd>{generation.files_generated}</dd></div><div><dt>Tests</dt><dd>{generation.tests_generated}</dd></div><div><dt>Compiler</dt><dd>{generation.generator_version}</dd></div></dl>{generation.status === "COMPLETED" ? <button onClick={() => downloadEucApplicationGeneration(eucId, generation.generation_run_id)}>Download verified ZIP</button> : null}</> : <div className="empty-state">No native application artifact has been generated.</div>}</div></section> : null}
  </div>;
}

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

const REVIEW_EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function reviewDateMilliseconds(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
  );
  if (!match) return null;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)
  );
}

function reviewExcelDateMilliseconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 2958465
    ? REVIEW_EXCEL_EPOCH_MS + value * 86400000 : null;
}

function reviewValuesEqual(left, right) {
  if (left == null || left === "") return right == null || right === "";
  if (right == null || right === "") return false;
  const leftDate = reviewDateMilliseconds(left);
  const rightDate = reviewDateMilliseconds(right);
  if (leftDate != null && rightDate != null) return Math.abs(leftDate - rightDate) < 1;
  if (leftDate != null && reviewExcelDateMilliseconds(right) != null) {
    return Math.abs(leftDate - reviewExcelDateMilliseconds(right)) < 1;
  }
  if (rightDate != null && reviewExcelDateMilliseconds(left) != null) {
    return Math.abs(rightDate - reviewExcelDateMilliseconds(left)) < 1;
  }
  return String(left) === String(right);
}

function isMeaningfulReviewChange(change) {
  if (change.operation_type !== "CELL_VALUE_UPDATE") return true;
  return !reviewValuesEqual(change.old_value, change.new_value);
}

function formatReviewValue(value, counterpart = null) {
  const serialDate = reviewExcelDateMilliseconds(value);
  if (serialDate != null && reviewDateMilliseconds(counterpart) != null) {
    const rendered = new Date(serialDate).toISOString();
    value = typeof counterpart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(counterpart.trim())
      ? rendered.slice(0, 10)
      : `${rendered.slice(0, 10)} ${rendered.slice(11, 19)}`;
  }
  return value == null ? "null" : typeof value === "string" ? value : JSON.stringify(value);
}

function SecurityAdministration({ repositoryId, onError }) {
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [groupName, setGroupName] = useState("");
  const [assignment, setAssignment] = useState({ user_id: "", role_key: "VIEWER", scope_type: "REPOSITORY" });
  const [policy, setPolicy] = useState({ name: "", effect: "DENY", permission_key: "commit.create", subject_type: "USER", subject_id: "" });
  const [serviceAccount, setServiceAccount] = useState({ name: "", role_key: "VIEWER" });
  const [issuedCredential, setIssuedCredential] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const result = await getSecurityAdminOverview();
      setOverview(result);
      setAssignment((current) => ({ ...current, user_id: current.user_id || result.users?.[0]?.user_id || "" }));
      setPolicy((current) => ({ ...current, subject_id: current.subject_id || result.users?.[0]?.user_id || "" }));
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { load(); }, []);

  const run = async (operation, success) => {
    setBusy(true); setNotice("");
    try { await operation(); setNotice(success); await load(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };

  if (!overview) return <section className="security-admin-loading"><p className="eyebrow">ENTERPRISE SECURITY</p><h2>{busy ? "Opening Security Center..." : "Security Center unavailable"}</h2></section>;
  const organization = overview.organization || {};
  const scopeId = assignment.scope_type === "ORGANIZATION" ? organization.organization_id : repositoryId;
  return <div className="security-admin">
    <header className="security-admin-hero">
      <div><p className="eyebrow">STAGE 3.1 / IDENTITY CONTROL PLANE</p><h2>Security Center</h2><p>Default-deny access, scoped roles, explicit policies, and non-human identities for <strong>{organization.name}</strong>.</p></div>
      <div className="security-shield"><span>AUTHZ</span><strong>{overview.users?.filter((user) => user.status === "ACTIVE").length || 0}</strong><small>active identities</small></div>
    </header>
    {notice ? <div className="security-notice">{notice}</div> : null}
    <section className="security-stat-grid">
      <article><span>Members</span><strong>{overview.users?.length || 0}</strong><small>tenant isolated</small></article>
      <article><span>Groups</span><strong>{overview.groups?.length || 0}</strong><small>{overview.groups?.reduce((total, group) => total + Number(group.member_count || 0), 0)} memberships</small></article>
      <article><span>Assignments</span><strong>{overview.assignments?.length || 0}</strong><small>organization + repository scopes</small></article>
      <article><span>Guardrails</span><strong>{overview.policies?.length || 0}</strong><small>{overview.branch_protections?.length || 0} protected branches</small></article>
    </section>
    <div className="security-admin-grid">
      <section className="security-admin-panel identities-panel">
        <div className="panel-header"><div><p className="eyebrow">IDENTITY DIRECTORY</p><h3>People and session state</h3></div><span className="pill ready">{organization.status}</span></div>
        <form className="security-inline-form" onSubmit={(event) => { event.preventDefault(); run(() => addOrganizationMember(memberEmail), `Added ${memberEmail} to the organization.`); setMemberEmail(""); }}><input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="employee@company.com" required /><button disabled={busy}>Add member</button></form>
        <div className="identity-list">{overview.users?.map((user) => <article key={user.user_id}><span className="user-avatar">{user.email.slice(0, 2).toUpperCase()}</span><div><strong>{user.display_name || user.email}</strong><small>{user.email} / {user.employee_id || user.user_id}</small></div><b className={user.status === "ACTIVE" ? "state-active" : "state-suspended"}>{user.status}</b>{user.user_id !== organization.created_by ? <button onClick={() => run(() => updateOrganizationUserStatus(user.user_id, user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"), `${user.email} is now ${user.status === "ACTIVE" ? "suspended" : "active"}.`)}>{user.status === "ACTIVE" ? "Suspend" : "Restore"}</button> : <em>Owner</em>}</article>)}</div>
      </section>
      <section className="security-admin-panel groups-panel">
        <div className="panel-header"><div><p className="eyebrow">TEAM INHERITANCE</p><h3>Groups</h3></div></div>
        <form className="security-inline-form" onSubmit={(event) => { event.preventDefault(); run(() => createSecurityGroup({ name: groupName }), `Created ${groupName}.`); setGroupName(""); }}><input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Finance reviewers" required /><button disabled={busy}>Create group</button></form>
        <div className="security-card-list">{overview.groups?.map((group) => <article key={group.group_id}><div><strong>{group.name}</strong><small>{group.member_count} members / {group.status}</small></div><button disabled={!assignment.user_id} onClick={() => run(() => addSecurityGroupMember(group.group_id, assignment.user_id), "Group membership updated.")}>Add selected user</button></article>)}{!overview.groups?.length ? <p>No groups yet. Create one to manage access at team scale.</p> : null}</div>
      </section>
      <section className="security-admin-panel roles-panel">
        <div className="panel-header"><div><p className="eyebrow">SCOPED RBAC</p><h3>Role assignments</h3></div><span className="pill">Explicit scope</span></div>
        <div className="security-role-form"><select value={assignment.user_id} onChange={(event) => { setAssignment({ ...assignment, user_id: event.target.value }); setPolicy({ ...policy, subject_id: event.target.value }); }}>{overview.users?.map((user) => <option key={user.user_id} value={user.user_id}>{user.email}</option>)}</select><select value={assignment.role_key} onChange={(event) => setAssignment({ ...assignment, role_key: event.target.value })}>{overview.roles?.map((role) => <option key={role.role_key} value={role.role_key}>{role.display_name}</option>)}</select><select value={assignment.scope_type} onChange={(event) => setAssignment({ ...assignment, scope_type: event.target.value })}><option value="REPOSITORY">This repository</option><option value="ORGANIZATION">Entire organization</option></select><button disabled={busy || !scopeId} onClick={() => run(() => createRoleAssignment({ ...assignment, scope_id: scopeId }), "Scoped role assigned.")}>Grant role</button></div>
        <div className="assignment-table"><header><span>Identity</span><span>Role</span><span>Scope</span><span /></header>{overview.assignments?.slice(0, 30).map((item) => <article key={item.assignment_id}><span>{item.email || item.user_id}</span><strong>{item.role_key}</strong><code>{item.scope_type.toLowerCase()} / {item.scope_id.slice(0, 14)}</code><button onClick={() => run(() => revokeRoleAssignment(item.assignment_id), "Role assignment revoked.")}>Revoke</button></article>)}</div>
      </section>
      <section className="security-admin-panel policy-panel">
        <div className="panel-header"><div><p className="eyebrow">POLICY GUARDRAILS</p><h3>Explicit allow and deny</h3></div><span className="pill alert">Deny wins</span></div>
        <div className="policy-composer"><input value={policy.name} onChange={(event) => setPolicy({ ...policy, name: event.target.value })} placeholder="Block external commit" /><select value={policy.effect} onChange={(event) => setPolicy({ ...policy, effect: event.target.value })}><option>DENY</option><option>ALLOW</option></select><input value={policy.permission_key} onChange={(event) => setPolicy({ ...policy, permission_key: event.target.value })} placeholder="commit.create" /><button disabled={busy || !repositoryId || !policy.name} onClick={() => run(() => createAccessPolicy({ ...policy, resource_type: "REPOSITORY", resource_id: repositoryId, conditions: {}, priority: 50 }), "Access policy published.")}>Publish policy</button></div>
        <div className="security-card-list">{overview.policies?.map((item) => <article key={item.policy_id} className={`effect-${item.effect.toLowerCase()}`}><div><strong>{item.name}</strong><small>{item.effect} {item.permission_key}</small></div><code>{item.subject_type} / {item.subject_id || "ANY"}</code></article>)}{!overview.policies?.length ? <p>No explicit policies. Scoped roles and default deny remain active.</p> : null}</div>
      </section>
      <section className="security-admin-panel service-panel">
        <div className="panel-header"><div><p className="eyebrow">NON-HUMAN ACCESS</p><h3>Service identities</h3></div><span className="pill ready">Hashed secrets</span></div>
        <div className="security-role-form"><input value={serviceAccount.name} onChange={(event) => setServiceAccount({ ...serviceAccount, name: event.target.value })} placeholder="Nightly inventory bot" /><select value={serviceAccount.role_key} onChange={(event) => setServiceAccount({ ...serviceAccount, role_key: event.target.value })}>{overview.roles?.map((role) => <option key={role.role_key}>{role.role_key}</option>)}</select><button disabled={busy || !repositoryId || !serviceAccount.name} onClick={async () => { setBusy(true); try { const result = await createServiceAccount({ ...serviceAccount, scope_type: "REPOSITORY", scope_id: repositoryId }); setIssuedCredential(result.credential); setServiceAccount({ ...serviceAccount, name: "" }); await load(); } catch (error) { onError(error.message); } finally { setBusy(false); } }}>Issue credential</button></div>
        {issuedCredential ? <div className="issued-secret"><span>Shown once</span><code>{issuedCredential}</code><button onClick={() => setIssuedCredential("")}>I stored it securely</button></div> : null}
        <div className="security-card-list">{overview.service_accounts?.map((account) => <article key={account.service_account_id}><div><strong>{account.name}</strong><small>{account.status} / {account.scope_type.toLowerCase()}</small></div><code>{account.service_account_id}</code></article>)}</div>
      </section>
      <section className="security-admin-panel sessions-panel">
        <div className="panel-header"><div><p className="eyebrow">SESSION ASSURANCE</p><h3>Recent sessions</h3></div></div>
        <div className="session-list">{overview.sessions?.slice(0, 12).map((session) => <article key={session.session_id}><i className={session.revoked_at ? "revoked" : "active"} /><div><strong>{session.email}</strong><small>{session.session_id} / {new Date(session.created_at).toLocaleString()}</small></div><span>{session.revoked_at ? "Revoked" : "Active"}</span></article>)}</div>
      </section>
    </div>
  </div>;
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
  const [aiConfigModel, setAiConfigModel] = useState("");
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
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [selectedSheetId, setSelectedSheetId] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryDescription, setRepositoryDescription] = useState("");
  const [repositoryClassification, setRepositoryClassification] = useState("internal");
  const [repositoryRetention, setRepositoryRetention] = useState("3 years");
  const [repositoryOwnerEmail, setRepositoryOwnerEmail] = useState("");
  const [repositoryOwnerEmployeeId, setRepositoryOwnerEmployeeId] = useState("");
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [checkoutPrompt, setCheckoutPrompt] = useState(null);
  const [changeActivity, setChangeActivity] = useState({ events: [] });
  const [activitySort, setActivitySort] = useState("desc");
  const [activityOperation, setActivityOperation] = useState("");
  const [storageMetrics, setStorageMetrics] = useState(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");
  const [eucAssets, setEucAssets] = useState([]);
  const [selectedEucId, setSelectedEucId] = useState("");
  const [eucInventory, setEucInventory] = useState(null);
  const [eucFile, setEucFile] = useState(null);
  const [eucSearch, setEucSearch] = useState("");
  const [eucBusy, setEucBusy] = useState(false);
  const [eucSection, setEucSection] = useState("overview");

  // Local EUC Excel download directory state (C: or D: drive)
  const [eucDownloadDir, setEucDownloadDir] = useState(() => localStorage.getItem("gitwalk:euc_download_dir") || "");
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [pendingCheckout, setPendingCheckout] = useState(null);
  const [folderModalInput, setFolderModalInput] = useState("");
  const [folderModalError, setFolderModalError] = useState("");
  const [folderSettingsInput, setFolderSettingsInput] = useState("");
  const [folderSettingsMsg, setFolderSettingsMsg] = useState("");
  const [folderSettingsBusy, setFolderSettingsBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const isValidDrive = (path) => /^[cCdD]:[/\\]/.test(path?.trim());

  useEffect(() => {
    getEucStorageSetting()
      .then((res) => {
        if (res?.local_download_dir) {
          setEucDownloadDir(res.local_download_dir);
          setFolderSettingsInput(res.local_download_dir);
          localStorage.setItem("gitwalk:euc_download_dir", res.local_download_dir);
        }
      })
      .catch(() => {});
  }, []);

  const viewTableId = selectedBranchTable || selectedTable;
  const selectedBranch = branches.find((branch) => branch.data_table_id === viewTableId) || null;
  const selectedMergeSummary = mergeRequests.find(
    (request) => request.merge_request_id === selectedMergeRequestId
  );
  const selectedSemanticSheet = branchState?.sheets?.find(
    (sheet) => sheet.sheet_id === selectedSheetId
  ) || branchState?.sheets?.[0] || null;
  useEffect(() => {
    const expireSession = () => setAuth(null);
    window.addEventListener("gitwalk:auth-expired", expireSession);
    return () => window.removeEventListener("gitwalk:auth-expired", expireSession);
  }, []);

  const loadDatasets = async () => {
    const result = await getDatasets();
    setDatasets(result.datasets);
    if (!selectedTable) {
      const firstAccessible = result.datasets.find((dataset) => dataset.can_view);
      if (firstAccessible) setSelectedTable(firstAccessible.table_id);
    }
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
      setAiConfigModel(models.default_model || models.models[0] || "");
      setShowAISetup(!models.configured);
    }).catch(() => {});
  }, [auth]);

  useEffect(() => {
    if (!auth || !selectedTable || ["new", "inventory"].includes(tab)) return;
    refresh();
    const timer = setInterval(() => refresh(true), 2000);
    return () => clearInterval(timer);
  }, [auth, selectedTable, selectedBranchTable, selectedSheetId, tab]);

  useEffect(() => {
    if (!auth || tab !== "inventory") return;
    getEucAssets("", eucSearch).then((result) => {
      setEucAssets(result.assets || []);
      setSelectedEucId((current) => current || result.assets?.[0]?.euc_id || "");
    }).catch((err) => setError(err.message));
  }, [auth, tab, eucSearch]);

  useEffect(() => {
    if (!auth || tab !== "inventory" || !selectedEucId) {
      if (!selectedEucId) setEucInventory(null);
      return;
    }
    getEucInventory(selectedEucId).then(setEucInventory).catch((err) => setError(err.message));
  }, [auth, tab, selectedEucId]);

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
    if (!auth || !selectedTable || tab !== "storage") return;
    getRepositoryStorage(selectedTable)
      .then(setStorageMetrics)
      .catch((err) => setError(err.message));
  }, [auth, selectedTable, tab, data?.version]);

  useEffect(() => {
    if (!auth || !selectedBranch?.branch_id) {
      setChangeActivity({ events: [] });
      return;
    }
    getWorkbookChangeActivity(selectedBranch.branch_id, {
      sheetId: selectedSemanticSheet?.sheet_id || "",
      operation: activityOperation,
      sort: activitySort,
    }).then(setChangeActivity).catch((err) => setError(err.message));
  }, [auth, selectedBranch?.branch_id, branchState?.head_commit_id, selectedSemanticSheet?.sheet_id, activityOperation, activitySort]);

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
    if (!auth || !selectedTable || tab === "new") return undefined;
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
  }, [auth, selectedTable, tab]);

  useEffect(() => {
    if (!auth || !selectedTable || tab === "new") return undefined;
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
  }, [auth, browserClientId, selectedTable, tab]);

  if (!auth) return <LoginPage onAuthenticated={setAuth} />;

  const selectedDataset = datasets.find((item) => item.table_id === selectedTable);

  const reloadEucPortfolio = async (preferredId = selectedEucId) => {
    const result = await getEucAssets("", eucSearch);
    setEucAssets(result.assets || []);
    const nextId = preferredId || result.assets?.[0]?.euc_id || "";
    setSelectedEucId(nextId);
    if (nextId) setEucInventory(await getEucInventory(nextId));
  };

  const ingestAndAnalyzeEuc = async () => {
    if (!eucFile || !repository?.repository_id) return;
    setEucBusy(true);
    setError("");
    try {
      const asset = await uploadEuc(eucFile, repository.repository_id);
      setSelectedEucId(asset.euc_id);
      await analyzeEuc(asset.euc_id);
      await reloadEucPortfolio(asset.euc_id);
      setEucFile(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setEucBusy(false);
    }
  };

  const reanalyzeSelectedEuc = async () => {
    if (!selectedEucId) return;
    setEucBusy(true);
    setError("");
    try {
      await analyzeEuc(selectedEucId);
      await reloadEucPortfolio(selectedEucId);
    } catch (err) {
      setError(err.message);
    } finally {
      setEucBusy(false);
    }
  };
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
        business_owner: repositoryOwnerEmail.trim() || auth.user.email,
        owner_email: repositoryOwnerEmail.trim() || auth.user.email,
        owner_employee_id: repositoryOwnerEmployeeId.trim(),
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
      setRepositoryOwnerEmail("");
      setRepositoryOwnerEmployeeId("");
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

  const issueWorkingCopy = async (mode, branchId = null, overrideDir = null) => {
    if (!selectedTable) return;
    const targetDir = overrideDir || eucDownloadDir;
    if (!targetDir || !isValidDrive(targetDir)) {
      setPendingCheckout({ mode, branchId });
      setFolderModalInput(targetDir || "C:\\GitWalk_Workbooks");
      setFolderModalError("");
      setShowFolderModal(true);
      return;
    }
    setWorkingCopyBusy(true);
    setError("");
    try {
      const result = await workOnWorkbook(selectedTable, mode, branchId, targetDir);
      setCheckoutPrompt(null);
      await loadFoundation();
      const branchRes = await getRepositoryBranches(selectedTable);
      setBranches(branchRes.branches || []);
      if (result?.localSavedPath) {
        setNotice(`Workbook downloaded and saved to: ${result.localSavedPath}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setWorkingCopyBusy(false);
    }
  };

  const handleWorkOnWorkbook = async () => {
    if (!selectedTable || !selectedDataset?.can_edit) return;
    if (!eucDownloadDir || !isValidDrive(eucDownloadDir)) {
      setPendingCheckout({ mode: "start" });
      setFolderModalInput("C:\\GitWalk_Workbooks");
      setFolderModalError("");
      setShowFolderModal(true);
      return;
    }
    setWorkingCopyBusy(true);
    setError("");
    try {
      const options = await getCheckoutOptions(selectedTable);
      if (options.branches?.length) {
        setCheckoutPrompt(options);
        setWorkingCopyBusy(false);
        return;
      }
      await issueWorkingCopy("new");
    } catch (err) {
      setError(err.message);
      setWorkingCopyBusy(false);
    }
  };

  const handleConfirmFolderModal = async (event) => {
    event.preventDefault();
    const input = folderModalInput.trim();
    if (!isValidDrive(input)) {
      setFolderModalError("Path must be located on C: or D: drive (e.g. C:\\... or D:\\...).");
      return;
    }
    try {
      await saveEucStorageSetting(input);
      setEucDownloadDir(input);
      setFolderSettingsInput(input);
      localStorage.setItem("gitwalk:euc_download_dir", input);
      setShowFolderModal(false);

      if (pendingCheckout) {
        const { mode, branchId } = pendingCheckout;
        setPendingCheckout(null);
        if (mode === "start") {
          const options = await getCheckoutOptions(selectedTable);
          if (options.branches?.length) {
            setCheckoutPrompt(options);
          } else {
            await issueWorkingCopy("new", null, input);
          }
        } else {
          await issueWorkingCopy(mode, branchId, input);
        }
      }
    } catch (err) {
      setFolderModalError(err.message);
    }
  };

  const handleSaveEucStorageSettings = async (event) => {
    event.preventDefault();
    const input = folderSettingsInput.trim();
    if (!isValidDrive(input)) {
      setFolderSettingsMsg("Error: Directory must reside on C: or D: drive.");
      return;
    }
    setFolderSettingsBusy(true);
    setFolderSettingsMsg("");
    try {
      const res = await saveEucStorageSetting(input);
      setEucDownloadDir(input);
      localStorage.setItem("gitwalk:euc_download_dir", input);
      setFolderSettingsMsg(`Directory saved! Local path: ${res.local_download_dir}`);
    } catch (err) {
      setFolderSettingsMsg(`Failed: ${err.message}`);
    } finally {
      setFolderSettingsBusy(false);
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
    setMergeBusy(true); setError(""); setNotice("");
    try {
      const mergeResult = await mergeMergeRequest(mergeRequestDetail.merge_request_id);
      setSelectedBranchTable("");
      await Promise.all([refresh(), loadFoundation(), loadMergeRequests()]);
      const branchResult = await getRepositoryBranches(selectedTable);
      setBranches(branchResult.branches || []);
      setMergeRequestDetail(await getMergeRequest(mergeRequestDetail.merge_request_id));
      const cleanupMsg = mergeResult?.cleanup?.message
        ? ` ${mergeResult.cleanup.message}`
        : " Local EUC Excel file deleted and branch removed from database.";
      setNotice(`Branch merged into main successfully!${cleanupMsg}`);
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
      setAiConfigModel(models.default_model || models.models[0] || "");
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
      setAiConfigModel(models.default_model || models.models[0] || "");
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

  const migrateStorage = async () => {
    setStorageBusy(true);
    setStorageNotice("");
    try {
      const result = await migrateRepositoryStorage(selectedTable);
      setStorageNotice(`${result.branches.length} branch root(s) verified on ${result.storage_engine}.`);
      setStorageMetrics(await getRepositoryStorage(selectedTable));
    } catch (err) {
      setError(err.message);
    } finally {
      setStorageBusy(false);
    }
  };

  const inspectGarbage = async () => {
    setStorageBusy(true);
    setStorageNotice("");
    try {
      const result = await runStorageGC(selectedTable, true);
      setStorageNotice(`GC preview: ${result.objects_candidates} unreachable object(s), ${formatBytes(result.candidate_bytes)} reclaimable. Nothing was deleted.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setStorageBusy(false);
    }
  };

  const mergeReviewTimeline = (
    mergeRequestDetail?.timeline?.length
      ? mergeRequestDetail.timeline
      : mergeRequestDetail?.changes || []
  ).filter(isMeaningfulReviewChange).slice(0, 250);

  return (
    <div className="product-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark small">GW</div><div><strong>Git Walk</strong><span>Spreadsheet version control</span></div></div>
        <nav>
          {[["home", "Repositories"], ["new", "New repository"], ["inventory", "EUC inventory"], ["fabric", "Information Fabric"], ["ai", "AI Command Center"], ["data", "Repository data"], ["branches", "Branches"], ["merges", "Merge requests"], ["history", "History & lineage"], ["storage", "Semantic storage"], ["analytics", "Insights"], ["audit", "Audit ledger"], ["admin", "Security Center"], ["settings", "Settings"]].map(([id, label]) => (
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
            <p className="eyebrow">{tab === "home" ? "GIT WALK / COMMAND CENTER" : tab === "new" ? "GIT WALK / CREATE" : tab === "inventory" ? "GIT WALK / EUC INTELLIGENCE" : tab === "fabric" ? "GIT WALK / DIGITAL THREAD" : tab === "ai" ? "GIT WALK / AI CONTROL PLANE" : tab === "admin" ? "GIT WALK / ENTERPRISE SECURITY" : "GIT WALK / REPOSITORY"}</p>
            <h1>{tab === "home" ? "Repository workspaces" : tab === "new" ? "Create a repository" : tab === "inventory" ? "EUC inventory" : tab === "fabric" ? "Enterprise information fabric" : tab === "ai" ? "AI Command Center" : tab === "admin" ? "Identity and access" : repository?.repository_name || selectedDataset?.original_filename || "Repository workspace"}</h1>
          </div>
          {!['new', 'inventory', 'fabric', 'ai', 'admin'].includes(tab) ? <div className="topbar-actions">
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
              if (match?.can_view) {
                setSelectedTable(match.table_id);
                setRepoSearch("");
              }
            }} placeholder="Search repositories" />
            <datalist id="repository-options">{datasets.map((dataset) => <option key={dataset.table_id} value={dataset.repository_name}>{dataset.access_level} / {dataset.table_id}</option>)}</datalist>
            <select value={selectedTable} onChange={(event) => { setSelectedTable(event.target.value); setRepoSearch(""); }}>
              {datasets.map((dataset) => <option key={dataset.table_id} value={dataset.table_id} disabled={!dataset.can_view}>[{dataset.can_edit ? "EDIT" : dataset.can_view ? "VIEW" : "LOCKED"}] {dataset.repository_name} / {dataset.table_id}</option>)}
            </select>
            {selectedTable ? <select className="branch-selector" value={viewTableId} onChange={(event) => setSelectedBranchTable(event.target.value === selectedTable ? "" : event.target.value)}>
              {branches.map((branch) => <option key={branch.branch_id} value={branch.data_table_id}>{branch.branch_name}</option>)}
            </select> : null}
            <button className="primary-button compact" onClick={handleWorkOnWorkbook} disabled={!selectedTable || !selectedDataset?.can_edit || workingCopyBusy}>{workingCopyBusy ? "Preparing branch..." : selectedDataset?.can_edit ? "Open branch in Excel" : "Viewer access"}</button>
            <button className="secondary-button" onClick={() => refresh()} disabled={!selectedTable}>Refresh</button>
          </div> : null}
        </header>

        {error ? <div className="error-banner global"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div> : null}
        {notice ? <div className="notice-banner global"><span>{notice}</span><button onClick={() => setNotice("")}>Dismiss</button></div> : null}

        {showFolderModal ? (
          <div className="checkout-backdrop" role="presentation">
            <section className="checkout-dialog folder-modal-dialog" role="dialog" aria-modal="true">
              <button className="checkout-close" onClick={() => { setShowFolderModal(false); setPendingCheckout(null); }}>Close</button>
              <p className="eyebrow">LOCAL EUC STORAGE</p>
              <h2>Select Download Location</h2>
              <p className="muted">
                Please specify the local directory on <strong>C:</strong> or <strong>D:</strong> drive where your Excel workbook will be downloaded and tracked.
                If the folder does not exist, it will be created automatically.
              </p>
              <form onSubmit={handleConfirmFolderModal}>
                <label>
                  <span>Directory Path (Must begin with C:\ or D:\)</span>
                  <input
                    type="text"
                    value={folderModalInput}
                    onChange={(event) => {
                      setFolderModalInput(event.target.value);
                      setFolderModalError("");
                    }}
                    placeholder="e.g. C:\GitWalk_Workbooks or D:\EUC_Files"
                    autoFocus
                    required
                  />
                </label>
                {folderModalError ? <p className="form-error-inline">{folderModalError}</p> : null}
                <div className="modal-actions-strip">
                  <button type="button" className="secondary-button" onClick={() => { setShowFolderModal(false); setPendingCheckout(null); }}>
                    Cancel
                  </button>
                  <button type="submit" className="primary-button">
                    Save & Open in Excel
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}

        {checkoutPrompt ? <div className="checkout-backdrop" role="presentation"><section className="checkout-dialog" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><button className="checkout-close" onClick={() => setCheckoutPrompt(null)}>Close</button><p className="eyebrow">SIGNED WORKING COPY</p><h2 id="checkout-title">Resume a branch or start clean?</h2><p className="muted">A fresh Excel file will be generated either way. Resume keeps the selected branch history; new branch clones protected main.</p><div className="checkout-branch-list">{checkoutPrompt.branches.map((branch) => <button key={branch.branch_id} onClick={() => issueWorkingCopy("continue", branch.branch_id)} disabled={workingCopyBusy}><span><strong>{branch.branch_name}</strong><small>Last opened {branch.last_opened_at ? new Date(branch.last_opened_at).toLocaleString() : "not recorded"}</small></span><b>Resume</b></button>)}</div><button className="primary-button checkout-new" onClick={() => issueWorkingCopy("new")} disabled={workingCopyBusy}>{workingCopyBusy ? "Preparing workbook..." : "Create a new personal branch"}</button></section></div> : null}

        {!['new', 'fabric', 'ai'].includes(tab) ? <><section className="status-rail">
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
        </section></> : null}

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
                  <button key={dataset.table_id} className={!dataset.can_view ? "repository-locked" : ""} disabled={!dataset.can_view} onClick={() => { setSelectedTable(dataset.table_id); setTab("data"); }}>
                    <span className="repo-icon">XL</span>
                    <span><strong>{dataset.repository_name || dataset.original_filename}</strong><small>{dataset.category_name} / {dataset.row_count} rows</small></span>
                    <b className={`access-badge access-${dataset.access_level}`}>{dataset.can_edit ? `${dataset.repository_role} / edit` : dataset.can_view ? "viewer / read" : "locked / request access"}</b>
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
              <label>Repository owner email<input type="email" value={repositoryOwnerEmail} onChange={(event) => setRepositoryOwnerEmail(event.target.value)} placeholder={auth.user.email} /></label>
              <label>Owner employee ID<input value={repositoryOwnerEmployeeId} onChange={(event) => setRepositoryOwnerEmployeeId(event.target.value)} placeholder="EMP-1042 (optional)" maxLength={80} /></label>
            </div>
            <div className="repository-create-footer"><span>Owner: <strong>{repositoryOwnerEmail.trim() || auth.user.email}</strong><small>{repositoryOwnerEmail.trim() && repositoryOwnerEmail.trim().toLowerCase() !== auth.user.email.toLowerCase() ? "You remain an editor and receive the initial branch." : "You will own protected main."}</small></span><button className="primary-button compact" onClick={handleUpload} disabled={!selectedFile || !repositoryName.trim() || uploading}>{uploading ? "Creating repository..." : "Create repository and download branch"}</button></div>
          </section>
        ) : null}

        {tab === "inventory" ? (
          <div className="euc-stage">
            <section className="euc-hero">
              <div><p className="eyebrow">STAGE 2.1 / TECHNICAL DISCOVERY</p><h2>See the machinery inside every workbook.</h2><p>Git Walk fingerprints the source, extracts its complete technical structure, and seals a deterministic inventory into the semantic ledger without executing workbook code.</p></div>
              <div className="euc-ingest-card">
                <span className="euc-safe-mark">READ ONLY</span>
                <label>Target repository<select value={selectedTable} onChange={(event) => setSelectedTable(event.target.value)}>{datasets.filter((item) => item.can_edit).map((dataset) => <option key={dataset.table_id} value={dataset.table_id}>{dataset.repository_name}</option>)}</select></label>
                <label className="euc-file-drop"><input type="file" accept=".xlsx,.xlsm,.csv" onChange={(event) => setEucFile(event.target.files[0] || null)} /><strong>{eucFile?.name || "Drop an EUC or choose a file"}</strong><small>.xlsx, .xlsm, or .csv / source stored once</small></label>
                <button onClick={ingestAndAnalyzeEuc} disabled={!eucFile || !repository?.repository_id || eucBusy}>{eucBusy ? "Fingerprinting + analyzing..." : "Register and analyze"}</button>
              </div>
            </section>

            <section className="euc-portfolio-bar">
              <div><strong>{eucAssets.length}</strong><span>governed EUC assets</span></div>
              <div><i />Immutable originals / versioned analysis / no macro execution</div>
              <input value={eucSearch} onChange={(event) => setEucSearch(event.target.value)} placeholder="Search file or repository" />
            </section>

            <div className="euc-layout">
              <section className="panel euc-asset-list">
                <div className="panel-header"><div><p className="eyebrow">PORTFOLIO</p><h2>Registered assets</h2></div></div>
                <div className="euc-assets">
                  {eucAssets.map((asset) => <button key={asset.euc_id} className={selectedEucId === asset.euc_id ? "active" : ""} onClick={() => setSelectedEucId(asset.euc_id)}><span className={`euc-type ${asset.file_type}`}>{asset.file_type}</span><div><strong>{asset.filename}</strong><small>{asset.repository_name} / {formatBytes(asset.size_bytes)}</small></div><div className="euc-asset-facts"><b>{asset.summary?.sheet_count || 0} sheets</b><b>{asset.summary?.total_formulas || 0} formulas</b></div><em className={`analysis-state state-${asset.status.toLowerCase()}`}>{asset.status.replaceAll("_", " ")}</em></button>)}
                  {!eucAssets.length ? <div className="empty-state">Register the first workbook asset to create its governed inventory.</div> : null}
                </div>
              </section>

              <section className="euc-detail">
                {eucInventory ? <>
                  <div className="euc-detail-head"><div><p className="eyebrow">NORMALIZED INVENTORY / {eucInventory.analysis_id}</p><h2>{eucInventory.overview?.filename}</h2><p>Analyzer {eucAssets.find((item) => item.euc_id === selectedEucId)?.analyzer_version || "2.1.0"} / manifest-backed evidence</p></div><div><button onClick={reanalyzeSelectedEuc} disabled={eucBusy}>{eucBusy ? "Analyzing..." : "Re-analyze"}</button><button onClick={() => exportEucInventory(selectedEucId)}>Export JSON</button></div></div>
                  <div className="euc-kpis">
                    <article><span>Sheets</span><strong>{eucInventory.overview?.sheet_count || 0}</strong><small>{eucInventory.overview?.hidden_sheets || 0} hidden / {eucInventory.overview?.very_hidden_sheets || 0} very hidden</small></article>
                    <article><span>Used cells</span><strong>{Number(eucInventory.overview?.used_cells || 0).toLocaleString()}</strong><small>{Number(eucInventory.overview?.constant_cells || 0).toLocaleString()} constants</small></article>
                    <article><span>Formulas</span><strong>{Number(eucInventory.overview?.total_formulas || 0).toLocaleString()}</strong><small>{Number(eucInventory.overview?.unique_patterns || 0).toLocaleString()} unique patterns</small></article>
                    <article><span>Dependencies</span><strong>{(eucInventory.overview?.external_links || 0) + (eucInventory.overview?.connections || 0)}</strong><small>{eucInventory.overview?.connections || 0} connections</small></article>
                  </div>
                  <div className="euc-tabs">{[["overview", "Workbook map"], ["formulas", "Formula patterns"], ["objects", "Objects"], ["dependencies", "Dependency intelligence"], ["intelligence", "Risk & controls"], ["migration", "Migration blueprint"], ["native", "Native model"]].map(([id, label]) => <button key={id} className={eucSection === id ? "active" : ""} onClick={() => setEucSection(id)}>{label}</button>)}</div>
                  {eucSection === "overview" ? <div className="euc-sheet-tree">{(eucInventory.sheets || []).map((sheet) => <article key={sheet.sheet_inventory_id}><header><span>{sheet.sheet_position + 1}</span><div><strong>{sheet.sheet_name}</strong><small>{sheet.visibility} / {sheet.used_range}</small></div><em>{Number(sheet.used_cell_count).toLocaleString()} cells</em></header><div><span>fx {Number(sheet.formula_cell_count).toLocaleString()}</span><span>{sheet.table_count} tables</span><span>{sheet.chart_count} charts</span><span>{sheet.validation_count} rules</span><span>{sheet.hidden_row_count + sheet.hidden_column_count} hidden axes</span></div></article>)}</div> : null}
                  {eucSection === "formulas" ? <div className="euc-patterns"><header><span>Normalized business logic</span><span>Functions</span><span>Occurrences</span><span>Signals</span></header>{(eucInventory.formulas || []).map((pattern) => <article key={pattern.pattern_id}><code>{pattern.normalized_formula}</code><span>{pattern.functions.join(", ") || "operators"}</span><strong>{Number(pattern.occurrence_count).toLocaleString()}</strong><em>{[pattern.cross_sheet_reference ? "cross-sheet" : "", pattern.external_reference ? "external" : "", pattern.volatile ? "volatile" : ""].filter(Boolean).join(" / ") || "local"}</em></article>)}</div> : null}
                  {eucSection === "objects" ? <div className="euc-object-grid">{Object.entries((eucInventory.objects || []).reduce((groups, item) => ({...groups, [item.object_type]: [...(groups[item.object_type] || []), item]}), {})).map(([type, items]) => <article key={type}><span>{type.replaceAll("_", " ")}</span><strong>{items.length}</strong><small>{items.slice(0, 3).map((item) => item.object_name || item.cell_or_range).filter(Boolean).join(" / ")}</small></article>)}</div> : null}
                  {eucSection === "dependencies" ? <><DependencyWorkspace eucId={selectedEucId} inventory={eucInventory} onError={setError} /><div className="euc-dependencies dependency-sources"><div><p className="eyebrow">EXTERNAL WORKBOOKS</p>{(eucInventory.external_links || []).map((link) => <article key={link.link_id}><strong>{link.source_euc_reference}</strong><span>{link.relationship_type}</span><em>{link.resolution_status}</em></article>)}{!eucInventory.external_links?.length ? <div className="empty-state compact">No external workbook links discovered.</div> : null}</div><div><p className="eyebrow">DATA CONNECTIONS</p>{(eucInventory.connections || []).map((connection) => <article key={connection.connection_id}><strong>{connection.connection_name || "Unnamed connection"}</strong><span>{connection.connection_type || "Unknown type"}</span><em>{connection.credential_present ? "credentials redacted" : "metadata only"}</em></article>)}{!eucInventory.connections?.length ? <div className="empty-state compact">No packaged data connections discovered.</div> : null}</div></div></> : null}
                  {eucSection === "intelligence" ? <IntelligenceWorkspace eucId={selectedEucId} onError={setError} /> : null}
                  {eucSection === "migration" ? <MigrationWorkspace eucId={selectedEucId} onError={setError} /> : null}
                  {eucSection === "native" ? <NativeModelWorkspace eucId={selectedEucId} onError={setError} /> : null}
                  {(eucAssets.find((item) => item.euc_id === selectedEucId)?.warning_count || 0) > 0 ? <div className="euc-warning-ribbon"><strong>{eucAssets.find((item) => item.euc_id === selectedEucId)?.warning_count} inventory warning(s)</strong><span>Analysis completed without executing macros or external connections.</span></div> : null}
                </> : <div className="panel empty-state">Select an analyzed EUC asset to inspect its technical inventory.</div>}
              </section>
            </div>
          </div>
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
                  <div className="review-block-title"><div><p className="eyebrow">CHRONOLOGICAL REVIEW</p><h3>Approved change journey</h3><p className="muted">Only effective workbook changes are shown, in the exact commit order they reached this branch.</p></div><span>{mergeReviewTimeline.length} operation{mergeReviewTimeline.length === 1 ? "" : "s"}</span></div>
                  <div className="merge-timeline">{mergeReviewTimeline.map((change, index) => <article key={`${change.commit_id || "diff"}-${change.change_id || index}`}><div className="timeline-rail"><span>{index + 1}</span><i /></div><div className="timeline-change"><header><b>{change.operation_type.replaceAll("_", " ")}</b><time>{change.occurred_at ? new Date(change.occurred_at).toLocaleString() : "Computed review diff"}</time></header><p>{change.commit_message || "Pending semantic change"}<small>{change.author_email || "Git Walk validation"}</small></p><code>{change.previous_cell_reference || change.new_cell_reference || `${change.sheet_id} / ${change.row_id || "structure"} / ${change.column_id || "structure"}`}</code><div className="timeline-values"><del><span>-</span> {formatReviewValue(change.old_formula ?? change.old_value ?? null, change.new_formula ?? change.new_value ?? null)}</del><ins><span>+</span> {formatReviewValue(change.new_formula ?? change.new_value ?? null, change.old_formula ?? change.old_value ?? null)}</ins></div></div></article>)}</div>
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

        {tab === "admin" ? (
          <SecurityAdministration repositoryId={repository?.repository_id || ""} onError={setError} />
        ) : null}

        {tab === "fabric" ? (
          <InformationFabric onError={setError} />
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
            <section className="panel wide euc-storage-settings">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">LOCAL EUC WORKBOOK STORAGE</p>
                  <h2>Download & Working Copy Directory</h2>
                  <p className="muted">Specify the local directory on C: or D: drive where branch workbooks are downloaded, saved, and lifecycle-managed. The folder will be automatically created if it does not exist.</p>
                </div>
                <span className={`pill ${eucDownloadDir ? "ready" : "pending"}`}>{eucDownloadDir ? "Configured" : "Not configured"}</span>
              </div>
              <form className="euc-storage-form" onSubmit={handleSaveEucStorageSettings}>
                <label>
                  <span>Local Directory Path (Strictly C: or D: drive)</span>
                  <input
                    value={folderSettingsInput}
                    onChange={(event) => {
                      setFolderSettingsInput(event.target.value);
                      setFolderSettingsMsg("");
                    }}
                    placeholder="e.g. C:\GitWalk_Workbooks or D:\EUC_Files"
                    required
                  />
                </label>
                <div className="euc-storage-actions">
                  <button className="primary-button" disabled={folderSettingsBusy}>
                    {folderSettingsBusy ? "Validating & Saving..." : "Save Storage Directory"}
                  </button>
                  {eucDownloadDir ? <button type="button" className="secondary-button" onClick={() => setFolderSettingsInput(eucDownloadDir)}>Reset</button> : null}
                  {folderSettingsMsg ? <span className="settings-feedback">{folderSettingsMsg}</span> : null}
                </div>
              </form>
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
              <div className="panel-header"><div><p className="eyebrow">CHANGE TRACEABILITY / COMMITTED EVENTS</p><h2>Workbook mutation ledger</h2><p className="muted">Only cells, rows, columns, and sheets that were created, updated, moved, or deleted are listed. Unchanged imported data is intentionally excluded.</p></div><span className="pill ready">{changeActivity.events?.length || 0} events</span></div>
              <div className="activity-controls"><label>Operation<select value={activityOperation} onChange={(event) => setActivityOperation(event.target.value)}><option value="">All activity</option><option value="CELL_READ">Cell reads</option><option value="CELL_VALUE_UPDATE">Cell value updates</option><option value="CELL_FORMULA_UPDATE">Formula updates</option><option value="ROW_INSERT">Rows created</option><option value="ROW_DELETE">Rows deleted</option><option value="COLUMN_INSERT">Columns created</option><option value="COLUMN_DELETE">Columns deleted</option><option value="SHEET_CREATE">Sheets created</option><option value="SHEET_DELETE">Sheets deleted</option></select></label><label>Order<select value={activitySort} onChange={(event) => setActivitySort(event.target.value)}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label></div>
              <div className="blame-table-wrap">
                <table className="blame-table activity-table"><thead><tr><th>Action</th><th>Excel coordinate</th><th>Before / after</th><th>Author</th><th>Commit / time</th><th /></tr></thead><tbody>
                  {(changeActivity.events || []).map((event) => <tr key={event.change_id}><td><b className={`event-action action-${event.action}`}>{event.action}</b><small>{event.operation_type.replaceAll("_", " ")}</small></td><td><strong>{event.column_name || event.sheet_name || "Workbook structure"}</strong><small>{event.sheet_name || event.sheet_id} / row {event.row_position == null ? "-" : event.row_position + 1} / col {event.column_position == null ? "-" : event.column_position + 1}</small><code>{event.previous_cell_reference || event.new_cell_reference || event.row_id || event.column_id || event.sheet_id}</code></td><td><div className="compact-value-diff"><del>{JSON.stringify(event.old_formula ?? event.old_value ?? null)}</del><ins>{JSON.stringify(event.new_formula ?? event.new_value ?? null)}</ins></div></td><td>{event.author_email || event.author_user_id}</td><td><span className="trace-commit">{String(event.commit_id).slice(0, 14)}</span><small>{new Date(event.occurred_at).toLocaleString()}</small></td><td>{event.row_id && event.column_id && event.action !== "deleted" ? <button className="trace-button" onClick={() => inspectBlameCell(event)}>Trace</button> : null}</td></tr>)}
                </tbody></table>
              </div>
              {!changeActivity.events?.length ? <div className="empty-state compact">No committed mutations match this sheet and filter.</div> : null}
            </section>
            {selectedTrace ? <section className="panel traceability-card"><button className="trace-close" onClick={() => setSelectedTrace(null)}>Close</button><p className="eyebrow">VALUE PROVENANCE</p><h2>{selectedTrace.column_name} / {selectedTrace.row_id}</h2><div className="trace-current"><span>Current</span><strong>{selectedTrace.formula || JSON.stringify(selectedTrace.value)}</strong></div><div className="trace-facts"><div><span>Author</span><strong>{selectedTrace.last_author_email || selectedTrace.last_author_user_id}</strong></div><div><span>Commit</span><strong>{selectedTrace.last_commit_id}</strong></div><div><span>Merge request</span><strong>{selectedTrace.merge_request_id || "Not merged through an MR"}</strong></div><div><span>Modified</span><strong>{new Date(selectedTrace.last_modified_at).toLocaleString()}</strong></div></div><div className="trace-history">{(selectedTrace.history || []).map((event) => <article key={event.change_id}><i /><div><strong>{event.operation_type.replaceAll("_", " ")}</strong><span>{event.author_email} / {event.message}</span><code>{JSON.stringify(event.old_value)} to {JSON.stringify(event.new_value)}</code></div></article>)}</div></section> : null}
          </div>
        ) : null}

        {tab === "storage" ? (
          <div className="storage-stage">
            <section className="storage-hero">
              <div className="storage-hero-copy">
                <p className="eyebrow">SEMANTIC LEDGER / CONTENT ADDRESSED</p>
                <h2>One logical workbook.<br />Only unique data stored.</h2>
                <p>Every commit points to a verified root manifest. Branches share unchanged objects and only changed blocks consume new physical storage.</p>
                <div className="storage-actions">
                  <button onClick={migrateStorage} disabled={storageBusy || !repository?.capabilities?.manage_access}>{storageBusy ? "Verifying ledger..." : "Verify + migrate roots"}</button>
                  <button onClick={inspectGarbage} disabled={storageBusy || !repository?.capabilities?.manage_access}>Preview garbage collection</button>
                </div>
                {storageNotice ? <div className="storage-notice">{storageNotice}</div> : null}
              </div>
              <div className="merkle-map" aria-label="Commit to immutable object topology">
                <div className="merkle-node commit-root"><span>HEAD</span><strong>{String(selectedBranch?.head_commit_id || "ROOT").slice(0, 12)}</strong></div>
                <i />
                <div className="merkle-node root-manifest"><span>ROOT MANIFEST</span><strong>{storageMetrics?.root_manifests || 0} roots</strong></div>
                <div className="merkle-branches"><i /><i /><i /></div>
                <div className="merkle-leaves"><span>Values</span><span>Formulas</span><span>Styles</span></div>
              </div>
            </section>

            <section className="storage-score-grid">
              <article><span>Logical change volume</span><strong>{formatBytes(storageMetrics?.logical_bytes)}</strong><small>Workbook history represented</small></article>
              <article><span>Physical object storage</span><strong>{formatBytes(storageMetrics?.physical_bytes)}</strong><small>Compressed unique payload</small></article>
              <article><span>Deduplication saved</span><strong>{formatBytes(storageMetrics?.deduplication_saved_bytes)}</strong><small>{storageMetrics?.object_references || 0} shared references</small></article>
              <article><span>Compression</span><strong>{storageMetrics?.compression_ratio || 1}x</strong><small>{formatBytes(storageMetrics?.compression_saved_bytes)} avoided</small></article>
            </section>

            <section className="panel storage-inventory">
              <div className="panel-header">
                <div><p className="eyebrow">OBJECT INVENTORY</p><h2>Branch storage footprint</h2><p className="muted">Reachable cost shows the complete state addressable from each branch HEAD. Shared objects are never copied.</p></div>
                <div className="object-health"><i /><span>{storageMetrics?.object_health?.corrupt ? `${storageMetrics.object_health.corrupt} corrupt` : "All objects verified"}</span><b>{storageMetrics?.unique_objects || 0} unique</b></div>
              </div>
              <div className="branch-cost-table">
                <header><span>Branch pointer</span><span>HEAD</span><span>Objects</span><span>Reachable storage</span></header>
                {(storageMetrics?.branches || []).map((branch) => <article key={branch.branch_id}><div><i /><strong>{branch.branch_name}</strong><small>{branch.branch_id}</small></div><code>{String(branch.head_commit_id || "ROOT").slice(0, 18)}</code><b>{branch.reachable_objects}</b><strong>{formatBytes(branch.reachable_bytes)}</strong></article>)}
              </div>
            </section>

            <section className="storage-principles">
              <article><span>01</span><div><strong>Immutable by construction</strong><p>Server-computed hashes protect every object. Corruption is detected before state is returned.</p></div></article>
              <article><span>02</span><div><strong>Copy-on-write commits</strong><p>A cell update creates only its changed block, sheet manifest, and root path.</p></div></article>
              <article><span>03</span><div><strong>Safe lifecycle</strong><p>Mark-and-sweep sees all commit roots and refuses destructive GC under legal hold.</p></div></article>
            </section>
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

        {tab === "ai" ? <AICommandCenter repositoryId={repository?.repository_id || null} onError={setError} /> : null}

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
                <label>Free NVIDIA model<select value={aiConfigModel} onChange={(event) => setAiConfigModel(event.target.value)} required>{aiModels.models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
                <small className="ai-privacy-note">Zero-price NVIDIA routes only. Free endpoints may be rate limited and provider-logged.</small>
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
