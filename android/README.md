# Halcyon for Android

A native Android app (Kotlin, `android/`) that shows your Halcyon server in a WebView, and adds what a web page cannot
do reliably on a phone:

- **Notifications through Firebase Cloud Messaging (FCM)**, also when the app is closed and the phone is asleep. They
  do not depend on Chrome. The server decides what notifies (Settings → Notifications: which mail, reminders, quiet
  hours, muted accounts and shared spaces, hidden content on the lock screen) and sends only the title, the short text
  and where it opens. Tapping a notification opens that message or event, and switches to its shared space.
- **Launcher shortcuts**: long-press the icon for New message, Mail, Calendar, Tasks and Contacts. They always open
  that place, also when the app is already running.
- **mailto: links** from other apps open a new message. The app can be chosen as the phone's email app.
- **Files**: attachments and exports are saved to Downloads, and previews open in the matching app. Attaching files
  uses the phone's file picker.
- **Your own CA**: a server whose certificate comes from your own certificate authority works, either with the CA
  added in the app (connect screen → *Add CA certificate…*) or installed on the phone (Settings → Security →
  Encryption & credentials → Install a certificate → CA certificate).
- The back gesture goes back inside the app. You stay signed in.

On the first start, enter your server's address, for example `https://mail.example.com`, then sign in. *Change
server* is on the page that appears when the server cannot be reached.

The app always shows the current web app from your server, so a server upgrade needs no app update. Rebuild the app
only when `android/` changes.

## 1. Set up Firebase (once, for notifications)

Firebase is free for this use. Your Google account only owns the project; your mail never goes through Google. The
push message carries a title and a short text (or only "New email" if *Hide content on the lock screen* is on) and
the place to open.

1. Open <https://console.firebase.google.com>, choose **Create a project** (for example *Halcyon*). Google Analytics
   is not needed.
2. In the project, choose **Add app → Android**. Package name: **`cc.halcyon.mail`**, or the `PKG` you build with.
   Skip the other steps of that wizard (SDK setup is already done in this repository).
3. **Download `google-services.json`** (Project settings → General → Your apps → the Android app). Put it at
   `android/app/google-services.json` for a local build. It is in `.gitignore`: do not commit it. For GitHub
   Actions, store it as a secret (see below).
4. **Create a key for the server**: Project settings → **Service accounts** → *Firebase Admin SDK* → **Generate new
   private key**. This downloads a JSON file. Keep it secret: it can send notifications to your app. Put it in the
   server's data folder:
   - podman (`deploy/podman-pod.sh`): `podman cp firebase-service-account.json halcyon-app:/data/`
   - docker compose: `docker compose cp firebase-service-account.json halcyon:/data/`
   - Ubuntu installer: copy it into the data directory (`HALCYON_DATA_DIR` in `/etc/halcyon/halcyon.env`) and make
     it readable only by the `halcyon` user.
5. **Tell the server** where the key is and restart it:
   ```
   HALCYON_FCM_SERVICE_ACCOUNT=/data/firebase-service-account.json
   ```
   The setting goes in `deploy/halcyon.env` for podman, `.env` for docker compose, or `/etc/halcyon/halcyon.env`
   (with the real data directory as the path). In a container the path is the one *inside* it (`/data`). The server
   calls `oauth2.googleapis.com` and `fcm.googleapis.com` over HTTPS, so it needs outgoing internet access.

Firebase Cloud Messaging (HTTP v1) is enabled by default in new projects. If sending fails with *SERVICE_DISABLED*,
enable the "Firebase Cloud Messaging API" in the Google Cloud console for the project.

## 2. Build the app

### Locally (Linux or WSL)

`android/build-local.sh` expects these in `~/android-build`:
- JDK 17 in `jdk/`
- the Android SDK in `sdk/`, with `platforms;android-36` and `build-tools;36.1.0`

Gradle 8.11.1 is downloaded there on the first run. `JAVA_HOME`, `ANDROID_HOME` and `GRADLE` override these paths.

```bash
HOST=mail.example.com ./android/build-local.sh
```

`HOST` is optional: it only pre-fills the address on the first start. The script writes
`dist-apps/Halcyon-<version>.apk`. On the first run it creates the signing key in `../halcyon-android-signing/`,
next to the checkout. Keep that folder: every update of the installed app must be signed with the same key. A key
made earlier for the previous app (the Trusted Web Activity) is used again, so the new app installs as an update of
it. Other variables are `PKG` (package, default `cc.halcyon.mail`), `APP_NAME`, `VERSION`, `KEYDIR` and
`GOOGLE_SERVICES_JSON` (the path of the Firebase file, if it is not at `android/app/google-services.json`).

Without the Firebase file, the app is built without notifications, and the script says so.

### With GitHub Actions

1. **Signing key.** Every later build must be signed with the same key. If you built locally before, use
   `halcyon-android.keystore` and `password.txt` from `halcyon-android-signing/`. Otherwise create a key on any
   computer that has Java, with the same password for the keystore and the key:
   ```bash
   keytool -genkeypair -keystore halcyon-android.keystore -alias halcyon -keyalg RSA -keysize 2048 -validity 10000
   ```
2. **Repository secrets** (GitHub → Settings → Secrets and variables → Actions):
   - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 halcyon-android.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`: its password
   - `GOOGLE_SERVICES_JSON_BASE64`: the output of `base64 -w0 google-services.json`
3. **Run** Actions → **Android app** → Run workflow, then download `Halcyon-<version>.apk` from the run's artifacts.

## 3. Install and turn on notifications

1. Copy the APK to the phone and open it. Allow installing from that source when asked.
2. Open Halcyon, enter the server address and sign in.
3. **Settings → Notifications → This device → Turn on.** On Android 13 and later, allow notifications when asked.
   *Send a test* checks the whole path. If the page says the server is not set up, `HALCYON_FCM_SERVICE_ACCOUNT` is
   missing or unreadable. If it says the app has no Firebase setup, the APK was built without `google-services.json`.
4. Optional: in Android's settings for Halcyon, the channels *New mail*, *New mail (silent)* and *Reminders* can be
   set separately. Some phones (Xiaomi, Huawei, Samsung power saving) stop apps in the background. If notifications
   still arrive late, set Battery to *Unrestricted* for Halcyon.

The phone must reach the server over HTTPS, or over plain http on your own network or VPN (the app warns). The server
does not need to be reachable from the internet for notifications: they come through Google's servers, which only
the Halcyon server talks to.

## Development

Open `android/` in Android Studio, or build a debug APK with `gradle -p android assembleDebug` (needs `ANDROID_HOME`).
The web side of the app is in `web/src/push.js`. The page talks to the app through `window.halcyonAndroid`:
`pushState()`, `call(id, 'enable')` (answered with `window.halcyonAndroidResolve(id, result)`), `setOn()` and `ready()`.
The app moves the page with `window.halcyonOpen(route, sharedId)`. In debug builds the WebView can be inspected
from desktop Chrome (`chrome://inspect`).

## Windows

The Windows app is the Electron desktop app in `desktop/`. It has a tray icon, can start at login, shows the unread
count on its icon, and uses native notifications; clicking a notification opens the message. It uses the same
notification settings as the web app. Build it with Actions → **Desktop builds**, or locally with
`npm run dist:win`.
