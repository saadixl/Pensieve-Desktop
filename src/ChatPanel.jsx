import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";

const SUGGESTIONS = [
  "What is this document about?",
  "What are the key takeaways?",
  "List the main topics covered",
  "Are there any action items or recommendations?",
  "Explain the conclusion",
  "What data or evidence is presented?",
];

let streamCounter = 0;

export default function ChatPanel({ fileId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    setMessages([]);
    setInput("");
  }, [fileId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function notifyInsights(allMessages) {
    window.dispatchEvent(
      new CustomEvent("pensieve:conv-update", {
        detail: { fileId, history: allMessages },
      }),
    );
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

    const streamId = `chat-${++streamCounter}`;
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
        listen(`stream-done-${streamId}`, (event) => {
          resolve(event.payload);
        }).then((u) => unlisteners.push(u));
        listen(`stream-error-${streamId}`, (event) => {
          reject(new Error(event.payload));
        }).then((u) => unlisteners.push(u));
      });

      invoke("chat", {
        fileId,
        message: text,
        history,
        streamId,
      }).catch((err) => {
        if (!accumulated) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `Error: ${err}`,
            };
            return updated;
          });
        }
      });

      await done;

      const finalMessages = [
        ...history,
        userMsg,
        { role: "assistant", content: accumulated },
      ];
      notifyInsights(finalMessages);
    } catch (err) {
      if (!accumulated) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Failed to connect. Is Ollama running?",
          };
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

  return (
    <div style={styles.wrapper}>
      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.emptyHint}>Ask a question about this PDF</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.msgRow,
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                ...styles.bubble,
                ...(m.role === "user" ? styles.userBubble : styles.assistantBubble),
              }}
            >
              {m.role === "user" ? (
                m.content
              ) : m.content ? (
                <div className="md-content">
                  <Markdown>{m.content}</Markdown>
                </div>
              ) : (
                streaming && i === messages.length - 1 ? "..." : ""
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {messages.length === 0 && (
        <div style={styles.tagCloud}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              style={styles.chip}
              onClick={() => send(s)}
              disabled={streaming}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div style={styles.inputRow}>
        <textarea
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this PDF..."
          rows={1}
          disabled={streaming}
        />
        <button
          style={{
            ...styles.sendBtn,
            opacity: streaming || !input.trim() ? 0.5 : 1,
          }}
          onClick={() => send()}
          disabled={streaming || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflow: "hidden",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 12px 4px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  emptyHint: {
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
  input: {
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
