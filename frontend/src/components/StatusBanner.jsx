/**
 * StatusBanner — Animated sync status indicator.
 *
 * Displays connection state with color-coded pulse animations:
 *   • connected  → green pulse
 *   • syncing    → amber pulse
 *   • synced     → green solid
 *   • error      → red pulse
 *   • idle       → gray
 */
import React from "react";

const STATUS_CONFIG = {
  idle: {
    label: "Idle",
    color: "#64748b",
    bgColor: "rgba(100, 116, 139, 0.12)",
    borderColor: "rgba(100, 116, 139, 0.3)",
    pulse: false,
    icon: "○",
  },
  connected: {
    label: "Connected",
    color: "#22d3ee",
    bgColor: "rgba(34, 211, 238, 0.1)",
    borderColor: "rgba(34, 211, 238, 0.3)",
    pulse: true,
    icon: "◉",
  },
  syncing: {
    label: "Syncing...",
    color: "#f59e0b",
    bgColor: "rgba(245, 158, 11, 0.1)",
    borderColor: "rgba(245, 158, 11, 0.3)",
    pulse: true,
    icon: "⟳",
  },
  synced: {
    label: "Synced to SQLite DB",
    color: "#10b981",
    bgColor: "rgba(16, 185, 129, 0.1)",
    borderColor: "rgba(16, 185, 129, 0.3)",
    pulse: false,
    icon: "✓",
  },
  error: {
    label: "Sync Error",
    color: "#ef4444",
    bgColor: "rgba(239, 68, 68, 0.1)",
    borderColor: "rgba(239, 68, 68, 0.3)",
    pulse: true,
    icon: "✕",
  },
};

const styles = {
  banner: (config) => ({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    borderRadius: "10px",
    background: config.bgColor,
    border: `1px solid ${config.borderColor}`,
    transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
  }),
  dot: (config) => ({
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: config.color,
    boxShadow: config.pulse
      ? `0 0 8px ${config.color}, 0 0 16px ${config.color}40`
      : "none",
    animation: config.pulse ? "statusPulse 1.5s ease-in-out infinite" : "none",
    flexShrink: 0,
  }),
  icon: (config) => ({
    fontSize: "16px",
    color: config.color,
    fontWeight: 600,
    flexShrink: 0,
    animation:
      config.pulse && config.icon === "⟳"
        ? "statusSpin 1s linear infinite"
        : "none",
  }),
  label: (config) => ({
    fontSize: "13px",
    fontWeight: 500,
    color: config.color,
    letterSpacing: "0.02em",
  }),
  keyframes: `
    @keyframes statusPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }
    @keyframes statusSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `,
};

export default function StatusBanner({ status = "idle", message }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.idle;

  return (
    <>
      <style>{styles.keyframes}</style>
      <div style={styles.banner(config)} role="status" aria-live="polite" id="sync-status-banner">
        <span style={styles.dot(config)} />
        <span style={styles.icon(config)}>{config.icon}</span>
        <span style={styles.label(config)}>
          {message || config.label}
        </span>
      </div>
    </>
  );
}
