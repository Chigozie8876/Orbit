"use client";

import React, { useMemo, useState } from "react";

// ─────────────────────────────── Types ────────────────────────────────────

export const ROLES = ["owner", "admin", "developer", "accountant"];

export const ROLE_PERMISSIONS = {
  owner: ["billing", "treasury", "plans", "subscribers", "payroll_approve", "api_keys", "webhooks", "transactions", "exports", "team"],
  admin: ["plans", "subscribers", "payroll_approve", "api_keys", "webhooks", "transactions", "exports", "team"],
  developer: ["api_keys", "webhooks"],
  accountant: ["transactions", "exports"],
};

export const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  developer: "Developer",
  accountant: "Accountant",
};

export const ROLE_DESCRIPTIONS = {
  owner: "Full access including billing and treasury transfers",
  admin: "Create plans, manage subscribers, approve payroll",
  developer: "Manage API keys and webhook settings",
  accountant: "Read-only access to transactions, receipts, and exports",
};

export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

// ─────────────────────── Invite Member Modal ──────────────────────────────

function InviteModal({ onInvite, onClose }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("developer");
  const [error, setError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      setError("Enter a valid email address.");
      return;
    }
    onInvite({ email, role });
    onClose();
  }

  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Invite team member">
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>Invite Team Member</h3>
          <button onClick={onClose} style={S.iconBtn} aria-label="Close" type="button">✕</button>
        </div>

        <form onSubmit={handleSubmit} style={S.form}>
          <label style={S.label}>
            Email address
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="teammate@company.com"
              style={S.input}
              required
            />
          </label>

          <label style={S.label}>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)} style={S.select}>
              {ROLES.filter((r) => r !== "owner").map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]} — {ROLE_DESCRIPTIONS[r]}</option>
              ))}
            </select>
          </label>

          {error && <p style={S.errorText}>{error}</p>}

          <div style={S.formActions}>
            <button type="button" onClick={onClose} style={{ ...S.btn, ...S.btnSecondary }}>Cancel</button>
            <button type="submit" style={{ ...S.btn, ...S.btnPrimary }}>Send Invite</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────── Audit Log Table ─────────────────────────────────

const EVENT_CATEGORIES = ["all", "api_key", "payroll", "plan", "subscriber", "team", "webhook"];

function AuditLog({ events }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (category !== "all" && ev.category !== category) return false;
      if (search && !ev.description.toLowerCase().includes(search.toLowerCase()) && !ev.actor.toLowerCase().includes(search.toLowerCase())) return false;
      if (dateFrom && new Date(ev.timestamp) < new Date(dateFrom)) return false;
      if (dateTo && new Date(ev.timestamp) > new Date(dateTo + "T23:59:59")) return false;
      return true;
    });
  }, [events, search, category, dateFrom, dateTo]);

  return (
    <section style={S.section}>
      <h3 style={S.sectionTitle}>Audit Activity Log</h3>

      {/* Filters */}
      <div style={S.filterRow}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events or actors…"
          style={{ ...S.input, flex: 2, minWidth: 160 }}
          aria-label="Search audit log"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...S.select, flex: 1, minWidth: 130 }} aria-label="Filter by category">
          {EVENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c === "all" ? "All categories" : c.replace("_", " ")}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...S.input, flex: 1 }} aria-label="From date" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...S.input, flex: 1 }} aria-label="To date" />
      </div>

      {/* Table */}
      <div style={S.tableWrapper} role="region" aria-label="Audit log">
        <table style={S.table}>
          <thead>
            <tr>
              {["Timestamp", "Actor", "IP", "Event"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={4} style={S.emptyCell}>No matching events</td></tr>
            ) : (
              filtered.map((ev) => (
                <tr key={ev.id} style={S.tr}>
                  <td style={S.td}><time dateTime={ev.timestamp}>{new Date(ev.timestamp).toLocaleString()}</time></td>
                  <td style={S.td}><span style={S.actorBadge}>{ev.actor}</span></td>
                  <td style={S.td}><code style={S.code}>{ev.ip}</code></td>
                  <td style={S.td}>{ev.description}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p style={S.hint}>{filtered.length} of {events.length} events shown</p>
    </section>
  );
}

// ─────────────────────── Team Member Row ─────────────────────────────────

function MemberRow({ member, activeRole, onRoleChange, onRevoke }) {
  const canEdit = hasPermission(activeRole, "team") && member.role !== "owner";

  return (
    <div style={S.memberRow}>
      <div style={S.memberInfo}>
        <div style={S.avatar} aria-hidden="true">{member.email[0].toUpperCase()}</div>
        <div>
          <p style={S.memberEmail}>{member.email}</p>
          <span style={{ ...S.roleBadge, ...roleColor(member.role) }}>{ROLE_LABELS[member.role]}</span>
        </div>
      </div>

      <div style={S.memberActions}>
        {canEdit ? (
          <>
            <select
              value={member.role}
              onChange={(e) => onRoleChange(member.id, e.target.value)}
              style={{ ...S.select, padding: "4px 8px", fontSize: 12 }}
              aria-label={`Change role for ${member.email}`}
            >
              {ROLES.filter((r) => r !== "owner").map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <button
              onClick={() => onRevoke(member.id)}
              style={{ ...S.btn, ...S.btnDanger, padding: "5px 10px", fontSize: 12 }}
              type="button"
              aria-label={`Revoke access for ${member.email}`}
            >
              Revoke
            </button>
          </>
        ) : (
          <span style={S.hintText}>{member.role === "owner" ? "Owner" : "No edit permission"}</span>
        )}
      </div>
    </div>
  );
}

function roleColor(role) {
  if (role === "owner") return { background: "#1e1b4b", color: "#a5b4fc" };
  if (role === "admin") return { background: "#172554", color: "#93c5fd" };
  if (role === "developer") return { background: "#052e16", color: "#6ee7b7" };
  return { background: "#1c1917", color: "#d6d3d1" };
}

// ─────────────────────── Main Component ──────────────────────────────────

/**
 * TeamManager
 *
 * Props:
 *   activeRole   {string}             role of the currently signed-in user
 *   members      {Array<{id, email, role}>}
 *   auditEvents  {Array<{id, timestamp, actor, ip, category, description}>}
 *   onInvite     {function({ email, role })}
 *   onRoleChange {function(memberId, newRole)}
 *   onRevoke     {function(memberId)}
 */
export function TeamManager({
  activeRole = "owner",
  members = [],
  auditEvents = [],
  onInvite,
  onRoleChange,
  onRevoke,
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [tab, setTab] = useState("members"); // members | audit

  const canInvite = hasPermission(activeRole, "team");

  return (
    <div style={S.container}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>Team & Access</h2>
          <p style={S.pageSubtitle}>Manage roles and review activity across your organization</p>
        </div>
        {canInvite && (
          <button onClick={() => setShowInvite(true)} style={{ ...S.btn, ...S.btnPrimary }} type="button">
            + Invite Member
          </button>
        )}
      </div>

      {/* Tab nav */}
      <div style={S.tabs} role="tablist">
        {["members", "audit"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}
            type="button"
          >
            {t === "members" ? `Team Members (${members.length})` : "Audit Log"}
          </button>
        ))}
      </div>

      {tab === "members" && (
        <section style={S.section}>
          {members.length === 0 ? (
            <p style={S.emptyState}>No team members yet. Invite someone to get started.</p>
          ) : (
            members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                activeRole={activeRole}
                onRoleChange={onRoleChange}
                onRevoke={onRevoke}
              />
            ))
          )}
        </section>
      )}

      {tab === "audit" && <AuditLog events={auditEvents} />}

      {showInvite && (
        <InviteModal
          onInvite={onInvite}
          onClose={() => setShowInvite(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────── Styles ───────────────────────────────────────────

const S = {
  container: { maxWidth: 860, margin: "0 auto", padding: "0 0 40px", fontFamily: "system-ui, sans-serif", color: "#e2e8f0" },
  pageHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  pageTitle: { margin: 0, fontSize: 22, fontWeight: 700, color: "#fff" },
  pageSubtitle: { margin: "4px 0 0", fontSize: 13, color: "#64748b" },
  tabs: { display: "flex", gap: 4, borderBottom: "1px solid #1e293b", marginBottom: 20 },
  tab: { padding: "8px 16px", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14, fontWeight: 500, borderBottom: "2px solid transparent", marginBottom: -1 },
  tabActive: { color: "#3B82F6", borderBottomColor: "#3B82F6" },
  section: { display: "flex", flexDirection: "column", gap: 2 },
  sectionTitle: { margin: "0 0 12px", fontSize: 15, fontWeight: 600, color: "#cbd5e1" },
  memberRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#0f1117", border: "1px solid #1e293b", borderRadius: 10, marginBottom: 6, flexWrap: "wrap", gap: 10 },
  memberInfo: { display: "flex", alignItems: "center", gap: 12 },
  avatar: { width: 36, height: 36, borderRadius: "50%", background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontWeight: 700, fontSize: 15 },
  memberEmail: { margin: 0, fontSize: 14, fontWeight: 500, color: "#e2e8f0" },
  roleBadge: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, marginTop: 3 },
  memberActions: { display: "flex", alignItems: "center", gap: 8 },
  hintText: { fontSize: 12, color: "#475569" },
  emptyState: { color: "#64748b", fontSize: 14, textAlign: "center", padding: "32px 0" },
  filterRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  tableWrapper: { overflowX: "auto", borderRadius: 8, border: "1px solid #1e293b" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px 14px", color: "#64748b", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", background: "#0f1117", borderBottom: "1px solid #1e293b" },
  tr: { borderBottom: "1px solid #0f1117" },
  td: { padding: "10px 14px", color: "#cbd5e1", verticalAlign: "top" },
  emptyCell: { padding: "24px", textAlign: "center", color: "#475569" },
  hint: { margin: "8px 0 0", fontSize: 12, color: "#475569" },
  actorBadge: { fontFamily: "monospace", fontSize: 12, color: "#93c5fd" },
  code: { fontFamily: "monospace", fontSize: 12, color: "#64748b" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 },
  modal: { background: "#1a1f2e", border: "1px solid #2d3748", borderRadius: 16, padding: "24px 20px", width: "100%", maxWidth: 440 },
  modalHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  modalTitle: { margin: 0, fontSize: 17, fontWeight: 700, color: "#fff" },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, color: "#94a3b8", fontWeight: 500 },
  input: { background: "#0f1117", border: "1px solid #2d3748", borderRadius: 7, padding: "9px 12px", color: "#e2e8f0", fontSize: 14, outline: "none" },
  select: { background: "#0f1117", border: "1px solid #2d3748", borderRadius: 7, padding: "9px 12px", color: "#e2e8f0", fontSize: 13 },
  formActions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  btn: { padding: "9px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  btnPrimary: { background: "#3B82F6", color: "#fff" },
  btnSecondary: { background: "#1e293b", color: "#cbd5e1", border: "1px solid #334155" },
  btnDanger: { background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d" },
  iconBtn: { background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 18, padding: 4 },
  errorText: { margin: 0, fontSize: 12, color: "#f87171" },
};

export default TeamManager;
