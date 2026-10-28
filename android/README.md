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
   will not update the installed app. Create it on any computer that has Java. Use the same password for the
   keystore and the key:
   ```bash
   keytool -genkeypair -keystore halcyon-android.keystore -alias halcyon -keyalg RSA -keysize 2048 -validity 10000
   ```
   If you already built the app locally (below), you already have a key: use `halcyon-android.keystore` and
   `password.txt` from the `halcyon-android-signing` folder.
2. **Add two repository secrets** in GitHub → Settings → Secrets and variables → Actions:
   - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 halcyon-android.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`: its password
3. **Run the build.** Go to Actions → **Android app** → Run workflow, and enter your server's address, for example
   `mail.example.com`.
4. **Install the app.** Download `Halcyon-<version>.apk` from the run's artifacts and install it on the phone. You
   will have to allow installing from that source. The `.aab` file is for the Play Store, if you ever publish there.
5. **Link the app to your server.** The run's summary shows two lines. Add them to your server environment
   (`deploy/halcyon.env` for podman, `.env` for docker compose) and restart the server:
   ```
   HALCYON_ANDROID_PACKAGE=cc.halcyon.mail
   HALCYON_ANDROID_SHA256=AB:CD:…
   ```
   The server then publishes `/.well-known/assetlinks.json`, and Android opens the app without a browser address
   bar. Until you do this, the app still works but shows a small address bar at the top.

The phone must reach the server over HTTPS at that address, with a certificate the phone trusts. If the certificate
comes from your own CA, install that CA on the phone: Settings → Security → Encryption & credentials → Install a
certificate → CA certificate. Without it, Chrome refuses the page, and with it notifications cannot work either.
Android may also keep showing the address bar with such a certificate. A publicly trusted certificate, for example
from Let's Encrypt, avoids both problems.

## Build it locally

On Linux or WSL you need Node 20 or newer and python3. `android/build-local.sh` expects these in `~/android-build`:
- JDK 17 in `jdk/`
- the Android SDK in `sdk/`, with `cmdline-tools/latest`, `platforms;android-36` and `build-tools;36.1.0`
- `npm i @bubblewrap/cli` installed in `bw/`

`JAVA_HOME`, `ANDROID_HOME` and `BW` override these paths.

```bash
HOST=mail.example.com ./android/build-local.sh
```

On the first run, the script creates the signing key in `../halcyon-android-signing/`, next to the checkout. Keep
that folder. It writes `dist-apps/Halcyon-<version>.apk` and `.aab`, and prints the two server lines from step 5.

## Windows

The Windows app is the Electron desktop app in `desktop/`. It has a tray icon, can start at login, shows the unread
count on its icon, and uses native notifications; clicking a notification opens the message. It uses the same
notification settings as the web app. Build it with Actions → **Desktop builds**, or locally with
`npm run dist:win`.
