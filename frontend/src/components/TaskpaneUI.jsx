import React, { useCallback, useEffect, useRef, useState } from "react";
import StatusBanner from "./StatusBanner";
import {
  authenticateWorkbook,
  clearAuth,
  commitWorkbook,
  getBranchState,
  getBranchDivergence,
  getClientId,
  getStoredAuth,
  getWorkbookSnapshot,
  heartbeatPresence,
  leaveDatasetPresence,
  logout,
  requestLoginCode,
  syncBranchWithMain,
  verifyLoginCode,
  verifyWorkbookAccess,
  setUserPassword,
} from "../services/api";

const TABLE_ID_DEFINED_NAME = "_EXCEL_SQLITE_SYNC_TABLE_ID";
const WORKBOOK_METADATA_NAMES = {
  repository_id: "_GITWALK_REPOSITORY_ID",
  branch_id: "_GITWALK_BRANCH_ID",
  branch_name: "_GITWALK_BRANCH_NAME",
  working_copy_id: "_GITWALK_WORKING_COPY_ID",
  base_commit_id: "_GITWALK_BASE_COMMIT_ID",
  issued_at: "_GITWALK_ISSUED_AT",
  signature: "_GITWALK_SIGNATURE",
  local_file_path: "_GITWALK_LOCAL_FILE_PATH",
  required_role: "_GITWALK_REQUIRED_ROLE",
};
const ROW_ID_HEADER = "__GITWALK_ROW_ID";
const LEGACY_ROW_ID_HEADER = "__LIVESYNC_ROW_ID";

function normalizeFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  let decoded = "";
  try {
    decoded = decodeURIComponent(rawPath.trim());
  } catch {
    decoded = rawPath.trim();
  }
  if (decoded.toLowerCase().startsWith("file:///")) {
    decoded = decoded.slice(8);
  } else if (decoded.toLowerCase().startsWith("file://")) {
    decoded = decoded.slice(7);
  }
  decoded = decoded.replace(/\//g, "\\");
  while (decoded.length >= 3 && decoded[0] === "\\" && decoded[2] === ":") {
    decoded = decoded.slice(1);
  }
  return decoded.replace(/\\+$/, "").toLowerCase();
}

function clientStableId(prefix) {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "").toUpperCase()
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.toUpperCase();
  return `${prefix}_${random.slice(0, 20)}`;
}

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

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function dateTextMilliseconds(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
  );
  if (!match) return null;
  const milliseconds = Number((match[7] || "").padEnd(3, "0").slice(0, 3));
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0), milliseconds
  );
}

function excelSerialMilliseconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2958465) return null;
  return EXCEL_EPOCH_MS + value * 86400000;
}

function formatExcelDateLike(serial, reference) {
  const milliseconds = excelSerialMilliseconds(serial);
  if (milliseconds == null) return serial;
  const date = new Date(milliseconds);
  const datePart = date.toISOString().slice(0, 10);
  if (typeof reference === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reference.trim())) return datePart;
  const separator = typeof reference === "string" && reference.includes("T") ? "T" : " ";
  return `${datePart}${separator}${date.toISOString().slice(11, 19)}`;
}

function normalizeSemanticValue(value, reference = null, dataType = "") {
  const normalized = normalizeValue(value);
  if (
    typeof normalized === "number"
    && (dateTextMilliseconds(reference) != null || /DATE|TIME/i.test(String(dataType)))
  ) {
    return formatExcelDateLike(normalized, reference);
  }
  return normalized;
}

function valuesEqual(left, right) {
  if (left == null || left === "") return right == null || right === "";
  if (right == null || right === "") return false;
  const leftDate = dateTextMilliseconds(left);
  const rightDate = dateTextMilliseconds(right);
  if (leftDate != null && rightDate != null) return Math.abs(leftDate - rightDate) < 1;
  if (leftDate != null) {
    const serialDate = excelSerialMilliseconds(right);
    if (serialDate != null) return Math.abs(leftDate - serialDate) < 1;
  }
  if (rightDate != null) {
    const serialDate = excelSerialMilliseconds(left);
    if (serialDate != null) return Math.abs(rightDate - serialDate) < 1;
  }
  return String(left) === String(right);
}

function parseTableIdFormula(formula) {
  const tableId = String(formula || "")
    .trim()
    .replace(/^=/, "")
    .replace(/^"|"$/g, "")
    .toUpperCase();
  return /^(QUEUE_BOARD|BRANCH_DATA)_[A-Z0-9]+$/.test(tableId) ? tableId : null;
}

function parseDefinedValue(formula) {
  return String(formula || "")
    .trim()
    .replace(/^=/, "")
    .replace(/^"|"$/g, "")
    .replace(/""/g, '"');
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

function semanticSheet(snapshot) {
  const sheet = snapshot?.semantic?.sheets?.[0];
  if (!sheet) throw new Error("This checkout has no Stage 2 identity map. Pull latest and reconnect.");
  return sheet;
}

function sequenceMoves(baseIds, localIds, positions) {
  const localSet = new Set(localIds);
  const working = baseIds.filter((id) => localSet.has(id));
  const target = localIds.filter((id) => working.includes(id));
  const moves = [];
  target.forEach((id, targetIndex) => {
    const currentIndex = working.indexOf(id);
    if (currentIndex === targetIndex) return;
    working.splice(currentIndex, 1);
    working.splice(targetIndex, 0, id);
    moves.push({ id, position: positions.get(id) });
  });
  return moves;
}

function buildSemanticSheetDiff(baseSheet, workbook) {
  const operations = [];
  const preview = [];
  const baseColumns = [...baseSheet.columns].sort((a, b) => a.position - b.position);
  const unusedBase = new Set(baseColumns.map((column) => column.column_id));
  const mappedColumns = workbook.columns.map((name, position) => {
    let match = baseColumns.find(
      (column) => unusedBase.has(column.column_id) && column.name === name
    );
    if (!match) {
      match = baseColumns.find(
        (column) => unusedBase.has(column.column_id) && column.position === position
      );
    }
    if (match) unusedBase.delete(match.column_id);
    return {
      columnId: match?.column_id || clientStableId("COL"),
      name,
      position,
      base: match || null,
    };
  });
  const columnByName = new Map(mappedColumns.map((column) => [column.name, column]));
  const columnPositions = new Map(mappedColumns.map((column) => [column.columnId, column.position]));

  mappedColumns.forEach((column) => {
    if (!column.base) {
      operations.push({
        operation_type: "COLUMN_INSERT", sheet_id: baseSheet.sheet_id,
        column_id: column.columnId, new_column_position: column.position,
        new_value: column.name, new_data_type: "TEXT",
      });
      preview.push(`COLUMN_INSERT ${column.name} at ${column.position + 1}`);
    } else if (column.base.name !== column.name) {
      operations.push({
        operation_type: "COLUMN_RENAME", sheet_id: baseSheet.sheet_id,
        column_id: column.columnId, old_value: column.base.name, new_value: column.name,
      });
      preview.push(`COLUMN_RENAME ${column.base.name} -> ${column.name}`);
    }
  });
  unusedBase.forEach((columnId) => {
    const column = baseColumns.find((item) => item.column_id === columnId);
    operations.push({
      operation_type: "COLUMN_DELETE", sheet_id: baseSheet.sheet_id,
      column_id: columnId, previous_column_position: column.position, old_value: column.name,
    });
    preview.push(`COLUMN_DELETE ${column.name}`);
  });
  sequenceMoves(
    baseColumns.map((column) => column.column_id),
    mappedColumns.map((column) => column.columnId),
    columnPositions
  ).forEach(({ id, position }) => {
    const base = baseColumns.find((column) => column.column_id === id);
    operations.push({
      operation_type: "COLUMN_MOVE", sheet_id: baseSheet.sheet_id, column_id: id,
      previous_column_position: base.position, new_column_position: position,
    });
    preview.push(`COLUMN_MOVE ${base.name}: ${base.position + 1} -> ${position + 1}`);
  });

  if (baseSheet.name !== workbook.sheetName) {
    operations.push({
      operation_type: "SHEET_RENAME", sheet_id: baseSheet.sheet_id,
      old_value: baseSheet.name, new_value: workbook.sheetName,
    });
    preview.push(`SHEET_RENAME ${baseSheet.name} -> ${workbook.sheetName}`);
  }

  const baseRows = [...baseSheet.rows].sort((a, b) => a.position - b.position);
  const baseById = new Map(baseRows.map((row) => [row.row_id, row]));
  const dateReferenceByColumn = new Map(
    mappedColumns.map((column) => [
      column.columnId,
      baseRows.map((row) => row.values[column.columnId]).find(
        (value) => dateTextMilliseconds(value) != null
      ) || null,
    ])
  );
  const seenRows = new Set();
  const localRows = workbook.rows.map((row, position) => ({
    ...row,
    rowId: row.rowId || clientStableId("ROW"),
    position,
  }));
  const rowPositions = new Map(localRows.map((row) => [row.rowId, row.position]));

  localRows.forEach((row) => {
    if (seenRows.has(row.rowId)) throw new Error(`Duplicate hidden row identity ${row.rowId}. Pull latest to repair it.`);
    seenRows.add(row.rowId);
    const original = baseById.get(row.rowId);
    const valuesById = {};
    mappedColumns.forEach((column) => {
      const reference = original?.values[column.columnId]
        ?? dateReferenceByColumn.get(column.columnId);
      valuesById[column.columnId] = normalizeSemanticValue(
        row.values[column.name] ?? null, reference, column.base?.data_type
      );
    });
    if (!original) {
      operations.push({
        operation_type: "ROW_INSERT", sheet_id: baseSheet.sheet_id,
        row_id: row.rowId, new_row_position: row.position, new_value: valuesById,
      });
      preview.push(`ROW_INSERT at ${row.position + 2}`);
    }
    mappedColumns.forEach((column) => {
      if (!original) {
        if (row.formulas[column.name]) {
          operations.push({
            operation_type: "CELL_FORMULA_UPDATE", sheet_id: baseSheet.sheet_id,
            row_id: row.rowId, column_id: column.columnId,
            old_formula: null, new_formula: row.formulas[column.name],
          });
        }
        return;
      }
      if (!column.base) {
        const newValue = normalizeSemanticValue(
          row.values[column.name] ?? null,
          dateReferenceByColumn.get(column.columnId),
          column.base?.data_type
        );
        if (newValue != null) {
          operations.push({
            operation_type: "CELL_VALUE_UPDATE", sheet_id: baseSheet.sheet_id,
            row_id: row.rowId, column_id: column.columnId,
            old_value: null, new_value: newValue,
          });
          preview.push(`${column.name} [${row.position + 2}]: NULL -> ${String(newValue)}`);
        }
        if (row.formulas[column.name]) {
          operations.push({
            operation_type: "CELL_FORMULA_UPDATE", sheet_id: baseSheet.sheet_id,
            row_id: row.rowId, column_id: column.columnId,
            old_formula: null, new_formula: row.formulas[column.name],
          });
        }
        return;
      }
      const oldValue = original.values[column.columnId] ?? null;
      const newValue = normalizeSemanticValue(
        row.values[column.name] ?? null,
        oldValue,
        column.base?.data_type
      );
      const oldFormula = original.formulas?.[column.columnId] || null;
      const newFormula = row.formulas[column.name] || null;
      if (!valuesEqual(oldValue, newValue)) {
        operations.push({
          operation_type: "CELL_VALUE_UPDATE", sheet_id: baseSheet.sheet_id,
          row_id: row.rowId, column_id: column.columnId,
          old_value: oldValue, new_value: newValue,
        });
        preview.push(`${column.name} [${row.position + 2}]: ${String(oldValue)} -> ${String(newValue)}`);
      }
      if (oldFormula !== newFormula) {
        operations.push({
          operation_type: "CELL_FORMULA_UPDATE", sheet_id: baseSheet.sheet_id,
          row_id: row.rowId, column_id: column.columnId,
          old_formula: oldFormula, new_formula: newFormula,
        });
        preview.push(`FORMULA ${column.name} [${row.position + 2}]: ${oldFormula || "none"} -> ${newFormula || "none"}`);
      }
    });
  });

  sequenceMoves(
    baseRows.map((row) => row.row_id),
    localRows.map((row) => row.rowId),
    rowPositions
  ).forEach(({ id, position }) => {
    const original = baseById.get(id);
    operations.push({
      operation_type: "ROW_MOVE", sheet_id: baseSheet.sheet_id, row_id: id,
      previous_row_position: original.position, new_row_position: position,
    });
    preview.push(`ROW_MOVE ${original.position + 2} -> ${position + 2}`);
  });
  baseRows.filter((row) => !seenRows.has(row.row_id)).forEach((row) => {
    operations.push({
      operation_type: "ROW_DELETE", sheet_id: baseSheet.sheet_id,
      row_id: row.row_id, previous_row_position: row.position,
    });
    preview.push(`ROW_DELETE at ${row.position + 2}`);
  });

  const counts = operations.reduce((result, operation) => {
    if (operation.operation_type.startsWith("CELL_")) result.cells += 1;
    if (operation.operation_type.startsWith("ROW_")) result.rows += 1;
    if (operation.operation_type.startsWith("COLUMN_")) result.columns += 1;
    if (operation.operation_type === "CELL_FORMULA_UPDATE") result.formulas += 1;
    return result;
  }, { cells: 0, rows: 0, columns: 0, formulas: 0 });

  return {
    semantic_changes: operations,
    changeCount: operations.length,
    preview,
    counts,
    updates: [], insert_rows: [], delete_row_ids: [], new_columns: [], delete_columns: [],
  };
}

function buildSemanticWorkbookDiff(baseline, workbook) {
  const baseSheets = [...(baseline?.semantic?.sheets || [])].sort((a, b) => a.position - b.position);
  const localSheets = [...(workbook?.sheets || [])].sort((a, b) => a.sheetPosition - b.sheetPosition);
  const unused = new Set(baseSheets.map((sheet) => sheet.sheet_id));
  const combined = {
    semantic_changes: [], preview: [], changeCount: 0,
    counts: { cells: 0, rows: 0, columns: 0, formulas: 0, sheets: 0 },
    updates: [], insert_rows: [], delete_row_ids: [], new_columns: [], delete_columns: [],
  };
  const mapped = localSheets.map((local, position) => {
    let base = baseSheets.find((sheet) => unused.has(sheet.sheet_id) && sheet.name === local.sheetName);
    if (!base) base = baseSheets.find((sheet) => unused.has(sheet.sheet_id) && sheet.position === position);
    if (base) unused.delete(base.sheet_id);
    if (!base) {
      const sheetId = clientStableId("SHEET");
      combined.semantic_changes.push({
        operation_type: "SHEET_CREATE", sheet_id: sheetId,
        new_value: local.sheetName, new_row_position: position,
      });
      combined.preview.push(`SHEET_CREATE ${local.sheetName}`);
      combined.counts.sheets += 1;
      base = { sheet_id: sheetId, name: local.sheetName, position, columns: [], rows: [] };
    }
    const diff = buildSemanticSheetDiff(base, local);
    combined.semantic_changes.push(...diff.semantic_changes);
    combined.preview.push(...diff.preview.map((line) => `${local.sheetName}: ${line}`));
    Object.keys(diff.counts).forEach((key) => { combined.counts[key] += diff.counts[key] || 0; });
    if (base.position !== position && (baseline?.semantic?.sheets || []).some((sheet) => sheet.sheet_id === base.sheet_id)) {
      combined.semantic_changes.push({
        operation_type: "SHEET_MOVE", sheet_id: base.sheet_id,
        previous_row_position: base.position, new_row_position: position,
      });
      combined.preview.push(`SHEET_MOVE ${local.sheetName}: ${base.position + 1} -> ${position + 1}`);
      combined.counts.sheets += 1;
    }
    return base.sheet_id;
  });
  void mapped;
  unused.forEach((sheetId) => {
    const sheet = baseSheets.find((item) => item.sheet_id === sheetId);
    combined.semantic_changes.push({
      operation_type: "SHEET_DELETE", sheet_id: sheetId,
      old_value: sheet.name, previous_row_position: sheet.position,
    });
    combined.preview.push(`SHEET_DELETE ${sheet.name}`);
    combined.counts.sheets += 1;
  });
  combined.changeCount = combined.semantic_changes.length;
  return combined;
}

function semanticTarget(change) {
  if (change.operation_type.startsWith("CELL_")) return `CELL:${change.row_id}:${change.column_id}`;
  if (change.operation_type.startsWith("ROW_")) return `ROW:${change.row_id}`;
  if (change.operation_type.startsWith("COLUMN_")) return `COLUMN:${change.column_id}`;
  return `SHEET:${change.sheet_id}`;
}

function workbookFromSemantic(snapshot) {
  return {
    sheets: [...(snapshot?.semantic?.sheets || [])].sort((a, b) => a.position - b.position).map((sheet) => {
      const columns = [...sheet.columns].sort((a, b) => a.position - b.position);
      return {
        sheetName: sheet.name,
        sheetPosition: sheet.position,
        columns: columns.map((column) => column.name),
        rows: [...sheet.rows].sort((a, b) => a.position - b.position).map((row) => ({
          rowId: row.row_id,
          values: Object.fromEntries(columns.map((column) => [column.name, row.values[column.column_id] ?? null])),
          formulas: Object.fromEntries(columns.map((column) => [column.name, row.formulas?.[column.column_id] || null])),
        })),
      };
    }),
  };
}

function semanticRebaseConflicts(baseline, remote, localDiff) {
  const remoteDiff = buildSemanticWorkbookDiff(baseline, workbookFromSemantic(remote));
  const remoteTargets = new Set(remoteDiff.semantic_changes.map(semanticTarget));
  return localDiff.semantic_changes
    .filter((change) => remoteTargets.has(semanticTarget(change)))
    .map((change) => `${semanticTarget(change)} changed locally and remotely.`);
}

function applySemanticChanges(snapshot, changes) {
  const rebased = JSON.parse(JSON.stringify(snapshot));
  const sheets = rebased.semantic.sheets;
  const sortState = (sheet) => {
    sheet.columns.sort((a, b) => a.position - b.position)
      .forEach((column, index) => { column.position = index; });
    sheet.rows.sort((a, b) => a.position - b.position)
      .forEach((row, index) => { row.position = index; });
    sheets.sort((a, b) => a.position - b.position)
      .forEach((item, index) => { item.position = index; });
  };
  changes.forEach((change) => {
    const operation = change.operation_type;
    if (operation === "SHEET_CREATE") {
      sheets.splice(change.new_row_position, 0, {
        sheet_id: change.sheet_id, name: change.new_value,
        position: change.new_row_position, columns: [], rows: [],
      });
      sortState(sheets[change.new_row_position]);
      return;
    }
    const sheet = sheets.find((item) => item.sheet_id === change.sheet_id);
    if (!sheet) return;
    if (operation === "SHEET_DELETE") {
      const index = sheets.findIndex((item) => item.sheet_id === change.sheet_id);
      if (index >= 0) sheets.splice(index, 1);
      return;
    }
    if (operation === "SHEET_RENAME") sheet.name = change.new_value;
    if (operation === "SHEET_MOVE") {
      const index = sheets.findIndex((item) => item.sheet_id === change.sheet_id);
      if (index >= 0) sheets.splice(change.new_row_position, 0, sheets.splice(index, 1)[0]);
    }
    if (operation === "COLUMN_INSERT") {
      sheet.columns.splice(change.new_column_position, 0, {
        column_id: change.column_id, name: change.new_value,
        position: change.new_column_position, data_type: change.new_data_type || "TEXT",
      });
      sheet.rows.forEach((row) => { row.values[change.column_id] = null; });
    }
    if (operation === "COLUMN_DELETE") {
      sheet.columns = sheet.columns.filter((column) => column.column_id !== change.column_id);
      sheet.rows.forEach((row) => {
        delete row.values[change.column_id];
        delete row.formulas?.[change.column_id];
      });
    }
    if (operation === "COLUMN_RENAME") {
      const column = sheet.columns.find((item) => item.column_id === change.column_id);
      if (column) column.name = change.new_value;
    }
    if (operation === "COLUMN_MOVE") {
      const index = sheet.columns.findIndex((column) => column.column_id === change.column_id);
      if (index >= 0) sheet.columns.splice(change.new_column_position, 0, sheet.columns.splice(index, 1)[0]);
    }
    if (operation === "ROW_INSERT") {
      sheet.rows.splice(change.new_row_position, 0, {
        row_id: change.row_id, position: change.new_row_position,
        values: { ...(change.new_value || {}) }, formulas: {}, styles: {}, comments: {},
      });
    }
    if (operation === "ROW_DELETE") {
      sheet.rows = sheet.rows.filter((row) => row.row_id !== change.row_id);
    }
    if (operation === "ROW_MOVE") {
      const index = sheet.rows.findIndex((row) => row.row_id === change.row_id);
      if (index >= 0) sheet.rows.splice(change.new_row_position, 0, sheet.rows.splice(index, 1)[0]);
    }
    if (operation.startsWith("CELL_")) {
      const row = sheet.rows.find((item) => item.row_id === change.row_id);
      if (!row) return;
      if (operation === "CELL_VALUE_UPDATE") row.values[change.column_id] = change.new_value;
      if (operation === "CELL_FORMULA_UPDATE") {
        row.formulas ||= {};
        if (change.new_formula) row.formulas[change.column_id] = change.new_formula;
        else delete row.formulas[change.column_id];
      }
    }
    sortState(sheet);
  });
  return rebased;
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
  background: "linear-gradient(180deg,#181818 0,#1f1f1f 100%)",
  display: "flex", flexDirection: "column", gap: 13,
};
const cardStyle = {
  padding: 14, border: "1px solid #3c3c3c", borderRadius: 6,
  background: "#252526", boxShadow: "0 8px 24px rgba(0,0,0,.16)",
};
const labelStyle = {
  color: "#8399a5", fontSize: 10, fontWeight: 800, letterSpacing: ".12em",
  textTransform: "uppercase", marginBottom: 7,
};
const inputStyle = {
  boxSizing: "border-box", width: "100%", padding: "10px 11px", color: "#edf8f7",
  background: "#1e1e1e", border: "1px solid #4c4c4c", borderRadius: 4, outline: "none",
};
const buttonStyle = {
  width: "100%", padding: "11px 13px", border: "1px solid #2ea043", borderRadius: 4, color: "#fff",
  background: "#238636", fontSize: 12, fontWeight: 800,
  cursor: "pointer", boxShadow: "0 4px 14px rgba(35,134,54,.18)",
};

function PathBlockedPanel({ expectedPath, currentPath }) {
  return (
    <div style={containerStyle}>
      <div style={{ marginTop: 25 }}>
        <div style={{ color: "#f85149", fontSize: 10, fontWeight: 800, letterSpacing: ".14em" }}>
          SECURITY ACCESS BLOCKED
        </div>
        <h1 style={{ margin: "8px 0", fontSize: 23, color: "#ff8b82" }}>Unauthorized Location</h1>
        <p style={{ color: "#c9d1d9", fontSize: 11, lineHeight: 1.6 }}>
          This workbook cannot load server data because its current file location does not match the authorized path injected during download.
        </p>
      </div>
      <div style={{ ...cardStyle, borderColor: "#f85149", background: "rgba(248,81,73,0.08)", marginTop: 14 }}>
        <div style={{ ...labelStyle, color: "#ff8b82" }}>Authorized Download Location</div>
        <div style={{ color: "#75ead0", fontSize: 10, fontFamily: "Consolas, monospace", wordBreak: "break-all", marginBottom: 12 }}>
          {expectedPath || "Not specified"}
        </div>

        <div style={{ ...labelStyle, color: "#ff8b82" }}>Current Open Location</div>
        <div style={{ color: "#ffaaa3", fontSize: 10, fontFamily: "Consolas, monospace", wordBreak: "break-all" }}>
          {currentPath || "Copied / moved outside authorized directory"}
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: 12 }}>
        <div style={{ ...labelStyle, color: "#e3b341" }}>Copy & Leak Protection</div>
        <p style={{ color: "#8fa4af", fontSize: 11, lineHeight: 1.6, margin: 0 }}>
          To prevent unauthorized copies and leakage of EUC data, this workbook is cryptographically locked to its registered download folder. Please open the workbook from:
        </p>
        <div style={{ color: "#58a6ff", fontSize: 10, fontFamily: "Consolas, monospace", marginTop: 8, wordBreak: "break-all" }}>
          {expectedPath}
        </div>
      </div>
    </div>
  );
}

function WorkbookVerificationPanel({ embeddedInfo, onVerifiedAndLoaded }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const submit = async (e) => {
    if (e) e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!sent) {
        const result = await requestLoginCode(email.trim());
        setSent(true);
        setNote(result.dev_otp ? `Local code: ${result.dev_otp}` : "Check your email for the 6-digit code.");
        if (result.dev_otp) setCode(result.dev_otp);
      } else {
        const currentDocPath = (typeof Office !== "undefined" && Office?.context?.document?.url)
          ? Office.context.document.url
          : (embeddedInfo.local_file_path || "");
        const result = await verifyWorkbookAccess({
          repository_id: embeddedInfo.repository_id,
          branch_id: embeddedInfo.branch_id,
          working_copy_id: embeddedInfo.working_copy_id,
          email: email.trim(),
          code: code.trim(),
          current_file_path: currentDocPath,
        });
        await onVerifiedAndLoaded(result);
      }
    } catch (err) {
      setError(err.message || "Verification failed. Check your code and role.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={containerStyle}>
      <div style={{ marginTop: 20 }}>
        <div style={{ color: "#58a6ff", fontSize: 10, fontWeight: 800, letterSpacing: ".14em" }}>
          GIT WALK / ACCESS VERIFICATION
        </div>
        <h1 style={{ margin: "6px 0", fontSize: 22 }}>Verify Identity & Role</h1>
        <p style={{ color: "#8fa4af", fontSize: 11, lineHeight: 1.5 }}>
          Authorized location verified. Authenticate via verification code to confirm your role and load branch data.
        </p>
      </div>

      <div style={{ ...cardStyle, background: "#15222e", borderColor: "#1f4a6e", marginBottom: 12, padding: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#75ead0", fontSize: 10, fontWeight: 700 }}>
          <span>✓</span> Path Verified on Authorized Drive
        </div>
        <div style={{ color: "#8fa4af", fontSize: 9, marginTop: 4, wordBreak: "break-all", fontFamily: "Consolas, monospace" }}>
          {embeddedInfo.local_file_path}
        </div>
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontSize: 10, color: "#8fa4af" }}>
          <span>Branch: <strong style={{ color: "#fff" }}>{embeddedInfo.branch_name || embeddedInfo.branch_id}</strong></span>
        </div>
      </div>

      <form onSubmit={submit} style={{ ...cardStyle, display: "grid", gap: 11 }}>
        <div>
          <div style={labelStyle}>Work email</div>
          <input
            style={inputStyle}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            disabled={sent || busy}
            autoFocus
          />
        </div>
        {sent ? (
          <div>
            <div style={labelStyle}>6-digit verification code</div>
            <input
              style={inputStyle}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              disabled={busy}
              autoFocus
            />
          </div>
        ) : null}
        {note ? <div style={{ color: "#75ead0", fontSize: 11 }}>{note}</div> : null}
        {error ? (
          <div style={{ color: "#ff8b82", fontSize: 11, background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.3)", padding: "8px 10px", borderRadius: 4, lineHeight: 1.4 }}>
            {error}
          </div>
        ) : null}
        <button
          style={{ ...buttonStyle, marginTop: 4 }}
          disabled={busy || !email.trim() || (sent && code.length !== 6)}
          type="submit"
        >
          {busy ? "Working..." : sent ? "Verify & Load Data" : "Email me a code"}
        </button>
        {sent ? (
          <button
            type="button"
            style={{ background: "transparent", border: 0, color: "#58a6ff", fontSize: 11, cursor: "pointer", textAlign: "center", padding: "4px 0" }}
            onClick={() => { setSent(false); setCode(""); setError(""); setNote(""); }}
          >
            Use a different email
          </button>
        ) : null}
      </form>
    </div>
  );
}

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
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [embeddedInfo, setEmbeddedInfo] = useState(null);
  const [pathBlocked, setPathBlocked] = useState(false);
  const [pathDetails, setPathDetails] = useState({ expected: "", current: "" });
  const [workbookVerified, setWorkbookVerified] = useState(false);
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
  const [divergence, setDivergence] = useState(null);
  const [workspaceClosed, setWorkspaceClosed] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [pullSource, setPullSource] = useState("branch");

  const baselineRef = useRef(null);
  const workbookIdentityRef = useRef(null);
  const handlerRef = useRef([]);
  const applyingRemoteRef = useRef(false);
  const autoConnectedRef = useRef(false);
  const autoAuthAttemptedRef = useRef(false);
  const displayHeadersRef = useRef({});
  const logEndRef = useRef(null);
  const presenceTimerRef = useRef(null);
  const clientIdRef = useRef(getClientId("excel"));

  useEffect(() => {
    const expireSession = () => setAuth(null);
    window.addEventListener("gitwalk:auth-expired", expireSession);
    return () => window.removeEventListener("gitwalk:auth-expired", expireSession);
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  const addLog = useCallback((message, isError = false) => {
    const time = new Date().toLocaleTimeString();
    setLogs((previous) => [...previous.slice(-119), { time, message, isError }]);
  }, []);

  const saveBaseVersion = useCallback((version, targetTableId = tableId, headCommitId = null) => new Promise((resolve) => {
    Office.context.document.settings.set(`baseVersion:${targetTableId}`, version);
    Office.context.document.settings.set("baseVersion", version);
    if (headCommitId) Office.context.document.settings.set(`baseHead:${targetTableId}`, headCommitId);
    Office.context.document.settings.saveAsync(() => resolve());
  }), [tableId]);

  const readWorkbook = useCallback(async () => window.Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load("items/id,name,position");
    await context.sync();
    const entries = worksheets.items.map((sheet) => {
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load(["isNullObject", "values", "formulas", "rowCount", "columnCount"]);
      return { sheet, used };
    });
    await context.sync();
    const sheets = entries.map(({ sheet, used }) => {
      if (used.isNullObject) {
        return { sheetId: sheet.id, sheetName: sheet.name, sheetPosition: sheet.position, columns: [], rows: [] };
      }
      const headers = used.values[0] || [];
      const metadataIndex = headers.findIndex((value) => {
        const header = String(value).trim();
        return header === ROW_ID_HEADER || header === LEGACY_ROW_ID_HEADER;
      });
      const columns = [];
      const headerIndexes = [];
      const seen = new Set();
      headers.forEach((raw, index) => {
        if (index === metadataIndex || String(raw || "").trim() === "") return;
        const column = sanitizeColumnName(raw);
        if (seen.has(column)) throw new Error(`Duplicate column after sanitizing on ${sheet.name}: ${column}`);
        seen.add(column); columns.push(column); headerIndexes.push(index);
        displayHeadersRef.current[`${sheet.name}:${column}`] = String(raw);
      });
      const rows = [];
      for (let rowIndex = 1; rowIndex < used.rowCount; rowIndex += 1) {
        const rawId = metadataIndex >= 0 ? used.values[rowIndex]?.[metadataIndex] : null;
        const rowId = rawId === "" || rawId == null ? null : String(rawId).trim().toUpperCase();
        if (rowId != null && !/^ROW_[A-Z0-9]+$/.test(rowId)) {
          throw new Error(`Invalid hidden Git Walk row identity on ${sheet.name}, row ${rowIndex + 1}. Pull latest to repair it.`);
        }
        const values = {};
        const formulas = {};
        headerIndexes.forEach((columnIndex, index) => {
          values[columns[index]] = normalizeValue(used.values[rowIndex]?.[columnIndex]);
          const formula = used.formulas[rowIndex]?.[columnIndex];
          formulas[columns[index]] = typeof formula === "string" && formula.startsWith("=") ? formula : null;
        });
        const hasData = columns.some((column) => values[column] != null);
        if (hasData || rowId != null) rows.push({ rowId, values, formulas });
      }
      return { sheetId: sheet.id, sheetName: sheet.name, sheetPosition: sheet.position, columns, rows };
    });
    return { sheets };
  }), []);

  const ensureRowIdentity = useCallback(async (snapshot) => window.Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load("items/id,name,position");
    await context.sync();
    const semanticSheets = [...(snapshot?.semantic?.sheets || [])].sort((a, b) => a.position - b.position);
    for (const semantic of semanticSheets) {
      const sheet = worksheets.items.find((item) => item.name === semantic.name)
        || worksheets.items.find((item) => item.position === semantic.position);
      if (!sheet) continue;
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load(["isNullObject", "values", "rowCount", "columnCount"]);
      const tables = sheet.tables;
      tables.load("items");
      await context.sync();
      if (used.isNullObject) continue;
      const expectedIds = [...semantic.rows].sort((a, b) => a.position - b.position).map((row) => row.row_id);
      let metadataIndex = (used.values[0] || []).findIndex((value) => {
        const header = String(value).trim();
        return header === ROW_ID_HEADER || header === LEGACY_ROW_ID_HEADER;
      });
      if (metadataIndex < 0) {
        if (tables.items.length) {
          const identityColumn = tables.items[0].columns.add(null, null, ROW_ID_HEADER);
          await context.sync();
          const body = identityColumn.getDataBodyRange();
          body.load("rowCount");
          const identityRange = identityColumn.getRange();
          identityRange.load("columnIndex");
          await context.sync();
          metadataIndex = identityRange.columnIndex;
          if (body.rowCount > 0) {
            body.values = Array.from({ length: body.rowCount }, (_, index) => [expectedIds[index] || null]);
          }
          identityRange.getEntireColumn().format.columnHidden = true;
        } else {
          metadataIndex = used.columnCount;
          sheet.getRangeByIndexes(0, metadataIndex, 1, 1).values = [[ROW_ID_HEADER]];
          const dataRows = Math.max(used.rowCount - 1, expectedIds.length);
          if (dataRows > 0) {
            sheet.getRangeByIndexes(1, metadataIndex, dataRows, 1).values =
              Array.from({ length: dataRows }, (_, index) => [expectedIds[index] || null]);
          }
        }
        addLog(`Attached stable row identity to ${semantic.name} (${expectedIds.length} row(s)).`);
      } else {
        const existingIds = used.values.slice(1).map((row) => row[metadataIndex]);
        const validIdCount = existingIds.filter((value) => /^ROW_[A-Z0-9]+$/.test(String(value))).length;
        if (String((used.values[0] || [])[metadataIndex]).trim() !== ROW_ID_HEADER) {
          sheet.getRangeByIndexes(0, metadataIndex, 1, 1).values = [[ROW_ID_HEADER]];
        }
        if (validIdCount === 0 || (used.rowCount - 1 === expectedIds.length
          && existingIds.some((value, index) => String(value || "") !== expectedIds[index]))) {
          sheet.getRangeByIndexes(1, metadataIndex, Math.max(used.rowCount - 1, expectedIds.length), 1).values =
            Array.from({ length: Math.max(used.rowCount - 1, expectedIds.length) }, (_, index) => [expectedIds[index] || null]);
          addLog(`Repaired stable row identity on ${semantic.name}.`);
        }
      }
      sheet.getRangeByIndexes(0, metadataIndex, 1, 1).getEntireColumn().format.columnHidden = true;
      await context.sync();
    }
  }), [addLog]);

  const writeSnapshot = useCallback(async (snapshot) => {
    applyingRemoteRef.current = true;
    try {
      await window.Excel.run(async (context) => {
        const worksheets = context.workbook.worksheets;
        worksheets.load("items/id,name,position");
        await context.sync();
        const semanticSheets = [...(snapshot?.semantic?.sheets || [])].sort((a, b) => a.position - b.position);
        const claimed = new Set();
        for (const [sheetIndex, semantic] of semanticSheets.entries()) {
          let sheet = worksheets.items.find((item) => !claimed.has(item.id) && item.name === semantic.name)
            || worksheets.items.find((item) => !claimed.has(item.id) && item.position === semantic.position);
          if (!sheet) {
            sheet = worksheets.add(semantic.name);
            sheet.load("id,name,position");
            await context.sync();
          }
          claimed.add(sheet.id);
          if (sheet.name !== semantic.name) sheet.name = semantic.name;
          sheet.position = sheetIndex;
          const used = sheet.getUsedRangeOrNullObject(true);
          used.load(["isNullObject", "rowIndex", "columnIndex", "rowCount", "columnCount"]);
          const tables = sheet.tables;
          tables.load("items");
          await context.sync();

          const dataColumns = [...semantic.columns].sort((a, b) => a.position - b.position);
          const rows = [...semantic.rows].sort((a, b) => a.position - b.position);
          const output = [[...dataColumns.map((column) => column.name), ROW_ID_HEADER]];
          const formulaOutput = [[...dataColumns.map((column) => column.name), ROW_ID_HEADER]];
          rows.forEach((row) => {
            output.push([...dataColumns.map((column) => row.values[column.column_id] ?? null), row.row_id]);
            formulaOutput.push([
              ...dataColumns.map((column) => row.formulas?.[column.column_id] || (row.values[column.column_id] ?? "")),
              row.row_id,
            ]);
          });
          if (output.length === 1 && tables.items.length) {
            output.push(Array.from({ length: output[0].length }, () => null));
            formulaOutput.push(Array.from({ length: output[0].length }, () => null));
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
              target = sheet.getRangeByIndexes(startRow, startColumn, output.length, output[0].length);
            }
            target.formulas = formulaOutput;
            if (oldRowCount > output.length) {
              sheet.getRangeByIndexes(startRow + output.length, startColumn, oldRowCount - output.length, oldColumnCount)
                .clear(window.Excel.ClearApplyTo.contents);
            }
            if (oldColumnCount > output[0].length) {
              sheet.getRangeByIndexes(startRow, startColumn + output[0].length, Math.min(oldRowCount, output.length), oldColumnCount - output[0].length)
                .clear(window.Excel.ClearApplyTo.contents);
            }
          } else {
            if (!used.isNullObject) used.clear(window.Excel.ClearApplyTo.contents);
            sheet.getRangeByIndexes(0, 0, output.length, output[0].length).formulas = formulaOutput;
          }
          if (dataColumns.length) {
            const header = sheet.getRangeByIndexes(startRow, startColumn, 1, dataColumns.length);
            header.format.font.bold = true;
            header.format.fill.color = "#1F6FEB";
            header.format.font.color = "#FFFFFF";
          }
          sheet.getRangeByIndexes(startRow, startColumn + dataColumns.length, 1, 1)
            .getEntireColumn().format.columnHidden = true;
        }
        worksheets.items.filter((sheet) => !claimed.has(sheet.id)).forEach((sheet) => sheet.delete());
        await context.sync();
      });
    } finally {
      setTimeout(() => { applyingRemoteRef.current = false; }, 350);
    }
  }, []);

  const reviewChanges = useCallback(async () => {
    if (!baselineRef.current) throw new Error("Connect to a dataset first.");
    const workbook = await readWorkbook();
    const diff = buildSemanticWorkbookDiff(baselineRef.current, workbook);
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
    await saveBaseVersion(latest.version, tableId, latest.head_commit_id);
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
        ...(workbookIdentityRef.current || {}),
        base_version: baselineRef.current.version,
        expected_head_commit_id: baselineRef.current.head_commit_id,
        semantic_changes: diff.semantic_changes,
        source: "excel_commit",
        commit_message: commitMessage.trim(),
      });
      addLog(`Committed ${result.commit_id} as version ${result.version}; ${result.change_count} semantic operation(s).`);
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
      if (err.detail?.code === "WORKING_COPY_CLOSED") {
        setWorkspaceClosed(true);
        setStatusMsg("Workspace merged");
        addLog("This branch was merged. Commit is disabled; create a new workspace from Git Walk.", true);
      } else if (err.status === 409) {
        const currentHead = err.detail?.current_head_commit_id || err.detail?.current_head || "a newer commit";
        setConflicts([`Branch HEAD advanced to ${currentHead}. Pull latest before committing.`]);
        addLog("Commit rejected because the server advanced. Pull latest to rebase your local work.", true);
      } else addLog(`Commit failed: ${err.message}`, true);
    } finally { setBusy(false); }
  }, [addLog, commitMessage, refreshAfterCommit, reviewChanges, tableId]);

  const syncMain = useCallback(async () => {
    const branchId = workbookIdentityRef.current?.branch_id;
    if (!branchId) { addLog("This workbook has no signed branch identity.", true); return; }
    setBusy(true); setSyncStatus("syncing"); setStatusMsg("Pulling protected main...");
    try {
      const local = await reviewChanges();
      if (local.changeCount) {
        setStatusMsg("Commit local changes before pulling main");
        addLog("Main pull paused because the working tree has local changes. Commit them first.", true);
        return;
      }
      const result = await syncBranchWithMain(branchId);
      const latest = await getWorkbookSnapshot(tableId);
      await writeSnapshot(latest);
      baselineRef.current = latest;
      await saveBaseVersion(latest.version, tableId, latest.head_commit_id);
      const status = await getBranchDivergence(branchId);
      setDivergence(status); setBranchName((current) => status.source_branch_name || current);
      setBaseVersion(latest.version); setStaged(null); setDirty(false);
      setSyncStatus("synced"); setStatusMsg(result.status === "UP_TO_DATE" ? "Already current with main" : "Main synced");
      addLog(result.status === "UP_TO_DATE" ? "Branch is already current with main." : `Created sync commit ${result.commit_id}.`);
    } catch (err) {
      const mergeConflicts = err.detail?.conflicts || [];
      if (mergeConflicts.length) {
        setConflicts(mergeConflicts.map((item) => `${item.conflict_type}: ${item.row_id || item.column_id || item.sheet_id || "workbook"}`));
        setStatusMsg(`${mergeConflicts.length} main-sync conflict(s)`);
      } else setStatusMsg(err.message);
      setSyncStatus("error"); addLog(`Pull from main failed: ${err.message}`, true);
    } finally { setBusy(false); }
  }, [addLog, reviewChanges, saveBaseVersion, tableId, writeSnapshot]);

  const pullLatest = useCallback(async (discardLocal = false) => {
    setBusy(true); setSyncStatus("syncing"); setStatusMsg("Pulling server changes...");
    try {
      const diff = discardLocal ? null : await reviewChanges();
      const remote = await getWorkbookSnapshot(tableId);
      if (!discardLocal && diff?.changeCount) {
        const found = semanticRebaseConflicts(baselineRef.current, remote, diff);
        if (found.length) {
          setConflicts(found); setSyncStatus("error");
          setStatusMsg(`${found.length} merge conflict(s)`);
          addLog(`Pull paused with ${found.length} conflict(s). Local cells were not overwritten.`, true);
          return;
        }
        const rebased = applySemanticChanges(remote, diff.semantic_changes);
        await writeSnapshot(rebased);
        baselineRef.current = remote;
        await saveBaseVersion(remote.version, tableId, remote.head_commit_id);
        setBaseVersion(remote.version); setDirty(true); setStaged(null); setConflicts([]);
        setSyncStatus("syncing"); setStatusMsg("Pulled and reapplied local changes");
        addLog(`Pulled version ${remote.version} and rebased ${diff.changeCount} local change(s). Review and commit next.`);
      } else {
        await writeSnapshot(remote);
        baselineRef.current = remote;
        await saveBaseVersion(remote.version, tableId, remote.head_commit_id);
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
        const worksheets = context.workbook.worksheets;
        worksheets.load("items/id");
        await context.sync();
        for (const binding of handlerRef.current) {
          if (binding.kind === "changed") {
            const sheet = worksheets.items.find((item) => item.id === binding.sheetId);
            if (sheet) sheet.onChanged.remove(binding.handler);
          }
          if (binding.kind === "added") worksheets.onAdded.remove(binding.handler);
          if (binding.kind === "deleted") worksheets.onDeleted.remove(binding.handler);
        }
        await context.sync();
      });
    } catch (err) { addLog(`Could not unbind: ${err.message}`, true); }
    handlerRef.current = []; baselineRef.current = null;
    setConnected(false); setSyncStatus("idle"); setStatusMsg(null); setStaged(null); setDirty(false);
    setDivergence(null); setWorkspaceClosed(false); setPullSource("branch");
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
      const branchId = workbookIdentityRef.current?.branch_id;
      const savedHead = Office.context.document.settings.get(`baseHead:${normalized}`)
        || workbookIdentityRef.current?.base_commit_id;
      const hasSavedVersion = keyedVersion != null || legacyVersion != null;
      const savedVersion = Number(keyedVersion ?? legacyVersion);
      let baseline = latest;
      if (branchId && savedHead && savedHead !== latest.head_commit_id) {
        try {
          const state = await getBranchState(branchId, savedHead);
          baseline = {
            ...latest, semantic: state, head_commit_id: savedHead,
            version: hasSavedVersion && Number.isInteger(savedVersion) ? savedVersion : latest.version,
          };
        } catch {
          addLog(`Saved checkout ${savedHead} was unavailable; using current branch HEAD.`, true);
        }
      }
      await ensureRowIdentity(baseline);
      const workbook = await readWorkbook();
      baselineRef.current = baseline;
      setBaseVersion(baseline.version);

      await window.Excel.run(async (context) => {
        const worksheets = context.workbook.worksheets;
        worksheets.load("items/id,name");
        await context.sync();
        const markDirty = () => {
          if (applyingRemoteRef.current) return;
          setDirty(true); setStaged(null); setConflicts([]);
          setSyncStatus("syncing"); setStatusMsg("Local changes pending review");
          heartbeatPresence(normalized, clientIdRef.current, "excel", "editing").catch(() => {});
        };
        const bindings = worksheets.items.map((sheet) => {
          const handler = () => markDirty();
          sheet.onChanged.add(handler);
          return { kind: "changed", sheetId: sheet.id, handler };
        });
        const addedHandler = () => markDirty();
        const deletedHandler = () => markDirty();
        worksheets.onAdded.add(addedHandler);
        worksheets.onDeleted.add(deletedHandler);
        bindings.push({ kind: "added", handler: addedHandler });
        bindings.push({ kind: "deleted", handler: deletedHandler });
        handlerRef.current = bindings;
        await context.sync();
      });
      Office.context.document.settings.set("tableId", normalized);
      Office.context.document.settings.set(`baseHead:${normalized}`, baseline.head_commit_id);
      Office.context.document.settings.saveAsync(() => {});
      setConnected(true); setSyncStatus("connected");
      if (workbookIdentityRef.current?.branch_id) {
        try {
          const branchStatus = await getBranchDivergence(workbookIdentityRef.current.branch_id);
          setDivergence(branchStatus);
          setBranchName((current) => branchStatus.source_branch_name || current);
          setWorkspaceClosed(branchStatus.source_status === "MERGED");
        } catch { setDivergence(null); }
      }
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

  const getEmbeddedIdentity = useCallback(async () => {
    try {
      return await window.Excel.run(async (context) => {
        const definitions = { table_id: TABLE_ID_DEFINED_NAME, ...WORKBOOK_METADATA_NAMES };
        const items = Object.fromEntries(
          Object.entries(definitions).map(([key, name]) => {
            const item = context.workbook.names.getItemOrNullObject(name);
            item.load("formula");
            return [key, item];
          })
        );
        await context.sync();
        const identity = {};
        Object.entries(items).forEach(([key, item]) => {
          if (!item.isNullObject) identity[key] = parseDefinedValue(item.formula);
        });
        identity.table_id = parseTableIdFormula(identity.table_id);
        return identity.table_id ? identity : null;
      });
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (autoAuthAttemptedRef.current) return;
    autoAuthAttemptedRef.current = true;
    (async () => {
      try {
        const embedded = await getEmbeddedIdentity();
        if (!embedded?.working_copy_id) {
          setAuthBootstrapping(false);
          return;
        }
        setEmbeddedInfo(embedded);
        setBranchName(embedded.branch_name || "");
        workbookIdentityRef.current = Object.fromEntries(
          Object.entries(embedded).filter(([key]) => key !== "table_id" && key !== "branch_name")
        );

        // Path Verification check:
        if (embedded.local_file_path) {
          const docUrl = (typeof Office !== "undefined" && Office?.context?.document?.url)
            ? Office.context.document.url
            : "";
          const expected = normalizeFilePath(embedded.local_file_path);
          const current = normalizeFilePath(docUrl);
          if (!current || expected !== current) {
            setPathBlocked(true);
            setPathDetails({
              expected: embedded.local_file_path,
              current: docUrl || "Unknown location (file outside authorized directory)",
            });
            addLog(`Security Alert: Workbook path mismatch. Expected: ${embedded.local_file_path}, Current: ${docUrl}`, true);
            setAuthBootstrapping(false);
            return;
          }
          addLog(`Path verification passed for authorized location.`);
        }
      } catch (err) {
        addLog(`Workbook initialization check failed: ${err.message}`, true);
      } finally {
        setAuthBootstrapping(false);
      }
    })();
  }, [addLog, getEmbeddedIdentity]);

  const handleVerifiedAndLoaded = useCallback(async (result) => {
    setBusy(true);
    try {
      setAuth({ token: result.token, user: result.user });
      setWorkbookVerified(true);
      setTableId(result.table_id);
      addLog(`Verified role '${result.role}' for ${result.user.email}.`);
      if (result.snapshot) {
        addLog("Loading branch dataset into workbook...");
        await writeSnapshot(result.snapshot);
        baselineRef.current = result.snapshot;
        await saveBaseVersion(result.snapshot.version, result.table_id, result.snapshot.head_commit_id);
        setBaseVersion(result.snapshot.version);
      }
      await connect(result.table_id);
      addLog("Branch data loaded and synchronized. Ready to edit.");
    } catch (err) {
      addLog(`Failed loading branch data: ${err.message}`, true);
    } finally {
      setBusy(false);
    }
  }, [addLog, connect, saveBaseVersion, writeSnapshot]);

  useEffect(() => {
    if (!auth || autoConnectedRef.current) return;
    if (embeddedInfo?.working_copy_id && !workbookVerified) return;
    autoConnectedRef.current = true;
    (async () => {
      const embedded = await getEmbeddedIdentity();
      const saved = Office.context.document.settings.get("tableId");
      setBranchName(embedded?.branch_name || "");
      workbookIdentityRef.current = embedded
        ? Object.fromEntries(Object.entries(embedded).filter(([key]) => key !== "table_id" && key !== "branch_name"))
        : null;
      if (embedded?.table_id || saved) await connect(embedded?.table_id || saved);
      else addLog("No embedded Table ID found. Enter it once to connect.");
    })();
  }, [addLog, auth, connect, embeddedInfo, getEmbeddedIdentity, workbookVerified]);

  const signOut = useCallback(async () => {
    if (connected) await disconnect();
    await logout().catch(() => clearAuth());
    setAuth(null);
    setWorkbookVerified(false);
    setTableId("");
    setBranchName("");
    setLogs([]);
    autoConnectedRef.current = false;
    workbookIdentityRef.current = null;
  }, [connected, disconnect]);

  if (pathBlocked) {
    return (
      <PathBlockedPanel
        expectedPath={pathDetails.expected}
        currentPath={pathDetails.current}
      />
    );
  }

  if (authBootstrapping) return (
    <div style={containerStyle}>
      <div style={{ ...cardStyle, marginTop: 30 }}>
        <div style={labelStyle}>SIGNED BRANCH</div>
        <h2 style={{ margin: "8px 0" }}>Verifying location & branch</h2>
        <p style={{ color: "#8fa4af", fontSize: 11, lineHeight: 1.6 }}>
          Checking file path authorization and loading workspace...
        </p>
      </div>
    </div>
  );

  if (embeddedInfo?.working_copy_id && !workbookVerified) {
    return (
      <WorkbookVerificationPanel
        embeddedInfo={embeddedInfo}
        onVerifiedAndLoaded={handleVerifiedAndLoaded}
      />
    );
  }

  if (!auth?.token) return <AuthPanel onAuthenticated={setAuth} />;
  const summary = staged || {
    changeCount: dirty ? "?" : 0,
    counts: { cells: 0, rows: 0, columns: 0, formulas: 0, sheets: 0 },
    preview: [],
  };

  return (
    <div style={containerStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ color: "#58a6ff", fontSize: 10, fontWeight: 800, letterSpacing: ".13em" }}>GIT WALK / SOURCE CONTROL</div><div style={{ fontSize: 20, fontWeight: 800 }}>Repository workspace</div></div>
        <button onClick={signOut} style={{ border: 0, color: "#92a6af", background: "transparent" }}>Sign out</button>
      </div>
      <div style={{ ...cardStyle, padding: 11, display: "flex", justifyContent: "space-between" }}>
        <div><div style={{ fontSize: 11 }}>{auth.user?.email}</div><div style={{ color: "#70858f", fontSize: 9, marginTop: 3 }}>{auth.user?.user_id}</div></div>
        <div style={{ color: "#75ead0", fontSize: 10, fontWeight: 800 }}>BASE v{baseVersion}</div>
      </div>
      <StatusBanner status={syncStatus} message={statusMsg} />
      <div style={cardStyle}><div style={labelStyle}>Repository data ID</div><input style={inputStyle} value={tableId} onChange={(e) => setTableId(e.target.value.toUpperCase())} disabled={connected} placeholder="QUEUE_BOARD_A1B2C3D4" /></div>

      {!connected ? <button style={buttonStyle} disabled={busy || !tableId} onClick={() => connect()}>{busy ? "Connecting..." : "Open repository workspace"}</button> : <>
        {workspaceClosed ? <div style={{ ...cardStyle, borderColor: "#b9862d", background: "#2a2114" }}><div style={{ ...labelStyle, color: "#f4ba62" }}>Workspace merged</div><div style={{ color: "#e9d7b5", fontSize: 11, lineHeight: 1.55 }}>This signed working copy is closed. Download latest main or create a new workspace in Git Walk.</div></div> : null}
        {divergence ? <div style={{ ...cardStyle, padding: 10, display: "flex", justifyContent: "space-between", color: "#9bafb8", fontSize: 10 }}><span><b style={{ color: "#75ead0" }}>{divergence.ahead}</b> ahead</span><span><b style={{ color: "#f4ba62" }}>{divergence.behind}</b> behind main</span></div> : null}
        <button style={{ ...buttonStyle, color: "#d8e5e9", background: "#172632", boxShadow: "none" }} disabled={busy || workspaceClosed} onClick={reviewChanges}>Review local changes</button>
        <div style={{ ...cardStyle, padding: 11 }}>
          <div style={labelStyle}>Pull data from</div>
          <select
            style={{ ...inputStyle, appearance: "auto", cursor: "pointer" }}
            value={pullSource}
            disabled={busy || workspaceClosed}
            onChange={(event) => setPullSource(event.target.value)}
          >
            <option value="main">Protected main{divergence?.target_branch_name ? ` / ${divergence.target_branch_name}` : ""}</option>
            <option value="branch">My branch / {branchName || divergence?.source_branch_name || workbookIdentityRef.current?.branch_id || "signed workspace"}</option>
          </select>
          <div style={{ color: "#718792", fontSize: 9, lineHeight: 1.5, marginTop: 7 }}>
            {pullSource === "main"
              ? "Reconcile protected main into your branch, then refresh this workbook."
              : "Refresh this workbook from your personal branch without touching main."}
          </div>
          <button
            style={{ ...buttonStyle, marginTop: 10, color: "#071716", background: "linear-gradient(135deg,#66c4ff,#49a8e8)" }}
            disabled={busy || workspaceClosed}
            onClick={() => (pullSource === "main" ? syncMain() : pullLatest(false))}
          >
            {pullSource === "main" ? "Pull from protected main" : "Pull from my branch"}
          </button>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Commit message</div>
          <input style={inputStyle} value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Describe this data change" maxLength={300} />
          <button style={{ ...buttonStyle, marginTop: 10, opacity: !commitMessage.trim() || busy || workspaceClosed ? .55 : 1 }} disabled={!commitMessage.trim() || busy || workspaceClosed} onClick={commitChanges}>{busy ? "Working..." : `Commit ${summary.changeCount === "?" ? "changes" : `${summary.changeCount} change(s)`}`}</button>
        </div>
        <button style={{ ...buttonStyle, color: "#ffaaa3", background: "#2a191c", boxShadow: "none" }} onClick={disconnect}>Disconnect</button>
      </>}

      {connected ? <div style={{ ...cardStyle, display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, textAlign: "center" }}>
        <div><div style={labelStyle}>Cells / formulas</div><strong style={{ color: "#75ead0" }}>{summary.counts.cells}/{summary.counts.formulas}</strong></div>
        <div><div style={labelStyle}>Row operations</div><strong style={{ color: "#66c4ff" }}>{summary.counts.rows}</strong></div>
        <div><div style={labelStyle}>Column operations</div><strong style={{ color: "#f4ba62" }}>{summary.counts.columns}</strong></div>
        <div><div style={labelStyle}>Sheet operations</div><strong style={{ color: "#d2a8ff" }}>{summary.counts.sheets || 0}</strong></div>
      </div> : null}

      {staged?.preview.length ? <div style={cardStyle}><div style={labelStyle}>Staged diff</div><div style={{ maxHeight: 155, overflowY: "auto" }}>{staged.preview.slice(0, 30).map((line, index) => <div key={index} style={{ color: "#a8bbc3", borderBottom: "1px solid #20303a", padding: "5px 0", font: "10px Consolas,monospace" }}>{line}</div>)}</div></div> : null}

      {conflicts.length ? <div style={{ ...cardStyle, borderColor: "rgba(255,127,117,.45)" }}><div style={{ ...labelStyle, color: "#ff8b82" }}>Merge conflicts</div>{conflicts.slice(0, 12).map((item, index) => <div key={index} style={{ color: "#ffaaa3", fontSize: 10, padding: "4px 0" }}>{item}</div>)}<button style={{ ...buttonStyle, marginTop: 10, color: "#fff", background: "#b84540" }} onClick={() => { if (window.confirm("Discard every local uncommitted change and pull the server version?")) pullLatest(true); }}>Discard local changes and pull</button></div> : null}

      <div><div style={labelStyle}>Activity log</div><div style={{ ...cardStyle, maxHeight: 230, overflowY: "auto", padding: 11 }}>{logs.length ? logs.map((log, index) => <div key={`${log.time}-${index}`} style={{ color: log.isError ? "#ff8b82" : "#9bafb8", borderBottom: "1px solid #20303a", padding: "5px 0", font: "10px Consolas,monospace", lineHeight: 1.5 }}><span style={{ color: "#60747e" }}>[{log.time}]</span> {log.message}</div>) : <div style={{ color: "#60747e", fontSize: 11 }}>No activity yet.</div>}<div ref={logEndRef} /></div></div>
    </div>
  );
}
