package cc.halcyon.mail

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/** Small requests the app makes itself (no page needed), with the WebView's session cookie and certificate trust. */
object Server {
    private val pool = Executors.newSingleThreadExecutor()

    val deviceName: String
        get() = (if (Build.MODEL.startsWith(Build.MANUFACTURER, true)) Build.MODEL else "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}").take(80)

    private fun post(ctx: Context, path: String, body: JSONObject, shared: String = "") {
        val app = ctx.applicationContext
        val server = Prefs.server(app) ?: return
        pool.execute {
            try {
                val c = URL("$server$path").openConnection() as HttpURLConnection
                if (c is HttpsURLConnection) c.sslSocketFactory = Trust.socketFactory(app)
                CookieManager.getInstance().getCookie(server)?.let { c.setRequestProperty("Cookie", it) }
                if (shared.isNotEmpty()) c.setRequestProperty("x-halcyon-as", shared)
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 15000
                c.readTimeout = 20000
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                c.responseCode
                c.disconnect()
            } catch (_: Exception) { } // the web app registers again on its next start
        }
    }

    /** This device's FCM token for the signed-in user (also from the service when Firebase gives a new one). */
    fun register(ctx: Context, token: String) =
        post(ctx, "/api/push/fcm/register", JSONObject().put("token", token).put("device", deviceName).put("version", BuildConfig.VERSION_CODE))

    /** A notification opened or swiped away here: taken back on the user's other devices. */
    fun closed(ctx: Context, tag: String, shared: String) = post(ctx, "/api/push/close", JSONObject().put("tag", tag), shared)
}
