package cc.halcyon.mail

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Halcyon in Android's share menu: "Send by email" (text into a new message, files as attachments), "Add to task" and
 * "Add to event" (activity-aliases in the manifest; the alias says which). What was shared is copied into the app's
 * cache (the other app's permission to read it ends with this activity) and the web app is opened at
 * #/share/<kind>/<id>, which asks for it through the bridge (Shared.data / Shared.file; web/src/share.jsx).
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val kind = when (intent.component?.className?.substringAfterLast('.')) {
            "ShareTask" -> "task"
            "ShareEvent" -> "event"
            else -> "mail"
        }
        if (Prefs.server(this) == null) { startActivity(Intent(this, ConnectActivity::class.java)); finish(); return }
        val id = runCatching { Shared.keep(this, intent) }.getOrNull()
        if (id == null) {
            Toast.makeText(this, R.string.share_failed, Toast.LENGTH_LONG).show()
        } else {
            startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
                .putExtra(MainActivity.EXTRA_ROUTE, "#/share/$kind/$id")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}

object Shared {
    private const val MAX_FILE = 25L * 1024 * 1024
    private const val MAX_TOTAL = 40L * 1024 * 1024

    private fun dir(ctx: Context) = File(ctx.cacheDir, "shared")

    /** Copies what was shared; returns its id (older shares are removed). */
    fun keep(ctx: Context, i: Intent): String? {
        val root = dir(ctx)
        root.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 3600_000 }?.forEach { it.deleteRecursively() }
        val id = UUID.randomUUID().toString().replace("-", "").take(16)
        val d = File(root, id).apply { mkdirs() }
        val uris = mutableListOf<Uri>()
        if (i.action == Intent.ACTION_SEND_MULTIPLE) streams(i)?.let { uris += it }
        else stream(i)?.let { uris += it }
        val files = JSONArray()
        var total = 0L
        for ((n, u) in uris.withIndex()) {
            // Only content shared by another app: never a file path, nor this app's own files (a sharing app could
            // point at them and get them attached).
            if (u.scheme != "content" || u.authority.orEmpty().startsWith(ctx.packageName)) continue
            val (name, size) = meta(ctx, u)
            if (size > MAX_FILE || total + size > MAX_TOTAL) continue
            val out = File(d, "f$n")
            val copied = runCatching { ctx.contentResolver.openInputStream(u)?.use { inp -> out.outputStream().use { inp.copyTo(it) } } }.getOrNull() ?: continue
            if (out.length() > MAX_FILE) { out.delete(); continue }
            total += copied
            files.put(JSONObject().put("name", name).put("type", ctx.contentResolver.getType(u) ?: i.type ?: "application/octet-stream").put("size", out.length()).put("file", out.name))
        }
        val text = i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        val subject = i.getStringExtra(Intent.EXTRA_SUBJECT) ?: i.getStringExtra(Intent.EXTRA_TITLE) ?: ""
        if (text.isBlank() && subject.isBlank() && files.length() == 0) { d.deleteRecursively(); return null }
        File(d, "share.json").writeText(JSONObject().put("subject", subject).put("text", text).put("files", files).toString())
        return id
    }

    private fun safe(id: String) = id.takeIf { Regex("^[a-f0-9]{16}$").matches(it) }

    /** { subject, text, files: [{ name, type, size }] } as JSON, or "" when gone. */
    fun data(ctx: Context, id: String): String {
        val f = File(dir(ctx), "${safe(id) ?: return ""}/share.json")
        return if (f.exists()) f.readText() else ""
    }

    /** File number `n` of a share, as base64 ("" when gone). */
    fun file(ctx: Context, id: String, n: Int): String {
        val d = File(dir(ctx), safe(id) ?: return "")
        val list = runCatching { JSONObject(File(d, "share.json").readText()).getJSONArray("files") }.getOrNull() ?: return ""
        val name = list.optJSONObject(n)?.optString("file") ?: return ""
        val f = File(d, name)
        return if (f.exists()) Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) else ""
    }

    @Suppress("DEPRECATION")
    private fun stream(i: Intent): Uri? = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableExtra(Intent.EXTRA_STREAM)
    @Suppress("DEPRECATION")
    private fun streams(i: Intent): List<Uri>? = if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableArrayListExtra(Intent.EXTRA_STREAM)

    private fun meta(ctx: Context, u: Uri): Pair<String, Long> {
        var name = u.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = 0L
        runCatching {
            ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it) }?.let { name = it }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { size = c.getLong(it) }
                }
            }
        }
        return name.replace(Regex("[\\/:*?\"<>|]+"), "_") to size
    }
}
