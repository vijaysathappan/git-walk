const API_BASE = "/api/v1";
const AUTH_KEY = "livesync:auth";

export function getStoredAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
  } catch {
    return null;
  }
}

export function storeAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

export function getClientId(surface) {
  const key = `gitwalk:client:${surface}`;
  let clientId = localStorage.getItem(key);
  if (!clientId) {
    clientId = `${surface}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(key, clientId);
  }
  return clientId;
}

async function parseError(response) {
  const body = await response.json().catch(() => ({}));
  const detail = body.detail || body.message || `HTTP ${response.status}`;
  return { body, detail };
}

async function apiFetch(path, options = {}) {
  const auth = getStoredAuth();
  const headers = new Headers(options.headers || {});
  if (auth?.token) headers.set("Authorization", `Bearer ${auth.token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      clearAuth();
      window.dispatchEvent(new Event("gitwalk:auth-expired"));
    }
    const parsed = await parseError(response);
    const message = typeof parsed.detail === "object"
      ? parsed.detail.message || JSON.stringify(parsed.detail)
      : parsed.detail;
    const error = new Error(message);
    error.status = response.status;
    error.detail = parsed.detail;
    throw error;
  }
  return response;
}

export async function requestLoginCode(email) {
  const response = await fetch(`${API_BASE}/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    const parsed = await parseError(response);
    throw new Error(typeof parsed.detail === "object" ? parsed.detail.message : parsed.detail);
  }
  return response.json();
}

export async function verifyLoginCode(email, code) {
  const response = await fetch(`${API_BASE}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!response.ok) {
    const parsed = await parseError(response);
    throw new Error(typeof parsed.detail === "object" ? parsed.detail.message : parsed.detail);
  }
  const auth = await response.json();
  storeAuth(auth);
  return auth;
}

export async function getProfile() {
  return (await apiFetch("/auth/me")).json();
}

export async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } finally {
    clearAuth();
  }
}

export async function uploadAndProvision(file, metadata = {}) {
  const formData = new FormData();
  formData.append("file", file);
  Object.entries(metadata).forEach(([key, value]) => {
    if (value != null && String(value).trim() !== "") formData.append(key, value);
  });
  const response = await apiFetch("/upload-and-provision", {
    method: "POST",
    body: formData,
  });
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
  return {
    blob,
    tableId: response.headers.get("X-Table-ID") || "UNKNOWN",
    branchTableId: response.headers.get("X-Branch-Table-ID") || "",
    repositoryId: response.headers.get("X-Repository-ID") || "",
    branchId: response.headers.get("X-Branch-ID") || "",
    workingCopyId: response.headers.get("X-Working-Copy-ID") || "",
    rowCount: response.headers.get("X-Row-Count") || "0",
    colCount: response.headers.get("X-Column-Count") || "0",
    filename: filenameMatch ? filenameMatch[1] : `configured_${file.name}`,
  };
}

export async function realtimeSync(payload) {
  return (
    await apiFetch("/realtime-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function bulkSync(payload) {
  return (
    await apiFetch("/bulk-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function getWorkbookSnapshot(tableId, version = null) {
  const query = version == null ? "" : `?version=${encodeURIComponent(version)}`;
  return (await apiFetch(`/datasets/${tableId}/snapshot${query}`)).json();
}

export async function commitWorkbook(payload) {
  return (
    await apiFetch("/workbook-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function getBranchState(branchId, commitId = "") {
  const query = commitId ? `?commit_id=${encodeURIComponent(commitId)}` : "";
  return (await apiFetch(`/branches/${branchId}/state${query}`)).json();
}

export async function getBranchCommits(branchId, limit = 100) {
  return (await apiFetch(`/branches/${branchId}/commits?limit=${limit}`)).json();
}

export async function getBranchMetrics(branchId) {
  return (await apiFetch(`/branches/${branchId}/metrics`)).json();
}

export async function getCommitDetail(commitId) {
  return (await apiFetch(`/commits/${commitId}`)).json();
}

export async function getStableCellHistory(branchId, sheetId, rowId, columnId, limit = 100) {
  return (
    await apiFetch(
      `/branches/${branchId}/cells/${sheetId}/${rowId}/${columnId}/history?limit=${limit}`
    )
  ).json();
}

export async function getBranchDivergence(branchId) {
  return (await apiFetch(`/branches/${branchId}/divergence`)).json();
}

export async function syncBranchWithMain(branchId) {
  return (await apiFetch(`/branches/${branchId}/sync`, { method: "POST" })).json();
}

export async function getMergeRequests(tableId) {
  return (await apiFetch(`/repositories/${tableId}/merge-requests`)).json();
}

export async function createMergeRequest(payload) {
  return (
    await apiFetch("/merge-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function getMergeRequest(mergeRequestId) {
  return (await apiFetch(`/merge-requests/${mergeRequestId}`)).json();
}

export async function resolveMergeConflict(mergeRequestId, conflictId, payload) {
  return (
    await apiFetch(`/merge-requests/${mergeRequestId}/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function reviewMergeRequest(mergeRequestId, decision, comment = "") {
  return (
    await apiFetch(`/merge-requests/${mergeRequestId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment }),
    })
  ).json();
}

export async function mergeMergeRequest(mergeRequestId) {
  return (await apiFetch(`/merge-requests/${mergeRequestId}/merge`, { method: "POST" })).json();
}

export async function revertSemanticCommit(commitId) {
  return (await apiFetch(`/commits/${commitId}/revert`, { method: "POST" })).json();
}

export async function getCellValue(payload) {
  const params = new URLSearchParams({
    table_id: payload.table_id,
    row_id: String(payload.row_id),
    column_name: payload.column_name,
  });
  return (await apiFetch(`/cell-value?${params}`)).json();
}

export async function getDatasets() {
  return (await apiFetch("/datasets")).json();
}

export async function getCategories() {
  return (await apiFetch("/categories")).json();
}

export async function createCategory(name, description = "", parentCategoryId = "CAT_HOME") {
  return (
    await apiFetch("/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        parent_category_id: parentCategoryId,
      }),
    })
  ).json();
}

export async function getRepository(tableId) {
  return (await apiFetch(`/repositories/${tableId}`)).json();
}

export async function checkRepositoryName(name) {
  return (await apiFetch(`/repositories/name-availability?name=${encodeURIComponent(name)}`)).json();
}

export async function getRepositoryBranches(tableId) {
  return (await apiFetch(`/repositories/${tableId}/branches`)).json();
}

export async function getMyWorkingCopies() {
  return (await apiFetch("/working-copies/mine")).json();
}

export async function moveRepositoryToCategory(tableId, categoryId) {
  return (
    await apiFetch(`/repositories/${tableId}/category`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id: categoryId }),
    })
  ).json();
}

export async function workOnWorkbook(tableId) {
  const response = await apiFetch(`/repositories/${tableId}/work-on-workbook`, {
    method: "POST",
  });
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameMatch ? filenameMatch[1] : `gitwalk_${tableId}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return {
    repositoryId: response.headers.get("X-Repository-ID"),
    branchId: response.headers.get("X-Branch-ID"),
    workingCopyId: response.headers.get("X-Working-Copy-ID"),
  };
}

async function downloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameMatch ? filenameMatch[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadRepositoryBranch(tableId, branchId) {
  const response = await apiFetch(`/repositories/${tableId}/branches/${branchId}/download`);
  await downloadResponse(response, `gitwalk_${branchId}.xlsx`);
}

export async function getRepositorySheetData(tableId, branchId, sheetId, limit = 100, offset = 0) {
  return (
    await apiFetch(
      `/repositories/${tableId}/branches/${branchId}/sheets/${sheetId}/records?limit=${limit}&offset=${offset}`
    )
  ).json();
}

export async function deleteRepository(tableId) {
  return (await apiFetch(`/repositories/${tableId}`, { method: "DELETE" })).json();
}

export async function deleteBranch(branchId) {
  return (await apiFetch(`/branches/${branchId}`, { method: "DELETE" })).json();
}

export async function getDatasetData(tableId, limit = 100, offset = 0) {
  return (await apiFetch(`/datasets/${tableId}/data?limit=${limit}&offset=${offset}`)).json();
}

export async function getDatasetHistory(tableId, limit = 100) {
  return (await apiFetch(`/datasets/${tableId}/history?limit=${limit}`)).json();
}

export async function getDatasetMembers(tableId) {
  return (await apiFetch(`/datasets/${tableId}/members`)).json();
}

export async function addDatasetMember(tableId, email, role) {
  return (
    await apiFetch(`/datasets/${tableId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    })
  ).json();
}

export async function revokeDatasetMember(tableId, email) {
  const query = new URLSearchParams({ email });
  return (await apiFetch(`/datasets/${tableId}/members?${query}`, { method: "DELETE" })).json();
}

export async function getWorkspaceState(tableId, sinceRevision = 0, waitSeconds = 0) {
  const query = new URLSearchParams({
    since_revision: String(sinceRevision),
    wait_seconds: String(waitSeconds),
  });
  return (await apiFetch(`/datasets/${tableId}/workspace?${query}`)).json();
}

export async function heartbeatPresence(tableId, clientId, surface, activity = "viewing") {
  return (
    await apiFetch(`/datasets/${tableId}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, surface, activity }),
    })
  ).json();
}

export async function getDatasetPresence(tableId) {
  return (await apiFetch(`/datasets/${tableId}/presence`)).json();
}

export async function leaveDatasetPresence(tableId, clientId) {
  const query = new URLSearchParams({ client_id: clientId });
  return (await apiFetch(`/datasets/${tableId}/presence?${query}`, { method: "DELETE" })).json();
}

export async function getKpis(tableId = "") {
  const query = tableId ? `?table_id=${encodeURIComponent(tableId)}` : "";
  return (await apiFetch(`/analytics/kpis${query}`)).json();
}

export async function rollbackChangeSet(tableId, batchId) {
  return (
    await apiFetch("/datasets/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table_id: tableId, batch_id: batchId }),
    })
  ).json();
}

export async function downloadDataset(tableId, format = "xlsx") {
  const response = await apiFetch(`/datasets/${tableId}/export?format=${format}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${tableId}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function getAIModels() {
  return (await apiFetch("/ai/models")).json();
}

export async function saveAIConfig(apiKey, model) {
  return (
    await apiFetch("/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, model }),
    })
  ).json();
}

export async function clearAIConfig() {
  return (await apiFetch("/ai/config", { method: "DELETE" })).json();
}

export async function generateAIInsight(payload) {
  return (
    await apiFetch("/ai/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function getAuditEvents(tableId = "", options = {}) {
  const query = new URLSearchParams();
  if (tableId) query.set("table_id", tableId);
  if (options.eventType) query.set("event_type", options.eventType);
  if (options.status) query.set("status", options.status);
  query.set("limit", String(options.limit || 300));
  return (await apiFetch(`/audit/events?${query}`)).json();
}

export async function getOperationalMetrics(hours = 24) {
  return (await apiFetch(`/observability/metrics?hours=${hours}`)).json();
}

export async function getSecurityPosture() {
  return (await apiFetch("/security/posture")).json();
}

export async function getRepositoryInsights(tableId) {
  return (await apiFetch(`/repositories/${tableId}/insights`)).json();
}

export async function getWorkbookBlame(branchId, sheetId = "", limit = 5000) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (sheetId) query.set("sheet_id", sheetId);
  return (await apiFetch(`/branches/${branchId}/blame?${query}`)).json();
}

export async function getRowHistory(branchId, sheetId, rowId) {
  return (await apiFetch(`/branches/${branchId}/rows/${sheetId}/${rowId}/history`)).json();
}

export async function getCellTraceability(branchId, sheetId, rowId, columnId) {
  return (
    await apiFetch(
      `/branches/${branchId}/cells/${sheetId}/${rowId}/${columnId}/traceability`
    )
  ).json();
}
