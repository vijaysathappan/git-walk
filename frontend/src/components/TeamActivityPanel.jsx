import React, { useCallback, useEffect, useState } from "react";
import {
  blockRepositoryDevice,
  getRepositoryActivity,
  getRepositoryDevices,
  trustRepositoryDevice,
} from "../services/api";
import TeamActivityMatrix from "./TeamActivityMatrix";
import RepositoryAccessTree from "./RepositoryAccessTree";

function timeAgo(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Live view of who has this repository open, their RBAC role, device/IP,
 * and activity recency — visible to every member with access. Backed by
 * GET /repositories/{table_id}/activity (any-access, since this session's
 * 14F change) and /devices (still owner-only — a 403/404 there just means
 * the viewer isn't the owner, and the devices panel/trust controls are
 * hidden rather than gating the whole view).
 */
export default function TeamActivityPanel({ tableId, repositoryName, isOwner, onError }) {
  const [activity, setActivity] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyFingerprintId, setBusyFingerprintId] = useState(null);
  const [notAllowed, setNotAllowed] = useState(false);
  const [devicesAllowed, setDevicesAllowed] = useState(true);
  const [selectedMember, setSelectedMember] = useState(null);

  const load = useCallback(async () => {
    if (!tableId) return;
    setLoading(true); setNotAllowed(false);
    try {
      const activityResult = await getRepositoryActivity(tableId);
      setActivity(activityResult.activity || []);
    } catch (err) {
      if (err.status === 403 || err.status === 404) setNotAllowed(true);
      else onError?.(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const devicesResult = await getRepositoryDevices(tableId);
      setDevices(devicesResult.devices || []);
      setDevicesAllowed(true);
    } catch (err) {
      if (err.status === 403 || err.status === 404) setDevicesAllowed(false);
      else onError?.(err.message);
    }
  }, [tableId, onError]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!tableId) return undefined;
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, [tableId, load]);

  const setDeviceTrust = async (fingerprintId, action) => {
    setBusyFingerprintId(fingerprintId);
    try {
      if (action === "block") await blockRepositoryDevice(tableId, fingerprintId);
      else await trustRepositoryDevice(tableId, fingerprintId);
      await load();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusyFingerprintId(null);
    }
  };

  if (notAllowed) {
    return (
      <section className="panel">
        <div className="panel-header"><div><p className="eyebrow">TEAM / LIVE ACTIVITY</p><h2>Team activity</h2><p className="muted">Only the repository owner can view this.</p></div></div>
      </section>
    );
  }

  const onlineCount = activity.filter((item) => item.status === "ONLINE").length;
  const needHelpCount = activity.filter((item) => item.status === "NEED_HELP").length;
  const blockedDeviceCount = devices.filter((item) => item.trust_status === "BLOCKED").length;
  const showDevices = isOwner && devicesAllowed;

  const rank = (item) => (item.status === "NEED_HELP" ? 2 : item.status === "ONLINE" ? 1 : 0);
  const topPerformers = [...activity]
    .sort((a, b) => rank(b) - rank(a) || (b.hours_active_today || 0) - (a.hours_active_today || 0))
    .slice(0, 5);

  return (
    <div className="history-stage">
      <section className="kpi-grid team-kpi-grid">
        <article className="kpi-card tone-green"><span>Online now</span><strong>{onlineCount}</strong><small>Excel taskpane open right now</small></article>
        <article className={`kpi-card tone-amber ${needHelpCount ? "kpi-card-pulse" : ""}`}><span>Need help</span><strong>{needHelpCount}</strong><small>Flagged for owner attention</small></article>
        <article className="kpi-card tone-ink"><span>Team members</span><strong>{activity.length}</strong><small>With access to this repository</small></article>
        {showDevices ? (
          <article className="kpi-card tone-red"><span>Devices blocked</span><strong>{blockedDeviceCount}</strong><small>Of {devices.length} known device(s)</small></article>
        ) : null}
      </section>

      <section className="panel team-activity-hero">
        <div className="panel-header">
          <div><p className="eyebrow">TEAM / LIVE ACTIVITY</p><h2>Top 5 performers</h2><p className="muted">Ranked by live status and active time today — automatic Online/Offline from the Excel taskpane, Need Help set manually there.</p></div>
          <span className="pill">{onlineCount} online &middot; {needHelpCount} need help</span>
        </div>
        <TeamActivityMatrix activity={topPerformers} onSelect={setSelectedMember} />
        {!activity.length && !loading ? <div className="empty-state compact">No members with access to this repository yet.</div> : null}
        {activity.length > 5 ? <p className="muted team-roster-footnote">Showing top 5 of {activity.length} members. Full roster in the access tree below.</p> : null}
        {selectedMember ? <div className="team-member-detail"><button className="secondary-button" onClick={() => setSelectedMember(null)}>Close</button><strong>{selectedMember.display_name || selectedMember.email}</strong><span>{selectedMember.role}</span><small>{selectedMember.status === "ONLINE" ? "Online in Excel now" : selectedMember.status === "NEED_HELP" ? "Needs help right now" : `Last seen ${timeAgo(selectedMember.last_seen_at)}`}</small>{selectedMember.hours_active_today != null ? <small>{selectedMember.hours_active_today}h active today</small> : null}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">RBAC / REPOSITORY ACCESS</p><h2>Access tree</h2><p className="muted">Who's onboarded to this repository, their role, and their access. Click a person for their full status, hours, and device controls.</p></div>
        </div>
        <RepositoryAccessTree
          tableId={tableId}
          repositoryName={repositoryName}
          isOwner={isOwner}
          onError={onError}
          activity={activity}
          devices={devices}
          busyFingerprintId={busyFingerprintId}
          onSetDeviceTrust={setDeviceTrust}
        />
      </section>

      {showDevices ? (
      <section className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">DEVICES / DATA PROTECTION</p><h2>Known devices</h2><p className="muted">Block a device to immediately cut off its access to this repository's data — independent of the user's login credentials.</p></div>
          <span className="pill">{devices.length} device(s)</span>
        </div>
        <div className="team-table-wrap">
          <table className="team-table">
            <colgroup>
              <col style={{ width: "20%" }} /><col style={{ width: "16%" }} /><col style={{ width: "26%" }} />
              <col style={{ width: "13%" }} /><col style={{ width: "13%" }} /><col style={{ width: "12%" }} />
            </colgroup>
            <thead><tr><th>User</th><th>IP address</th><th>Machine</th><th>Trust</th><th>Last seen</th><th>Action</th></tr></thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.fingerprint_id}>
                  <td><strong>{device.display_name || device.email}</strong></td>
                  <td><code>{device.ip_address || "unknown"}</code></td>
                  <td><small className="team-machine-id" title={device.machine_id}>{device.machine_id}</small></td>
                  <td><span className={`pill device-trust-${device.trust_status?.toLowerCase()}`}>{device.trust_status}</span></td>
                  <td>{timeAgo(device.last_seen_at)}</td>
                  <td>
                    {device.trust_status !== "BLOCKED" ? (
                      <button className="trace-button" disabled={busyFingerprintId === device.fingerprint_id} onClick={() => setDeviceTrust(device.fingerprint_id, "block")}>Block</button>
                    ) : (
                      <button className="trace-button" disabled={busyFingerprintId === device.fingerprint_id} onClick={() => setDeviceTrust(device.fingerprint_id, "trust")}>Trust</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!devices.length && !loading ? <div className="empty-state compact">No devices have connected to this repository yet.</div> : null}
      </section>
      ) : null}
    </div>
  );
}
