mod relay;

use std::{
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Serialize)]
struct Config {
    api_key: String,
    model: String,
}

#[tauri::command]
fn get_config() -> Result<Config, String> {
    let api_key = std::env::var("GEMINI_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .ok_or("GEMINI_API_KEY is missing. Put it in .env next to package.json.")?;
    let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-3.1-flash-live-preview".into());
    Ok(Config { api_key, model })
}

fn find_chrome() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CHROME_PATH") {
        return Ok(p.into());
    }
    let mut candidates = vec![];
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            candidates.push(Path::new(&base).join("Google/Chrome/Application/chrome.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "Chrome not found. Set CHROME_PATH in .env.".into())
}

/// Reads `<profile>/DevToolsActivePort` and returns the browser WebSocket URL if Chrome is listening.
fn active_ws_url(profile: &Path) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = text.lines();
    let port = lines.next()?.trim().to_string();
    let path = lines.next()?.trim().to_string();
    TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().ok()?, Duration::from_millis(300)).ok()?;
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

fn user_data_dir() -> Result<PathBuf, String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set")?;
    Ok(Path::new(&base).join("Google/Chrome/User Data"))
}

#[derive(Serialize)]
struct Profile {
    dir: String,
    name: String,
}

#[derive(Serialize)]
struct Profiles {
    last_used: String,
    profiles: Vec<Profile>,
}

/// The user's Chrome profiles, from `User Data/Local State`.
#[tauri::command]
fn chrome_profiles() -> Result<Profiles, String> {
    let text = std::fs::read_to_string(user_data_dir()?.join("Local State")).map_err(|e| format!("Cannot read Chrome profiles: {e}"))?;
    let state: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let profile = &state["profile"];
    let profiles = profile["info_cache"]
        .as_object()
        .map(|m| m.iter().map(|(dir, v)| Profile { dir: dir.clone(), name: v["name"].as_str().unwrap_or(dir).to_string() }).collect())
        .unwrap_or_default();
    Ok(Profiles { last_used: profile["last_used"].as_str().unwrap_or("Default").to_string(), profiles })
}

fn chrome_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq chrome.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("chrome.exe"))
        .unwrap_or(false)
}

fn open_in_chrome(args: &[String]) -> Result<(), String> {
    Command::new(find_chrome()?)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to start Chrome: {e}"))
}

/// Opens `about:blank#ottoman-<nonce>` in `profile`. Without `--new-window`, Chrome adds it as a tab to that profile's
/// last active window and only opens a window when the profile has none. CDP's createTarget cannot pick a window.
#[tauri::command]
fn open_tab(profile: String, nonce: String) -> Result<(), String> {
    open_in_chrome(&[format!("--profile-directory={profile}"), format!("about:blank#ottoman-{nonce}")])
}

#[derive(Serialize)]
struct Connection {
    ws_url: String,
    /// Profile directory the agent's first tab was opened in.
    profile: String,
}

/// Connects to the user's own Chrome. Chrome 136+ refuses `--remote-debugging-port` on the real profile, so this relies on
/// the user enabling chrome://inspect/#remote-debugging, which makes Chrome write `User Data/DevToolsActivePort`.
/// Opens the agent's first tab in `profile` (or the last-used one), starting Chrome if needed.
#[tauri::command]
async fn connect_chrome(profile: Option<String>, nonce: String) -> Result<Connection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = user_data_dir()?;
        let running = chrome_running();
        let live = active_ws_url(&dir);
        let enable = || {
            // Best effort: show the setting page; the error text tells the user where to go either way.
            let _ = open_in_chrome(&["chrome://inspect/#remote-debugging".into()]);
            Err("REMOTE_DEBUGGING_OFF".to_string())
        };
        if running && live.is_none() {
            return enable();
        }
        let profile = match profile {
            Some(p) => p,
            None => chrome_profiles().map(|p| p.last_used).unwrap_or_else(|_| "Default".into()),
        };
        open_tab(profile.clone(), nonce)?;
        if let Some(ws_url) = live {
            return Ok(Connection { ws_url, profile });
        }
        // Chrome was just started; give it time to come up and publish its debugging port.
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(15) {
            if let Some(ws_url) = active_ws_url(&dir) {
                return Ok(Connection { ws_url, profile });
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        enable()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ottoman's own folder for screenshots and files it may upload: `Pictures/Ottoman`.
fn ottoman_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().picture_dir().map_err(|e| e.to_string())?.join("Ottoman");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Resolves `file` inside `dir`, refusing anything that escapes it (`..`, absolute paths, symlinks out) or does not exist.
/// This is the only way the agent can name a local file, so a page cannot trick it into uploading other files.
fn resolve_in(dir: &Path, file: &str) -> Result<PathBuf, String> {
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(file).canonicalize().map_err(|_| format!("No file named \"{file}\" in the Ottoman folder."))?;
    if path.parent() != Some(root.as_path()) {
        return Err(format!("\"{file}\" is outside the Ottoman folder; only files directly in it can be used."));
    }
    Ok(path)
}

#[tauri::command]
fn resolve_upload(app: AppHandle, file: String) -> Result<String, String> {
    Ok(resolve_in(&ottoman_dir(&app)?, &file)?.display().to_string())
}

#[derive(Serialize)]
struct Saved {
    file: String,
    path: String,
}

fn copy_rgba(app: &AppHandle, img: &image::RgbaImage) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let image = tauri::image::Image::new(img.as_raw(), img.width(), img.height());
    app.clipboard().write_image(&image).map_err(|e| format!("Copy to clipboard failed: {e}"))
}

/// Saves PNG bytes as `Pictures/Ottoman/<name>.png` (timestamped when no name) and optionally copies the image.
fn save_png(app: &AppHandle, png: &[u8], name: Option<String>, copy: bool) -> Result<Saved, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    // Keep names to safe characters so they stay inside the folder and are easy to say back.
    let base: String = name
        .unwrap_or_else(|| format!("screenshot-{stamp}"))
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let file = format!("{}.png", base.trim_end_matches(".png"));
    let path = ottoman_dir(app)?.join(&file);
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    if copy {
        let img = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
        copy_rgba(app, &img)?;
    }
    Ok(Saved { file, path: path.display().to_string() })
}

#[tauri::command]
fn save_image(app: AppHandle, png_base64: String, name: Option<String>, copy: bool) -> Result<Saved, String> {
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    save_png(&app, &png, name, copy)
}

#[derive(Serialize)]
struct Desktop {
    file: String,
    path: String,
    png_base64: String,
}

/// Captures the primary monitor, saves it to the Ottoman folder and returns it for the model to see.
#[tauri::command]
async fn capture_desktop(app: AppHandle, name: Option<String>, copy: bool) -> Result<Desktop, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let monitor = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or(monitors.first())
            .ok_or("No monitor found")?;
        let img = monitor.capture_image().map_err(|e| format!("Screen capture failed: {e}"))?;
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        let png = png.into_inner();
        let saved = save_png(&app, &png, name, copy)?;
        Ok(Desktop { file: saved.file, path: saved.path, png_base64: base64::engine::general_purpose::STANDARD.encode(png) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies an image from the Ottoman folder to the clipboard, so it can be pasted into a chat or editor.
#[tauri::command]
fn copy_file_to_clipboard(app: AppHandle, file: String) -> Result<(), String> {
    let path = resolve_in(&ottoman_dir(&app)?, &file)?;
    let img = image::open(&path).map_err(|e| format!("Not an image: {e}"))?.to_rgba8();
    copy_rgba(&app, &img)
}

/// Files in the Ottoman folder, newest first.
#[tauri::command]
fn list_saved(app: AppHandle) -> Result<Vec<String>, String> {
    let mut files: Vec<_> = std::fs::read_dir(ottoman_dir(&app)?)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| (e.metadata().and_then(|m| m.modified()).ok(), e.file_name().to_string_lossy().into_owned()))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files.into_iter().map(|(_, f)| f).collect())
}

/// Id of the connected Ottoman Chrome extension, if any.
#[tauri::command]
fn extension_status(relay: tauri::State<'_, std::sync::Arc<relay::Relay>>) -> Option<u64> {
    relay.extension_id()
}

/// WebSocket URL the app window uses to reach the extension through the relay.
#[tauri::command]
fn relay_url(relay: tauri::State<'_, std::sync::Arc<relay::Relay>>) -> String {
    format!("ws://127.0.0.1:{}/app?token={}", relay::PORT, relay.token)
}

#[tauri::command]
fn chrome_is_running() -> bool {
    chrome_running()
}

/// Starts Chrome (or opens a window) in a profile without debugging flags; used to wake the extension.
#[tauri::command]
fn start_chrome(profile: Option<String>) -> Result<(), String> {
    let profile = match profile {
        Some(p) => p,
        None => chrome_profiles().map(|p| p.last_used).unwrap_or_else(|_| "Default".into()),
    };
    open_in_chrome(&[format!("--profile-directory={profile}")])
}

fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Looks in the working directory and its parents, so `.env` at the project root works for `tauri dev`.
    let _ = dotenvy::dotenv();
    let talk = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &talk && event.state() == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("toggle-mic", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // OTTOMAN_RELAY_TOKEN lets the end-to-end test reach the relay; normally a fresh random token per run.
            app.manage(relay::start(std::env::var("OTTOMAN_RELAY_TOKEN").unwrap_or_else(|_| random_token())));
            app.global_shortcut().register(talk)?;
            let show = MenuItem::with_id(app, "show", "Show Ottoman", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ottoman (Ctrl+Shift+Space to talk)")
                .menu(&Menu::with_items(app, &[&show, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to tray; Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![get_config, chrome_profiles, connect_chrome, open_tab, resolve_upload, save_image, capture_desktop, copy_file_to_clipboard, list_saved, extension_status, relay_url, start_chrome, chrome_is_running])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::resolve_in;

    #[test]
    fn resolve_in_stays_inside_the_folder() {
        let base = std::env::temp_dir().join(format!("ottoman-test-{}", std::process::id()));
        let dir = base.join("Ottoman");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shot.png"), b"x").unwrap();
        std::fs::write(base.join("secret.txt"), b"x").unwrap();

        assert!(resolve_in(&dir, "shot.png").unwrap().ends_with("shot.png"));
        assert!(resolve_in(&dir, "../secret.txt").is_err());
        assert!(resolve_in(&dir, base.join("secret.txt").to_str().unwrap()).is_err());
        assert!(resolve_in(&dir, "missing.png").is_err());
        assert!(resolve_in(&dir, ".").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
