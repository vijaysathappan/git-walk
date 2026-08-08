/**
 * App.jsx — Main browser application for uploading .xlsx files.
 *
 * Premium dark-theme UI with glassmorphism, animated background,
 * file upload, and auto-download of the provisioned file.
 */
import React, { useState } from "react";
import FileUploader from "./components/FileUploader";
import StatusBanner from "./components/StatusBanner";
import { uploadAndProvision } from "./services/api";

// ── CSS-in-JS styles ────────────────────────────────────────────────────
const appStyles = `
  @keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(24px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50% { transform: translateY(-8px); }
  }

  @keyframes shimmer {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
`;

const pageStyle = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "40px 20px",
  position: "relative",
  overflow: "hidden",
};

const bgGlowStyle = {
  position: "absolute",
  width: "600px",
  height: "600px",
  borderRadius: "50%",
  filter: "blur(120px)",
  opacity: 0.15,
  pointerEvents: "none",
};

const cardStyle = {
  position: "relative",
  width: "100%",
  maxWidth: "520px",
  background: "rgba(15, 23, 42, 0.7)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(148, 163, 184, 0.1)",
  borderRadius: "24px",
  padding: "40px 32px",
  boxShadow:
    "0 4px 30px rgba(0, 0, 0, 0.3), 0 0 80px rgba(99, 102, 241, 0.05)",
  animation: "fadeInUp 0.6s ease-out",
};

const headingStyle = {
  fontSize: "28px",
  fontWeight: 800,
  letterSpacing: "-0.02em",
  marginBottom: "8px",
  background: "linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  lineHeight: 1.2,
};

const subtitleStyle = {
  fontSize: "14px",
  color: "#64748b",
  lineHeight: 1.6,
  marginBottom: "32px",
};

const buttonStyle = (isUploading) => ({
  width: "100%",
  padding: "14px 20px",
  borderRadius: "12px",
  border: "none",
  fontSize: "15px",
  fontWeight: 600,
  fontFamily: "'Inter', sans-serif",
  cursor: isUploading ? "wait" : "pointer",
  color: "#fff",
  background: isUploading
    ? "linear-gradient(135deg, #475569 0%, #334155 100%)"
    : "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  boxShadow: isUploading
    ? "none"
    : "0 4px 20px rgba(99, 102, 241, 0.35)",
  transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
  transform: "scale(1)",
  marginTop: "20px",
  letterSpacing: "0.02em",
});

const resultCardStyle = {
  marginTop: "20px",
  background: "rgba(16, 185, 129, 0.06)",
  border: "1px solid rgba(16, 185, 129, 0.2)",
  borderRadius: "12px",
  padding: "16px",
  animation: "fadeInUp 0.4s ease-out",
};

const resultRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 0",
  fontSize: "13px",
};

const resultLabelStyle = {
  color: "#64748b",
  fontWeight: 500,
};

const resultValueStyle = {
  color: "#e2e8f0",
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: "12px",
};

export default function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("idle");

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setError(null);
    setUploadResult(null);
    setStatus("syncing");

    try {
      const result = await uploadAndProvision(selectedFile);
      // Auto-trigger file download
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setUploadResult(result);
      setStatus("synced");

      // Reset to idle after 5s
      setTimeout(() => setStatus("idle"), 5000);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      <style>{appStyles}</style>
      <div style={pageStyle}>
        {/* Background glows */}
        <div
          style={{
            ...bgGlowStyle,
            top: "-200px",
            left: "-100px",
            background: "radial-gradient(circle, #6366f1, transparent)",
          }}
        />
        <div
          style={{
            ...bgGlowStyle,
            bottom: "-200px",
            right: "-100px",
            background: "radial-gradient(circle, #8b5cf6, transparent)",
          }}
        />

        {/* Main card */}
        <div style={cardStyle}>
          {/* Logo */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "24px",
              animation: "float 4s ease-in-out infinite",
            }}
          >
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "12px",
                background:
                  "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "22px",
                boxShadow: "0 4px 20px rgba(99, 102, 241, 0.4)",
              }}
            >
              ⚡
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "#6366f1",
                }}
              >
                Excel ↔ SQLite
              </div>
              <div style={{ fontSize: "10px", color: "#475569" }}>
                LiveSync v1.0
              </div>
            </div>
          </div>

          <h1 style={headingStyle} id="app-title">
            Upload & Provision
          </h1>
          <p style={subtitleStyle}>
            Upload your <strong style={{ color: "#8b5cf6" }}>.xlsx</strong>{" "}
            workbook. We'll create a SQLite table, seed it with your data,
            inject the Office Add-in manifest, and return a ready-to-sync
            file.
          </p>

          {/* Status */}
          <div style={{ marginBottom: "20px" }}>
            <StatusBanner status={status} />
          </div>

          {/* File Uploader */}
          <FileUploader
            onFileSelected={setSelectedFile}
            disabled={isUploading}
          />

          {/* Upload Button */}
          <button
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
            style={buttonStyle(isUploading)}
            id="upload-btn"
            onMouseEnter={(e) => {
              if (!isUploading)
                e.target.style.transform = "scale(1.02)";
            }}
            onMouseLeave={(e) => {
              e.target.style.transform = "scale(1)";
            }}
          >
            {isUploading ? "⏳ Provisioning..." : "🚀 Upload & Provision"}
          </button>

          {/* Error */}
          {error && (
            <div
              style={{
                marginTop: "16px",
                padding: "12px 16px",
                borderRadius: "10px",
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                color: "#f87171",
                fontSize: "13px",
                fontWeight: 500,
              }}
              role="alert"
              id="upload-error"
            >
              ⚠ {error}
            </div>
          )}

          {/* Result card */}
          {uploadResult && (
            <div style={resultCardStyle} id="upload-result">
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "#10b981",
                  marginBottom: "12px",
                }}
              >
                ✓ Provisioning Complete
              </div>
              <div style={resultRowStyle}>
                <span style={resultLabelStyle}>Table ID</span>
                <span style={resultValueStyle}>
                  {uploadResult.tableId}
                </span>
              </div>
              <div style={resultRowStyle}>
                <span style={resultLabelStyle}>Rows Seeded</span>
                <span style={resultValueStyle}>
                  {uploadResult.rowCount}
                </span>
              </div>
              <div style={resultRowStyle}>
                <span style={resultLabelStyle}>Columns</span>
                <span style={resultValueStyle}>
                  {uploadResult.colCount}
                </span>
              </div>
              <div style={resultRowStyle}>
                <span style={resultLabelStyle}>Downloaded</span>
                <span style={resultValueStyle}>
                  {uploadResult.filename}
                </span>
              </div>
              <div
                style={{
                  marginTop: "12px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  background: "rgba(99, 102, 241, 0.08)",
                  border: "1px solid rgba(99, 102, 241, 0.2)",
                  fontSize: "12px",
                  color: "#94a3b8",
                  lineHeight: 1.6,
                }}
              >
                📋 Copy the <strong style={{ color: "#8b5cf6" }}>Table ID</strong>{" "}
                above and paste it into the Excel taskpane to start
                real-time syncing.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            marginTop: "24px",
            fontSize: "12px",
            color: "#334155",
            textAlign: "center",
          }}
        >
          ExcelSQLiteLiveSync • Zero-setup • Powered by FastAPI + SQLite
        </div>
      </div>
    </>
  );
}
