# Strem+

Extra plugins for [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced) on Windows.

| Plugin | What it does |
|---|---|
| **DownloadAhead** | Download episodes ahead of time, so they play from your PC with no buffering. Adds a **Downloads** page to the sidebar, and converts downloads (e.g. MKV → MP4) so they never freeze. *Needs the helper (step 3).* |
| **StreamInfoBadges** | Colour badges on every stream: resolution, HDR / Dolby Vision, codec, source, Atmos, seeders, and a warning on AI-upscaled releases. Hover a badge to see what it means. Also fixes streams that start with no sound or stutter. |
| **TorrentStats** | A stats bubble in the player: seeders, leechers, speed and peers. Press **Ctrl+I** or click the chart button. |
| **RememberTimeRemaining** | Remembers if you like the player clock showing time left or total time. |

## Install (2 minutes)

### 1. Download

Click the green **Code** button at the top of this page, then **Download ZIP** (about 75 MB, most of
it is FFmpeg for the helper). Open the ZIP.

### 2. Drag and drop

1. Press **Windows key + R**, type `%APPDATA%` and press **Enter**. A folder opens.
2. Drag the **`stremio-enhanced`** folder from the ZIP into that folder.
3. If Windows asks about replacing or merging, say **yes**. Your other plugins stay where they are.

Then open Stremio Enhanced, go to **Settings → Enhanced → Plugins**, and turn on the ones you want.

### 3. The helper (only for DownloadAhead)

DownloadAhead needs a small helper program running in the background. (TorrentStats works
without it but shows more seeders with it.)

1. Install [Node.js](https://nodejs.org) (the **LTS** button).
2. Press **Windows key + R**, paste `%APPDATA%\stremio-enhanced\strem-plus-helper`, press **Enter**.
3. Right-click **`install-startup.ps1`** → **Run with PowerShell**.

That's it. It says **All set** when it's done, and from then on it starts by itself with Windows.

## Using DownloadAhead

1. Click **Downloads** in Stremio's sidebar and choose a folder for your downloads.
2. Click the download button on an episode (it asks which stream) or right on a stream.
3. Watch it from the **Downloads** page, or open the episode as usual: Stremio asks whether to play
   it from your PC or stream it.

On the Downloads page you can also:

- **Delete after watching** (on by default) and **📌** to keep an episode.
- **Auto-convert to MP4**, or **Convert ▾** on any file. MP4 plays smoothly in Stremio; other file
  types (like MKV) go through Stremio's own converter and can freeze for a few seconds.
- Open **What do the file types and colours mean?** for a quick guide, and click a colour badge
  there to turn a file type off.
- **Check files** looks for damaged audio in your MP4 downloads (it makes Stremio stop with
  "Error occurred when decoding") and repairs it. Converted files are checked automatically.

## Updates

The plugins update themselves. When there's a new version, Stremio Enhanced shows an update button
in **Settings → Enhanced → Plugins**.

## Uninstall

- **Plugins:** turn them off in **Settings → Enhanced → Plugins**, or delete them from
  `%APPDATA%\stremio-enhanced\plugins`.
- **Helper:** open PowerShell in the `strem-plus-helper` folder and run
  `powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove`, then delete the folder.

## Good to know

- Works great with [TheIntroDB](https://github.com/TheIntroDB/stremio-enhanced-plugin). StreamInfoBadges'
  badge style is inspired by [Stream Quality Picker](https://github.com/JZOnTheGit/stream-quality-picker).
- The helper comes with [FFmpeg](https://ffmpeg.org) (LGPL) for converting downloads, so there's
  nothing else to install. Its license and source are in `strem-plus-helper\ffmpeg`.
- The helper only runs on your own PC, only listens to Stremio, and only talks to torrent trackers
  and Stremio's own streaming server.

## Releasing an update

Change the plugin, raise its `@version` at the top of the file, and push. Stremio Enhanced only
offers the update when the version on GitHub is higher than the installed one.

## License

[MIT](LICENSE), except the bundled FFmpeg (LGPL 3.0, see `stremio-enhanced/strem-plus-helper/ffmpeg`).
