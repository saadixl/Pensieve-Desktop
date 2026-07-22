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

    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let url = format!(
        "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin-{}",
        arch
    );

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Download failed with status {}", res.status()));
    }

    app.emit("ollama-install-status", "Installing Ollama...").ok();

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {}", e))?;

    let bin_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    let dest = bin_dir.join("ollama");
    fs::write(&dest, &bytes).map_err(|e| format!("Failed to write binary: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

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
    let res = client
        .get(format!("{}/api/tags", OLLAMA_URL))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let models = body
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let has_model = models.iter().any(|m| {
        m.get("name")
            .and_then(|n| n.as_str())
            .map(|n| n.starts_with("llama3.2"))
            .unwrap_or(false)
    });
    if !has_model {
        app.emit("ollama-install-status", "Pulling llama3.2 model...").ok();
        let pull_res = client
            .post(format!("{}/api/pull", OLLAMA_URL))
            .json(&serde_json::json!({"name": "llama3.2"}))
            .send()
            .await
            .map_err(|e| format!("Failed to pull model: {}", e))?;
        if !pull_res.status().is_success() {
            return Err("Failed to pull llama3.2 model".to_string());
        }
        let mut stream = pull_res.bytes_stream();
        let mut line_buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download interrupted: {}", e))?;
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
                    }
                }
            }
        }
        app.emit("ollama-install-status", "Model ready").ok();
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
        .map_err(|e| format!("Ollama connection failed: {}. Is Ollama running?", e))?;

    if !res.status().is_success() {
        let error = res.text().await.unwrap_or_default();
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
    let dir = uploads_dir(&app);
    let mut entries = load_metadata(&app);
    let mut new_entries = vec![];

    for path_str in paths {
        let source = PathBuf::from(&path_str);
        if !source.exists() {
            continue;
        }
        let ext = source
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase());
        if ext.as_deref() != Some("pdf") {
            continue;
        }

        let file_id = Uuid::new_v4().to_string().replace('-', "");
        let stored_name = format!("{}.pdf", file_id);
        let dest = dir.join(&stored_name);

        let content = fs::read(&source).map_err(|e| e.to_string())?;
        let size = content.len() as u64;
        fs::write(&dest, &content).map_err(|e| e.to_string())?;

        let name = source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

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
    Ok(new_entries)
}

#[tauri::command]
fn delete_file(app: AppHandle, file_id: String) -> Result<bool, String> {
    let mut entries = load_metadata(&app);
    let idx = entries.iter().position(|e| e.id == file_id);

    if let Some(idx) = idx {
        let entry = entries.remove(idx);
        let pdf_path = uploads_dir(&app).join(&entry.stored_name);
        if pdf_path.exists() {
            fs::remove_file(pdf_path).ok();
        }
        let ip = insights_dir(&app).join(format!("{}.json", file_id));
        if ip.exists() {
            fs::remove_file(ip).ok();
        }
        save_metadata(&app, &entries);
        Ok(true)
    } else {
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
    let path = resolve_pdf_path(&app, &file_id)?;

    let mut pdf_text = extract_pdf_text(&path)?;
    if pdf_text.len() > 60000 {
        pdf_text = format!("{}\n\n[... truncated]", &pdf_text[..60000]);
    }

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

    stream_ollama(&app, messages, &stream_id).await?;
    Ok(())
}

#[tauri::command]
async fn summarize_document(
    app: AppHandle,
    file_id: String,
    stream_id: String,
) -> Result<(), String> {
    let path = resolve_pdf_path(&app, &file_id)?;

    let existing = load_insights_data(&app, &file_id);
    if let Some(summary) = existing.get("document_summary").and_then(|s| s.as_str()) {
        if !summary.is_empty() {
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

    let full = stream_ollama(&app, messages, &stream_id).await?;
    let mut data = load_insights_data(&app, &file_id);
    data["document_summary"] = serde_json::Value::String(full);
    save_insights_data(&app, &file_id, &data);
    Ok(())
}

#[tauri::command]
async fn summarize_conversation(
    app: AppHandle,
    file_id: String,
    history: Vec<serde_json::Value>,
    stream_id: String,
) -> Result<(), String> {
    resolve_pdf_path(&app, &file_id)?;

    if history.len() < 2 {
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

    let full = stream_ollama(&app, messages, &stream_id).await?;
    let mut data = load_insights_data(&app, &file_id);
    data["conversation_summary"] = serde_json::Value::String(full);
    save_insights_data(&app, &file_id, &data);
    Ok(())
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
        app.emit("ollama-install-status", "Ollama not found — downloading...").ok();
        match install_ollama(&app).await {
            Ok(path) => {
                binary = Some(path);
            }
            Err(e) => {
                return OllamaStatus {
                    installed: false,
                    running: false,
                    model_ready: false,
                    message: format!("Failed to install Ollama: {}", e),
                };
            }
        }
    }

    let running = is_ollama_running().await;
    if !running {
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
                    return OllamaStatus {
                        installed: true,
                        running: false,
                        model_ready: false,
                        message: "Failed to start Ollama server".to_string(),
                    };
                }
            }
            Err(e) => {
                return OllamaStatus {
                    installed: true,
                    running: false,
                    model_ready: false,
                    message: format!("Failed to start Ollama: {}", e),
                };
            }
        }
    }

    app.emit("ollama-install-status", "Checking model...").ok();
    let model_ready = ensure_model_available(&app).await.is_ok();
    let message = if model_ready {
        "Ollama is running with llama3.2".to_string()
    } else {
        "Failed to pull llama3.2 model — check your internet connection".to_string()
    };

    OllamaStatus {
        installed: true,
        running: true,
        model_ready,
        message,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OllamaProcess(Mutex::new(None)))
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
