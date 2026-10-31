# Changelog

All notable changes to Ottoman. Versions follow [Semantic Versioning](https://semver.org); release with
`pnpm release <version>` (see `scripts/release.mjs`).

## 0.2.0

### Added
- Desktop app control: Ottoman can open apps from the Start menu and drive them like the browser. It reads a window's controls (`app_snapshot`), then clicks, types, presses shortcuts and scrolls. Screenshot and click-by-position cover apps with no readable controls.
- Screenshot of a single app window, and closing an app window.
- `calculate` tool, so sums are worked out exactly instead of in the voice model's head.
- Desktop end-to-end test (`pnpm e2e:desktop`) driving Calculator and Notepad through the real app.
- CI on every pull request and push to main; tag-driven Windows release builds.

### Safety
- Terminals, PowerShell, Registry Editor, Task Manager and the UAC prompt are off limits, as are apps running as administrator.
- Ottoman asks before "Don't save", discard, uninstall, overwrite, sign out and similar clicks, before Enter in a message box that would send, and before Shift+Delete.

### Fixed
- Text typed into Windows 11 Notepad was mangled when sent in one burst.

### Install notes
- The installer is not code-signed yet; Windows SmartScreen will warn. Choose "More info", then "Run anyway".
- Set your Gemini API key once as a user environment variable, then start Ottoman: `setx GEMINI_API_KEY your-key`

## 0.1.0

- First version: voice browser companion driving the user's Chrome through Gemini Live.
