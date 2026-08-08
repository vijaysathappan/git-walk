/**
 * TaskpaneUI — Office.js embedded side panel for real-time Excel ↔ SQLite sync.
 *
 * This component:
 *   1. Binds a worksheet.onChanged listener to the active sheet
 *   2. Debounces rapid edits (300ms)
 *   3. Maps cell addresses to ROW_ID + column_name
 *   4. POSTs cell-level updates to the backend /api/v1/realtime-sync endpoint
 *   5. Shows real-time sync status (Connected, Syncing, Synced, Error)
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import StatusBanner from "./StatusBanner";
import { getCellValue, realtimeSync } from "../services/api";

function sanitizeColumnName(raw) {
  let name = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/ /g, "_")
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!name) {
    name = "COL";
  }

  if (/^\d/.test(name)) {
    name = `_${name}`;
  }

  return name.substring(0, 30);
}

function parseExcelAddress(address) {
  const normalized = String(address || "").trim();
  if (!normalized) {
    return null;
  }

  const withoutSheet = (normalized.includes("!")
    ? normalized.split("!").pop()
    : normalized
  ).replace(/\$/g, "");
  const [startCell, endCell] = withoutSheet.split(":");

  if (!startCell) {
    return null;
  }

  if (endCell && endCell.toUpperCase() !== startCell.toUpperCase()) {
    return { type: "range", startCell, endCell };
  }

  const match = startCell.match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    type: "cell",
    cell: startCell.toUpperCase(),
    colLetter: match[1].toUpperCase(),
    rowNum: parseInt(match[2], 10),
  };
}

const TABLE_ID_DEFINED_NAME = "_EXCEL_SQLITE_SYNC_TABLE_ID";

function parseTableIdFormula(formula) {
  const tableId = String(formula || "")
    .trim()
    .replace(/^=/, "")
    .replace(/^"|"$/g, "")
    .toUpperCase();
  return /^QUEUE_BOARD_[A-Z0-9]+$/.test(tableId) ? tableId : null;
}

// ── Styles ──────────────────────────────────────────────────────────────
const containerStyle = {
  padding: "20px 16px",
  minHeight: "100vh",
  background: "linear-gradient(180deg, #0f1219 0%, #131927 100%)",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  marginBottom: "4px",
};

const logoStyle = {
  width: "32px",
  height: "32px",
  borderRadius: "8px",
  background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "16px",
  fontWeight: 700,
  color: "#fff",
  boxShadow: "0 2px 12px rgba(99, 102, 241, 0.35)",
};

const titleStyle = {
  fontSize: "16px",
  fontWeight: 700,
  background: "linear-gradient(90deg, #e2e8f0, #94a3b8)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
};

const cardStyle = {
  background: "rgba(30, 41, 59, 0.5)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(148, 163, 184, 0.1)",
  borderRadius: "12px",
  padding: "16px",
};

const labelStyle = {
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#64748b",
  marginBottom: "8px",
};

const valueStyle = {
  fontSize: "14px",
  fontWeight: 500,
  color: "#e2e8f0",
  wordBreak: "break-all",
};

const logContainerStyle = {
  ...cardStyle,
  maxHeight: "280px",
  overflowY: "auto",
  padding: "12px",
};

const logEntryStyle = (isError) => ({
  fontSize: "11px",
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  color: isError ? "#f87171" : "#94a3b8",
  padding: "4px 0",
  borderBottom: "1px solid rgba(148, 163, 184, 0.06)",
  lineHeight: 1.6,
});

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid rgba(148, 163, 184, 0.2)",
  background: "rgba(15, 23, 42, 0.6)",
  color: "#e2e8f0",
  fontSize: "13px",
  fontFamily: "'Inter', sans-serif",
  outline: "none",
  transition: "border-color 0.2s ease",
};

const buttonStyle = {
  width: "100%",
  padding: "10px 16px",
  borderRadius: "8px",
  border: "none",
  background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  color: "#fff",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.2s ease",
  boxShadow: "0 2px 12px rgba(99, 102, 241, 0.3)",
};

export default function TaskpaneUI() {
  const [tableId, setTableId] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | connected | syncing | synced | error
  const [statusMsg, setStatusMsg] = useState(null);
  const [logs, setLogs] = useState([]);
  const [syncCount, setSyncCount] = useState(0);
  const [isListening, setIsListening] = useState(false);

  const debounceTimers = useRef(new Map());
  const logEndRef = useRef(null);
  const handlerRef = useRef(null);
  const boundSheetRef = useRef(null);
  const hasAutoConnectedRef = useRef(false);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((msg, isError = false) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-99), { time, msg, isError }]);
  }, []);

  const performSync = useCallback(
    async (payload, source = "event") => {
      setSyncStatus("syncing");
      setStatusMsg("Syncing...");
      addLog(
        `→ ${source.toUpperCase()} SYNC: ${payload.column_name} @ ROW_ID=${payload.row_id} = "${payload.new_value}"`
      );

      try {
        const result = await realtimeSync(payload);
        setSyncStatus("synced");
        setStatusMsg(`Synced to SQLite DB — ${result.timestamp}`);
        setSyncCount((c) => c + 1);
        const outcome = result.changed ? "updated" : "already matched";
        addLog(
          `✓ SQLite verified: ${payload.column_name} = "${result.persisted_value}" (${outcome})`
        );

        setTimeout(() => {
          setSyncStatus("connected");
          setStatusMsg(null);
        }, 3000);
      } catch (err) {
        setSyncStatus("error");
        setStatusMsg(`Error: ${err.message}`);
        addLog(`✕ FAILED: ${err.message}`, true);
      }
    },
    [addLog]
  );

  // ── Debounced sync handler ────────────────────────────────────────────
  const debouncedSync = useCallback(
    (payload) => {
      const key = `${payload.table_id}:${payload.row_id}:${payload.column_name}`;
      const existingTimer = debounceTimers.current.get(key);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        debounceTimers.current.delete(key);
        performSync(payload, "event");
      }, 300);
      debounceTimers.current.set(key, timer);
    },
    [performSync]
  );

  // ── Start listening to worksheet changes ──────────────────────────────
  const startListening = useCallback(async (requestedTableId = tableId) => {
    const currentTableId = String(requestedTableId || "").trim().toUpperCase();
    if (!currentTableId) {
      addLog("⚠ Enter a Table ID first.", true);
      return;
    }

    setTableId(currentTableId);
    addLog(`Connecting to table: ${currentTableId}...`);

    try {
      await window.Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();

        // Remove previous handler if any
        if (handlerRef.current) {
          const previousSheet = boundSheetRef.current || sheet;
          previousSheet.onChanged.remove(handlerRef.current);
          await context.sync();
        }

        // Create the change handler
        const handler = async (eventArgs) => {
          try {
            await window.Excel.run(async (ctx) => {
              const parsedAddress = parseExcelAddress(eventArgs.address);
              if (!parsedAddress) {
                addLog(`⊘ Ignored unsupported address: ${eventArgs.address}`, true);
                return;
              }

              if (parsedAddress.type === "range") {
                addLog(
                  `⊘ Ignored multi-cell change: ${eventArgs.address}. Edit one cell at a time for sync.`,
                  true
                );
                return;
              }

              const { cell: address, colLetter, rowNum } = parsedAddress;

              // Skip header row edits
              if (rowNum <= 1) {
                addLog(`⊘ Skipped header row edit at ${address}`);
                return;
              }

              // Map to ROW_ID (row 2 in Excel = ROW_ID 1 in DB)
              const rowId = rowNum - 1;

              // Convert column letter to index (A=0, B=1, ...)
              let colIndex = 0;
              for (let i = 0; i < colLetter.length; i++) {
                colIndex =
                  colIndex * 26 + (colLetter.charCodeAt(i) - 64);
              }
              colIndex -= 1; // zero-based

              const worksheet = eventArgs.worksheetId
                ? ctx.workbook.worksheets.getItem(eventArgs.worksheetId)
                : ctx.workbook.worksheets.getActiveWorksheet();

              // Read the header cell to get column name
              const headerRange = worksheet
                .getRangeByIndexes(0, colIndex, 1, 1);
              headerRange.load("values");

              // Read the changed cell value
              const changedRange = worksheet.getRange(address);
              changedRange.load("values");

              await ctx.sync();

              const columnName = sanitizeColumnName(
                headerRange.values[0][0] || `COL_${colIndex}`
              );

              const newValue =
                changedRange.values[0][0] != null
                  ? String(changedRange.values[0][0])
                  : null;

              // Fire debounced sync
              debouncedSync({
                table_id: currentTableId,
                row_id: rowId,
                column_name: columnName,
                new_value: newValue,
              });
            });
          } catch (innerErr) {
            addLog(`⚠ Change handler error: ${innerErr.message}`, true);
          }
        };

        sheet.onChanged.add(handler);
        handlerRef.current = handler;
        boundSheetRef.current = sheet;
        await context.sync();

        Office.context.document.settings.set("tableId", currentTableId);
        Office.context.document.settings.saveAsync(() => {});

        setIsListening(true);
        setSyncStatus("connected");
        setStatusMsg("Connected — Listening for changes");
        addLog("✓ Bound to active worksheet. Editing any cell will sync.");
      });
    } catch (err) {
      setSyncStatus("error");
      setStatusMsg(`Connection failed: ${err.message}`);
      addLog(`✕ Failed to bind: ${err.message}`, true);
    }
  }, [tableId, debouncedSync, addLog]);

  const getEmbeddedTableId = useCallback(async () => {
    try {
      return await window.Excel.run(async (context) => {
        const namedItem = context.workbook.names.getItemOrNullObject(
          TABLE_ID_DEFINED_NAME
        );
        namedItem.load("formula");
        await context.sync();

        if (namedItem.isNullObject) return null;
        return parseTableIdFormula(namedItem.formula);
      });
    } catch (err) {
      addLog(`⚠ Could not read workbook table ID: ${err.message}`, true);
      return null;
    }
  }, [addLog]);

  useEffect(() => {
    if (hasAutoConnectedRef.current) return;
    hasAutoConnectedRef.current = true;

    const connectToWorkbookTable = async () => {
      const embeddedTableId = await getEmbeddedTableId();
      const savedTableId = Office.context.document.settings.get("tableId");
      const resolvedTableId = embeddedTableId || savedTableId;

      if (embeddedTableId && savedTableId && embeddedTableId !== savedTableId) {
        addLog(
          `Workbook table ${embeddedTableId} overrides stale saved table ${savedTableId}.`
        );
      }

      if (resolvedTableId) {
        addLog(`Found workbook table ID: ${resolvedTableId}`);
        await startListening(resolvedTableId);
      } else {
        addLog("No workbook table ID found. Enter it once to connect.");
      }
    };

    connectToWorkbookTable();
  }, [addLog, getEmbeddedTableId, startListening]);

  const verifySelectedCell = useCallback(async () => {
    if (!tableId.trim()) {
      addLog("⚠ Enter a Table ID first.", true);
      return;
    }

    try {
      await window.Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load(["address", "values", "rowIndex", "columnIndex", "rowCount", "columnCount"]);
        await context.sync();

        if (range.rowCount !== 1 || range.columnCount !== 1) {
          addLog("⚠ Select exactly one cell before verification.", true);
          return;
        }

        const rowNum = range.rowIndex + 1;
        if (rowNum <= 1) {
          addLog("⊘ Header row cannot be verified.", true);
          return;
        }

        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const headerRange = worksheet.getRangeByIndexes(0, range.columnIndex, 1, 1);
        headerRange.load("values");
        await context.sync();

        const payload = {
          table_id: tableId.trim().toUpperCase(),
          row_id: rowNum - 1,
          column_name: sanitizeColumnName(
            headerRange.values[0][0] || `COL_${range.columnIndex}`
          ),
          new_value:
            range.values[0][0] != null ? String(range.values[0][0]) : null,
        };

        addLog(`Verifying selected cell ${range.address}...`);
        const persisted = await getCellValue(payload);
        const expectedValue = payload.new_value == null ? null : String(payload.new_value);
        const persistedValue = persisted.value == null ? null : String(persisted.value);

        if (expectedValue === persistedValue) {
          setSyncStatus("synced");
          setStatusMsg("Selected cell matches SQLite");
          addLog(
            `✓ SQLite verified: ${payload.column_name} = "${persisted.value}" (no repair needed)`
          );
          setTimeout(() => {
            setSyncStatus("connected");
            setStatusMsg(null);
          }, 3000);
        } else {
          addLog(
            `⚠ SQLite has "${persisted.value}"; repairing it to "${payload.new_value}".`,
            true
          );
          await performSync(payload, "manual repair");
        }
      });
    } catch (err) {
      setSyncStatus("error");
      setStatusMsg(`Verification failed: ${err.message}`);
      addLog(`✕ Verification failed: ${err.message}`, true);
    }
  }, [addLog, performSync, tableId]);

  // ── Stop listening ────────────────────────────────────────────────────
  const stopListening = useCallback(async () => {
    try {
      await window.Excel.run(async (context) => {
        if (handlerRef.current) {
          const sheet = boundSheetRef.current ||
            context.workbook.worksheets.getActiveWorksheet();
          sheet.onChanged.remove(handlerRef.current);
          await context.sync();
          handlerRef.current = null;
          boundSheetRef.current = null;
        }
      });
    } catch (err) {
      addLog(`⚠ Could not unbind: ${err.message}`, true);
    }
    setIsListening(false);
    setSyncStatus("idle");
    setStatusMsg(null);
    addLog("Disconnected from worksheet.");
  }, [addLog]);

  useEffect(() => () => {
    debounceTimers.current.forEach((timer) => clearTimeout(timer));
    debounceTimers.current.clear();
  }, []);

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={logoStyle}>⚡</div>
        <div style={titleStyle}>SQLite LiveSync</div>
      </div>

      {/* Status Banner */}
      <StatusBanner status={syncStatus} message={statusMsg} />

      {/* Table ID Input */}
      <div style={cardStyle}>
        <div style={labelStyle}>Table ID</div>
        <input
          type="text"
          value={tableId}
          onChange={(e) => setTableId(e.target.value)}
          placeholder="e.g. QUEUE_BOARD_A1B2C3D4"
          style={inputStyle}
          disabled={isListening}
          id="table-id-input"
        />
      </div>

      {/* Connect / Disconnect Button */}
      {!isListening ? (
        <button
          onClick={() => startListening()}
          style={buttonStyle}
          disabled={!tableId.trim()}
          id="connect-btn"
        >
          ⚡ Connect & Start Syncing
        </button>
      ) : (
        <button
          onClick={stopListening}
          style={{
            ...buttonStyle,
            background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
            boxShadow: "0 2px 12px rgba(239, 68, 68, 0.3)",
          }}
          id="disconnect-btn"
        >
          ■ Disconnect
        </button>
      )}

      {isListening ? (
        <button
          onClick={verifySelectedCell}
          style={{
            ...buttonStyle,
            background: "linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)",
            boxShadow: "0 2px 12px rgba(37, 99, 235, 0.3)",
          }}
          id="manual-sync-btn"
        >
          Verify Selected Cell
        </button>
      ) : null}

      {/* Stats */}
      <div style={{ display: "flex", gap: "12px" }}>
        <div style={{ ...cardStyle, flex: 1, textAlign: "center" }}>
          <div style={labelStyle}>Synced Edits</div>
          <div
            style={{
              fontSize: "24px",
              fontWeight: 700,
              background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {syncCount}
          </div>
        </div>
        <div style={{ ...cardStyle, flex: 1, textAlign: "center" }}>
          <div style={labelStyle}>Status</div>
          <div style={{ ...valueStyle, fontSize: "13px" }}>
            {isListening ? "🟢 Active" : "⚪ Inactive"}
          </div>
        </div>
      </div>

      {/* Activity Log */}
      <div>
        <div style={{ ...labelStyle, marginBottom: "8px" }}>Activity Log</div>
        <div style={logContainerStyle} id="activity-log">
          {logs.length === 0 ? (
            <div
              style={{
                color: "#475569",
                fontSize: "12px",
                textAlign: "center",
                padding: "20px 0",
              }}
            >
              No activity yet
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={logEntryStyle(log.isError)}>
                <span style={{ color: "#475569" }}>[{log.time}]</span>{" "}
                {log.msg}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
