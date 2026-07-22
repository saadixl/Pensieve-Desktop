import { useState } from "react";
import InsightsPanel from "./InsightsPanel.jsx";
import ChatPanel from "./ChatPanel.jsx";

export default function RightPanel({ fileId, viewMode, onLayoutChange }) {
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);

  return (
    <div style={styles.wrapper}>
      {viewMode === "minimized" && onLayoutChange && (
        <div style={styles.layoutBar}>
          <button
            style={styles.layoutBtn}
            onClick={() => onLayoutChange("split")}
            title="Split view"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
          <button
            style={styles.layoutBtn}
            onClick={() => onLayoutChange("maximized")}
            title="Maximize PDF"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
        </div>
      )}

      <div style={{ ...styles.section, flex: insightsOpen ? 1 : "none" }}>
        <div
          style={styles.sectionHeader}
          onClick={() => setInsightsOpen((v) => !v)}
        >
          <span style={styles.chevron}>{insightsOpen ? "▼" : "▶"}</span>
          <span style={styles.sectionTitle}>Insights</span>
        </div>
        {insightsOpen && (
          <div style={styles.sectionBody}>
            <InsightsPanel fileId={fileId} />
          </div>
        )}
      </div>

      <div style={{ ...styles.section, flex: chatOpen ? 1 : "none" }}>
        <div
          style={styles.sectionHeader}
          onClick={() => setChatOpen((v) => !v)}
        >
          <span style={styles.chevron}>{chatOpen ? "▼" : "▶"}</span>
          <span style={styles.sectionTitle}>Chat</span>
        </div>
        {chatOpen && (
          <div style={styles.sectionBody}>
            <ChatPanel fileId={fileId} />
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    borderLeft: "1px solid #2a2a2a",
    background: "#141414",
  },
  layoutBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px",
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  layoutBtn: {
    background: "transparent",
    color: "#888",
    border: "1px solid #444",
    borderRadius: 4,
    width: 26,
    height: 26,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    cursor: "pointer",
    userSelect: "none",
    flexShrink: 0,
  },
  chevron: {
    fontSize: 10,
    color: "#888",
    width: 12,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#ccc",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  sectionBody: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
};
