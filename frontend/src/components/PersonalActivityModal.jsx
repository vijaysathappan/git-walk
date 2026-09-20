import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getPersonalActivity } from "../services/api";

const RANGE_OPTIONS = [
  { key: "all", label: "All" },
  { key: "30d", label: "30d" },
  { key: "7d", label: "7d" },
];

function intensityClass(count, max) {
  if (!count) return 0;
  if (max <= 0) return 1;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function buildWeeks(heatmap) {
  if (!heatmap.length) return [];
  const weeks = [];
  const firstDay = new Date(`${heatmap[0].date}T00:00:00Z`).getUTCDay();
  let week = new Array(firstDay).fill(null);
  heatmap.forEach((day) => {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  });
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

function monthLabelForWeek(week) {
  const firstReal = week.find((day) => day);
  if (!firstReal) return "";
  return new Date(`${firstReal.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short" });
}

/**
 * Personal Activity — a GitHub-style "your footprint in Git Walk" popup.
 * Every number comes from GET /ai-platform/personal-activity (repository
 * access, commits, cell-level change volume, and AI usage, all read
 * straight from their own tables server side) — nothing here is invented
 * client-side.
 */
export default function PersonalActivityModal({ onClose }) {
  const [range, setRange] = useState("30d");
  const [view, setView] = useState("overview");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    getPersonalActivity(range)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const weeks = useMemo(() => buildWeeks(data?.heatmap || []), [data]);
  const maxCount = useMemo(() => Math.max(0, ...(data?.heatmap || []).map((day) => day.count)), [data]);

  const overview = data?.overview || {};

  return createPortal(
    <div className="checkout-backdrop" onClick={onClose}>
      <div className="checkout-dialog personal-activity-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="checkout-close" onClick={onClose}>Close</button>
        <p className="eyebrow">YOUR FOOTPRINT</p>
        <h2>Personal Activity</h2>

        <div className="personal-activity-toolbar">
          <div className="personal-activity-tabs">
            <button type="button" className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>Overview</button>
            <button type="button" className={view === "models" ? "active" : ""} onClick={() => setView("models")}>Models</button>
          </div>
          <div className="personal-activity-range">
            {RANGE_OPTIONS.map((option) => (
              <button key={option.key} type="button" className={range === option.key ? "active" : ""} onClick={() => setRange(option.key)}>{option.label}</button>
            ))}
          </div>
        </div>

        {error ? <div className="empty-state compact">{error}</div> : null}
        {loading && !data ? <div className="empty-state compact">Loading your activity...</div> : null}

        {data && view === "overview" ? (
          <>
            <div className="personal-activity-kpis">
              <article><span>Repositories</span><strong>{overview.repositories ?? 0}</strong></article>
              <article><span>Commits</span><strong>{overview.commits ?? 0}</strong></article>
              <article><span>Cells changed</span><strong>{Number(overview.cells_changed || 0).toLocaleString()}</strong></article>
              <article><span>Total tokens</span><strong>{Number(overview.total_tokens || 0).toLocaleString()}</strong></article>
              <article><span>Active days</span><strong>{overview.active_days ?? 0}</strong></article>
              <article><span>Longest streak</span><strong>{overview.longest_streak ?? 0}<small className="personal-activity-unit">{overview.longest_streak === 1 ? " day" : " days"}</small></strong></article>
              <article><span>Busiest day</span><strong className="personal-activity-favorite">{overview.busiest_day || "—"}</strong></article>
              <article><span>Peak hour</span><strong>{overview.peak_hour || "—"}</strong></article>
            </div>

            <div className="personal-activity-heatmap-wrap">
              {weeks.length ? (
                <div className="personal-activity-heatmap" style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}>
                  {weeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="personal-activity-week">
                      {weekIndex === 0 || monthLabelForWeek(week) !== monthLabelForWeek(weeks[weekIndex - 1]) ? (
                        <span className="personal-activity-month">{monthLabelForWeek(week)}</span>
                      ) : null}
                      {week.map((day, dayIndex) => (
                        <div
                          key={dayIndex}
                          className={`personal-activity-cell level-${day ? intensityClass(day.count, maxCount) : "empty"}`}
                          title={day ? `${day.count} event${day.count === 1 ? "" : "s"} on ${day.date}` : ""}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : <div className="empty-state compact">No activity recorded yet.</div>}
            </div>

            {data.comparison?.message ? <p className="personal-activity-comparison muted">{data.comparison.message}</p> : null}
          </>
        ) : null}

        {data && view === "models" ? (
          <div className="personal-activity-models">
            {data.models.length ? data.models.map((model) => (
              <article key={model.model_id}>
                <div><strong>{model.display_name}</strong><small>{model.requests} request{model.requests === 1 ? "" : "s"}</small></div>
                <div className="personal-activity-model-bar-track"><div className="personal-activity-model-bar-fill" style={{ width: `${Math.round((model.tokens / (data.models[0]?.tokens || 1)) * 100)}%` }} /></div>
                <div className="personal-activity-model-stats">
                  <span>{Number(model.tokens).toLocaleString()} tokens</span>
                  <span>{Math.round(model.success_rate * 100)}% success</span>
                  <span>{model.avg_latency_ms ? `${Math.round(model.avg_latency_ms)}ms avg` : "—"}</span>
                </div>
              </article>
            )) : <div className="empty-state compact">No AI usage in this period yet.</div>}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
