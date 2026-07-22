# Pensieve Desktop

A native macOS PDF reader with AI-powered chat and insights, built with Tauri + React. Powered by a local Ollama model.

<img width="1325" height="838" alt="Screenshot 2026-07-22 at 11 22 04 PM" src="https://github.com/user-attachments/assets/75b1b04d-d1a9-4587-9de2-19cb9a20a602" />

## Install

Download the latest release: [Pensieve_0.1.0_aarch64.dmg](src-tauri/target/release/bundle/dmg/Pensieve_0.1.0_aarch64.dmg)

Open the `.dmg` and drag Pensieve to your Applications folder. No prerequisites needed — on first launch, the app will automatically:

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
