import React, { useCallback, useEffect, useRef, useState } from "react";
import StatusBanner from "./StatusBanner";
import {
  clearAuth,
  commitWorkbook,
  getClientId,
  getStoredAuth,
  getWorkbookSnapshot,
  heartbeatPresence,
  leaveDatasetPresence,
  requestLoginCode,
  verifyLoginCode,
} from "../services/api";

const TABLE_ID_DEFINED_NAME = "_EXCEL_SQLITE_SYNC_TABLE_ID";
const ROW_ID_HEADER = "__LIVESYNC_ROW_ID";

function sanitizeColumnName(raw) {
  let name = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/ /g, "_")
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = "COL";
  if (/^\d/.test(name)) name = `_${name}`;
  return name.substring(0, 30);
}

function normalizeValue(value) {
  return value === "" || value == null ? null : value;
}

function valuesEqual(left, right) {
  if (left == null || left === "") return right == null || right === "";
  if (right == null || right === "") return false;
  return String(left) === String(right);
}

function parseTableIdFormula(formula) {
  const tableId = String(formula || "")
    .trim()
    .replace(/^=/, "")
    .replace(/^"|"$/g, "")
    .toUpperCase();
  return /^QUEUE_BOARD_[A-Z0-9]+$/.test(tableId) ? tableId : null;
}

function snapshotModel(snapshot) {
  const rowIdIndex = snapshot.columns.findIndex(
    (column) => String(column).toUpperCase() === "ROW_ID"
  );
  if (rowIdIndex < 0) throw new Error("Server snapshot does not contain ROW_ID.");
  const columns = snapshot.columns
    .filter((_, index) => index !== rowIdIndex)
    .map((column) => String(column).toUpperCase());
  const rows = new Map();
  for (const rawRow of snapshot.rows) {
    const rowId = Number(rawRow[rowIdIndex]);
    const values = {};
    snapshot.columns.forEach((column, index) => {
      if (index !== rowIdIndex) values[String(column).toUpperCase()] = normalizeValue(rawRow[index]);
    });
    rows.set(rowId, values);
  }
  return { columns, rows };
}

function buildWorkbookDiff(baseline, workbook) {
  const server = snapshotModel(baseline);
  const localColumns = workbook.columns;
  const newColumns = localColumns.filter((column) => !server.columns.includes(column));
  const deleteColumns = server.columns.filter((column) => !localColumns.includes(column));
  const localIds = new Set();
  const updates = [];
  const insertRows = [];
  const preview = [];

  for (const row of workbook.rows) {
    if (row.rowId != null) {
      if (localIds.has(row.rowId)) throw new Error(`Duplicate hidden ROW_ID ${row.rowId}. Pull latest to repair it.`);
      localIds.add(row.rowId);
      const original = server.rows.get(row.rowId);
      if (!original) throw new Error(`ROW_ID ${row.rowId} is not present in base version ${baseline.version}.`);
      for (const column of localColumns) {
        const oldValue = original[column] ?? null;
        const newValue = row.values[column] ?? null;
        if (!valuesEqual(oldValue, newValue)) {
          updates.push({ row_id: row.rowId, column_name: column, new_value: newValue });
          preview.push(`${column} [${row.rowId}]: ${String(oldValue)} -> ${String(newValue)}`);
        }
      }
    } else {
      insertRows.push({ ...row.values });
      preview.push(`New row: ${localColumns.map((column) => `${column}=${row.values[column] ?? "NULL"}`).join(", ")}`);
    }
  }

  const deleteRowIds = [...server.rows.keys()].filter((rowId) => !localIds.has(rowId));
  deleteRowIds.forEach((rowId) => preview.push(`Deleted row: ROW_ID=${rowId}`));
  newColumns.forEach((column) => preview.push(`Added column: ${column}`));
  deleteColumns.forEach((column) => preview.push(`Deleted column: ${column}`));

  const changeCount = updates.length + insertRows.length + deleteRowIds.length
    + newColumns.length + deleteColumns.length;
  return {
    updates,
    insert_rows: insertRows,
    delete_row_ids: deleteRowIds,
    new_columns: newColumns,
    delete_columns: deleteColumns,
    changeCount,
    preview,
  };
}

function rowChanged(columns, before, after) {
  return columns.some((column) => !valuesEqual(before?.[column], after?.[column]));
}

function findRebaseConflicts(baseline, remote, diff) {
  const base = snapshotModel(baseline);
  const latest = snapshotModel(remote);
  const conflicts = [];
  for (const update of diff.updates) {
    const before = base.rows.get(update.row_id);
    const after = latest.rows.get(update.row_id);
    if (!after) {
      conflicts.push(`ROW_ID ${update.row_id} was deleted on the server.`);
      continue;
    }
    const remoteValue = after[update.column_name] ?? null;
    const baseValue = before?.[update.column_name] ?? null;
    if (!valuesEqual(baseValue, remoteValue) && !valuesEqual(remoteValue, update.new_value)) {
      conflicts.push(`${update.column_name} [${update.row_id}] changed both locally and remotely.`);
    }
  }
  for (const rowId of diff.delete_row_ids) {
    const before = base.rows.get(rowId);
    const after = latest.rows.get(rowId);
    if (after && rowChanged(base.columns, before, after)) {
      conflicts.push(`ROW_ID ${rowId} was edited remotely but deleted locally.`);
    }
  }
  for (const column of diff.new_columns) {
    if (!base.columns.includes(column) && latest.columns.includes(column)) {
      conflicts.push(`Column ${column} was also added remotely.`);
    }
  }
  for (const column of diff.delete_columns) {
    if (!latest.columns.includes(column)) continue;
    for (const [rowId, before] of base.rows) {
      const after = latest.rows.get(rowId);
      if (after && !valuesEqual(before[column], after[column])) {
        conflicts.push(`Column ${column} has remote edits and cannot be deleted automatically.`);
        break;
      }
    }
  }
  return conflicts;
}

function rebaseDiffOntoSnapshot(remote, diff) {
  const latest = snapshotModel(remote);
  let columns = [...latest.columns];
  for (const column of diff.new_columns) if (!columns.includes(column)) columns.push(column);
  columns = columns.filter((column) => !diff.delete_columns.includes(column));

  const rows = new Map();
  for (const [rowId, values] of latest.rows) rows.set(rowId, { ...values });
  for (const update of diff.updates) {
    if (rows.has(update.row_id)) rows.get(update.row_id)[update.column_name] = update.new_value;
  }
  diff.delete_row_ids.forEach((rowId) => rows.delete(rowId));

  const snapshotRows = [...rows.entries()].map(([rowId, values]) => [
    rowId,
    ...columns.map((column) => values[column] ?? null),
  ]);
  for (const values of diff.insert_rows) {
    snapshotRows.push([null, ...columns.map((column) => values[column] ?? null)]);
  }
  return {
    ...remote,
    columns: ["ROW_ID", ...columns],
    rows: snapshotRows,
    total: snapshotRows.length,
  };
}

const containerStyle = {
  minHeight: "100vh", padding: "18px 15px", color: "#e8f0f2",
  background: "radial-gradient(circle at top right, #17343c 0, #101821 38%, #0b1017 100%)",
  display: "flex", flexDirection: "column", gap: 13,
};
const cardStyle = {
  padding: 14, border: "1px solid rgba(118,232,209,.13)", borderRadius: 14,
  background: "rgba(18,29,40,.84)", boxShadow: "0 16px 45px rgba(0,0,0,.16)",
};
const labelStyle = {
  color: "#8399a5", fontSize: 10, fontWeight: 800, letterSpacing: ".12em",
  textTransform: "uppercase", marginBottom: 7,
};
const inputStyle = {
  boxSizing: "border-box", width: "100%", padding: "10px 11px", color: "#edf8f7",
  background: "#0b131c", border: "1px solid #29404c", borderRadius: 9, outline: "none",
};
const buttonStyle = {
  width: "100%", padding: "11px 13px", border: 0, borderRadius: 9, color: "#071716",
  background: "linear-gradient(135deg,#75ead0,#41cbb4)", fontSize: 12, fontWeight: 800,
  cursor: "pointer", boxShadow: "0 8px 25px rgba(65,203,180,.18)",
};

function AuthPanel({ onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const submit = async () => {
    setBusy(true); setError("");
    try {
      if (!sent) {
        const result = await requestLoginCode(email.trim());
        setSent(true);
        setNote(result.dev_otp ? `Local code: ${result.dev_otp}` : "Check your email for the 6-digit code.");
        if (result.dev_otp) setCode(result.dev_otp);
      } else {
        onAuthenticated(await verifyLoginCode(email.trim(), code.trim()));
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div style={containerStyle}>
      <div style={{ marginTop: 25 }}>
        <div style={{ color: "#58a6ff", fontSize: 10, fontWeight: 800, letterSpacing: ".14em" }}>GIT WALK FOR EXCEL</div>
        <h1 style={{ margin: "8px 0", fontSize: 27 }}>Sign in to sync</h1>
        <p style={{ color: "#8fa4af", fontSize: 12, lineHeight: 1.6 }}>Clone, commit, pull, and audit Excel data safely.</p>
      </div>
      <div style={{ ...cardStyle, display: "grid", gap: 11 }}>
        <div><div style={labelStyle}>Work email</div><input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} /></div>
        {sent ? <div><div style={labelStyle}>Verification code</div><input style={inputStyle} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></div> : null}
        {note ? <div style={{ color: "#75ead0", fontSize: 11 }}>{note}</div> : null}
        {error ? <div style={{ color: "#ff8b82", fontSize: 11 }}>{error}</div> : null}
        <button style={buttonStyle} disabled={busy || !email || (sent && code.length !== 6)} onClick={submit}>{busy ? "Working..." : sent ? "Verify and continue" : "Email me a code"}</button>
      </div>
    </div>
  );
}

export default function TaskpaneUI() {
  const [auth, setAuth] = useState(getStoredAuth());
  const [tableId, setTableId] = useState("");
  const [connected, setConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle");
  const [statusMsg, setStatusMsg] = useState(null);
  const [logs, setLogs] = useState([]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [staged, setStaged] = useState(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState([]);

  const baselineRef = useRef(null);
  const handlerRef = useRef(null);
  const boundSheetRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const autoConnectedRef = useRef(false);
  const displayHeadersRef = useRef({});
  const logEndRef = useRef(null);
  const presenceTimerRef = useRef(null);
  const clientIdRef = useRef(getClientId("excel"));

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  const addLog = useCallback((message, isError = false) => {
    const time = new Date().toLocaleTimeString();
    setLogs((previous) => [...previous.slice(-119), { time, message, isError }]);
  }, []);

  const saveBaseVersion = useCallback((version, targetTableId = tableId) => new Promise((resolve) => {
    Office.context.document.settings.set(`baseVersion:${targetTableId}`, version);
    Office.context.document.settings.set("baseVersion", version);
    Office.context.document.settings.saveAsync(() => resolve());
  }), [tableId]);

  const readWorkbook = useCallback(async () => window.Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRange(true);
    used.load(["values", "rowCount", "columnCount"]);
    sheet.load("id");
    await context.sync();
    const headers = used.values[0] || [];
    const metadataIndex = headers.findIndex((value) => String(value).trim() === ROW_ID_HEADER);
    if (metadataIndex < 0) throw new Error("Workbook row identity is missing. Pull latest to repair it.");

    const columns = [];
    const headerIndexes = [];
    const seen = new Set();
    headers.forEach((raw, index) => {
      if (index === metadataIndex || String(raw || "").trim() === "") return;
      const column = sanitizeColumnName(raw);
      if (seen.has(column)) throw new Error(`Duplicate column after sanitizing: ${column}`);
      seen.add(column); columns.push(column); headerIndexes.push(index);
      displayHeadersRef.current[column] = String(raw);
    });

    const rows = [];
    for (let rowIndex = 1; rowIndex < used.rowCount; rowIndex += 1) {
      const rawId = used.values[rowIndex]?.[metadataIndex];
      const rowId = rawId === "" || rawId == null ? null : Number(rawId);
      if (rowId != null && (!Number.isInteger(rowId) || rowId < 1)) {
        throw new Error(`Invalid hidden ROW_ID at Excel row ${rowIndex + 1}.`);
      }
      const values = {};
      headerIndexes.forEach((columnIndex, index) => {
        values[columns[index]] = normalizeValue(used.values[rowIndex]?.[columnIndex]);
      });
      const hasData = columns.some((column) => values[column] != null);
      if (hasData || rowId != null) rows.push({ rowId, values });
    }
    return { sheetId: sheet.id, columns, rows };
  }), []);

  const ensureRowIdentity = useCallback(async (snapshot) => window.Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRange(true);
    used.load(["values", "rowCount", "columnCount"]);
    const tables = sheet.tables;
    tables.load("items");
    await context.sync();
    let metadataIndex = (used.values[0] || []).findIndex(
      (value) => String(value).trim() === ROW_ID_HEADER
    );
    if (metadataIndex < 0) {
      const rowIdIndex = snapshot.columns.findIndex((column) => String(column).toUpperCase() === "ROW_ID");
      if (tables.items.length) {
        const table = tables.items[0];
        const identityColumn = table.columns.add(null, null, ROW_ID_HEADER);
        await context.sync();
        const body = identityColumn.getDataBodyRange();
        body.load("rowCount");
        const identityRange = identityColumn.getRange();
        identityRange.load("columnIndex");
        await context.sync();
        metadataIndex = identityRange.columnIndex;
        if (body.rowCount > 0) {
          body.values = Array.from({ length: body.rowCount }, (_, index) => [
            index < snapshot.rows.length ? snapshot.rows[index][rowIdIndex] : null,
          ]);
        }
        identityRange.getEntireColumn().format.columnHidden = true;
        addLog(`Attached hidden row identity to the Excel table (${body.rowCount} row(s)).`);
      } else {
        metadataIndex = used.columnCount;
        sheet.getRangeByIndexes(0, metadataIndex, 1, 1).values = [[ROW_ID_HEADER]];
        const dataRows = Math.max(used.rowCount - 1, snapshot.rows.length);
        if (dataRows > 0) {
          const ids = Array.from({ length: dataRows }, (_, index) => [
            index < snapshot.rows.length ? snapshot.rows[index][rowIdIndex] : null,
          ]);
          sheet.getRangeByIndexes(1, metadataIndex, dataRows, 1).values = ids;
        }
        addLog(`Created hidden row identity for ${Math.min(dataRows, snapshot.rows.length)} server row(s).`);
      }
    } else {
      const existingIds = used.values.slice(1).map((row) => row[metadataIndex]);
      const validIdCount = existingIds.filter((value) => Number.isInteger(Number(value)) && Number(value) > 0).length;
      if (validIdCount === 0 && used.rowCount - 1 === snapshot.rows.length) {
        const rowIdIndex = snapshot.columns.findIndex((column) => String(column).toUpperCase() === "ROW_ID");
        sheet.getRangeByIndexes(1, metadataIndex, snapshot.rows.length, 1).values =
          snapshot.rows.map((row) => [row[rowIdIndex]]);
        addLog(`Repaired hidden row identity for ${snapshot.rows.length} row(s).`);
      }
    }
    sheet.getRangeByIndexes(0, metadataIndex, 1, 1).getEntireColumn().format.columnHidden = true;
    await context.sync();
  }), [addLog]);

  const writeSnapshot = useCallback(async (snapshot) => {
    applyingRemoteRef.current = true;
    try {
      await window.Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        const used = sheet.getUsedRangeOrNullObject(true);
        used.load(["isNullObject", "rowIndex", "columnIndex", "rowCount", "columnCount"]);
        const tables = sheet.tables;
        tables.load("items");
        await context.sync();

        const rowIdIndex = snapshot.columns.findIndex((column) => String(column).toUpperCase() === "ROW_ID");
        const dataColumns = snapshot.columns.filter((_, index) => index !== rowIdIndex);
        const output = [[
          ...dataColumns.map((column) => displayHeadersRef.current[String(column).toUpperCase()] || column),
          ROW_ID_HEADER,
        ]];
        snapshot.rows.forEach((row) => output.push([
          ...dataColumns.map((_, index) => row[index < rowIdIndex ? index : index + 1]),
          row[rowIdIndex],
        ]));
        if (output.length === 1 && tables.items.length) {
          output.push(Array.from({ length: output[0].length }, () => null));
        }

        let startRow = 0;
        let startColumn = 0;
        let oldRowCount = used.isNullObject ? 0 : used.rowCount;
        let oldColumnCount = used.isNullObject ? 0 : used.columnCount;
        if (tables.items.length) {
          const tableRange = tables.items[0].getRange();
          tableRange.load(["rowIndex", "columnIndex", "rowCount", "columnCount"]);
          await context.sync();
          startRow = tableRange.rowIndex;
          startColumn = tableRange.columnIndex;
          oldRowCount = tableRange.rowCount;
          oldColumnCount = tableRange.columnCount;
          let target = sheet.getRangeByIndexes(startRow, startColumn, output.length, output[0].length);
          if (oldRowCount !== output.length || oldColumnCount !== output[0].length) {
            tables.items[0].resize(target);
            await context.sync();
            // Excel Desktop can invalidate a range proxy after table resize.
            target = sheet.getRangeByIndexes(startRow, startColumn, output.length, output[0].length);
          }
          target.values = output;
          if (oldRowCount > output.length) {
            sheet.getRangeByIndexes(
              startRow + output.length, startColumn,
              oldRowCount - output.length, oldColumnCount
            ).clear(window.Excel.ClearApplyTo.contents);
          }
          if (oldColumnCount > output[0].length) {
            sheet.getRangeByIndexes(
              startRow, startColumn + output[0].length,
              Math.min(oldRowCount, output.length), oldColumnCount - output[0].length
            ).clear(window.Excel.ClearApplyTo.contents);
          }
        } else {
          if (!used.isNullObject) used.clear(window.Excel.ClearApplyTo.contents);
          sheet.getRangeByIndexes(0, 0, output.length, output[0].length).values = output;
        }

        const header = sheet.getRangeByIndexes(startRow, startColumn, 1, dataColumns.length);
        header.format.font.bold = true;
        header.format.fill.color = "#1F5A82";
        header.format.font.color = "#FFFFFF";
        sheet.getRangeByIndexes(
          startRow, startColumn + dataColumns.length, 1, 1
        ).getEntireColumn().format.columnHidden = true;
        await context.sync();
      });
    } finally {
      setTimeout(() => { applyingRemoteRef.current = false; }, 350);
    }
  }, []);

  const reviewChanges = useCallback(async () => {
    if (!baselineRef.current) throw new Error("Connect to a dataset first.");
    const workbook = await readWorkbook();
    const diff = buildWorkbookDiff(baselineRef.current, workbook);
    setStaged(diff); setDirty(diff.changeCount > 0); setConflicts([]);
    setSyncStatus(diff.changeCount ? "syncing" : "connected");
    setStatusMsg(diff.changeCount ? `${diff.changeCount} staged change(s)` : "Working tree clean");
    addLog(diff.changeCount ? `Reviewed ${diff.changeCount} staged change(s).` : "Working tree matches the checked-out version.");
    return diff;
  }, [addLog, readWorkbook]);

  const refreshAfterCommit = useCallback(async () => {
    const latest = await getWorkbookSnapshot(tableId);
    await writeSnapshot(latest);
    baselineRef.current = latest;
    await saveBaseVersion(latest.version);
    setBaseVersion(latest.version); setDirty(false); setStaged(null); setConflicts([]);
    return latest;
  }, [saveBaseVersion, tableId, writeSnapshot]);

  const commitChanges = useCallback(async () => {
    if (!commitMessage.trim()) { addLog("Enter a commit message first.", true); return; }
    setBusy(true); setSyncStatus("syncing"); setStatusMsg("Creating audited commit...");
    try {
      const diff = await reviewChanges();
      if (!diff.changeCount) return;
      const result = await commitWorkbook({
        table_id: tableId,
        base_version: baselineRef.current.version,
        updates: diff.updates,
        insert_rows: diff.insert_rows,
        delete_row_ids: diff.delete_row_ids,
        new_columns: diff.new_columns,
        delete_columns: diff.delete_columns,
        source: "excel_commit",
        commit_message: commitMessage.trim(),
      });
      addLog(`Committed ${result.batch_id} as version ${result.version}; risk ${result.risk_score}/100.`);
      setCommitMessage("");
      try {
        await refreshAfterCommit();
        setSyncStatus("synced");
        setStatusMsg(`Committed version ${result.version}`);
      } catch (refreshError) {
        setSyncStatus("error");
        setStatusMsg(`Version ${result.version} committed; Excel refresh needs Pull`);
        addLog(
          `Server commit succeeded, but Excel refresh failed: ${refreshError.message}. Click Pull latest to repair the workbook.`,
          true
        );
      }
    } catch (err) {
      setSyncStatus("error"); setStatusMsg(err.message);
      if (err.status === 409) {
        setConflicts([`Server is at version ${err.detail?.current_version}; workbook is based on version ${err.detail?.base_version}.`]);
        addLog("Commit rejected because the server advanced. Pull latest to rebase your local work.", true);
      } else addLog(`Commit failed: ${err.message}`, true);
    } finally { setBusy(false); }
  }, [addLog, commitMessage, refreshAfterCommit, reviewChanges, tableId]);

  const pullLatest = useCallback(async (discardLocal = false) => {
    setBusy(true); setSyncStatus("syncing"); setStatusMsg("Pulling server changes...");
    try {
      const diff = discardLocal ? null : await reviewChanges();
      const remote = await getWorkbookSnapshot(tableId);
      if (!discardLocal && diff?.changeCount) {
        const found = findRebaseConflicts(baselineRef.current, remote, diff);
        if (found.length) {
          setConflicts(found); setSyncStatus("error");
          setStatusMsg(`${found.length} merge conflict(s)`);
          addLog(`Pull paused with ${found.length} conflict(s). Local cells were not overwritten.`, true);
          return;
        }
        const rebased = rebaseDiffOntoSnapshot(remote, diff);
        await writeSnapshot(rebased);
        baselineRef.current = remote;
        await saveBaseVersion(remote.version);
        setBaseVersion(remote.version); setDirty(true); setStaged(null); setConflicts([]);
        setSyncStatus("syncing"); setStatusMsg("Pulled and reapplied local changes");
        addLog(`Pulled version ${remote.version} and rebased ${diff.changeCount} local change(s). Review and commit next.`);
      } else {
        await writeSnapshot(remote);
        baselineRef.current = remote;
        await saveBaseVersion(remote.version);
        setBaseVersion(remote.version); setDirty(false); setStaged(null); setConflicts([]);
        setSyncStatus("synced"); setStatusMsg(`Pulled version ${remote.version}`);
        addLog(`Pulled server version ${remote.version}. Working tree is clean.`);
      }
    } catch (err) {
      setSyncStatus("error"); setStatusMsg(err.message); addLog(`Pull failed: ${err.message}`, true);
    } finally { setBusy(false); }
  }, [addLog, reviewChanges, saveBaseVersion, tableId, writeSnapshot]);

  const disconnect = useCallback(async () => {
    clearInterval(presenceTimerRef.current);
    presenceTimerRef.current = null;
    if (tableId) leaveDatasetPresence(tableId, clientIdRef.current).catch(() => {});
    try {
      await window.Excel.run(async (context) => {
        if (!handlerRef.current) return;
        const sheet = boundSheetRef.current || context.workbook.worksheets.getActiveWorksheet();
        sheet.onChanged.remove(handlerRef.current); await context.sync();
      });
    } catch (err) { addLog(`Could not unbind: ${err.message}`, true); }
    handlerRef.current = null; boundSheetRef.current = null; baselineRef.current = null;
    setConnected(false); setSyncStatus("idle"); setStatusMsg(null); setStaged(null); setDirty(false);
  }, [addLog, tableId]);

  const connect = useCallback(async (requestedTableId = tableId) => {
    const normalized = String(requestedTableId || "").trim().toUpperCase();
    if (!normalized) return;
    setBusy(true); setTableId(normalized); setSyncStatus("syncing"); setStatusMsg("Checking out workbook...");
    try {
      const latest = await getWorkbookSnapshot(normalized);
      const savedTableId = Office.context.document.settings.get("tableId");
      const keyedVersion = Office.context.document.settings.get(`baseVersion:${normalized}`);
      const legacyVersion = savedTableId === normalized
        ? Office.context.document.settings.get("baseVersion") : null;
      const hasSavedVersion = keyedVersion != null || legacyVersion != null;
      const savedVersion = Number(keyedVersion ?? legacyVersion);
      let baseline = latest;
      if (hasSavedVersion && Number.isInteger(savedVersion) && savedVersion >= 0 && savedVersion < latest.version) {
        try { baseline = await getWorkbookSnapshot(normalized, savedVersion); }
        catch { addLog(`Saved base version ${savedVersion} was unavailable; using server version ${latest.version}.`, true); }
      }
      await ensureRowIdentity(baseline);
      const workbook = await readWorkbook();
      baselineRef.current = baseline;
      setBaseVersion(baseline.version);

      await window.Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getItem(workbook.sheetId);
        const handler = () => {
          if (applyingRemoteRef.current) return;
          setDirty(true); setStaged(null); setConflicts([]);
          setSyncStatus("syncing"); setStatusMsg("Local changes pending review");
          heartbeatPresence(normalized, clientIdRef.current, "excel", "editing").catch(() => {});
        };
        sheet.onChanged.add(handler); handlerRef.current = handler; boundSheetRef.current = sheet;
        await context.sync();
      });
      Office.context.document.settings.set("tableId", normalized);
      Office.context.document.settings.saveAsync(() => {});
      setConnected(true); setSyncStatus("connected");
      const heartbeat = () => heartbeatPresence(
        normalized, clientIdRef.current, "excel", "viewing"
      ).catch(() => {});
      heartbeat();
      clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = setInterval(heartbeat, 15000);
      setStatusMsg(latest.version > baseline.version ? `Server ahead: v${latest.version}` : `Checked out v${baseline.version}`);
      addLog(`Checked out version ${baseline.version}. Edits stay local until Commit.`);
      if (latest.version > baseline.version) addLog(`Server version ${latest.version} is available. Pull before committing.`);
    } catch (err) {
      setSyncStatus("error"); setStatusMsg(err.message); addLog(`Connection failed: ${err.message}`, true);
    } finally { setBusy(false); }
  }, [addLog, ensureRowIdentity, readWorkbook, tableId]);

  const getEmbeddedTableId = useCallback(async () => {
    try {
      return await window.Excel.run(async (context) => {
        const item = context.workbook.names.getItemOrNullObject(TABLE_ID_DEFINED_NAME);
        item.load("formula"); await context.sync();
        return item.isNullObject ? null : parseTableIdFormula(item.formula);
      });
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (!auth || autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    (async () => {
      const embedded = await getEmbeddedTableId();
      const saved = Office.context.document.settings.get("tableId");
      if (embedded || saved) await connect(embedded || saved);
      else addLog("No embedded Table ID found. Enter it once to connect.");
    })();
  }, [addLog, auth, connect, getEmbeddedTableId]);

  const signOut = useCallback(async () => {
    if (connected) await disconnect();
    clearAuth(); setAuth(null); setTableId(""); setLogs([]); autoConnectedRef.current = false;
  }, [connected, disconnect]);

  if (!auth?.token) return <AuthPanel onAuthenticated={setAuth} />;
  const summary = staged || { changeCount: dirty ? "?" : 0, updates: [], insert_rows: [], delete_row_ids: [], new_columns: [], delete_columns: [], preview: [] };

  return (
    <div style={containerStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ color: "#58a6ff", fontSize: 10, fontWeight: 800, letterSpacing: ".13em" }}>GIT WALK</div><div style={{ fontSize: 20, fontWeight: 800 }}>Workbook repository</div></div>
        <button onClick={signOut} style={{ border: 0, color: "#92a6af", background: "transparent" }}>Sign out</button>
      </div>
      <div style={{ ...cardStyle, padding: 11, display: "flex", justifyContent: "space-between" }}>
        <div><div style={{ fontSize: 11 }}>{auth.user?.email}</div><div style={{ color: "#70858f", fontSize: 9, marginTop: 3 }}>{auth.user?.user_id}</div></div>
        <div style={{ color: "#75ead0", fontSize: 10, fontWeight: 800 }}>BASE v{baseVersion}</div>
      </div>
      <StatusBanner status={syncStatus} message={statusMsg} />
      <div style={cardStyle}><div style={labelStyle}>Table ID</div><input style={inputStyle} value={tableId} onChange={(e) => setTableId(e.target.value.toUpperCase())} disabled={connected} placeholder="QUEUE_BOARD_A1B2C3D4" /></div>

      {!connected ? <button style={buttonStyle} disabled={busy || !tableId} onClick={() => connect()}>{busy ? "Connecting..." : "Clone and connect"}</button> : <>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button style={{ ...buttonStyle, color: "#d8e5e9", background: "#172632", boxShadow: "none" }} disabled={busy} onClick={reviewChanges}>Review changes</button>
          <button style={{ ...buttonStyle, color: "#071716", background: "linear-gradient(135deg,#66c4ff,#49a8e8)" }} disabled={busy} onClick={() => pullLatest(false)}>Pull latest</button>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Commit message</div>
          <input style={inputStyle} value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Describe this data change" maxLength={300} />
          <button style={{ ...buttonStyle, marginTop: 10, opacity: !commitMessage.trim() || busy ? .55 : 1 }} disabled={!commitMessage.trim() || busy} onClick={commitChanges}>{busy ? "Working..." : `Commit ${summary.changeCount === "?" ? "changes" : `${summary.changeCount} change(s)`}`}</button>
        </div>
        <button style={{ ...buttonStyle, color: "#ffaaa3", background: "#2a191c", boxShadow: "none" }} onClick={disconnect}>Disconnect</button>
      </>}

      {connected ? <div style={{ ...cardStyle, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, textAlign: "center" }}>
        <div><div style={labelStyle}>Cells</div><strong style={{ color: "#75ead0" }}>{summary.updates.length}</strong></div>
        <div><div style={labelStyle}>Rows +/-</div><strong style={{ color: "#66c4ff" }}>{summary.insert_rows.length}/{summary.delete_row_ids.length}</strong></div>
        <div><div style={labelStyle}>Columns +/-</div><strong style={{ color: "#f4ba62" }}>{summary.new_columns.length}/{summary.delete_columns.length}</strong></div>
      </div> : null}

      {staged?.preview.length ? <div style={cardStyle}><div style={labelStyle}>Staged diff</div><div style={{ maxHeight: 155, overflowY: "auto" }}>{staged.preview.slice(0, 30).map((line, index) => <div key={index} style={{ color: "#a8bbc3", borderBottom: "1px solid #20303a", padding: "5px 0", font: "10px Consolas,monospace" }}>{line}</div>)}</div></div> : null}

      {conflicts.length ? <div style={{ ...cardStyle, borderColor: "rgba(255,127,117,.45)" }}><div style={{ ...labelStyle, color: "#ff8b82" }}>Merge conflicts</div>{conflicts.slice(0, 12).map((item, index) => <div key={index} style={{ color: "#ffaaa3", fontSize: 10, padding: "4px 0" }}>{item}</div>)}<button style={{ ...buttonStyle, marginTop: 10, color: "#fff", background: "#b84540" }} onClick={() => { if (window.confirm("Discard every local uncommitted change and pull the server version?")) pullLatest(true); }}>Discard local changes and pull</button></div> : null}

      <div><div style={labelStyle}>Activity log</div><div style={{ ...cardStyle, maxHeight: 230, overflowY: "auto", padding: 11 }}>{logs.length ? logs.map((log, index) => <div key={`${log.time}-${index}`} style={{ color: log.isError ? "#ff8b82" : "#9bafb8", borderBottom: "1px solid #20303a", padding: "5px 0", font: "10px Consolas,monospace", lineHeight: 1.5 }}><span style={{ color: "#60747e" }}>[{log.time}]</span> {log.message}</div>) : <div style={{ color: "#60747e", fontSize: 11 }}>No activity yet.</div>}<div ref={logEndRef} /></div></div>
    </div>
  );
}
