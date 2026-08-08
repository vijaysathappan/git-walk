/**
 * Centralized API client for ExcelSQLiteLiveSync.
 * Handles communication with the FastAPI backend.
 */

const API_BASE = "/api/v1";

/**
 * Upload an .xlsx file to the backend for provisioning.
 *
 * @param {File} file - The .xlsx File object from the file input.
 * @returns {Promise<{blob: Blob, tableId: string, rowCount: string, colCount: string, filename: string}>}
 */
export async function uploadAndProvision(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE}/upload-and-provision`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: "Upload failed" }));
    throw new Error(err.detail || `HTTP ${response.status}`);
  }

  const blob = await response.blob();

  // Extract metadata from response headers
  const tableId = response.headers.get("X-Table-ID") || "UNKNOWN";
  const rowCount = response.headers.get("X-Row-Count") || "0";
  const colCount = response.headers.get("X-Column-Count") || "0";

  // Derive download filename from Content-Disposition or original name
  const disposition = response.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
  const filename = filenameMatch
    ? filenameMatch[1]
    : `configured_${file.name}`;

  return { blob, tableId, rowCount, colCount, filename };
}

/**
 * Send a single cell-edit sync event to the backend.
 *
 * @param {Object} payload
 * @param {string} payload.table_id   - Target SQLite table name
 * @param {number} payload.row_id     - ROW_ID of the edited row
 * @param {string} payload.column_name - Sanitized column name
 * @param {string|null} payload.new_value - New cell value
 * @returns {Promise<{status: string, timestamp: string, message: string}>}
 */
export async function realtimeSync(payload) {
  const response = await fetch(`${API_BASE}/realtime-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: "Sync failed" }));
    throw new Error(err.detail || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function getCellValue(payload) {
  const params = new URLSearchParams({
    table_id: payload.table_id,
    row_id: String(payload.row_id),
    column_name: payload.column_name,
  });
  const response = await fetch(`${API_BASE}/cell-value?${params}`);

  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: "Verification failed" }));
    throw new Error(err.detail || `HTTP ${response.status}`);
  }

  return response.json();
}
