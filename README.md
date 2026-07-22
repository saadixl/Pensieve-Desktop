# Pensieve Desktop

A native macOS PDF reader with AI-powered chat and insights, built with Tauri + React. Powered by a local Ollama model.

<img width="1325" height="838" alt="Screenshot 2026-07-22 at 11 22 04 PM" src="https://github.com/user-attachments/assets/75b1b04d-d1a9-4587-9de2-19cb9a20a602" />

## Features

- **Zero-Setup Install** — Just open the app. Ollama is downloaded, started, and the AI model is pulled automatically on first launch
- **Native File Picker** — Open PDFs using the macOS native file dialog
- **PDF Upload & Management** — Upload multiple PDFs, browse them in a sidebar, delete when no longer needed
- **In-App PDF Viewer** — Page-by-page rendering with navigation, zoom controls, and text selection
- **AI Chat** — Ask questions about any uploaded PDF with streaming responses from a local Ollama model
- **Insights Panel** — Auto-generated document and conversation summaries, persisted across sessions
- **Tabbed Interface** — Open multiple PDFs in tabs, each with its own chat history and insights
- **Resizable Split View** — Drag the divider to resize the PDF viewer and chat/insights panels
- **Layout Modes** — Minimize, maximize, or split the PDF viewer with toolbar controls
- **Suggested Questions** — Clickable prompts to get started quickly
- **Markdown Rendering** — Chat responses and insights render formatted markdown
- **Fully Local** — All data stays on your machine. No cloud, no accounts, no tracking

## Install

Download the latest release: [Pensieve_0.1.0_aarch64.dmg](src-tauri/target/release/bundle/dmg/Pensieve_0.1.0_aarch64.dmg)

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
