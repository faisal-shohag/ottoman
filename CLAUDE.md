# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Ottoman: Windows voice browser companion. Tauri 2 app (React/TS frontend, Rust backend) runs a Gemini Live session and drives the user's Chrome over the Chrome DevTools Protocol (CDP).

## Commands

Package manager is pnpm.

```sh
pnpm install
cp .env.example .env            # GEMINI_API_KEY required; GEMINI_MODEL, CHROME_PATH optional
pnpm tauri dev                  # run the app (Vite on fixed port 1420)
pnpm build                      # tsc typecheck + vite build
pnpm test                       # vitest unit tests (src/*.test.ts)
pnpm vitest run src/snapshot.test.ts      # single test file
pnpm vitest run -t "test name"            # single test by name
cd src-tauri && cargo test      # Rust unit tests (in lib.rs)
pnpm demo                       # demo test site on http://localhost:5555
pnpm e2e                        # end-to-end: real app + real Gemini against demo site (needs GEMINI_API_KEY)
pnpm e2e:desktop                # end-to-end: real app + real Gemini driving Calculator and Notepad (close both first)
pnpm release 0.3.0              # on clean main: bump versions, commit, tag v0.3.0; then git push --follow-tags
```

Demo site records every submit: `GET /api/log` shows what agent sent, `DELETE /api/log` clears it. E2E test (`e2e/app.e2e.mjs`) starts demo + app if not running, connects to the app's WebView2 over CDP on port 9333, types requests into the window, then checks the demo log. Shared harness (start app, `ask`, `scenario` answering approvals) is `e2e/harness.mjs`. `e2e/desktop.e2e.mjs` checks app state through `e2e/uia.ps1` (UI Automation, independent of Ottoman); it works in its own Notepad file because Windows 11 Notepad restores the user's tabs.

## Versions and releases

Version lives in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`); `scripts/release.mjs` keeps them equal and CI fails if they drift. Add a `## x.y.z` section to `CHANGELOG.md`, run `pnpm release x.y.z` on main, push with `--follow-tags`. The `v*` tag triggers `.github/workflows/release.yml`: builds Windows installers (unsigned) into a **draft** GitHub Release with the changelog section as notes; publish it by hand. `.github/workflows/ci.yml` runs typecheck, build, unit tests and `cargo test` on Windows for every PR and push to main. Work on branches, merge to main through PRs.

## Architecture

Three processes talk to each other:

1. **Rust backend** (`src-tauri/src/lib.rs`): loads `.env`, finds/launches Chrome, tray, global hotkey (Ctrl+Shift+Space), file ops in the Ottoman folder (Pictures/Ottoman: screenshots, uploads, clipboard). All exposed as `#[tauri::command]`s registered in `invoke_handler`; frontend calls them via `invoke`. New command needs both.
   - `desktop.rs`: desktop app control over UI Automation (`windows` crate). One worker thread owns all COM objects; `app_*` commands send it jobs. Same shape as browser tools: `app_snapshot` lists a window's controls as `[ref]` lines, actions take refs, refuse stale refs, and return a new snapshot. Clicks use UIA patterns (no mouse) when possible, else real `SendInput`; typing and keys need the window in front (`focus_window`).
2. **Frontend** (`src/`): all agent logic lives here, not in Rust.
   - `App.tsx`: UI, settings (localStorage), wires Chrome connection + tools + assistant together. Built with shadcn/ui (Radix, `src/components/ui/`, add more with `pnpm dlx shadcn@latest add <name>`) and Tailwind v4; Inter font and teal brand theme live in `src/styles.css`, dark mode follows the system. Plain classes `status`, `entry <role>`, `approval` are hooks for `e2e/app.e2e.mjs`, not styles.
   - `live.ts` (`Assistant`): Gemini Live session via `@google/genai`; mic/speaker (`audio.ts`), session resumption, tool-call dispatch, voice approval (yes/no regex on transcript).
   - `tools.ts`: function declarations given to Gemini plus `createTools(ctx: ToolContext)` implementing them over CDP. Adding a tool = add declaration + implementation here.
   - `cdp.ts`: minimal CDP client (one browser-level socket, flat sessions per tab) and `Browser` tab tracking. Socket implementation is injectable (`OpenSocket`).
   - `snapshot.ts`: converts accessibility tree to `[ref] role "name" flags` lines; model acts on ref numbers, which change after every action.
   - `pointer.ts`: human-like mouse (eased paths, in-page drawn cursor) using trusted `Input.dispatchMouseEvent`.
   - `prompt.ts`: system instruction (safety rules first). `models.ts`: Live model list from API with fallback. `voices.ts`: voice list.
3. **Chrome**, reached one of two ways:
   - **Extension (preferred)**: `extension/` MV3 service worker connects to Rust WebSocket relay (`src-tauri/src/relay.rs`, `127.0.0.1:47801`). Extension on `/ext`, app on `/app?token=<per-run secret>`; relay only accepts the extension's fixed origin (pinned by `key` in `manifest.json`) and the token. Extension maps tab-level CDP onto `chrome.debugger` and the browser-level `Target.*` commands onto `chrome.tabs`, so `cdp.ts` works unchanged. Agent tabs go in an "Ottoman" tab group.
   - **Fallback**: Chrome's built-in remote debugging (`DevToolsActivePort` in profile dir). Socket opened from Rust via `tauriSocket.ts` (tauri-plugin-websocket) because Chrome rejects the webview's Origin header.

`OTTOMAN_RELAY_TOKEN` env var fixes the relay token (used by e2e); otherwise random per run.

### Safety gating for irreversible actions

Two layers, keep both when changing tools:
- Model calls `confirm_action` first, user approves by button or saying "yes"; approval is valid 60s on the same URL.
- `tools.ts` independently gates clicks/dialogs whose label matches `RISKY` regex (`isRisky`), asking the user even if the model did not.

Desktop apps add: `isRiskyInApp` (RISKY plus Don't save, discard, uninstall, overwrite...) gates `app_click`, Enter in an app with a risky button, and Shift+Delete; approvals are scoped to the app window (`app:<hwnd>`) instead of a URL. `desktop::blocked` hard-refuses terminals, PowerShell, Registry Editor, Task Manager, UAC (in `open_app` and `app_snapshot`), and Ottoman's own window.

## Unit tests

Tests cover pure logic only (`models`, `pointer`, `snapshot`, `tools`); CDP/Browser is faked. Real browser behaviour is checked with `pnpm e2e` against `demo/public/` pages (forms, tricky widgets, shadow DOM, iframes, wizard, shop/checkout, dialogs, CAPTCHA).
