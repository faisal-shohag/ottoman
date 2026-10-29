# Ottoman

Voice browser companion for Windows. A small Tauri app runs a Gemini Live session, launches Chrome on its own profile, and controls it through the Chrome DevTools Protocol.

## Run

```sh
pnpm install
cp .env.example .env      # add GEMINI_API_KEY
pnpm tauri dev
```

Chrome opens with a dedicated profile (`%APPDATA%/com.ottoman.app/chrome-profile`). Log into your sites once in that window and the logins persist. Talk with the mic button or **Ctrl+Shift+Space** from anywhere, or type. Closing the window hides it to the tray; quit from the tray menu.

Irreversible actions (submit, send, post, publish, pay, order, delete, subscribe) wait for your approval: click **Yes** or say "yes".

## Connect Chrome: install the Ottoman extension (recommended)

1. Open `chrome://extensions` in the Chrome profile you want Ottoman to use.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder of this project.

That's it: no debugging setting, no Allow prompt. While Ottoman controls a tab, Chrome shows a "Ottoman started debugging this browser" bar; that is normal. Agent tabs open in your current window, in an **Ottoman** tab group. To use another profile, load the extension there too.

Without the extension, Ottoman falls back to Chrome's own remote debugging: turn it on at `chrome://inspect/#remote-debugging` and click **Allow** when Chrome asks. Chrome allows only one debugging client at a time.

## Demo test site

```sh
pnpm demo                 # http://localhost:5555
```

Pages for forms, tricky widgets (controlled inputs, custom dropdowns, shadow DOM, iframes), a multi-step wizard, login, a shop with cart and checkout, a post composer, dynamic content, data extraction and hard cases (canvas, dialogs, CAPTCHA). Every submit is recorded: `GET /api/log` shows what the agent actually sent, and `DELETE /api/log` clears it.

Try: "go to localhost:5555/shop.html, find the cheapest wireless mouse under 30 dollars and buy it".

## Layout

- `src-tauri/src/lib.rs`: `.env`, Chrome launch, tray, global hotkey
- `src/live.ts`: Gemini Live session, audio, approval
- `src/cdp.ts`: CDP client and tab tracking
- `src/snapshot.ts`: accessibility tree to `[ref]` lines
- `src/tools.ts`: tools the model calls
- `src/prompt.ts`: system instruction

`pnpm test` runs the unit tests.
