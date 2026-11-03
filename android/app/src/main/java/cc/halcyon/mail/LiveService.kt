package cc.halcyon.mail

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext

/**
 * Keeps a connection to the server open while notifications are on (server/src/index.js /api/ws?device=…), so they
 * do not depend on Firebase alone: phones hold Firebase messages back for apps not opened in a while. The server waits
 * for an answer to each notification and uses Firebase only when none comes; what was sent while the connection was
 * down comes again when it is back (since = the server time last heard).
 */
class LiveService : Service() {
    companion object {
        private const val ID = 7

        /** Starts (or keeps) the connection when notifications are on, else stops it. */
        fun start(ctx: Context) {
            if (!Prefs.pushOn(ctx) || Prefs.token(ctx) == null || Prefs.server(ctx) == null) return stop(ctx)
            Watchdog.schedule(ctx)
            // Not allowed from the background just now (the app is not exempt from battery optimisation): Firebase
            // still delivers, and the watchdog tries again.
            try { ContextCompat.startForegroundService(ctx, Intent(ctx, LiveService::class.java)) } catch (_: Exception) { }
        }

        fun stop(ctx: Context) {
            Watchdog.cancel(ctx)
            ctx.stopService(Intent(ctx, LiveService::class.java))
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var open = false
    private var usedToken: String? = null
    private var attempt = 0
    private var client: OkHttpClient? = null
    private var network: ConnectivityManager.NetworkCallback? = null
    private val retry = Runnable { connect() }

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        foreground()
        // Back on a network: at once, not after the back-off.
        network = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) { main.post { if (!open) { main.removeCallbacks(retry); connect() } } }
        }
        try { getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network!!) } catch (_: Exception) { network = null }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground()
        if (!Prefs.pushOn(this) || Prefs.token(this) == null) { stopSelf(); return START_NOT_STICKY }
        if (socket == null || usedToken != Prefs.token(this)) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        network?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        socket?.close(1000, null)
        socket = null
        super.onDestroy()
    }

    private fun foreground() {
        Notifications.channels(this)
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifications.CONNECTION)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ContextCompat.getColor(this, R.color.brand))
            .setContentTitle(getString(R.string.live_title))
            .setContentText(getString(R.string.live_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        try { ServiceCompat.startForeground(this, ID, n, type) } catch (_: Exception) { stopSelf() }
    }

    private fun http(): OkHttpClient = client ?: run {
        val tm = Trust.trustManager(this)
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        // Pings from here find a connection that died without a word (a network change) while the phone is awake.
        OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, tm).pingInterval(3, TimeUnit.MINUTES)
            .connectTimeout(20, TimeUnit.SECONDS).build().also { client = it }
    }

    private fun connect() {
        main.removeCallbacks(retry)
        socket?.cancel()
        socket = null
        open = false
        val server = Prefs.server(this)
        val token = Prefs.token(this)
        if (server == null || token == null || !Prefs.pushOn(this)) return stopSelf()
        usedToken = token
        val url = server.replaceFirst(Regex("^http"), "ws") + "/api/ws?device=" + URLEncoder.encode(token, "UTF-8") + "&since=" + Prefs.liveSince(this)
        val req = Request.Builder().url(url)
        CookieManager.getInstance().getCookie(server)?.let { req.header("Cookie", it) }
        socket = http().newWebSocket(req.build(), Listener())
    }

    private fun later(ms: Long) {
        main.removeCallbacks(retry)
        main.postDelayed(retry, ms)
    }

    private inner class Listener : WebSocketListener() {
        private fun mine(ws: WebSocket) = ws === socket

        override fun onOpen(ws: WebSocket, response: Response) { main.post { if (mine(ws)) { open = true; attempt = 0 } } }

        override fun onMessage(ws: WebSocket, text: String) {
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            val p = m.optJSONObject("payload") ?: JSONObject()
            val ctx = this@LiveService
            when (m.optString("type")) {
                "hello" -> Prefs.setLiveSince(ctx, p.optLong("now"))
                "notify:close" -> {
                    val tags = p.optJSONArray("tags")
                    Notifications.cancel(ctx, (0 until (tags?.length() ?: 0)).map { tags!!.optString(it) })
                    Prefs.setLiveSince(ctx, p.optLong("at"))
                }
                "notify:show" -> {
                    val tag = p.optString("tag")
                    // Already showing (Firebase brought it while this connection was down): not again.
                    if (Prefs.pushOn(ctx) && !Notifications.showing(ctx, tag)) Notifications.show(ctx, mapOf(
                        "title" to p.optString("title"), "body" to p.optString("body"), "url" to p.optString("url"),
                        "tag" to tag, "kind" to p.optString("kind"), "type" to p.optString("type"),
                        "silent" to p.optBoolean("silent").toString(), "as" to if (p.isNull("as")) "" else p.optString("as"),
                    ))
                    ws.send(JSONObject().put("type", "ack").put("id", p.optLong("id")).toString())
                    Prefs.setLiveSince(ctx, p.optLong("at"))
                }
            }
        }

        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(1000, null) }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) = main.post {
            if (!mine(ws)) return@post
            open = false
            when (code) {
                // Signed out: until the app is opened and signed in again (Firebase still delivers what it can).
                4001 -> later(30 * 60_000L)
                // This device is not registered (removed in Settings, or another server): registered again.
                4003 -> { Prefs.token(this@LiveService)?.let { Server.register(this@LiveService, it) }; later(60_000L) }
                else -> backOff()
            }
        }.let { }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = main.post {
            if (!mine(ws)) return@post
            open = false
            backOff()
        }.let { }
    }

    private fun backOff() {
        val ms = (5_000L shl attempt.coerceAtMost(6)).coerceAtMost(5 * 60_000L)
        attempt++
        later(ms)
    }
}

/** Every 15 minutes, and after a restart of the phone or an update of the app: the connection is started again if gone. */
class Watchdog : BroadcastReceiver() {
    companion object {
        private const val ACTION = "cc.halcyon.mail.WATCHDOG"
        private fun pi(ctx: Context) = PendingIntent.getBroadcast(ctx, 0, Intent(ctx, Watchdog::class.java).setAction(ACTION), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        fun schedule(ctx: Context) {
            val am = ctx.getSystemService(AlarmManager::class.java)
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi(ctx))
        }

        fun cancel(ctx: Context) = ctx.getSystemService(AlarmManager::class.java).cancel(pi(ctx))
    }

    override fun onReceive(ctx: Context, intent: Intent) = LiveService.start(ctx)
}
