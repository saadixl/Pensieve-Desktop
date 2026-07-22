# Pensieve Desktop

A native macOS PDF reader with AI-powered chat and insights, built with Tauri + React. Powered by a local Ollama model.

## Prerequisites

- [Ollama](https://ollama.com/) running locally with the `llama3.2` model
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)

## Setup

```bash
ollama serve
ollama pull llama3.2
```

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.
