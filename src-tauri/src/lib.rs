use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const OLLAMA_URL: &str = "http://localhost:11434";

struct OllamaProcess(Mutex<Option<std::process::Child>>);
struct AppLogs(Mutex<Vec<LogEntry>>);

#[derive(Serialize, Deserialize, Clone)]
struct LogEntry {
    timestamp: String,
    level: String,
    message: String,
}

fn append_log(app: &AppHandle, level: &str, message: &str) {
    let entry = LogEntry {
        timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
        level: level.to_string(),
        message: message.to_string(),
    };
    if let Some(state) = app.try_state::<AppLogs>() {
        state.0.lock().unwrap().push(entry.clone());
    }
    app.emit("app-log", &entry).ok();
}

impl Drop for OllamaProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            child.kill().ok();
        }
    }
}

fn find_ollama_binary(app: Option<&AppHandle>) -> Option<PathBuf> {
    if let Some(app) = app {
        let bundled = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("bin").join("ollama"));
        if let Some(ref p) = bundled {
            if p.exists() {
                return bundled;
            }
        }
    }
    let candidates = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/usr/bin/ollama",
    ];
    for path in candidates {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(output) = Command::new("which").arg("ollama").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

async fn install_ollama(app: &AppHandle) -> Result<PathBuf, String> {
    app.emit("ollama-install-status", "Downloading Ollama...").ok();
    append_log(app, "info", "Downloading Ollama from GitHub releases...");

    let url = "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz";

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| {
            let msg = format!("Failed to create HTTP client: {}", e);
            append_log(app, "error", &msg);
            msg
        })?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Download failed: {}", e);
            append_log(app, "error", &msg);
            msg
        })?;

    if !res.status().is_success() {
        let msg = format!("Download failed with status {}", res.status());
        append_log(app, "error", &msg);
        return Err(msg);
    }

    append_log(app, "info", "Download complete, extracting archive...");
    app.emit("ollama-install-status", "Installing Ollama...").ok();

    let bytes = res
        .bytes()
        .await
        .map_err(|e| {
            let msg = format!("Failed to read download: {}", e);
            append_log(app, "error", &msg);
            msg
        })?;

    append_log(app, "info", &format!("Downloaded {} MB", bytes.len() / (1024 * 1024)));

    let bin_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(&bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut file_count = 0u32;
    for entry in archive.entries().map_err(|e| {
        let msg = format!("Failed to read archive: {}", e);
        append_log(app, "error", &msg);
        msg
    })? {
        let mut entry = entry.map_err(|e| {
            let msg = format!("Bad archive entry: {}", e);
            append_log(app, "error", &msg);
            msg
        })?;
        let path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        let dest = bin_dir.join(&file_name);
        let mut file = fs::File::create(&dest).map_err(|e| format!("Failed to write {}: {}", file_name, e))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| format!("Failed to extract {}: {}", file_name, e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.header().mode().unwrap_or(0o644);
            fs::set_permissions(&dest, fs::Permissions::from_mode(mode))
                .map_err(|e| format!("Failed to set permissions on {}: {}", file_name, e))?;
        }

        file_count += 1;
    }
    if file_count == 0 {
        let msg = "Archive was empty — no files extracted";
        append_log(app, "error", msg);
        return Err(msg.to_string());
    }
    let dest = bin_dir.join("ollama");
    if !dest.exists() {
        let msg = "Could not find ollama binary in archive";
        append_log(app, "error", msg);
        return Err(msg.to_string());
    }

    append_log(app, "info", &format!("Extracted {} files to {}", file_count, bin_dir.display()));
    app.emit("ollama-install-status", "Ollama installed successfully").ok();
    Ok(dest)
}

async fn is_ollama_running() -> bool {
    reqwest::Client::new()
        .get(OLLAMA_URL)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .is_ok()
}

async fn ensure_model_available(app: &AppHandle) -> Result<(), String> {
    let client = reqwest::Client::new();
    append_log(app, "info", "Querying installed models...");
    let res = client
        .get(format!("{}/api/tags", OLLAMA_URL))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Failed to query models: {}", e);
            append_log(app, "error", &msg);
            msg
        })?;
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let models = body
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let model_names: Vec<&str> = models.iter()
        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
        .collect();
    append_log(app, "info", &format!("Installed models: {}", if model_names.is_empty() { "none".to_string() } else { model_names.join(", ") }));
    let has_model = model_names.iter().any(|n| n.starts_with("llama3.2"));
    if !has_model {
        append_log(app, "info", "llama3.2 not found, pulling model...");
        app.emit("ollama-install-status", "Pulling llama3.2 model...").ok();
        let pull_res = client
            .post(format!("{}/api/pull", OLLAMA_URL))
            .json(&serde_json::json!({"name": "llama3.2"}))
            .send()
            .await
            .map_err(|e| {
                let msg = format!("Failed to pull model: {}", e);
                append_log(app, "error", &msg);
                msg
            })?;
        if !pull_res.status().is_success() {
            append_log(app, "error", "Model pull request failed");
            return Err("Failed to pull llama3.2 model".to_string());
        }
        let mut stream = pull_res.bytes_stream();
        let mut line_buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                let msg = format!("Download interrupted: {}", e);
                append_log(app, "error", &msg);
                msg
            })?;
            let text = String::from_utf8_lossy(&chunk);
            line_buffer.push_str(&text);
            while let Some(pos) = line_buffer.find('\n') {
                let line: String = line_buffer[..pos].to_string();
                line_buffer = line_buffer[pos + 1..].to_string();
                if line.is_empty() {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                    let status = parsed.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    let total = parsed.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
                    let completed = parsed.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
                    let msg = if total > 0 {
                        let pct = (completed as f64 / total as f64 * 100.0) as u32;
                        let total_mb = total / (1024 * 1024);
                        format!("{} — {}% of {} MB", status, pct, total_mb)
                    } else {
                        status.to_string()
                    };
                    if !msg.is_empty() {
                        app.emit("ollama-install-status", &msg).ok();
                        append_log(app, "info", &msg);
                    }
                }
            }
        }
        append_log(app, "info", "Model pull complete");
        app.emit("ollama-install-status", "Model ready").ok();
    } else {
        append_log(app, "info", "llama3.2 already available");
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
struct FileEntry {
    id: String,
    name: String,
    stored_name: String,
    size: u64,
}

fn uploads_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("uploads");
    fs::create_dir_all(&dir).ok();
    dir
}

fn insights_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("insights");
    fs::create_dir_all(&dir).ok();
    dir
}

fn metadata_path(app: &AppHandle) -> PathBuf {
    uploads_dir(app).join("metadata.json")
}

fn load_metadata(app: &AppHandle) -> Vec<FileEntry> {
    let path = metadata_path(app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    }
}

fn save_metadata(app: &AppHandle, entries: &[FileEntry]) {
    let path = metadata_path(app);
    let data = serde_json::to_string_pretty(entries).unwrap();
    fs::write(path, data).ok();
}

fn file_display_name(app: &AppHandle, file_id: &str) -> String {
    load_metadata(app)
        .iter()
        .find(|e| e.id == file_id)
        .map(|e| e.name.clone())
        .unwrap_or_else(|| file_id.to_string())
}

fn resolve_pdf_path(app: &AppHandle, file_id: &str) -> Result<PathBuf, String> {
    let entries = load_metadata(app);
    let entry = entries
        .iter()
        .find(|e| e.id == file_id)
        .ok_or_else(|| "File not found".to_string())?;
    let path = uploads_dir(app).join(&entry.stored_name);
    if !path.exists() {
        return Err("File missing from storage".to_string());
    }
    Ok(path)
}

fn extract_pdf_text(path: &PathBuf) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|e| format!("PDF extraction failed: {}", e))
}

fn load_insights_data(app: &AppHandle, file_id: &str) -> serde_json::Value {
    let path = insights_dir(app).join(format!("{}.json", file_id));
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_else(|_| {
            serde_json::json!({"document_summary": null, "conversation_summary": null})
        })
    } else {
        serde_json::json!({"document_summary": null, "conversation_summary": null})
    }
}

fn save_insights_data(app: &AppHandle, file_id: &str, data: &serde_json::Value) {
    let path = insights_dir(app).join(format!("{}.json", file_id));
    let json = serde_json::to_string_pretty(data).unwrap();
    fs::write(path, json).ok();
}

async fn stream_ollama(
    app: &AppHandle,
    messages: Vec<serde_json::Value>,
    stream_id: &str,
) -> Result<String, String> {
    append_log(app, "info", &format!("Streaming from Ollama ({} messages in context)...", messages.len()));
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/chat", OLLAMA_URL))
        .json(&serde_json::json!({
            "model": "llama3.2",
            "messages": messages,
            "stream": true
        }))
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Ollama connection failed: {}. Is Ollama running?", e);
            append_log(app, "error", &msg);
            msg
        })?;

    if !res.status().is_success() {
        let error = res.text().await.unwrap_or_default();
        append_log(app, "error", &format!("Ollama returned error: {}", error));
        app.emit(&format!("stream-error-{}", stream_id), &error)
            .ok();
        return Err(format!("Ollama error: {}", error));
    }

    let mut stream = res.bytes_stream();
    let mut line_buffer = String::new();
    let mut accumulated = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&chunk);
        line_buffer.push_str(&text);

        while let Some(newline_pos) = line_buffer.find('\n') {
            let line: String = line_buffer[..newline_pos].to_string();
            line_buffer = line_buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(token) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !token.is_empty() {
                        accumulated.push_str(token);
                        app.emit(&format!("stream-token-{}", stream_id), token)
                            .ok();
                    }
                }
            }
        }
    }

    if !line_buffer.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line_buffer) {
            if let Some(token) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                if !token.is_empty() {
                    accumulated.push_str(token);
                    app.emit(&format!("stream-token-{}", stream_id), token)
                        .ok();
                }
            }
        }
    }

    app.emit(&format!("stream-done-{}", stream_id), &accumulated)
        .ok();
    Ok(accumulated)
}

#[tauri::command]
fn list_files(app: AppHandle) -> Vec<FileEntry> {
    load_metadata(&app)
}

#[tauri::command]
fn upload_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<FileEntry>, String> {
    append_log(&app, "info", &format!("Uploading {} file(s)...", paths.len()));
    let dir = uploads_dir(&app);
    let mut entries = load_metadata(&app);
    let mut new_entries = vec![];

    for path_str in paths {
        let source = PathBuf::from(&path_str);
        if !source.exists() {
            append_log(&app, "warn", &format!("File not found, skipping: {}", path_str));
            continue;
        }
        let ext = source
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase());
        if ext.as_deref() != Some("pdf") {
            append_log(&app, "warn", &format!("Not a PDF, skipping: {}", path_str));
            continue;
        }

        let file_id = Uuid::new_v4().to_string().replace('-', "");
        let stored_name = format!("{}.pdf", file_id);
        let dest = dir.join(&stored_name);

        let content = fs::read(&source).map_err(|e| {
            let msg = format!("Failed to read file {}: {}", path_str, e);
            append_log(&app, "error", &msg);
            msg
        })?;
        let size = content.len() as u64;
        fs::write(&dest, &content).map_err(|e| {
            let msg = format!("Failed to write file: {}", e);
            append_log(&app, "error", &msg);
            msg
        })?;

        let name = source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        append_log(&app, "info", &format!("Uploaded \"{}\" ({:.1} MB)", name, size as f64 / (1024.0 * 1024.0)));

        let entry = FileEntry {
            id: file_id,
            name,
            stored_name,
            size,
        };
        entries.push(entry.clone());
        new_entries.push(entry);
    }

    save_metadata(&app, &entries);
    append_log(&app, "info", &format!("{} file(s) uploaded successfully", new_entries.len()));
    Ok(new_entries)
}

#[tauri::command]
fn delete_file(app: AppHandle, file_id: String) -> Result<bool, String> {
    let mut entries = load_metadata(&app);
    let idx = entries.iter().position(|e| e.id == file_id);

    if let Some(idx) = idx {
        let entry = entries.remove(idx);
        append_log(&app, "info", &format!("Deleting file \"{}\"", entry.name));
        let pdf_path = uploads_dir(&app).join(&entry.stored_name);
        if pdf_path.exists() {
            fs::remove_file(pdf_path).ok();
        }
        let ip = insights_dir(&app).join(format!("{}.json", file_id));
        if ip.exists() {
            fs::remove_file(ip).ok();
        }
        save_metadata(&app, &entries);
        append_log(&app, "info", &format!("File \"{}\" deleted", entry.name));
        Ok(true)
    } else {
        append_log(&app, "error", &format!("Delete failed: file {} not found", file_id));
        Err("File not found".to_string())
    }
}

#[tauri::command]
fn read_pdf_bytes(app: AppHandle, file_id: String) -> Result<Vec<u8>, String> {
    let path = resolve_pdf_path(&app, &file_id)?;
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_insights(app: AppHandle, file_id: String) -> Result<serde_json::Value, String> {
    resolve_pdf_path(&app, &file_id)?;
    Ok(load_insights_data(&app, &file_id))
}

#[tauri::command]
async fn chat(
    app: AppHandle,
    file_id: String,
    message: String,
    history: Vec<serde_json::Value>,
    stream_id: String,
) -> Result<(), String> {
    let fname = file_display_name(&app, &file_id);
    append_log(&app, "info", &format!("[{}] Chat: \"{}\" (history: {} messages)", fname, message, history.len()));
    let path = resolve_pdf_path(&app, &file_id)?;

    let mut pdf_text = extract_pdf_text(&path)?;
    let text_len = pdf_text.len();
    if pdf_text.len() > 60000 {
        pdf_text = format!("{}\n\n[... truncated]", &pdf_text[..60000]);
        append_log(&app, "warn", &format!("[{}] PDF text truncated from {} to 60000 chars", fname, text_len));
    }
    append_log(&app, "info", &format!("[{}] Extracted {} chars, sending to Ollama...", fname, text_len));

    let system_prompt = format!(
        "You are a helpful assistant that answers questions about a PDF document. \
         Below is the extracted text from the PDF. Use it to answer the user's questions. \
         If the answer is not in the document, say so.\n\n\
         --- PDF CONTENT ---\n{}\n--- END PDF CONTENT ---",
        pdf_text
    );

    let mut messages = vec![serde_json::json!({"role": "system", "content": system_prompt})];
    for h in &history {
        messages.push(h.clone());
    }
    messages.push(serde_json::json!({"role": "user", "content": message}));

    match stream_ollama(&app, messages, &stream_id).await {
        Ok(_) => {
            append_log(&app, "info", &format!("[{}] Chat response complete", fname));
            Ok(())
        }
        Err(e) => {
            append_log(&app, "error", &format!("[{}] Chat failed: {}", fname, e));
            Err(e)
        }
    }
}

#[tauri::command]
async fn summarize_document(
    app: AppHandle,
    file_id: String,
    stream_id: String,
) -> Result<(), String> {
    let fname = file_display_name(&app, &file_id);
    append_log(&app, "info", &format!("[{}] Generating document summary...", fname));
    let path = resolve_pdf_path(&app, &file_id)?;

    let existing = load_insights_data(&app, &file_id);
    if let Some(summary) = existing.get("document_summary").and_then(|s| s.as_str()) {
        if !summary.is_empty() {
            append_log(&app, "info", &format!("[{}] Using cached document summary", fname));
            app.emit(&format!("stream-token-{}", stream_id), summary)
                .ok();
            app.emit(&format!("stream-done-{}", stream_id), summary)
                .ok();
            return Ok(());
        }
    }

    let mut pdf_text = extract_pdf_text(&path)?;
    if pdf_text.len() > 60000 {
        pdf_text = format!("{}\n\n[... truncated]", &pdf_text[..60000]);
    }

    let messages = vec![
        serde_json::json!({
            "role": "system",
            "content": "You summarize PDF documents. Provide a clear, structured summary \
                        covering the main topics, key points, and conclusions. \
                        Keep it concise but comprehensive."
        }),
        serde_json::json!({
            "role": "user",
            "content": format!("Summarize this document:\n\n{}", pdf_text)
        }),
    ];

    match stream_ollama(&app, messages, &stream_id).await {
        Ok(full) => {
            let mut data = load_insights_data(&app, &file_id);
            data["document_summary"] = serde_json::Value::String(full);
            save_insights_data(&app, &file_id, &data);
            append_log(&app, "info", &format!("[{}] Document summary generated and saved", fname));
            Ok(())
        }
        Err(e) => {
            append_log(&app, "error", &format!("[{}] Document summary failed: {}", fname, e));
            Err(e)
        }
    }
}

#[tauri::command]
async fn summarize_conversation(
    app: AppHandle,
    file_id: String,
    history: Vec<serde_json::Value>,
    stream_id: String,
) -> Result<(), String> {
    let fname = file_display_name(&app, &file_id);
    append_log(&app, "info", &format!("[{}] Generating conversation summary ({} messages)...", fname, history.len()));
    resolve_pdf_path(&app, &file_id)?;

    if history.len() < 2 {
        append_log(&app, "info", &format!("[{}] Not enough messages to summarize, skipping", fname));
        app.emit(&format!("stream-done-{}", stream_id), "")
            .ok();
        return Ok(());
    }

    let conversation_text: String = history
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?;
            let content = m.get("content")?.as_str()?;
            let label = if role == "user" { "User" } else { "Assistant" };
            Some(format!("{}: {}", label, content))
        })
        .collect::<Vec<_>>()
        .join("\n");

    let messages = vec![
        serde_json::json!({
            "role": "system",
            "content": "You summarize conversations about PDF documents. \
                        Capture the key questions asked, important answers given, \
                        and any conclusions reached. Be concise."
        }),
        serde_json::json!({
            "role": "user",
            "content": format!("Summarize this conversation:\n\n{}", conversation_text)
        }),
    ];

    match stream_ollama(&app, messages, &stream_id).await {
        Ok(full) => {
            let mut data = load_insights_data(&app, &file_id);
            data["conversation_summary"] = serde_json::Value::String(full);
            save_insights_data(&app, &file_id, &data);
            append_log(&app, "info", &format!("[{}] Conversation summary generated and saved", fname));
            Ok(())
        }
        Err(e) => {
            append_log(&app, "error", &format!("[{}] Conversation summary failed: {}", fname, e));
            Err(e)
        }
    }
}

#[derive(Serialize, Clone)]
struct OllamaStatus {
    installed: bool,
    running: bool,
    model_ready: bool,
    message: String,
}

#[tauri::command]
async fn check_ollama(app: AppHandle) -> OllamaStatus {
    let mut binary = find_ollama_binary(Some(&app));

    if binary.is_none() {
        append_log(&app, "info", "Ollama not found — downloading...");
        app.emit("ollama-install-status", "Ollama not found — downloading...").ok();
        match install_ollama(&app).await {
            Ok(path) => {
                append_log(&app, "info", &format!("Ollama installed at {}", path.display()));
                binary = Some(path);
            }
            Err(e) => {
                let msg = format!("Failed to install Ollama: {}", e);
                append_log(&app, "error", &msg);
                return OllamaStatus {
                    installed: false,
                    running: false,
                    model_ready: false,
                    message: msg,
                };
            }
        }
    } else {
        append_log(&app, "info", &format!("Ollama found at {}", binary.as_ref().unwrap().display()));
    }

    let running = is_ollama_running().await;
    if !running {
        append_log(&app, "info", "Starting Ollama server...");
        let ollama_path = binary.unwrap();
        let child = Command::new(&ollama_path)
            .arg("serve")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        match child {
            Ok(child_proc) => {
                let state = app.state::<OllamaProcess>();
                *state.0.lock().unwrap() = Some(child_proc);

                for _ in 0..20 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if is_ollama_running().await {
                        break;
                    }
                }

                if !is_ollama_running().await {
                    append_log(&app, "error", "Failed to start Ollama server after 10s");
                    return OllamaStatus {
                        installed: true,
                        running: false,
                        model_ready: false,
                        message: "Failed to start Ollama server".to_string(),
                    };
                }
                append_log(&app, "info", "Ollama server started");
            }
            Err(e) => {
                let msg = format!("Failed to start Ollama: {}", e);
                append_log(&app, "error", &msg);
                return OllamaStatus {
                    installed: true,
                    running: false,
                    model_ready: false,
                    message: msg,
                };
            }
        }
    } else {
        append_log(&app, "info", "Ollama server already running");
    }

    app.emit("ollama-install-status", "Checking model...").ok();
    append_log(&app, "info", "Checking for llama3.2 model...");
    let model_ready = ensure_model_available(&app).await.is_ok();
    let message = if model_ready {
        append_log(&app, "info", "llama3.2 model ready");
        "Ollama is running with llama3.2".to_string()
    } else {
        append_log(&app, "error", "Failed to pull llama3.2 model");
        "Failed to pull llama3.2 model — check your internet connection".to_string()
    };

    OllamaStatus {
        installed: true,
        running: true,
        model_ready,
        message,
    }
}

// --- Projects ---

#[derive(Serialize, Deserialize, Clone)]
struct Project {
    id: String,
    name: String,
    file_ids: Vec<String>,
}

fn projects_metadata_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("projects");
    fs::create_dir_all(&dir).ok();
    dir.join("metadata.json")
}

fn load_projects(app: &AppHandle) -> Vec<Project> {
    let path = projects_metadata_path(app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    }
}

fn save_projects(app: &AppHandle, projects: &[Project]) {
    let path = projects_metadata_path(app);
    let data = serde_json::to_string_pretty(projects).unwrap();
    fs::write(path, data).ok();
}

#[tauri::command]
fn create_project(app: AppHandle, name: String) -> Project {
    append_log(&app, "info", &format!("Creating project \"{}\"", name));
    let project = Project {
        id: Uuid::new_v4().to_string().replace('-', ""),
        name,
        file_ids: vec![],
    };
    let mut projects = load_projects(&app);
    projects.push(project.clone());
    save_projects(&app, &projects);
    project
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Vec<Project> {
    load_projects(&app)
}

#[tauri::command]
fn delete_project(app: AppHandle, project_id: String) -> Result<bool, String> {
    let mut projects = load_projects(&app);
    let idx = projects.iter().position(|p| p.id == project_id);
    if let Some(idx) = idx {
        let project = projects.remove(idx);
        append_log(&app, "info", &format!("Deleting project \"{}\"", project.name));
        save_projects(&app, &projects);
        Ok(true)
    } else {
        Err("Project not found".to_string())
    }
}

#[tauri::command]
fn get_project(app: AppHandle, project_id: String) -> Result<Project, String> {
    load_projects(&app)
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())
}

#[derive(Serialize, Clone)]
struct ProjectFiles {
    project: Project,
    files: Vec<FileEntry>,
}

#[tauri::command]
fn get_project_files(app: AppHandle, project_id: String) -> Result<ProjectFiles, String> {
    let projects = load_projects(&app);
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| "Project not found".to_string())?;
    let all_files = load_metadata(&app);
    let files: Vec<FileEntry> = project
        .file_ids
        .iter()
        .filter_map(|fid| all_files.iter().find(|f| f.id == *fid).cloned())
        .collect();
    Ok(ProjectFiles { project, files })
}

#[tauri::command]
fn upload_project_files(app: AppHandle, project_id: String, paths: Vec<String>) -> Result<Vec<FileEntry>, String> {
    let new_entries = upload_files(app.clone(), paths)?;
    let mut projects = load_projects(&app);
    let project = projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    for entry in &new_entries {
        if !project.file_ids.contains(&entry.id) {
            project.file_ids.push(entry.id.clone());
        }
    }
    append_log(&app, "info", &format!("[{}] Added {} file(s) to project", project.name, new_entries.len()));
    save_projects(&app, &projects);
    Ok(new_entries)
}

#[tauri::command]
fn remove_project_file(app: AppHandle, project_id: String, file_id: String) -> Result<bool, String> {
    let mut projects = load_projects(&app);
    let project = projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let fname = file_display_name(&app, &file_id);
    project.file_ids.retain(|fid| fid != &file_id);
    append_log(&app, "info", &format!("[{}] Removed \"{}\" from project", project.name, fname));
    save_projects(&app, &projects);
    Ok(true)
}

#[tauri::command]
async fn chat_project(
    app: AppHandle,
    project_id: String,
    message: String,
    history: Vec<serde_json::Value>,
    stream_id: String,
) -> Result<(), String> {
    let projects = load_projects(&app);
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    append_log(&app, "info", &format!("[Project: {}] Chat: \"{}\" (history: {} messages)", project.name, message, history.len()));

    let char_budget = 60000usize;
    let per_doc = if project.file_ids.is_empty() { char_budget } else { char_budget / project.file_ids.len() };
    let mut doc_sections = Vec::new();
    for fid in &project.file_ids {
        let path = match resolve_pdf_path(&app, fid) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let fname = file_display_name(&app, fid);
        let mut text = match extract_pdf_text(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if text.len() > per_doc {
            text = format!("{}\n\n[... truncated]", &text[..per_doc]);
        }
        doc_sections.push(format!("--- DOCUMENT: {} ---\n{}\n--- END DOCUMENT ---", fname, text));
    }

    if doc_sections.is_empty() {
        append_log(&app, "warn", &format!("[Project: {}] No documents available for chat", project.name));
    }

    let system_prompt = format!(
        "You are a helpful assistant analyzing multiple PDF documents in a project called \"{}\". \
         Below are the contents of each document. Use them to answer the user's questions. \
         You can compare, contrast, and find insights across all documents. \
         If the answer is not in any document, say so.\n\n{}",
        project.name,
        doc_sections.join("\n\n")
    );

    let mut messages = vec![serde_json::json!({"role": "system", "content": system_prompt})];
    for h in &history {
        messages.push(h.clone());
    }
    messages.push(serde_json::json!({"role": "user", "content": message}));

    match stream_ollama(&app, messages, &stream_id).await {
        Ok(_) => {
            append_log(&app, "info", &format!("[Project: {}] Chat response complete", project.name));
            Ok(())
        }
        Err(e) => {
            append_log(&app, "error", &format!("[Project: {}] Chat failed: {}", project.name, e));
            Err(e)
        }
    }
}

#[tauri::command]
async fn get_logs(app: AppHandle) -> Vec<LogEntry> {
    let state = app.state::<AppLogs>();
    let logs = state.0.lock().unwrap().clone();
    logs
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OllamaProcess(Mutex::new(None)))
        .manage(AppLogs(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            list_files,
            upload_files,
            delete_file,
            read_pdf_bytes,
            get_insights,
            chat,
            summarize_document,
            summarize_conversation,
            check_ollama,
            get_logs,
            create_project,
            list_projects,
            delete_project,
            get_project,
            get_project_files,
            upload_project_files,
            remove_project_file,
            chat_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
