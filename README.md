# Pensieve Desktop

A native macOS PDF reader with AI-powered chat and insights, built with Tauri + React. Powered by a local Ollama model.

<img width="1351" height="864" alt="Screenshot 2026-07-23 at 12 31 09 AM" src="https://github.com/user-attachments/assets/16d1ab47-aa48-491e-b23b-cc4f24f9cd16" />
<img width="1330" height="858" alt="Screenshot 2026-07-23 at 12 31 27 AM" src="https://github.com/user-attachments/assets/ef12d258-4362-4474-8402-a867fcbeed65" />


## Features

- **Zero-Setup Install** — Just open the app. Ollama is downloaded, started, and the AI model is pulled automatically on first launch
- **Native File Picker** — Open single PDFs or create multi-document projects using the macOS native file dialog
- **PDF Management** — Browse uploaded PDFs in a sidebar with tooltips for long filenames, delete when no longer needed
- **In-App PDF Viewer** — Page-by-page rendering with navigation, zoom controls, and text selection
- **AI Chat** — Ask questions about any uploaded PDF with streaming responses from a local Ollama model
- **Insights Panel** — Auto-generated document and conversation summaries, persisted across sessions
- **Tabbed Interface** — Open multiple PDFs in tabs, each with its own chat history and insights
- **Resizable Split View** — Drag the divider to resize the PDF viewer and chat/insights panels
- **Layout Modes** — Minimize, maximize, or split the PDF viewer with toolbar controls
- **Suggested Questions** — Clickable prompts to get started quickly
- **Markdown Rendering** — Chat responses and insights render formatted markdown
- **Multi-Document Projects** — Create projects, add multiple PDFs, view them side-by-side in expandable accordions with full PDF rendering, generate per-document summaries in the Insights section, and chat across all documents for cross-document comparisons and analysis
- **Resizable Project Layout** — Drag to resize the documents and insights/chat panes, with minimize/split/maximize controls matching the single-file view
- **Comprehensive Logging** — All operations logged with timestamps, viewable in the Logs tab
- **Fully Local** — All data stays on your machine. No cloud, no accounts, no tracking

## Install

Download the latest release: [Pensieve_0.3.0_aarch64.dmg](src-tauri/target/release/bundle/dmg/Pensieve_0.3.0_aarch64.dmg)

Open the `.dmg` and drag Pensieve to your Applications folder.

Since the app is not signed with an Apple Developer certificate, macOS may block it from opening. If that happens, run:

```bash
xattr -cr /Applications/Pensieve-Desktop.app
```

No other prerequisites needed — on first launch, the app will automatically:

1. Download and install Ollama if not already on your machine
2. Start the Ollama server
3. Pull the `llama3.2` model (~2 GB)

Progress is shown in the sidebar status indicator.

## Development

Requires [Node.js](https://nodejs.org/) (v18+) and [Rust](https://rustup.rs/).

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.
