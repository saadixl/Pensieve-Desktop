import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";

let streamCounter = 0;

export default function InsightsPanel({ fileId }) {
  const [docSummary, setDocSummary] = useState(null);
  const [convSummary, setConvSummary] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    setDocSummary(null);
    setConvSummary(null);
    loadInsights();
  }, [fileId]);

  async function loadInsights() {
    try {
      const data = await invoke("get_insights", { fileId });
      if (data.document_summary) setDocSummary(data.document_summary);
      else generateDocSummary();
      if (data.conversation_summary) setConvSummary(data.conversation_summary);
    } catch {
      generateDocSummary();
    }
  }

  async function generateDocSummary() {
    setDocLoading(true);
    setDocSummary("");
    const streamId = `doc-${++streamCounter}`;
    const unlisteners = [];

    try {
      const unToken = await listen(`stream-token-${streamId}`, (event) => {
        setDocSummary((prev) => (prev || "") + event.payload);
      });
      unlisteners.push(unToken);

      const done = new Promise((resolve, reject) => {
        listen(`stream-done-${streamId}`, () => resolve()).then((u) =>
          unlisteners.push(u),
        );
        listen(`stream-error-${streamId}`, (event) =>
          reject(new Error(event.payload)),
        ).then((u) => unlisteners.push(u));
      });

      invoke("summarize_document", { fileId, streamId }).catch(() => {});
      await done;
    } catch {
      setDocSummary("Failed to connect. Is Ollama running?");
    }

    for (const u of unlisteners) u();
    setDocLoading(false);
  }

  useEffect(() => {
    function handleConvUpdate(e) {
      if (e.detail.fileId !== fileId) return;
      generateConvSummary(e.detail.history);
    }
    window.addEventListener("pensieve:conv-update", handleConvUpdate);
    return () =>
      window.removeEventListener("pensieve:conv-update", handleConvUpdate);
  }, [fileId]);

  async function generateConvSummary(history) {
    if (!history || history.length < 2) return;
    setConvLoading(true);
    setConvSummary("");
    const streamId = `conv-${++streamCounter}`;
    const unlisteners = [];

    try {
      const unToken = await listen(`stream-token-${streamId}`, (event) => {
        setConvSummary((prev) => (prev || "") + event.payload);
      });
      unlisteners.push(unToken);

      const done = new Promise((resolve, reject) => {
        listen(`stream-done-${streamId}`, () => resolve()).then((u) =>
          unlisteners.push(u),
        );
        listen(`stream-error-${streamId}`, (event) =>
          reject(new Error(event.payload)),
        ).then((u) => unlisteners.push(u));
      });

      invoke("summarize_conversation", { fileId, history, streamId }).catch(
        () => {},
      );
      await done;
    } catch {
      setConvSummary("Failed to generate summary.");
    }

    for (const u of unlisteners) u();
    setConvLoading(false);
  }

  return (
    <div ref={scrollRef} style={styles.wrapper}>
      <div style={styles.block}>
        <div style={styles.label}>Document Summary</div>
        {docSummary ? (
          <div className="md-content" style={styles.markdown}>
            <Markdown>{docSummary}</Markdown>
          </div>
        ) : docLoading ? (
          <div style={styles.loading}>Generating summary...</div>
        ) : (
          <div style={styles.empty}>No summary yet</div>
        )}
      </div>

      <div style={styles.divider} />

      <div style={styles.block}>
        <div style={styles.label}>Conversation Summary</div>
        {convSummary ? (
          <div className="md-content" style={styles.markdown}>
            <Markdown>{convSummary}</Markdown>
          </div>
        ) : convLoading ? (
          <div style={styles.loading}>Summarizing conversation...</div>
        ) : (
          <div style={styles.empty}>
            Chat about the document to see a summary here
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 14px",
  },
  block: {
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: 8,
  },
  markdown: {
    fontSize: 13,
    lineHeight: 1.6,
    color: "#ccc",
    wordBreak: "break-word",
  },
  loading: {
    fontSize: 12,
    color: "#666",
    fontStyle: "italic",
  },
  empty: {
    fontSize: 12,
    color: "#555",
  },
  divider: {
    height: 1,
    background: "#2a2a2a",
    margin: "12px 0",
  },
};
