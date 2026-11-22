import java.net.URI

// The Halcyon app: the server's web app in a WebView, plus what a web page cannot do on Android — notifications through
// Firebase Cloud Messaging, launcher shortcuts, mailto: links, downloads and a private CA. Built by android/build.sh.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
// Without the Firebase file the app still builds and works, only without notifications.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

fun prop(name: String) = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

android {
    namespace = "cc.halcyon.mail"
    compileSdk = 36
    defaultConfig {
        applicationId = prop("halcyon.package") ?: "cc.halcyon.mail"
        minSdk = 24
        targetSdk = 36
        versionCode = prop("halcyon.versionCode")?.toInt() ?: 1
        versionName = prop("halcyon.version") ?: "0.1.0"
        // Pre-filled on the first start (the build script's HOST), still changeable there.
        buildConfigField("String", "DEFAULT_SERVER", "\"${prop("halcyon.server") ?: ""}\"")
        // Browser links to this host open the app (manifest); without a server none do (.invalid never resolves).
        manifestPlaceholders["serverHost"] = prop("halcyon.server")?.let { URI(if ("://" in it) it else "https://$it").host } ?: "halcyon.invalid"
        resValue("string", "app_name", prop("halcyon.name") ?: "Halcyon")
    }
    signingConfigs {
        create("release") {
            prop("halcyon.keystore")?.let {
                storeFile = file(it)
                storePassword = prop("halcyon.keystorePassword")
                keyAlias = prop("halcyon.keyAlias") ?: "halcyon"
                keyPassword = prop("halcyon.keystorePassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (prop("halcyon.keystore") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { checkReleaseBuilds = false }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
}
