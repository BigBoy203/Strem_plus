# Strem+ helper

A small background program for the Strem+ plugins. To install it, right-click
`install-startup.ps1` → **Run with PowerShell** (you need [Node.js](https://nodejs.org) first).
Full steps are in the [main README](../../README.md).

- **DownloadAhead needs it** to download episodes, play them from your PC and delete them.
- **TorrentStats uses it if it's running** to count seeders and leechers on all trackers.

## Files

| File | What it is |
|---|---|
| `install-startup.ps1` | Sets the helper to start with Windows and starts it. `-Remove` undoes it. |
| `start-hidden.vbs` | Runs the helper with no window, and restarts it if it ever crashes. |
| `scrape-helper.mjs` | The helper itself. Runs on `http://127.0.0.1:48760`. No `npm install` needed. |
| `downloads.mjs` | The DownloadAhead part: downloads, playing from your PC, deleting. |

While it runs, it keeps `downloads.json` (your download folder and list) and, only if something
goes wrong, `helper.log` in this folder.

**Is it running?** Open <http://127.0.0.1:48760/health>. It should show `{"ok":true}`.
