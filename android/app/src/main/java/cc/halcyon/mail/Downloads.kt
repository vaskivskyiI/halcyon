package cc.halcyon.mail

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/**
 * Files from the server (attachments, exports): fetched by the app with the WebView's session cookie and the same
 * certificate trust, then opened — inline views (…?inline=1) from the app's cache, everything else saved to Downloads.
 */
class Downloads(private val activity: Activity) {
    private val pool = Executors.newSingleThreadExecutor()

    fun fetch(url: String, userAgent: String) = background {
        val c = URL(url).openConnection() as HttpURLConnection
        if (c is HttpsURLConnection) c.sslSocketFactory = Trust.socketFactory(activity)
        CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
        c.setRequestProperty("User-Agent", userAgent)
        c.connectTimeout = 20000
        c.readTimeout = 120000
        if (c.responseCode !in 200..299) throw Exception("HTTP ${c.responseCode}")
        val mime = c.contentType?.substringBefore(';')?.trim()?.ifEmpty { null } ?: "application/octet-stream"
        val name = fileName(url, c.getHeaderField("Content-Disposition"), mime)
        c.inputStream.use { save(it, name, mime, inline = Uri.parse(url).getQueryParameter("inline") == "1") }
    }

    /** A file the page made itself (blob: URL), handed over as base64 by the bridge. */
    fun saveBytes(bytes: ByteArray, name: String, mime: String) = background {
        save(bytes.inputStream(), name.ifBlank { "download" }, mime.ifBlank { "application/octet-stream" }, inline = false)
    }

    private fun background(work: () -> Unit) = pool.execute {
        try { work() } catch (e: Exception) {
            activity.runOnUiThread { Toast.makeText(activity, activity.getString(R.string.download_failed, e.message), Toast.LENGTH_LONG).show() }
        }
    }

    private fun save(input: InputStream, name: String, mime: String, inline: Boolean) {
        val uri: Uri
        if (inline || Build.VERSION.SDK_INT < 29) {
            val dir = if (inline) File(activity.cacheDir, "open") else File(activity.getExternalFilesDir(null), "Download")
            dir.mkdirs()
            val f = unique(dir, name)
            f.outputStream().use { input.copyTo(it) }
            uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        } else {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val r = activity.contentResolver
            uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Exception("cannot write to Downloads")
            r.openOutputStream(uri)!!.use { input.copyTo(it) }
            r.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        }
        activity.runOnUiThread {
            if (!inline) Toast.makeText(activity, activity.getString(R.string.saved_to, name), Toast.LENGTH_SHORT).show()
            val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try { activity.startActivity(view) } catch (_: ActivityNotFoundException) {
                if (inline) Toast.makeText(activity, activity.getString(R.string.no_app, name), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun unique(dir: File, name: String): File {
        var f = File(dir, name)
        var i = 1
        while (f.exists()) f = File(dir, name.substringBeforeLast('.') + " ($i)" + (if (name.contains('.')) "." + name.substringAfterLast('.') else "")).also { i++ }
        return f
    }

    companion object {
        /** The name from Content-Disposition (RFC 5987 filename* first), else guessed from the URL and type. */
        fun fileName(url: String, disposition: String?, mime: String): String {
            val star = disposition?.let { Regex("filename\\*\\s*=\\s*([^']*)''([^;]+)", RegexOption.IGNORE_CASE).find(it) }
            val raw = when {
                star != null -> runCatching { URLDecoder.decode(star.groupValues[2].trim(), star.groupValues[1].ifEmpty { "UTF-8" }) }.getOrNull()
                disposition != null -> Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(disposition)?.groupValues?.get(1)
                else -> null
            } ?: URLUtil.guessFileName(url, null, mime)
            var name = raw.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().ifEmpty { "download" }
            if (!name.contains('.')) MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name += ".$it" }
            return name
        }
    }
}
