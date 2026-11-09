# Strem+

Extra plugins for [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced) on Windows.

| Plugin | What it does |
|---|---|
| **DownloadAhead** | Download episodes ahead of time, so they play from your PC with no buffering. *Needs the helper (step 3).* |
| **TorrentStats** | A stats bubble in the player: seeders, leechers, speed and peers. Press **Ctrl+I** or click the chart button. |
| **AIUpscaleBadge** | Shows the full torrent name on stream cards and flags AI-upscaled releases. |
| **RememberTimeRemaining** | Remembers if you like the player clock showing time left or total time. |

## Install (2 minutes)

### 1. Download

Click the green **Code** button at the top of this page, then **Download ZIP**. Open the ZIP.

### 2. Drag and drop

1. Press **Windows key + R**, type `%APPDATA%` and press **Enter**. A folder opens.
2. Drag the **`stremio-enhanced`** folder from the ZIP into that folder.
3. If Windows asks about replacing or merging, say **yes**. Your other plugins stay where they are.

Then open Stremio Enhanced, go to **Settings → Plugins**, and turn on the ones you want.

### 3. The helper (only for DownloadAhead)

DownloadAhead needs a small helper program running in the background. (TorrentStats works
without it but shows more seeders with it.)

1. Install [Node.js](https://nodejs.org) (the **LTS** button).
2. Press **Windows key + R**, paste `%APPDATA%\stremio-enhanced\strem-plus-helper`, press **Enter**.
3. Right-click **`install-startup.ps1`** → **Run with PowerShell**.

That's it. It says **All set** when it's done, and from then on it starts by itself with Windows.

## Updates

The plugins update themselves. When there's a new version, Stremio Enhanced shows an update button
in **Settings → Plugins**.

## Uninstall

- **Plugins:** turn them off in **Settings → Plugins**, or delete them from
  `%APPDATA%\stremio-enhanced\plugins`.
- **Helper:** open PowerShell in the `strem-plus-helper` folder and run
  `powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove`, then delete the folder.

## Good to know

- Works great with [Stream Quality Picker](https://github.com/JZOnTheGit/stream-quality-picker) and
  [TheIntroDB](https://github.com/TheIntroDB/stremio-enhanced-plugin).
- The helper only runs on your own PC, only listens to Stremio, and only talks to torrent trackers
  and Stremio's own streaming server.

## Releasing an update (for me)

Change the plugin, raise its `@version` at the top of the file, and push. Stremio Enhanced only
offers the update when the version on GitHub is higher than the installed one.

## License

[MIT](LICENSE)
