#!/usr/bin/env bash
# Builds the Android app on this machine (Linux / WSL): JDK 17 in $T/jdk, Android SDK in $T/sdk (with build-tools and
# platform 36), Bubblewrap in $T/bw. Makes a signing key on the first run in $KEYDIR — keep that folder; every update
# of the installed app must be signed with the same key.
#   HOST=mail.example.com ./android/build-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
HOST=${HOST:?set HOST, e.g. HOST=mail.example.com}; PKG=${PKG:-cc.halcyon.mail}; APP_NAME=${APP_NAME:-Halcyon}; VERSION=${VERSION:-1.0.0}
KEYDIR=${KEYDIR:-$ROOT/../halcyon-android-signing}
T=${T:-$HOME/android-build}
# JAVA_HOME / ANDROID_HOME / BW from the environment win (the GitHub workflow sets them).
[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ] || JAVA_HOME=$T/jdk
export JAVA_HOME ANDROID_HOME=${ANDROID_HOME:-$T/sdk} PATH="$JAVA_HOME/bin:$PATH"
BW=${BW:-$T/bw/node_modules/.bin/bubblewrap}
# Bubblewrap still looks for the old `tools` folder of the SDK.
[ -e "$ANDROID_HOME/tools" ] || ln -s cmdline-tools/latest "$ANDROID_HOME/tools"
mkdir -p ~/.bubblewrap; echo "{\"jdkPath\":\"$JAVA_HOME\",\"androidSdkPath\":\"$ANDROID_HOME\"}" > ~/.bubblewrap/config.json
mkdir -p "$KEYDIR"
if [ -n "${KEYSTORE_PASSWORD:-}" ]; then
  printf '%s\n' "$KEYSTORE_PASSWORD" > "$KEYDIR/password.txt"
elif [ ! -f "$KEYDIR/halcyon-android.keystore" ]; then
  P=$(openssl rand -hex 16)
  keytool -genkeypair -keystore "$KEYDIR/halcyon-android.keystore" -alias halcyon -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$P" -keypass "$P" -dname "CN=Halcyon" > /dev/null 2>&1
  printf '%s\n' "$P" > "$KEYDIR/password.txt"; chmod 600 "$KEYDIR/password.txt"
fi
P=$(cat "$KEYDIR/password.txt")
W=$T/project; rm -rf "$W"; mkdir -p "$W"; cd "$W"
cp "$KEYDIR/halcyon-android.keystore" android.keystore
# Icons are read from the repo's copy (the same files the server serves): the build then also works when the server's
# certificate comes from a private CA. The real addresses are put back before compiling.
HOST=$HOST PKG=$PKG APP_NAME=$APP_NAME VERSION=$VERSION node -e '
  const fs = require("fs"), e = process.env;
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace("\"__CODE__\"", "0"),
    (k, v) => typeof v === "string" ? v.replaceAll("__HOST__", e.HOST).replaceAll("__NAME__", e.APP_NAME)
      .replaceAll("__PACKAGE__", e.PKG).replaceAll("__VERSION__", e.VERSION) : v);
  m.appVersionCode = Math.floor(Date.now() / 60000) - 29000000;
  const local = (u) => u.replace("https://" + e.HOST + "/", "http://127.0.0.1:8765/");
  for (const k of ["iconUrl", "maskableIconUrl", "monochromeIconUrl", "webManifestUrl"]) m[k] = local(m[k]);
  for (const s of m.shortcuts) s.chosenIconUrl = local(s.chosenIconUrl);
  fs.writeFileSync("twa-manifest.json", JSON.stringify(m, null, 2));' "$ROOT/android/twa-manifest.template.json"
(cd "$ROOT/web/public" && exec python3 -m http.server 8765 --bind 127.0.0.1) > /dev/null 2>&1 & ICONS=$!
trap 'kill $ICONS 2>/dev/null' EXIT; sleep 1
{ yes || true; } | $BW update --skipVersionUpgrade --manifest=./twa-manifest.json
sed -i "s#http://127.0.0.1:8765/#https://$HOST/#g" app/build.gradle; ! grep -q 127.0.0.1 app/build.gradle
BUBBLEWRAP_KEYSTORE_PASSWORD=$P BUBBLEWRAP_KEY_PASSWORD=$P $BW build --skipPwaValidation --manifest=./twa-manifest.json
rm -f android.keystore
OUT=$ROOT/dist-apps; mkdir -p "$OUT"
cp app-release-signed.apk "$OUT/Halcyon-$VERSION.apk"; cp app-release-bundle.aab "$OUT/Halcyon-$VERSION.aab"
echo "Built $OUT/Halcyon-$VERSION.apk. For the server environment:"
echo "HALCYON_ANDROID_PACKAGE=$PKG"
keytool -list -v -keystore "$KEYDIR/halcyon-android.keystore" -alias halcyon -storepass "$P" | sed -n 's/.*SHA256: /HALCYON_ANDROID_SHA256=/p'
