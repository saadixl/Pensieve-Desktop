import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import PdfViewer from "./PdfViewer";

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
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [summaries, setSummaries] = useState({});
  const [summarizing, setSummarizing] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [layoutMode, setLayoutMode] = useState("split");
  const [splitPercent, setSplitPercent] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const bottomRef = useRef(null);
  const splitRef = useRef(null);

  const onMouseMove = useCallback((e) => {
    if (!splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.min(80, Math.max(20, pct)));
  }, []);

  const onMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onMouseMove, onMouseUp]);

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
      setExpandedFiles((prev) => { const next = new Set(prev); next.delete(fileId); return next; });
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
    <div ref={splitRef} style={s.container}>
      {/* Left pane */}
      {layoutMode !== "minimized" && (
        <div style={{ ...s.docsPane, width: layoutMode === "maximized" ? "100%" : `${splitPercent}%` }}>
          <div style={s.docsHeader}>
            <h2 style={s.projectName}>{project.name}</h2>
            <div style={s.headerRight}>
              <span style={s.fileCount}>{files.length} document{files.length !== 1 ? "s" : ""}</span>
              <div style={s.layoutGroup}>
                <button
                  style={{ ...s.layoutBtn, ...(layoutMode === "minimized" ? s.layoutBtnActive : {}) }}
                  onClick={() => setLayoutMode("minimized")}
                  title="Hide documents"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor" />
                  </svg>
                </button>
                <button
                  style={{ ...s.layoutBtn, ...(layoutMode === "split" ? s.layoutBtnActive : {}) }}
                  onClick={() => setLayoutMode("split")}
                  title="Split view"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                    <rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </button>
                <button
                  style={{ ...s.layoutBtn, ...(layoutMode === "maximized" ? s.layoutBtnActive : {}) }}
                  onClick={() => setLayoutMode("maximized")}
                  title="Maximize documents"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div style={s.docsActions}>
            <button style={s.addBtn} onClick={handleAddFiles} disabled={uploading}>
              {uploading ? "Adding..." : "+ Add PDFs"}
            </button>
          </div>

          <div style={s.docsList}>
            {files.map((f) => {
              const isExpanded = expandedFiles.has(f.id);
              return (
                <div key={f.id} style={s.accordion}>
                  <div
                    style={{ ...s.accordionHeader, ...(isExpanded ? s.accordionHeaderActive : {}) }}
                    onClick={() => setExpandedFiles((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                      return next;
                    })}
                  >
                    <span style={s.accordionArrow}>{isExpanded ? "▾" : "▸"}</span>
                    <div style={s.accordionIcon}>PDF</div>
                    <div style={s.accordionInfo}>
                      <div style={s.accordionName} title={f.name}>{f.name}</div>
                      <div style={s.accordionMeta}>{formatSize(f.size)}</div>
                    </div>
                    <div style={s.accordionRemove} onClick={(e) => removeFile(f.id, e)} title="Remove from project">
                      ×
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={s.pdfBody}>
                      <PdfViewer fileId={f.id} />
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
      )}

      {layoutMode === "split" && (
        <div style={s.resizeHandle} onMouseDown={() => setDragging(true)}>
          <div style={s.resizeGrip} />
        </div>
      )}

      {/* Right pane - matching single-file RightPanel */}
      {layoutMode !== "maximized" && (
        <div style={{ ...s.rightPane, width: layoutMode === "minimized" ? "100%" : `calc(${100 - splitPercent}% - 6px)` }}>
        {/* Insights section */}
        {layoutMode === "minimized" && (
          <div style={s.layoutBar}>
            <button style={s.layoutBtn} onClick={() => setLayoutMode("split")} title="Split view">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
            <button style={s.layoutBtn} onClick={() => setLayoutMode("maximized")} title="Maximize documents">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          </div>
        )}

        <div style={{ ...s.section, flex: insightsOpen ? 1 : "none" }}>
          <div style={s.sectionHeader} onClick={() => setInsightsOpen((v) => !v)}>
            <span style={s.chevron}>{insightsOpen ? "▼" : "▶"}</span>
            <span style={s.sectionTitle}>Insights</span>
          </div>
          {insightsOpen && (
            <div style={s.sectionBody}>
              <div style={s.insightsScroll}>
                {files.length > 0 && !allSummarized && (
                  <div style={s.insightsActions}>
                    <button style={s.summarizeAllBtn} onClick={summarizeAll} disabled={anySummarizing}>
                      {anySummarizing ? "Summarizing..." : "Summarize All"}
                    </button>
                  </div>
                )}
                {files.map((f) => {
                  const summary = summaries[f.id];
                  const isSummarizing = summarizing[f.id];
                  return (
                    <div key={f.id} style={s.insightBlock}>
                      <div style={s.insightLabel} title={f.name}>{f.name}</div>
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
                  );
                })}
                {files.length === 0 && (
                  <div style={s.emptyDocs}>Add documents first to generate insights</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Chat section */}
        <div style={{ ...s.section, flex: chatOpen ? 1 : "none" }}>
          <div style={s.sectionHeader} onClick={() => setChatOpen((v) => !v)}>
            <span style={s.chevron}>{chatOpen ? "▼" : "▶"}</span>
            <span style={s.sectionTitle}>Chat</span>
          </div>
          {chatOpen && (
            <div style={s.sectionBody}>
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
          )}
        </div>
      </div>
      )}
    </div>
  );
}

const s = {
  container: {
    display: "flex",
    height: "100%",
    background: "#111",
  },

  // Left pane
  docsPane: {
    height: "100%",
    overflow: "hidden",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
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
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  layoutGroup: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  layoutBtn: {
    background: "transparent",
    color: "#888",
    border: "1px solid transparent",
    borderRadius: 4,
    width: 26,
    height: 26,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  layoutBtnActive: {
    color: "#fff",
    background: "#333",
    borderColor: "#555",
  },
  resizeHandle: {
    width: 6,
    cursor: "col-resize",
    background: "#2a2a2a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.15s",
  },
  resizeGrip: {
    width: 2,
    height: 32,
    borderRadius: 1,
    background: "#555",
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
  pdfBody: {
    height: "70vh",
    borderTop: "1px solid #2a2a2a",
    borderBottom: "1px solid #2a2a2a",
    marginBottom: 4,
  },
  // Right pane - matching RightPanel
  layoutBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px",
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  rightPane: {
    height: "100%",
    overflow: "hidden",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: "#141414",
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

  // Insights section content
  insightsScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 14px",
  },
  insightsActions: {
    marginBottom: 12,
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
  insightBlock: {
    marginBottom: 12,
  },
  insightLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: 8,
  },
  summaryContent: {
    fontSize: 13,
    color: "#ccc",
    lineHeight: 1.6,
    wordBreak: "break-word",
  },
  summaryPlaceholder: {
    fontSize: 12,
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
  insightDivider: {
    height: 1,
    background: "#2a2a2a",
    margin: "12px 0",
  },

  // Chat section content
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
