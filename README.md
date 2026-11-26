# Cursor Usage Widget

A compact desktop widget for Cursor plan usage. It is a sibling of [Codex Usage Widget](https://github.com/wahackr/Codex-Usage-UI) and runs on Windows, Linux, and macOS with the same layout: full view, mini strip, tray tinting, and always-on-top.

The widget reads the access token Cursor already stores in your local profile and calls the same dashboard endpoint the editor uses for billing-cycle usage. It does not ask for an API key, start an agent, or store your credentials outside a local on-disk cache of the last successful response.

## Requirements

- Node.js 24.22.1 or newer (for running from source or building installers)
- Cursor desktop signed in on the same OS user account

Packaged installers bundle Electron and do not require a separate Node.js install.

## Run locally

```bash
nvm use   # optional
npm install
npm start
```

Set `CURSOR_STATE_DB` to the full path of `state.vscdb` if Cursor keeps its data in a non-standard location.

The app polls every five minutes and allows manual refresh about once per minute. It can live in the system tray.

Hover the tray icon to see remaining **Total** and **Auto** allowances for the current billing cycle. Offline mode shows the last cached snapshot and marks it as potentially stale.

| Remaining (Total) | Icon colour |
| --- | --- |
| under 20% | red |
| 20% to under 40% | orange |
| 40% to under 60% | yellow |
| 60% or more | green |

`npm run generate:icon` renders tinted tray PNGs into `src/assets/`.

### Mini mode

Toggle the compact 46px strip with the ▤ button, tray menu, or ▢ in the strip. The choice persists across restarts.

## Linux sandbox setup

```bash
npm run fix:linux-sandbox
```

## Build installers

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Artifacts land in `dist/`.

## Privacy and behavior

Live data comes from:

`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`

with the bearer token from `cursorAuth/accessToken` in Cursor's `state.vscdb` (read-only via Node's built-in SQLite). Recent Cursor builds encrypt that token as `cursor-safe-storage:v1:`; the widget decrypts it using the same OS storage Cursor uses (DPAPI on Windows, Keychain on macOS, Secret Service on Linux). Run the widget as the same OS user who runs Cursor. Enterprise or team accounts that do not return plan percentages may fall back to `GET https://cursor.com/api/usage-summary` with the same session Cookie the dashboard uses.

This endpoint is undocumented and may change. Tokens are read from disk only when refreshing and are sent only to Cursor's HTTPS API.

## Relation to Codex Usage Widget

| | Codex Usage Widget | Cursor Usage Widget |
| --- | --- | --- |
| Auth | Codex CLI login | Cursor IDE login |
| Live API | `codex app-server` JSON-RPC | Cursor dashboard Connect RPC |
| Primary meter | 5-hour window | Billing cycle total |
| Secondary meter | Weekly window | Auto mode |
| Refresh | 60 seconds | 5 minutes |