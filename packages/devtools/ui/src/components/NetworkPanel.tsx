import { useState } from "react";
import type { ClientInfo, GatewaySessionInfo, RequestInfo } from "../hooks/useDevToolsEvents.js";
import { formatDuration } from "../utils/format.js";

type NetworkTab = "connections" | "sessions" | "requests";

interface NetworkPanelProps {
  clients: ClientInfo[];
  gatewaySessions: GatewaySessionInfo[];
  requests: RequestInfo[];
}

export function NetworkPanel({ clients, gatewaySessions, requests }: NetworkPanelProps) {
  const [activeTab, setActiveTab] = useState<NetworkTab>("connections");

  return (
    <div className="network-panel">
      {/* Sub-tabs */}
      <div className="network-tabs">
        <button
          className={`network-tab ${activeTab === "connections" ? "active" : ""}`}
          onClick={() => setActiveTab("connections")}
        >
          Connections ({clients.length})
        </button>
        <button
          className={`network-tab ${activeTab === "sessions" ? "active" : ""}`}
          onClick={() => setActiveTab("sessions")}
        >
          Sessions ({gatewaySessions.length})
        </button>
        <button
          className={`network-tab ${activeTab === "requests" ? "active" : ""}`}
          onClick={() => setActiveTab("requests")}
        >
          Requests ({requests.length})
        </button>
      </div>

      {/* Content */}
      <div className="network-content">
        {activeTab === "connections" && <ConnectionsView clients={clients} />}
        {activeTab === "sessions" && <SessionsView sessions={gatewaySessions} />}
        {activeTab === "requests" && <RequestsView requests={requests} />}
      </div>
    </div>
  );
}

function ConnectionsView({ clients }: { clients: ClientInfo[] }) {
  if (clients.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔌</div>
        <div className="empty-state-title">No active connections</div>
        <div className="empty-state-text">
          Client connections will appear here when clients connect to the gateway
        </div>
      </div>
    );
  }

  return (
    <div className="network-list">
      {clients.map((client) => {
        const duration = Date.now() - client.connectedAt;
        return (
          <div key={client.id} className="network-item">
            <div className="network-item-header">
              <span className={`network-transport ${client.transport}`}>{client.transport}</span>
              <span className="network-item-id">{client.id.slice(0, 12)}...</span>
              <span className="network-item-duration">{formatDuration(duration)}</span>
            </div>
            {client.ip && (
              <div className="network-item-detail">
                <span className="network-detail-label">IP:</span> {client.ip}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SessionsView({ sessions }: { sessions: GatewaySessionInfo[] }) {
  if (sessions.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📋</div>
        <div className="empty-state-title">No gateway sessions</div>
        <div className="empty-state-text">
          Gateway sessions will appear here when sessions are created
        </div>
      </div>
    );
  }

  return (
    <div className="network-list">
      {sessions.map((session) => {
        const duration = Date.now() - session.createdAt;
        return (
          <div key={session.id} className="network-item">
            <div className="network-item-header">
              <span className="network-app-id">{session.appId}</span>
              <span className="network-item-id">{session.id.slice(0, 12)}...</span>
              <span className="network-item-duration">{formatDuration(duration)}</span>
            </div>
            <div className="network-item-detail">
              <span className="network-detail-label">Messages:</span> {session.messageCount}
              {session.clientId && (
                <>
                  {" "}
                  <span className="network-detail-label">Client:</span>{" "}
                  {session.clientId.slice(0, 8)}...
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RequestsView({ requests }: { requests: RequestInfo[] }) {
  if (requests.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📡</div>
        <div className="empty-state-title">No requests</div>
        <div className="empty-state-text">Gateway requests will appear here</div>
      </div>
    );
  }

  // Show most recent first
  const sortedRequests = [...requests].reverse();

  return (
    <div className="network-list">
      {sortedRequests.map((request) => (
        <div key={request.id} className="network-item">
          <div className="network-item-header">
            <span
              className={`network-status ${request.ok === undefined ? "pending" : request.ok ? "success" : "error"}`}
            >
              {request.ok === undefined ? "⏳" : request.ok ? "✓" : "✗"}
            </span>
            <span className="network-method">{request.method}</span>
            {request.latencyMs !== undefined && (
              <span className="network-latency">{request.latencyMs}ms</span>
            )}
            <span className="network-item-id">{request.id.slice(0, 8)}...</span>
          </div>
          {request.error && <div className="network-error">{request.error}</div>}
          {request.params && Object.keys(request.params).length > 0 && (
            <div className="network-item-detail">
              <pre className="network-params">{JSON.stringify(request.params, null, 2)}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
