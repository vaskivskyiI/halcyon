# Halcyon for Windows (lightweight app)

A small native Windows app (C# / .NET 8 WinForms + Microsoft Edge WebView2, ~1.5 MB) that shows **your Halcyon
server** in its own window — the Windows counterpart of the Android app in `android/`. It has no local server and no
offline copy; for those use the Electron app in `desktop/`. Both can be installed side by side.

What it adds to the web app:

- Connect window: the server address, checked with `GET <server>/api/health` before it is saved
  (`%APPDATA%\Halcyon\windows\config.json`). Change it later from the tray menu (**Change server…**). A certificate
  from your own CA: **Add CA certificate…** there (accepted only for that server's host; or install the CA in Windows).
- Window size and position are remembered; every start opens **Mail → All inboxes** (`#/mail/unified`).
- One running copy: starting it again, a `mailto:` link or a notification click brings the window to the front.
- `mailto:` links open a new message (`#/compose?url=mailto:…`). Windows asks the user to pick the default: tray menu →
  **Use Halcyon for mailto: links…** opens Settings → Default apps.
- Tray icon (red dot + unread count in its tooltip) and the unread badge on the taskbar button; closing the window
  keeps it in the tray (untick **Keep running in the tray when closed** to quit on close). **Start at login** starts
  it hidden in the tray.
- Notifications as Windows toasts, with an icon per kind (mail, calendar reminder, task, other); a newer one with the
  same tag replaces the older, and a click opens its place in the app.
- Downloads go to the Downloads folder; previews (`?inline=1`) open in the default app for the file; links to other
  sites open in the default browser; sign-in pop-ups, print and "open in its own window" get a window of this app.

Requirements: Windows 10 1809+ or 11, the **.NET 8 Desktop Runtime** and the **WebView2 Runtime** (part of Windows 11;
the app offers the download when it is missing).

## Build

- GitHub: Actions → **Windows app** → Run workflow (`.github/workflows/windows.yml`). Artifacts per architecture
  (x64, arm64): `Halcyon-Windows-Setup-<version>-<arch>.exe` (per-user installer, no admin) and a zip with
  `Halcyon.exe` alone (unpack anywhere and run).
- Locally (needs the .NET 8 SDK; without admin rights it can go into any folder with
  [dotnet-install.ps1](https://dot.net/v1/dotnet-install.ps1) `-Channel 8.0 -InstallDir <folder>`):

  ```powershell
  dotnet publish windows/Halcyon/Halcyon.csproj -c Release -r win-x64 -o windows/Halcyon/bin/publish
  windows/Halcyon/bin/publish/Halcyon.exe
  ```

  Installer: `iscc windows\installer.iss` (Inno Setup 6) after the publish above.
- The icon: `powershell -File windows/tools/make-icon.ps1` writes `windows/Halcyon/halcyon.ico` (the app icon without
  the yellow dot). The toast icons are drawn at run time (`Icons.cs`).

## How the web app talks to it

`Bridge.js` is injected into the server's pages (top frame, server origin only) before they run:

- `window.halcyonDesktop` — the surface of the Electron preload (`desktop/preload.js`): `isDesktop`, `platform`,
  `setBadge(count, dataUrl)`, `show()`, `info()`, `saveConnection()` (opens the server window), plus `shell: 'windows'`,
  `changeServer()` and `closeNotification(tag)` (not in Electron). `prepareDrag` / `dragFile` / `pickFile` are left out:
  dragging an attachment out uses the browser's own drag (DownloadURL), and picking local files is only for the
  Electron app's local server.
- `window.Notification` is replaced by a shim that shows toasts through the app (WebView2 has no Web Push, so
  `PushManager` is removed and the web app notifies through `new Notification()` while it runs, as in Electron).
  `close()` removes the toast, also from the notification centre.

Files: `Program.cs` (single instance, arguments), `MainForm.cs` (window, WebView2, links, downloads, tray, badge),
`ConnectForm.cs`, `Toasts.cs` (WinRT toast API through its ABI — no 25 MB Windows SDK projection), `Shell.cs` (HKCU
registrations: AppUserModelID, `halcyon-windows:` protocol for toast clicks, mailto: capability, Run key; taskbar
overlay), `Trust.cs`, `Icons.cs`, `Config.cs`. Logs: `%LOCALAPPDATA%\Halcyon\windows\halcyon.log`. Uninstall runs
`Halcyon.exe --unregister`.
