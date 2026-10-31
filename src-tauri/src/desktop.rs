//! Desktop app control over Windows UI Automation (UIA), shaped like the browser tools: a snapshot lists the
//! target window's controls with [ref] numbers, actions take a ref. UIA objects are COM objects, so one worker
//! thread owns all of them; commands send it jobs and await the answer.

use std::{collections::HashMap, sync::mpsc, thread, time::Duration};

use serde::Serialize;
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, RECT},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Threading::{OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{
            Accessibility::*,
            Input::KeyboardAndMouse::*,
            WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, SetCursorPos, SetForegroundWindow, ShowWindow, SW_RESTORE},
        },
    },
};

const MAX_LINES: usize = 400;
const MAX_DEPTH: usize = 40;
/// Time for the app to react before the next snapshot.
const SETTLE: Duration = Duration::from_millis(300);

// Typing into these runs arbitrary commands or changes the system, and page text could talk the model into it.
const BLOCKED_EXACT: [&str; 11] = ["cmd", "mmc", "pwsh", "conhost", "consent", "regedit", "taskmgr", "openconsole", "windowsterminal", "wt", "credentialuibroker"];
const BLOCKED_WORDS: [&str; 5] = ["powershell", "command prompt", "terminal", "registry editor", "task manager"];

/// Whether an app (exe stem or Start menu name) is off limits for Ottoman.
pub fn blocked(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    let n = n.strip_suffix(".exe").unwrap_or(&n);
    BLOCKED_EXACT.contains(&n) || BLOCKED_WORDS.iter().any(|w| n.contains(w))
}

#[derive(Serialize)]
pub struct Snapshot {
    window: String,
    /// Changes when the target window changes; the frontend scopes approvals to it.
    hwnd: isize,
    text: String,
    labels: HashMap<usize, String>,
}

#[derive(Serialize)]
pub struct Capture {
    png_base64: String,
    /// Window rectangle at capture time, "x,y,w,h"; app_click_at refuses if it moved since.
    rect: String,
}

struct State {
    uia: IUIAutomation,
    hwnd: HWND,
    title: String,
    /// Controls in the latest snapshot by ref, with the name they had then.
    refs: HashMap<usize, (IUIAutomationElement, String)>,
    /// Ref numbers stay with a control (by UIA runtime id) across snapshots of the same window, because the model
    /// often sends several actions at once with refs from one snapshot; renumbering would shift them onto
    /// neighbouring controls (Calculator's C/CE swap turned "Five" into "Four").
    ids: HashMap<Vec<i32>, usize>,
}

type Job = Box<dyn FnOnce(&mut Option<State>, &IUIAutomation) + Send>;

pub struct Desktop {
    tx: mpsc::Sender<Job>,
}

impl Desktop {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        thread::spawn(move || {
            // SAFETY: COM init and object creation on this thread, which owns every UIA object for its lifetime.
            let uia: IUIAutomation = unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                    Ok(u) => u,
                    Err(e) => return eprintln!("UI Automation unavailable: {e}"),
                }
            };
            let mut state: Option<State> = None;
            for job in rx {
                job(&mut state, &uia);
            }
        });
        Self { tx }
    }

    async fn run<T: Send + 'static>(&self, f: impl FnOnce(&mut Option<State>, &IUIAutomation) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx.send(Box::new(move |s, u| drop(tx.send(f(s, u))))).map_err(|_| "Desktop control is not running.".to_string())?;
        rx.await.map_err(|_| "Desktop control stopped.".to_string())?
    }
}

fn err(e: windows::core::Error) -> String {
    e.message()
}

fn current(state: &mut Option<State>) -> Result<&mut State, String> {
    let s = state.as_mut().ok_or("No app window chosen yet. Call app_snapshot with the app name first.")?;
    // SAFETY: plain query on a window handle.
    if !unsafe { IsWindow(Some(s.hwnd)) }.as_bool() {
        return Err(format!("The window \"{}\" is closed. Call app_snapshot again.", s.title));
    }
    Ok(s)
}

fn exe_and_elevation(hwnd: HWND) -> (String, bool) {
    // SAFETY: Win32 process queries with owned handles closed below.
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return (String::new(), true) };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let exe = if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or_default().to_string()
        } else {
            String::new()
        };
        // A process running as administrator rejects input from Ottoman (UIPI) and usually its token too.
        let mut token = HANDLE::default();
        let elevated = if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok() {
            let mut e = TOKEN_ELEVATION::default();
            let mut size = 0u32;
            let ok = GetTokenInformation(token, TokenElevation, Some(&mut e as *mut _ as *mut _), size_of::<TOKEN_ELEVATION>() as u32, &mut size).is_ok();
            let _ = CloseHandle(token);
            ok && e.TokenIsElevated != 0
        } else {
            true
        };
        let _ = CloseHandle(process);
        (exe, elevated && pid != std::process::id())
    }
}

fn runtime_id(el: &IUIAutomationElement) -> Option<Vec<i32>> {
    // SAFETY: GetRuntimeId returns a one-dimensional SAFEARRAY of i32 that we read once and destroy.
    unsafe {
        let sa = el.GetRuntimeId().ok()?;
        if sa.is_null() {
            return None;
        }
        let a = &*sa;
        let id = std::slice::from_raw_parts(a.pvData as *const i32, a.rgsabound[0].cElements as usize).to_vec();
        let _ = windows::Win32::System::Ole::SafeArrayDestroy(sa);
        Some(id)
    }
}

fn role(el: &IUIAutomationElement) -> String {
    // SAFETY: UIA property reads on the worker thread.
    unsafe { el.CurrentLocalizedControlType() }.map(|b| b.to_string()).unwrap_or_default()
}

fn clip(s: &str, n: usize) -> String {
    let s = s.replace(['\r', '\n'], " ");
    if s.chars().count() > n { s.chars().take(n - 1).collect::<String>() + "…" } else { s }
}

/// One snapshot line, or None for unnamed layout containers that only hold other controls.
fn describe(el: &IUIAutomationElement) -> Option<String> {
    // SAFETY: UIA property and pattern reads on the worker thread.
    unsafe {
        let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        let ty = el.CurrentControlType().unwrap_or_default();
        let interactive = [
            UIA_ButtonControlTypeId, UIA_EditControlTypeId, UIA_DocumentControlTypeId, UIA_ComboBoxControlTypeId, UIA_CheckBoxControlTypeId,
            UIA_RadioButtonControlTypeId, UIA_MenuItemControlTypeId, UIA_ListItemControlTypeId, UIA_TabItemControlTypeId, UIA_TreeItemControlTypeId,
            UIA_HyperlinkControlTypeId, UIA_SliderControlTypeId, UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId, UIA_DataItemControlTypeId,
        ]
        .contains(&ty);
        if name.trim().is_empty() && !interactive {
            return None;
        }
        let mut line = format!("{} \"{}\"", role(el), clip(name.trim(), 100));
        if let Ok(v) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            let value = v.CurrentValue().map(|b| b.to_string()).unwrap_or_default();
            if !value.is_empty() && value != name {
                line += &format!(" value=\"{}\"", clip(&value, 200));
            }
            if v.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
                line += " readonly";
            }
        }
        if !el.CurrentIsEnabled().unwrap_or(BOOL(1)).as_bool() {
            line += " disabled";
        }
        if el.CurrentHasKeyboardFocus().unwrap_or_default().as_bool() {
            line += " focused";
        }
        if el.CurrentIsPassword().unwrap_or_default().as_bool() {
            line += " password";
        }
        if let Ok(t) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            if t.CurrentToggleState() == Ok(ToggleState_On) {
                line += " checked";
            }
        }
        if let Ok(x) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            line += if x.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded) { " expanded" } else { " collapsed" };
        }
        if let Ok(s) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            if s.CurrentIsSelected().unwrap_or_default().as_bool() {
                line += " selected";
            }
        }
        Some(line)
    }
}

fn snapshot(s: &mut State) -> Result<Snapshot, String> {
    s.refs.clear();
    // SAFETY: UIA tree walk on the worker thread.
    let (root, walker) = unsafe { (s.uia.ElementFromHandle(s.hwnd).map_err(err)?, s.uia.ControlViewWalker().map_err(err)?) };
    let mut lines = Vec::new();
    let mut dropped = 0;
    let mut stack = vec![(root, 0usize)];
    while let Some((el, depth)) = stack.pop() {
        // SAFETY: as above.
        if unsafe { el.CurrentIsOffscreen() }.unwrap_or_default().as_bool() && depth > 0 {
            continue;
        }
        if depth > 0 {
            if let Some(line) = describe(&el) {
                if lines.len() >= MAX_LINES {
                    dropped += 1;
                } else {
                    // SAFETY: as above.
                    let name = unsafe { el.CurrentName() }.map(|b| b.to_string()).unwrap_or_default();
                    let next = s.ids.len() + 1;
                    // Controls without a runtime id (rare) are keyed by their place in this snapshot.
                    let id = runtime_id(&el).unwrap_or_else(|| vec![i32::MIN, lines.len() as i32]);
                    let r = *s.ids.entry(id).or_insert(next);
                    s.refs.insert(r, (el.clone(), name));
                    lines.push(format!("{}[{r}] {line}", "  ".repeat(depth - 1)));
                }
            }
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let mut children = Vec::new();
        // SAFETY: as above.
        let mut child = unsafe { walker.GetFirstChildElement(&el) }.ok();
        while let Some(c) = child {
            child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
            children.push((c, depth + 1));
        }
        stack.extend(children.into_iter().rev());
    }
    if dropped > 0 {
        lines.push(format!("… {dropped} more controls not shown"));
    }
    let labels = s.refs.iter().map(|(r, (_, name))| (*r, name.clone())).collect();
    Ok(Snapshot { window: s.title.clone(), hwnd: s.hwnd.0 as isize, text: format!("Window \"{}\":\n{}", s.title, lines.join("\n")), labels })
}

/// The element for a ref, refused if the app changed it since the snapshot (stale refs act on the wrong thing).
fn element(s: &State, index: usize) -> Result<IUIAutomationElement, String> {
    let (el, name) = s.refs.get(&index).ok_or_else(|| format!("Ref {index} is not in the latest app snapshot (that control is gone). Call app_snapshot and use its refs."))?;
    // SAFETY: UIA property read on the worker thread.
    match unsafe { el.CurrentName() } {
        Ok(now) if now.to_string() == *name => Ok(el.clone()),
        _ => Err(format!("The app changed since the snapshot (ref {index} \"{name}\" is gone or renamed). Call app_snapshot and use the new refs.")),
    }
}

fn focus_window(s: &State) -> Result<(), String> {
    // SAFETY: Win32 window calls; SendInput with a valid INPUT array.
    unsafe {
        if IsIconic(s.hwnd).as_bool() {
            let _ = ShowWindow(s.hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() == s.hwnd {
            return Ok(());
        }
        let _ = SetForegroundWindow(s.hwnd);
        if GetForegroundWindow() != s.hwnd {
            // Windows only lets the app that got the last input change the foreground; a lone Alt tap counts as input.
            send(&[key_input(VK_MENU.0, false), key_input(VK_MENU.0, true)]);
            let _ = SetForegroundWindow(s.hwnd);
        }
        thread::sleep(Duration::from_millis(100));
        if GetForegroundWindow() != s.hwnd {
            return Err(format!("Windows did not let Ottoman bring \"{}\" to the front, so keys and clicks would go elsewhere. Ask the user to click the window once.", s.title));
        }
    }
    Ok(())
}

fn send(inputs: &[INPUT]) {
    // SAFETY: inputs is a valid slice of INPUT structs.
    unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() } },
    }
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: unit, dwFlags: flags, ..Default::default() } } }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, mouseData: data as u32, ..Default::default() } } }
}

/// Virtual-key codes for a combo like "Control+Shift+S" (modifiers first), using the browser press_key names.
pub fn parse_key(combo: &str) -> Result<Vec<u16>, String> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    let (main, mods) = match parts.split_last() {
        Some((m, rest)) if !m.is_empty() => (*m, rest),
        _ => return Err(format!("Unknown key \"{combo}\".")),
    };
    let mut keys = Vec::new();
    for m in mods {
        keys.push(match m.to_lowercase().as_str() {
            "control" | "ctrl" => VK_CONTROL.0,
            "shift" => VK_SHIFT.0,
            "alt" => VK_MENU.0,
            "meta" | "win" | "windows" => VK_LWIN.0,
            _ => return Err(format!("Unknown modifier \"{m}\" in \"{combo}\".")),
        });
    }
    let lower = main.to_lowercase();
    let vk = match lower.as_str() {
        "enter" | "return" => VK_RETURN.0,
        "tab" => VK_TAB.0,
        "escape" | "esc" => VK_ESCAPE.0,
        "backspace" => VK_BACK.0,
        "delete" | "del" => VK_DELETE.0,
        "insert" => VK_INSERT.0,
        "home" => VK_HOME.0,
        "end" => VK_END.0,
        "pageup" => VK_PRIOR.0,
        "pagedown" => VK_NEXT.0,
        "arrowup" | "up" => VK_UP.0,
        "arrowdown" | "down" => VK_DOWN.0,
        "arrowleft" | "left" => VK_LEFT.0,
        "arrowright" | "right" => VK_RIGHT.0,
        "space" | " " => VK_SPACE.0,
        f if f.len() > 1 && f.starts_with('f') && f[1..].parse::<u16>().is_ok_and(|n| (1..=24).contains(&n)) => VK_F1.0 + f[1..].parse::<u16>().unwrap() - 1,
        c if c.chars().count() == 1 && c.chars().all(|c| c.is_ascii_alphanumeric()) => c.to_ascii_uppercase().as_bytes()[0] as u16,
        c if c.chars().count() == 1 => {
            // SAFETY: layout lookup of one UTF-16 unit.
            let r = unsafe { VkKeyScanW(c.encode_utf16().next().unwrap()) };
            if r == -1 {
                return Err(format!("No key for \"{c}\" on this keyboard layout."));
            }
            if r as u16 & 0x100 != 0 {
                keys.push(VK_SHIFT.0);
            }
            (r as u16) & 0xff
        }
        _ => return Err(format!("Unknown key \"{main}\".")),
    };
    keys.push(vk);
    Ok(keys)
}

fn press(keys: &[u16]) {
    let mut inputs: Vec<INPUT> = keys.iter().map(|k| key_input(*k, false)).collect();
    inputs.extend(keys.iter().rev().map(|k| key_input(*k, true)));
    send(&inputs);
}

/// Types one character per input event with a short pause. Sent as one burst, Windows 11 Notepad mangled
/// the text ("Hello smoke" became "Hello eeeee").
fn type_text(text: &str) {
    for c in text.replace("\r\n", "\n").chars() {
        let mut inputs = Vec::new();
        match c {
            '\n' => inputs.extend([key_input(VK_RETURN.0, false), key_input(VK_RETURN.0, true)]),
            '\t' => inputs.extend([key_input(VK_TAB.0, false), key_input(VK_TAB.0, true)]),
            _ => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    inputs.extend([unicode_input(*unit, false), unicode_input(*unit, true)]);
                }
            }
        }
        send(&inputs);
        thread::sleep(Duration::from_millis(15));
    }
}

fn centre(el: &IUIAutomationElement) -> Result<(i32, i32), String> {
    // SAFETY: UIA property read on the worker thread.
    let r = unsafe { el.CurrentBoundingRectangle() }.map_err(err)?;
    if r.right <= r.left || r.bottom <= r.top {
        return Err("That control has no size on screen (hidden or scrolled away).".into());
    }
    Ok(((r.left + r.right) / 2, (r.top + r.bottom) / 2))
}

fn mouse_click(x: i32, y: i32, right: bool, double: bool) -> Result<(), String> {
    // SAFETY: cursor move, then SendInput.
    unsafe { SetCursorPos(x, y) }.map_err(err)?;
    let (down, up) = if right { (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) } else { (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
    let click = [mouse_input(down, 0), mouse_input(up, 0)];
    send(&click);
    if double {
        send(&click);
    }
    Ok(())
}

struct Agile(IUIAutomationElement);
// SAFETY: UIA client objects are free-threaded in the multithreaded apartment.
unsafe impl Send for Agile {}

/// UIA's no-mouse click. Some apps answer Invoke only after a modal dialog it opened closes, so it runs on a
/// helper thread and the worker moves on after a short wait. Returns false when the control has no such pattern.
fn uia_click(el: &IUIAutomationElement) -> bool {
    // SAFETY: UIA pattern calls; COM initialised in the MTA on the helper thread too.
    unsafe {
        if let Ok(t) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            return t.Toggle().is_ok();
        }
        if el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).is_ok() {
            let (tx, rx) = mpsc::channel();
            let a = Agile(el.clone());
            thread::spawn(move || {
                let a = a;
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let ok = a.0.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).and_then(|p| p.Invoke()).is_ok();
                let _ = tx.send(ok);
            });
            return rx.recv_timeout(Duration::from_secs(2)).unwrap_or(true);
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            return p.Select().is_ok();
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            return if p.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded) { p.Collapse() } else { p.Expand() }.is_ok();
        }
    }
    false
}

fn window_rect(hwnd: HWND) -> Result<RECT, String> {
    let mut r = RECT::default();
    // SAFETY: plain query into a local RECT.
    unsafe { GetWindowRect(hwnd, &mut r) }.map_err(err)?;
    Ok(r)
}

/// Screen point for a 0-1000 grid point on a window screenshot padded to a square of its longest side.
pub fn grid_to_screen(rect: (i32, i32, i32, i32), x: f64, y: f64) -> Result<(i32, i32), String> {
    let (left, top, w, h) = rect;
    let side = w.max(h) as f64;
    let (px, py) = (x / 1000.0 * side, y / 1000.0 * side);
    if px < 0.0 || py < 0.0 || px >= w as f64 || py >= h as f64 {
        return Err("That point is outside the window (in the black padding of the screenshot). Look again.".into());
    }
    Ok((left + px as i32, top + py as i32))
}

fn settled(s: &mut State) -> Result<Snapshot, String> {
    thread::sleep(SETTLE);
    snapshot(s)
}

// --- Commands ---------------------------------------------------------------------------------------------------

/// Chooses the app window (by app name or title) and lists its controls; without `window`, re-reads the current one.
#[tauri::command]
pub async fn app_snapshot(desktop: tauri::State<'_, Desktop>, window: Option<String>) -> Result<Snapshot, String> {
    let found = match window {
        Some(q) => {
            let w = crate::find_window(&q)?;
            Some((w.id().map_err(|e| e.to_string())? as isize, w.title().unwrap_or_default(), w.app_name().unwrap_or_default(), w.pid().ok()))
        }
        None => None,
    };
    desktop
        .run(move |state, uia| {
            if let Some((hwnd, title, app, pid)) = found {
                let hwnd = HWND(hwnd as *mut _);
                let (exe, elevated) = exe_and_elevation(hwnd);
                if pid == Some(std::process::id()) {
                    return Err("Ottoman cannot control its own window.".into());
                }
                if blocked(&exe) || blocked(&app) {
                    return Err(format!("\"{title}\" ({exe}) is a terminal or system tool. Ottoman is not allowed to control it; tell the user to do this themselves."));
                }
                if elevated {
                    return Err(format!("\"{title}\" runs as administrator, so Windows blocks Ottoman from controlling it."));
                }
                *state = Some(State { uia: uia.clone(), hwnd, title, refs: HashMap::new(), ids: HashMap::new() });
            }
            snapshot(current(state)?)
        })
        .await
}

#[tauri::command]
pub async fn app_click(desktop: tauri::State<'_, Desktop>, index: usize, button: Option<String>, double: Option<bool>) -> Result<Snapshot, String> {
    desktop
        .run(move |state, _| {
            let s = current(state)?;
            let el = element(s, index)?;
            let right = button.as_deref() == Some("right");
            let double = double.unwrap_or(false);
            if right || double || !uia_click(&el) {
                let (x, y) = centre(&el)?;
                focus_window(s)?;
                mouse_click(x, y, right, double)?;
            }
            settled(s)
        })
        .await
}

#[tauri::command]
pub async fn app_type(desktop: tauri::State<'_, Desktop>, index: usize, text: String, clear: Option<bool>, submit: Option<bool>) -> Result<Snapshot, String> {
    desktop
        .run(move |state, _| {
            let s = current(state)?;
            let el = element(s, index)?;
            focus_window(s)?;
            // SAFETY: UIA focus call on the worker thread.
            if unsafe { el.SetFocus() }.is_err() {
                let (x, y) = centre(&el)?;
                mouse_click(x, y, false, false)?;
            }
            if clear.unwrap_or(false) {
                press(&[VK_CONTROL.0, b'A' as u16]);
                press(&[VK_DELETE.0]);
            }
            type_text(&text);
            if submit.unwrap_or(false) {
                press(&[VK_RETURN.0]);
            }
            settled(s)
        })
        .await
}

#[tauri::command]
pub async fn app_key(desktop: tauri::State<'_, Desktop>, key: String) -> Result<Snapshot, String> {
    let keys = parse_key(&key)?;
    desktop
        .run(move |state, _| {
            let s = current(state)?;
            focus_window(s)?;
            press(&keys);
            settled(s)
        })
        .await
}

#[derive(Serialize)]
pub struct Focused {
    name: String,
    /// Whether it takes typed text (edit box or document), where Enter may send a message.
    text_entry: bool,
}

/// The focused control in the current window, so the frontend can gate a risky Enter.
#[tauri::command]
pub async fn app_focused(desktop: tauri::State<'_, Desktop>) -> Result<Focused, String> {
    desktop
        .run(move |state, uia| {
            current(state)?;
            // SAFETY: UIA focus query on the worker thread.
            let Ok(el) = (unsafe { uia.GetFocusedElement() }) else { return Ok(Focused { name: String::new(), text_entry: false }) };
            let name = unsafe { el.CurrentName() }.map(|b| b.to_string()).unwrap_or_default();
            let ty = unsafe { el.CurrentControlType() }.unwrap_or_default();
            Ok(Focused { name, text_entry: ty == UIA_EditControlTypeId || ty == UIA_DocumentControlTypeId })
        })
        .await
}

#[tauri::command]
pub async fn app_scroll(desktop: tauri::State<'_, Desktop>, index: Option<usize>, direction: String) -> Result<Snapshot, String> {
    desktop
        .run(move |state, _| {
            let s = current(state)?;
            let (x, y) = match index {
                Some(i) => centre(&element(s, i)?)?,
                None => {
                    let r = window_rect(s.hwnd)?;
                    ((r.left + r.right) / 2, (r.top + r.bottom) / 2)
                }
            };
            focus_window(s)?;
            // SAFETY: cursor move.
            unsafe { SetCursorPos(x, y) }.map_err(err)?;
            let notches = if direction == "up" { 5 } else { -5 };
            send(&[mouse_input(MOUSEEVENTF_WHEEL, notches * 120)]);
            settled(s)
        })
        .await
}

/// Screenshot of the current app window for the model to look at before app_click_at.
#[tauri::command]
pub async fn app_capture(desktop: tauri::State<'_, Desktop>) -> Result<Capture, String> {
    let (hwnd, rect) = desktop
        .run(|state, _| {
            let s = current(state)?;
            focus_window(s)?;
            let r = window_rect(s.hwnd)?;
            Ok((s.hwnd.0 as isize, format!("{},{},{},{}", r.left, r.top, r.right - r.left, r.bottom - r.top)))
        })
        .await?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let window = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok() == Some(hwnd as u32))
            .ok_or("The app window is gone.")?;
        let img = window.capture_image().map_err(|e| format!("Window capture failed: {e}"))?;
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(Capture { png_base64: base64::engine::general_purpose::STANDARD.encode(png.into_inner()), rect })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Real mouse click at a point of the last app_capture, on Gemini's 0-1000 grid.
#[tauri::command]
pub async fn app_click_at(desktop: tauri::State<'_, Desktop>, x: f64, y: f64, rect: String) -> Result<Snapshot, String> {
    desktop
        .run(move |state, _| {
            let s = current(state)?;
            let r = window_rect(s.hwnd)?;
            let now = (r.left, r.top, r.right - r.left, r.bottom - r.top);
            if format!("{},{},{},{}", now.0, now.1, now.2, now.3) != rect {
                return Err("The window moved or resized since the last app_screenshot. Take a new one, then app_click_at again.".into());
            }
            let (px, py) = grid_to_screen(now, x, y)?;
            focus_window(s)?;
            mouse_click(px, py, false, false)?;
            settled(s)
        })
        .await
}
