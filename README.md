# Pensieve Desktop

A native macOS PDF reader with AI-powered chat and insights, built with Tauri + React. Powered by a local Ollama model.

<img width="1325" height="838" alt="Screenshot 2026-07-22 at 11 22 04 PM" src="https://github.com/user-attachments/assets/75b1b04d-d1a9-4587-9de2-19cb9a20a602" />

## Install

Download the latest release: [Pensieve_0.1.0_aarch64.dmg](src-tauri/target/release/bundle/dmg/Pensieve_0.1.0_aarch64.dmg)

Open the `.dmg` and drag Pensieve to your Applications folder. On first launch, the app will auto-install Ollama and pull the required model if needed.

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
