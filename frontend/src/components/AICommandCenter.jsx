import React, { useEffect, useState } from "react";
import {
  clearAIConfig,
  confirmAIAction,
  getAIAgentRuns,
  getAIConversations,
  getAIEvaluations,
  getAIInsights,
  getAIModels,
  getAIPlatformAdministration,
  getAIPlatformUsage,
  runAIAgent,
  runAIEvaluation,
  saveAIConfig,
  scanAIControls,
  sendAIPlatformMessage,
  updateAIPlatformSettings,
  updateAIModelPolicy,
} from "../services/api";

const prompts = [
  ["Control brief", "Explain the highest-priority control exceptions, their evidence, and the safest next decisions."],
  ["Change impact", "Summarize recent repository changes and identify downstream impact using only cited evidence."],
  ["Operations", "Diagnose integration freshness, reconciliation, conflicts, and dead-letter health. Do not execute actions."],
];

const fallbackAgents = [
  { agent_key: "INVESTIGATION_AGENT", name: "Root-cause investigator", description: "Evidence-backed investigation across governed context." },
  { agent_key: "INTEGRATION_OPERATIONS_AGENT", name: "Integration operations", description: "Diagnoses incidents and prepares confirmation-gated recovery." },
  { agent_key: "CONTROL_REMEDIATION_AGENT", name: "Control remediation", description: "Explains control failures and drafts remediation." },
];

function safeJson(value, fallback) {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

function modelLabel(slug) {
  return String(slug || "")
    .replace(/^nvidia\//, "")
    .replace(/:free$/, "")
    .replaceAll("-", " ");
}

export default function AICommandCenter({ repositoryId, onError }) {
  const [view, setView] = useState("copilot");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState(null);
  const [models, setModels] = useState({ configured: false, models: [] });
  const [admin, setAdmin] = useState(null);
  const [usage, setUsage] = useState(null);
  const [insights, setInsights] = useState([]);
  const [runs, setRuns] = useState([]);
  const [evaluations, setEvaluations] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [question, setQuestion] = useState(prompts[0][1]);
  const [conversationId, setConversationId] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [agentKey, setAgentKey] = useState("INVESTIGATION_AGENT");
  const [agentGoal, setAgentGoal] = useState("Investigate the most important open exception and provide a grounded remediation plan.");
  const [actionType, setActionType] = useState("");
  const [actionTarget, setActionTarget] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [editingProvider, setEditingProvider] = useState(false);
  const [policyFeature, setPolicyFeature] = useState("ENTERPRISE_COPILOT");
  const [policyModelId, setPolicyModelId] = useState("");

  const refresh = async () => {
    const requests = await Promise.allSettled([
      getAIModels(), getAIPlatformAdministration(), getAIPlatformUsage(), getAIInsights(),
      getAIAgentRuns(), getAIEvaluations(), getAIConversations(),
    ]);
    if (requests[0].status === "fulfilled") {
      const catalog = requests[0].value.models || [];
      setModels(requests[0].value);
      setModel((current) => catalog.includes(current) ? current : requests[0].value.default_model || catalog[0] || "");
    }
    if (requests[1].status === "fulfilled") setAdmin(requests[1].value);
    if (requests[2].status === "fulfilled") setUsage(requests[2].value);
    if (requests[3].status === "fulfilled") setInsights(requests[3].value);
    if (requests[4].status === "fulfilled") setRuns(requests[4].value);
    if (requests[5].status === "fulfilled") setEvaluations(requests[5].value);
    if (requests[6].status === "fulfilled") setConversations(requests[6].value);
  };

  useEffect(() => { refresh().catch((error) => onError?.(error.message)); }, []);

  const perform = async (work, success) => {
    setBusy(true); setNotice(""); setFailure(null);
    try { const result = await work(); if (success) setNotice(success(result)); await refresh(); return result; }
    catch (error) {
      setFailure({ code: error.code || `HTTP_${error.status || "ERROR"}`, message: error.message });
      onError?.(error.message);
      return null;
    }
    finally { setBusy(false); }
  };

  const ask = async () => {
    const result = await perform(() => sendAIPlatformMessage({
      question, conversation_id: conversationId, repository_id: repositoryId || null,
      resource_type: repositoryId ? "REPOSITORY" : "ORGANIZATION", resource_id: repositoryId || null,
      model: model || null,
    }));
    if (result) { setAnswer(result); setConversationId(result.conversation_id); }
  };

  const connect = async (event) => {
    event.preventDefault();
    const result = await perform(
      () => saveAIConfig(apiKey.trim(), model.trim()),
      (value) => value.replaced ? "OpenRouter token replaced and routing updated." : "OpenRouter token encrypted and connected.",
    );
    if (result) {
      setApiKey("");
      setEditingProvider(false);
      setModel(result.default_model);
    }
  };

  const scan = () => perform(() => scanAIControls(repositoryId || null), (result) => `${result.generated} governed control signal(s) refreshed.`);
  const runAgent = async () => {
    const requestedAction = actionType && actionTarget ? {
      action_type: actionType,
      ...(actionType === "RUN_INTEGRATION" ? { connection_id: actionTarget } : { dead_letter_id: actionTarget }),
    } : null;
    const result = await perform(() => runAIAgent({
      agent_key: agentKey, goal: agentGoal, repository_id: repositoryId || null,
      resource_type: repositoryId ? "REPOSITORY" : "ORGANIZATION", resource_id: repositoryId || null,
      model: model || null,
      requested_action: requestedAction,
    }), (value) => value.status === "COMPLETED" ? "Agent investigation completed without write actions." : "Agent is waiting for explicit action confirmation.");
    if (result) setView("agents");
  };

  const updatePolicy = () => {
    const settings = admin?.settings || {};
    return perform(() => updateAIPlatformSettings({
      ai_enabled: Boolean(settings.ai_enabled), external_ai_enabled: Boolean(settings.external_ai_enabled),
      allowed_classifications: safeJson(settings.allowed_classifications_json, ["PUBLIC", "INTERNAL", "CONFIDENTIAL"]),
      daily_token_quota: Number(settings.daily_token_quota || 1000000),
      user_daily_token_quota: Number(settings.user_daily_token_quota || 150000),
      agent_actions_enabled: Boolean(settings.agent_actions_enabled), retention_days: Number(settings.retention_days || 90),
    }), () => "Organization AI policy saved and audited.");
  };

  const updateRoute = () => perform(() => updateAIModelPolicy(policyFeature, {
    model_role: "REASONING", model_id: policyModelId || null, allow_external: true,
    allowed_classifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    max_input_tokens: 24000, max_output_tokens: 3000, temperature: 0.1,
  }), (result) => `${result.feature} routing policy saved.`);

  const tabs = [["copilot", "Copilot"], ["controls", "Controls"], ["agents", "Agents"], ["operations", "AI operations"]];
  const agents = admin?.agents || fallbackAgents;
  const quota = usage?.quota || admin?.settings || {};
  const tokenTotal = usage?.tokens?.total || 0;
  const quotaTotal = quota.daily_token_quota || 1000000;

  return <div className="ai-command-center">
    <section className="ai-command-hero">
      <div>
        <p className="eyebrow">STAGE 5 / GOVERNED DECISION INTELLIGENCE</p>
        <h2>Ask broadly.<br /><em>Act deliberately.</em></h2>
        <p>One policy-aware AI plane across repositories, EUC intelligence, integrations, digital threads, controls, and immutable evidence.</p>
      </div>
      <div className="ai-orbit" aria-label="AI safety architecture">
        <span>CONTEXT</span><span>POLICY</span><strong>AI</strong><span>EVIDENCE</span><span>HUMAN</span><i />
      </div>
    </section>

    <nav className="ai-command-nav">
      {tabs.map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}
      <button className="ai-refresh" onClick={() => refresh()} disabled={busy}>Refresh signals</button>
    </nav>
    {notice ? <div className="ai-notice">{notice}</div> : null}
    {failure ? <div className="ai-command-error"><div><strong>{failure.code.replaceAll("_", " ")}</strong><span>{failure.message}</span></div><button onClick={() => setFailure(null)}>Dismiss</button></div> : null}

    <section className="ai-signal-grid">
      <article><span>Grounded requests</span><strong>{usage?.requests || 0}</strong><small>{usage?.average_grounding ? `${Math.round(usage.average_grounding * 100)}% average grounding` : "Evidence required"}</small></article>
      <article><span>Open controls</span><strong>{insights.length}</strong><small>{insights.filter((item) => ["HIGH", "CRITICAL"].includes(item.severity)).length} require priority review</small></article>
      <article><span>Supervised runs</span><strong>{runs.length}</strong><small>{runs.filter((item) => item.status === "WAITING_CONFIRMATION").length} awaiting confirmation</small></article>
      <article><span>Safety baseline</span><strong>{evaluations[0]?.status || "NOT RUN"}</strong><small>{evaluations[0] ? `${evaluations[0].passed_cases}/${evaluations[0].total_cases} checks` : "Run before rollout"}</small></article>
    </section>

    {view === "copilot" ? <div className="ai-copilot-layout">
      <section className="ai-surface ai-conversation">
        <header><div><p className="eyebrow">CONTEXTUAL COPILOT</p><h3>Grounded enterprise reasoning</h3></div><div className="ai-provider-status"><span className={models.configured ? "ai-state connected" : "ai-state"}>{models.configured ? `OpenRouter ${models.masked_key || ""}` : "Provider required"}</span>{models.configured ? <button type="button" onClick={() => setEditingProvider(true)}>Replace token</button> : null}</div></header>
        <div className="ai-prompt-deck">{prompts.map(([label, prompt]) => <button key={label} onClick={() => setQuestion(prompt)}><span>{label}</span><small>{prompt}</small></button>)}</div>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about a repository, control, incident, dependency, or decision..." />
        <footer><select aria-label="Free NVIDIA model" value={model} onChange={(event) => setModel(event.target.value)}>{(models.models || []).map((item) => <option key={item} value={item}>NVIDIA {modelLabel(item)} / free</option>)}</select><button onClick={ask} disabled={busy || !models.configured || !model || question.trim().length < 3}>{busy ? "Grounding answer..." : "Ask with evidence"}</button></footer>
        {!models.configured || editingProvider ? <form className="ai-provider-inline" onSubmit={connect}><div><strong>{models.configured ? "Replace OpenRouter token" : "Connect OpenRouter"}</strong><small>The token is encrypted, write-only, and scoped to your account.</small></div><label><span>New API token</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-..." required /></label><label><span>Free NVIDIA model</span><select value={model} onChange={(event) => setModel(event.target.value)} required>{(models.models || []).map((item) => <option key={item} value={item}>{modelLabel(item)}</option>)}</select></label><div className="ai-provider-actions"><button disabled={busy || !model}>{models.configured ? "Replace securely" : "Connect"}</button>{models.configured ? <button type="button" className="secondary" onClick={() => { setEditingProvider(false); setApiKey(""); }}>Cancel</button> : null}</div><small className="ai-free-notice">Zero-price NVIDIA routes only. Free endpoints can be rate limited and provider-logged; do not submit confidential data unless your OpenRouter policy permits it.</small></form> : null}
      </section>
      <aside className="ai-surface ai-answer">
        <header><p className="eyebrow">ANSWER / PROVENANCE</p>{answer ? <span style={{ "--confidence": `${Math.round(answer.confidence * 100)}%` }}>{Math.round(answer.confidence * 100)}%</span> : null}</header>
        {answer ? <><div className="ai-answer-runtime"><span>TOKENS CONSUMED<strong>{((answer.usage?.input_tokens || 0) + (answer.usage?.output_tokens || 0) + (answer.usage?.reasoning_tokens || 0)).toLocaleString()}</strong></span><span>LATENCY<strong>{answer.latency_ms >= 1000 ? `${(answer.latency_ms / 1000).toFixed(1)} S` : `${Math.round(answer.latency_ms || 0)} MS`}</strong></span><span>DELIVERY<strong>{answer.cache_hit ? "CACHE HIT" : "LIVE RESPONSE"}</strong></span></div><h3>{answer.insufficient_evidence ? "Evidence is incomplete" : "Grounded response"}</h3><p>{answer.answer}</p><div className="ai-evidence-list">{answer.evidence_bundle?.map((item) => <article key={`${item.type}:${item.id}`}><span>{item.type}</span><strong>{item.title}</strong><code>{item.id}</code></article>)}</div>{answer.warnings?.map((warning) => <small className="ai-warning" key={warning}>{warning}</small>)}</> : <div className="ai-empty"><strong>No synthetic certainty</strong><p>Answers appear here only after authorized evidence retrieval and structured-output validation.</p><span>{conversations.length} saved conversation(s)</span></div>}
      </aside>
    </div> : null}

    {view === "controls" ? <section className="ai-surface ai-controls-room">
      <header><div><p className="eyebrow">CONTINUOUS CONTROL INTELLIGENCE</p><h3>Deterministic detection, AI explanation</h3></div><button onClick={scan} disabled={busy}>Scan governed signals</button></header>
      <div className="ai-control-list">{insights.map((item) => <article key={item.insight_id} className={`severity-${item.severity.toLowerCase()}`}><span>{item.severity}</span><div><strong>{item.title}</strong><p>{item.summary}</p><code>{item.resource_type} / {item.resource_id}</code></div><b>{item.generated_by.replaceAll("_", " ")}</b></article>)}{!insights.length ? <div className="ai-empty"><strong>No open control signals</strong><p>Run a scan to inspect deterministic Stage 1-4 exceptions.</p></div> : null}</div>
    </section> : null}

    {view === "agents" ? <div className="ai-agent-layout">
      <section className="ai-surface ai-agent-launcher"><p className="eyebrow">SUPERVISED AUTONOMY</p><h3>Launch a bounded investigation</h3><div className="ai-agent-cards">{agents.map((agent) => <button key={agent.agent_key} className={agentKey === agent.agent_key ? "active" : ""} onClick={() => setAgentKey(agent.agent_key)}><span>{agent.ai_level || "A2"}</span><strong>{agent.name}</strong><small>{agent.description}</small></button>)}</div><textarea value={agentGoal} onChange={(event) => setAgentGoal(event.target.value)} /><div className="ai-action-prep"><select value={actionType} onChange={(event) => setActionType(event.target.value)}><option value="">No write action</option><option value="RUN_INTEGRATION">Prepare integration run</option><option value="REPLAY_DEAD_LETTER">Prepare dead-letter replay</option></select>{actionType ? <input value={actionTarget} onChange={(event) => setActionTarget(event.target.value)} placeholder={actionType === "RUN_INTEGRATION" ? "Connection ID" : "Dead-letter ID"} /> : null}</div><button className="ai-run" onClick={runAgent} disabled={busy || !models.configured || (actionType && !actionTarget.trim())}>{busy ? "Running bounded plan..." : actionType ? "Investigate and prepare action" : "Run investigation"}</button><small className="ai-policy-note">Read tools may run automatically. Writes are prepared only and always require explicit human confirmation plus the underlying permission.</small></section>
      <section className="ai-surface ai-run-ledger"><header><p className="eyebrow">AGENT RUN LEDGER</p><span>{runs.length} runs</span></header>{runs.map((run) => <article key={run.agent_run_id}><div><span>{run.status.replaceAll("_", " ")}</span><strong>{run.name}</strong><code>{run.agent_run_id}</code></div>{run.actions?.map((action) => <button key={action.action_id} onClick={() => perform(() => confirmAIAction(action.action_id), () => "Authorized action executed and audited.")} disabled={busy || action.status !== "PENDING_CONFIRMATION"}>{action.status === "PENDING_CONFIRMATION" ? `Confirm ${action.action_type.replaceAll("_", " ")}` : action.status}</button>)}</article>)}{!runs.length ? <div className="ai-empty"><strong>No agent runs</strong><p>Start with an evidence-only investigation.</p></div> : null}</section>
    </div> : null}

    {view === "operations" ? <div className="ai-operations-layout">
      <section className="ai-surface ai-usage"><header><div><p className="eyebrow">FINOPS / OBSERVABILITY</p><h3>AI consumption and quality</h3></div><strong>{tokenTotal.toLocaleString()} tokens</strong></header><div className="ai-quota"><i style={{ width: `${Math.min(100, (tokenTotal / quotaTotal) * 100)}%` }} /></div><small>{Math.max(0, quotaTotal - tokenTotal).toLocaleString()} organization tokens remain in today&apos;s configured envelope</small><div className="ai-usage-facts"><span>Cache hits<b>{usage?.cache_hits || 0}</b></span><span>Invalid outputs<b>{usage?.invalid_outputs || 0}</b></span><span>Average latency<b>{Math.round(usage?.average_latency_ms || 0)} ms</b></span><span>Reasoning tokens<b>{usage?.tokens?.reasoning || 0}</b></span></div></section>
      <section className="ai-surface ai-evaluations"><header><div><p className="eyebrow">EVALUATION / RED TEAM</p><h3>Release safety baseline</h3></div><button onClick={() => perform(runAIEvaluation, (result) => `${result.passed_cases}/${result.total_cases} safety checks passed.`)} disabled={busy}>Run baseline</button></header>{evaluations.slice(0, 8).map((evaluation) => <article key={evaluation.evaluation_run_id}><span className={evaluation.status === "PASSED" ? "pass" : "fail"}>{evaluation.status}</span><div><strong>{evaluation.suite_name.replaceAll("_", " ")}</strong><small>{new Date(evaluation.started_at).toLocaleString()}</small></div><b>{evaluation.passed_cases}/{evaluation.total_cases}</b></article>)}</section>
      {admin ? <section className="ai-surface ai-admin-policy"><header><div><p className="eyebrow">ORGANIZATION POLICY</p><h3>AI remains below policy</h3></div><button onClick={updatePolicy} disabled={busy}>Save policy</button></header><div className="ai-policy-grid"><label><span>AI enabled</span><input type="checkbox" checked={Boolean(admin.settings.ai_enabled)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, ai_enabled: event.target.checked } })} /></label><label><span>External provider</span><input type="checkbox" checked={Boolean(admin.settings.external_ai_enabled)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, external_ai_enabled: event.target.checked } })} /></label><label><span>Agent actions</span><input type="checkbox" checked={Boolean(admin.settings.agent_actions_enabled)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, agent_actions_enabled: event.target.checked } })} /></label><label><span>User daily quota</span><input type="number" value={admin.settings.user_daily_token_quota} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, user_daily_token_quota: event.target.value } })} /></label></div><div className="ai-model-route"><label><span>Feature route</span><input value={policyFeature} onChange={(event) => setPolicyFeature(event.target.value.toUpperCase())} /></label><label><span>Enforced model</span><select value={policyModelId} onChange={(event) => setPolicyModelId(event.target.value)}><option value="">Capability-based routing</option>{admin.models.map((item) => <option key={item.model_id} value={item.model_id}>{item.model_slug} / {item.model_role}</option>)}</select></label><button onClick={updateRoute} disabled={busy || !policyFeature.trim()}>Enforce route</button><div>{admin.policies.map((item) => <span key={item.policy_id}>{item.feature} / {item.model_role}</span>)}</div></div><footer><span>{admin.models.length} governed models</span><span>{admin.tools.length} registered tools</span><span>{admin.agents.length} bounded agents</span><button onClick={() => perform(clearAIConfig, () => "Personal provider credential disconnected.")} disabled={!models.configured}>Disconnect provider</button></footer></section> : <section className="ai-surface ai-empty"><strong>Administrative metrics are permission restricted</strong><p>Organization owners and auditors can review quotas, provider policy, and evaluations.</p></section>}
    </div> : null}
  </div>;
}
