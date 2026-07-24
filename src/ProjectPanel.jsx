import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";

let streamCounter = 0;

const PROJECT_SUGGESTIONS = [
  "Compare these documents",
  "What are the common themes?",
  "Summarize the key differences",
  "What insights can you draw across all documents?",
];

export default function ProjectPanel({ projectId }) {
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [expandedFile, setExpandedFile] = useState(null);
  const [summaries, setSummaries] = useState({});
  const [summarizing, setSummarizing] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    loadProject();
  }, [projectId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadProject() {
    try {
      const data = await invoke("get_project_files", { projectId });
      setProject(data.project);
      setFiles(data.files);
      for (const f of data.files) {
        loadSummary(f.id);
      }
    } catch (err) {
      console.error("Failed to load project:", err);
    }
  }

  async function loadSummary(fileId) {
    try {
      const insights = await invoke("get_insights", { fileId });
      if (insights.document_summary) {
        setSummaries((prev) => ({ ...prev, [fileId]: insights.document_summary }));
      }
    } catch {}
  }

  async function handleAddFiles() {
    const selected = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (!paths.length) return;

    setUploading(true);
    try {
      const newEntries = await invoke("upload_project_files", { projectId, paths });
      setFiles((prev) => [...prev, ...newEntries]);
      for (const f of newEntries) {
        generateSummary(f.id);
      }
    } catch (err) {
      console.error("Upload failed:", err);
    }
    setUploading(false);
  }

  async function removeFile(fileId, e) {
    e.stopPropagation();
    try {
      await invoke("remove_project_file", { projectId, fileId });
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      if (expandedFile === fileId) setExpandedFile(null);
    } catch {}
  }

  async function generateSummary(fileId) {
    if (summarizing[fileId]) return;
    setSummarizing((prev) => ({ ...prev, [fileId]: true }));

    const streamId = `proj-sum-${++streamCounter}`;
    let accumulated = "";

    const unToken = await listen(`stream-token-${streamId}`, (event) => {
      accumulated += event.payload;
      const snapshot = accumulated;
      setSummaries((prev) => ({ ...prev, [fileId]: snapshot }));
    });

    const done = new Promise((resolve) => {
      listen(`stream-done-${streamId}`, () => resolve()).then();
    });

    try {
      await invoke("summarize_document", { fileId, streamId });
      await done;
    } catch {}

    unToken();
    setSummarizing((prev) => ({ ...prev, [fileId]: false }));
  }

  function summarizeAll() {
    for (const f of files) {
      if (!summaries[f.id] && !summarizing[f.id]) {
        generateSummary(f.id);
      }
    }
  }

  async function send(directText) {
    const text = (directText || input).trim();
    if (!text || streaming) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const userMsg = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);

    const assistantMsg = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    const streamId = `proj-chat-${++streamCounter}`;
    let accumulated = "";
    const unlisteners = [];

    try {
      const unToken = await listen(`stream-token-${streamId}`, (event) => {
        accumulated += event.payload;
        const snapshot = accumulated;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: snapshot };
          return updated;
        });
      });
      unlisteners.push(unToken);

      const done = new Promise((resolve, reject) => {
        listen(`stream-done-${streamId}`, (event) => resolve(event.payload)).then((u) => unlisteners.push(u));
        listen(`stream-error-${streamId}`, (event) => reject(new Error(event.payload))).then((u) => unlisteners.push(u));
      });

      invoke("chat_project", {
        projectId,
        message: text,
        history,
        streamId,
      }).catch((err) => {
        if (!accumulated) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: "assistant", content: `Error: ${err}` };
            return updated;
          });
        }
      });

      await done;
    } catch {
      if (!accumulated) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: "Failed to connect. Is Ollama running?" };
          return updated;
        });
      }
    }

    for (const u of unlisteners) u();
    setStreaming(false);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (!project) return null;

  const hasSummaries = files.some((f) => summaries[f.id]);
  const allSummarized = files.length > 0 && files.every((f) => summaries[f.id]);
  const anySummarizing = Object.values(summarizing).some(Boolean);

  return (
    <div style={s.container}>
      {/* Left: Documents */}
      <div style={s.docsPane}>
        <div style={s.docsHeader}>
          <h2 style={s.projectName}>{project.name}</h2>
          <span style={s.fileCount}>{files.length} document{files.length !== 1 ? "s" : ""}</span>
        </div>

        <div style={s.docsActions}>
          <button style={s.addBtn} onClick={handleAddFiles} disabled={uploading}>
            {uploading ? "Adding..." : "+ Add PDFs"}
          </button>
          {files.length > 0 && !allSummarized && (
            <button style={s.summarizeAllBtn} onClick={summarizeAll} disabled={anySummarizing}>
              {anySummarizing ? "Summarizing..." : "Summarize All"}
            </button>
          )}
        </div>

        <div style={s.docsList}>
          {files.map((f) => {
            const isExpanded = expandedFile === f.id;
            const summary = summaries[f.id];
            const isSummarizing = summarizing[f.id];
            return (
              <div key={f.id} style={s.accordion}>
                <div
                  style={{ ...s.accordionHeader, ...(isExpanded ? s.accordionHeaderActive : {}) }}
                  onClick={() => setExpandedFile(isExpanded ? null : f.id)}
                >
                  <span style={s.accordionArrow}>{isExpanded ? "▾" : "▸"}</span>
                  <div style={s.accordionIcon}>PDF</div>
                  <div style={s.accordionInfo}>
                    <div style={s.accordionName}>{f.name}</div>
                    <div style={s.accordionMeta}>
                      {formatSize(f.size)}
                      {summary && " · Summarized"}
                      {isSummarizing && " · Summarizing..."}
                    </div>
                  </div>
                  <div style={s.accordionRemove} onClick={(e) => removeFile(f.id, e)} title="Remove from project">
                    ×
                  </div>
                </div>
                {isExpanded && (
                  <div style={s.accordionBody}>
                    {summary ? (
                      <div className="md-content" style={s.summaryContent}>
                        <Markdown>{summary}</Markdown>
                      </div>
                    ) : isSummarizing ? (
                      <div style={s.summaryPlaceholder}>Generating summary...</div>
                    ) : (
                      <button style={s.genSummaryBtn} onClick={() => generateSummary(f.id)}>
                        Generate Summary
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {files.length === 0 && (
            <div style={s.emptyDocs}>Add PDFs to this project to get started</div>
          )}
        </div>
      </div>

      {/* Resize divider */}
      <div style={s.divider} />

      {/* Right: Chat */}
      <div style={s.chatPane}>
        <div style={s.chatHeader}>
          <h3 style={s.chatTitle}>Project Chat</h3>
          <span style={s.chatSubtitle}>Ask across all documents</span>
        </div>

        <div style={s.chatMessages}>
          {messages.length === 0 && (
            <div style={s.chatEmpty}>Ask a question about all documents in this project</div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ ...s.msgRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ ...s.bubble, ...(m.role === "user" ? s.userBubble : s.assistantBubble) }}>
                {m.role === "user" ? (
                  m.content
                ) : m.content ? (
                  <div className="md-content"><Markdown>{m.content}</Markdown></div>
                ) : (
                  streaming && i === messages.length - 1 ? "..." : ""
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {messages.length === 0 && files.length > 0 && (
          <div style={s.tagCloud}>
            {PROJECT_SUGGESTIONS.map((q) => (
              <button key={q} style={s.chip} onClick={() => send(q)} disabled={streaming}>
                {q}
              </button>
            ))}
          </div>
        )}

        <div style={s.inputRow}>
          <textarea
            style={s.chatInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={files.length ? "Ask about all documents..." : "Add PDFs first..."}
            rows={1}
            disabled={streaming || files.length === 0}
          />
          <button
            style={{ ...s.sendBtn, opacity: streaming || !input.trim() ? 0.5 : 1 }}
            onClick={() => send()}
            disabled={streaming || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  container: {
    display: "flex",
    height: "100%",
    background: "#111",
  },

  // Left pane - documents
  docsPane: {
    width: "40%",
    minWidth: 300,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid #2a2a2a",
  },
  docsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  projectName: {
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    margin: 0,
  },
  fileCount: {
    fontSize: 12,
    color: "#666",
  },
  docsActions: {
    display: "flex",
    gap: 8,
    padding: "12px 20px",
    flexShrink: 0,
  },
  addBtn: {
    padding: "8px 16px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  summarizeAllBtn: {
    padding: "8px 16px",
    background: "transparent",
    color: "#2563eb",
    border: "1px solid #2563eb",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  docsList: {
    flex: 1,
    overflowY: "auto",
    padding: "0 12px 12px",
  },
  emptyDocs: {
    padding: "40px 20px",
    textAlign: "center",
    color: "#555",
    fontSize: 13,
  },

  // Accordion
  accordion: {
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 4,
  },
  accordionHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    cursor: "pointer",
    borderRadius: 6,
    transition: "background 0.1s",
  },
  accordionHeaderActive: {
    background: "#1a1a1a",
  },
  accordionArrow: {
    fontSize: 11,
    color: "#666",
    width: 14,
    flexShrink: 0,
    textAlign: "center",
  },
  accordionIcon: {
    width: 30,
    height: 30,
    borderRadius: 4,
    background: "#dc2626",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    fontWeight: 700,
    flexShrink: 0,
  },
  accordionInfo: {
    flex: 1,
    minWidth: 0,
  },
  accordionName: {
    fontSize: 13,
    fontWeight: 500,
    color: "#e0e0e0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  accordionMeta: {
    fontSize: 11,
    color: "#666",
    marginTop: 1,
  },
  accordionRemove: {
    fontSize: 16,
    color: "#555",
    cursor: "pointer",
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    flexShrink: 0,
  },
  accordionBody: {
    padding: "4px 12px 12px 54px",
  },
  summaryContent: {
    fontSize: 13,
    color: "#bbb",
    lineHeight: 1.6,
  },
  summaryPlaceholder: {
    fontSize: 13,
    color: "#666",
    fontStyle: "italic",
  },
  genSummaryBtn: {
    padding: "6px 14px",
    background: "transparent",
    color: "#888",
    border: "1px solid #333",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
  },

  // Divider
  divider: {
    width: 1,
    background: "#2a2a2a",
    flexShrink: 0,
  },

  // Right pane - chat
  chatPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  chatHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    padding: "16px 20px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  chatTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#fff",
    margin: 0,
  },
  chatSubtitle: {
    fontSize: 12,
    color: "#666",
  },
  chatMessages: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 12px 4px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  chatEmpty: {
    color: "#555",
    fontSize: 13,
    textAlign: "center",
    marginTop: 40,
  },
  tagCloud: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    padding: "6px 12px",
    borderTop: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  chip: {
    background: "transparent",
    border: "1px solid #333",
    borderRadius: 14,
    color: "#999",
    padding: "4px 10px",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  },
  msgRow: {
    display: "flex",
  },
  bubble: {
    maxWidth: "85%",
    padding: "8px 12px",
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  userBubble: {
    background: "#2563eb",
    color: "#fff",
    borderBottomRightRadius: 2,
    whiteSpace: "pre-wrap",
  },
  assistantBubble: {
    background: "#252525",
    color: "#ddd",
    borderBottomLeftRadius: 2,
  },
  inputRow: {
    display: "flex",
    gap: 8,
    padding: "8px 12px",
    borderTop: "1px solid #2a2a2a",
    background: "#1a1a1a",
    flexShrink: 0,
  },
  chatInput: {
    flex: 1,
    background: "#252525",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#e0e0e0",
    padding: "8px 12px",
    fontSize: 13,
    resize: "none",
    fontFamily: "inherit",
    outline: "none",
  },
  sendBtn: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    flexShrink: 0,
  },
};
