# Halcyon for Android

The Android app is a **Trusted Web Activity**: an installed app with its own icon, launcher shortcuts (New message,
Calendar, Tasks) and notifications, which shows your Halcyon server full-screen through Chrome. It always runs the
current version of the web app, so there is nothing to update on the phone when the server is upgraded.

On the phone, the app gives you:
- Notifications even when the app is closed (Web Push). In the app, open **Settings → Notifications**, turn on
  *This device*, then choose which mail notifies you, reminders, quiet hours, and muted accounts or shared spaces.
- Swipe a message left or right to archive, delete, mark read, flag or snooze. Set what each direction does in
  **Settings → Mail**.
- Pull the message list down to check for new mail.
- The system back gesture goes back inside the app.

## Build it (GitHub Actions)

1. **Make a signing key once, and keep it safe.** Every later build must be signed with the same key, or Android
   will not update the installed app. Create it on any computer that has Java:
   ```bash
   keytool -genkeypair -keystore halcyon-android.keystore -alias halcyon -keyalg RSA -keysize 2048 -validity 10000
   ```
2. **Add three repository secrets** in GitHub → Settings → Secrets and variables → Actions:
   - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 halcyon-android.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`: the keystore password
   - `ANDROID_KEY_PASSWORD`: the key password. With the command above, this is the same as the keystore password.
3. **Run the build.** Go to Actions → **Android app** → Run workflow, and enter your server's address, for example
   `mail.example.com`.
4. **Install the app.** Download `app-release-signed.apk` from the run's artifacts and install it on the phone. You
   will have to allow installing from that source. The `.aab` file is for the Play Store, if you ever publish there.
5. **Link the app to your server.** The run's summary shows two lines. Add them to your server environment
   (`deploy/halcyon.env` for podman, `.env` for docker compose) and restart the server:
   ```
   HALCYON_ANDROID_PACKAGE=cc.halcyon.mail
   HALCYON_ANDROID_SHA256=AB:CD:…
   ```
   The server then publishes `/.well-known/assetlinks.json`, and Android opens the app without a browser address
   bar. Until you do this, the app still works but shows a small address bar at the top.

The server must be reachable over HTTPS at that address from the phone.

## Build it locally

You need Node 20 or newer, JDK 17 and the Android SDK. Bubblewrap can download the JDK and SDK itself.

```bash
npm i -g @bubblewrap/cli
cd android
# Copy twa-manifest.template.json to twa-manifest.json, then replace __HOST__, __NAME__, __PACKAGE__ and
# __VERSION__, and set appVersionCode to a number that grows with each build.
bubblewrap update --manifest=./twa-manifest.json
bubblewrap build
```

## Windows

The Windows app is the Electron desktop app in `desktop/`. It has a tray icon, can start at login, shows the unread
count on its icon, and uses native notifications; clicking a notification opens the message. It uses the same
notification settings as the web app. Build it with Actions → **Desktop builds**, or locally with
`npm run dist:win`.
