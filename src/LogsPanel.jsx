import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export default function LogsPanel() {
  const [logs, setLogs] = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => {
    invoke("get_logs").then(setLogs).catch(console.error);
    const unlisten = listen("app-log", (e) => {
      setLogs((prev) => [...prev, e.payload]);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Logs</h2>
        <span style={styles.count}>{logs.length} entries</span>
      </div>
      <div style={styles.logList}>
        {logs.length === 0 && (
          <div style={styles.empty}>No logs yet</div>
        )}
        {logs.map((log, i) => (
          <div key={i} style={styles.logEntry}>
            <span style={styles.timestamp}>{log.timestamp}</span>
            <span style={{
              ...styles.level,
              color: log.level === "error" ? "#f87171"
                : log.level === "warn" ? "#facc15"
                : "#4ade80",
            }}>
              {log.level.toUpperCase().padEnd(5)}
            </span>
            <span style={styles.message}>{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#111",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    margin: 0,
  },
  count: {
    fontSize: 12,
    color: "#666",
  },
  logList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 0",
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
    fontSize: 12,
  },
  logEntry: {
    display: "flex",
    gap: 12,
    padding: "4px 20px",
    lineHeight: 1.6,
  },
  timestamp: {
    color: "#666",
    flexShrink: 0,
  },
  level: {
    flexShrink: 0,
    fontWeight: 600,
    width: 44,
  },
  message: {
    color: "#ccc",
    wordBreak: "break-word",
  },
  empty: {
    padding: "24px 20px",
    color: "#555",
    textAlign: "center",
  },
};
