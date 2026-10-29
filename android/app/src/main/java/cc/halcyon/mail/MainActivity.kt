package cc.halcyon.mail

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * The user's Halcyon server in a WebView. Launcher shortcuts, notifications and mailto: links say where to go
 * (EXTRA_ROUTE, a hash route like "#/calendar"); a running app is moved there through the web app's halcyonOpen()
 * (push.js), which also switches to the shared space a notification belongs to (EXTRA_AS).
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_OPEN = "cc.halcyon.mail.OPEN"
        const val EXTRA_ROUTE = "route"
        const val EXTRA_AS = "as"
    }

    private data class Target(val route: String, val shared: String = "")

    private lateinit var web: WebView
    private lateinit var server: String
    private lateinit var downloads: Downloads
    private var ready = false // the web app is running and has its bridge hooks (push.js called ready())
    private var pending: Target? = null
    private var last: Target? = null
    @Volatile private var pageOrigin = ""
    private var files: ValueCallback<Array<Uri>>? = null
    private var permissionDone: ((Boolean) -> Unit)? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        files?.onReceiveValue(picked(r))
        files = null
    }
    private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permissionDone?.invoke(ok)
        permissionDone = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = Prefs.server(this) ?: run {
            startActivity(Intent(this, ConnectActivity::class.java))
            finish()
            return
        }
        enableEdgeToEdge()
        downloads = Downloads(this)
        Notifications.channels(this)
        Shortcuts.publish(this)

        web = WebView(this)
        val root = FrameLayout(this)
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.page))
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        setUpWebView()

        // Back = what the page closes first (an open menu: window.halcyonBack), else back in the web app's history; at
        // its start the app goes to the background (and stays signed in).
        onBackPressedDispatcher.addCallback(this) {
            web.evaluateJavascript("(window.halcyonBack && window.halcyonBack()) === true") { handled ->
                if (handled == "true") return@evaluateJavascript
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        }

        val target = targetOf(intent)
        if (target != null || savedInstanceState == null || web.restoreState(savedInstanceState) == null) load(target)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        targetOf(intent)?.let { open(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    private fun targetOf(i: Intent?): Target? {
        i ?: return null
        if (i.data?.scheme == "mailto") return Target("#/compose?url=" + Uri.encode(i.dataString))
        // Only places inside the web app: another app may start this activity too.
        val route = i.getStringExtra(EXTRA_ROUTE)?.takeIf { it.startsWith("#/") } ?: return null
        return Target(route, i.getStringExtra(EXTRA_AS).orEmpty())
    }

    private fun load(t: Target?) {
        ready = false
        last = t
        pending = t?.takeIf { it.shared.isNotEmpty() }
        web.loadUrl("$server/${t?.route.orEmpty()}")
    }

    /** Moves the running web app; before it is ready, loads the page at that place. */
    private fun open(t: Target) {
        if (!ready) return load(t)
        web.evaluateJavascript("window.halcyonOpen(${JSONObject.quote(t.route)}, ${JSONObject.quote(t.shared)})", null)
    }

    private fun origin(u: Uri) = "${u.scheme}://${u.authority}"
    private val serverOrigin get() = origin(Uri.parse(server))
    private fun ours(u: Uri) = origin(u) == serverOrigin

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString HalcyonAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // Only the user's server and the app's own error page are ever shown here; everything else opens outside.
        web.addJavascriptInterface(Bridge(), "halcyonAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = link(request.url)

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                ready = false
                pageOrigin = if (url.startsWith("data:") || url == "about:blank") "app" else origin(Uri.parse(url))
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Checked against the CAs added in the app (Trust.kt); anything else is refused.
                if (Trust.acceptsWebView(this@MainActivity, error)) return handler.proceed()
                handler.cancel()
                problem("The server's certificate is not trusted by this phone. If it comes from your own CA, add that CA certificate (Change server → Add CA certificate) or install it in Android's settings.")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) problem("$server cannot be reached: ${error.description}")
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                files?.onReceiveValue(null)
                files = callback
                val i = params.createIntent()
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try { pickFiles.launch(i); true } catch (_: ActivityNotFoundException) { files = null; false }
            }

            // window.open / target=_blank: a throwaway WebView catches the address, which is then handled like a link.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val probe = WebView(this@MainActivity)
                var done = false
                fun take(u: Uri) {
                    if (done) return
                    done = true
                    popup(u)
                    probe.post { probe.stopLoading(); probe.destroy() }
                }
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean { take(r.url); return true }
                    override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) = take(Uri.parse(url))
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }
        }

        web.setDownloadListener { url, userAgent, disposition, mime, _ ->
            if (url.startsWith("blob:")) blob(url, Downloads.fileName(url, disposition, mime ?: "application/octet-stream"))
            else downloads.fetch(url, userAgent)
        }
    }

    /** A link in the page: mailto: → a new message here, the server's pages stay, files are downloaded, the rest opens outside. */
    private fun link(u: Uri): Boolean {
        when {
            u.scheme == "mailto" -> open(Target("#/compose?url=" + Uri.encode(u.toString())))
            ours(u) && u.path.orEmpty().contains("/api/") && !u.path.orEmpty().contains("/api/oauth/") -> downloads.fetch(u.toString(), web.settings.userAgentString)
            ours(u) || u.scheme in listOf("blob", "data", "about", "javascript") -> return false
            else -> outside(u)
        }
        return true
    }

    private fun popup(u: Uri) {
        when {
            u.scheme == "blob" -> blob(u.toString(), "")
            ours(u) && !u.path.orEmpty().contains("/api/") -> web.loadUrl(u.toString())
            ours(u) && u.path.orEmpty().contains("/api/oauth/") -> web.loadUrl(u.toString())
            u.scheme == "about" -> {}
            else -> link(u)
        }
    }

    private fun outside(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this, getString(R.string.no_app, u.toString()), Toast.LENGTH_LONG).show() }
    }

    /** A file the page made (blob:), read by the page and handed to the bridge. */
    private fun blob(url: String, name: String) {
        web.evaluateJavascript("""(async () => { try {
            const b = await (await fetch(${JSONObject.quote(url)})).blob();
            const r = new FileReader();
            r.onload = () => halcyonAndroid.saveFile(String(r.result).split(',')[1] || '', ${JSONObject.quote(name)}, b.type || '');
            r.readAsDataURL(b);
          } catch (e) {} })()""", null)
    }

    private fun problem(text: String) {
        ready = false
        val esc = text.replace("&", "&amp;").replace("<", "&lt;")
        val dark = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        val (bg, fg) = if (dark) "#111827" to "#E5E7EB" else "#FFFFFF" to "#1D2433"
        web.loadDataWithBaseURL(null, """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="font-family:system-ui,sans-serif;padding:32px 24px;background:$bg;color:$fg">
            <h2 style="margin:0 0 10px">Halcyon</h2><p style="line-height:1.5">$esc</p>
            <button onclick="halcyonAndroid.retry()" style="height:40px;padding:0 18px;border:0;border-radius:8px;background:#2563EB;color:#fff;font-weight:600">Try again</button>
            <button onclick="halcyonAndroid.changeServer()" style="height:40px;padding:0 14px;border:0;background:none;color:#2563EB;font-weight:600">Change server</button>
            </body>""", "text/html", "utf-8", null)
    }

    private val deviceName: String
        get() = (if (Build.MODEL.startsWith(Build.MANUFACTURER, true)) Build.MODEL else "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}").take(80)

    private fun firebase() = FirebaseApp.getApps(this).isNotEmpty()

    /** Notification permission (Android 13+), then this device's FCM token. */
    private fun enablePush(done: (JSONObject) -> Unit) {
        val fail: (String) -> Unit = { msg -> done(JSONObject().put("error", msg)) }
        if (!firebase()) return fail("This build of the app has no Firebase setup (google-services.json), so it cannot receive notifications.")
        val then: (Boolean) -> Unit = { ok ->
            if (!ok || !Notifications.allowed(this)) fail("Notifications are blocked for Halcyon: allow them in Android Settings → Apps → Halcyon → Notifications.")
            else FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                if (t.isSuccessful && t.result != null) {
                    Prefs.setToken(this, t.result)
                    done(JSONObject().put("token", t.result).put("device", deviceName))
                } else fail("Firebase did not give this device a token: ${t.exception?.message ?: "no Google Play services?"}")
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissionDone = then
            askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else then(true)
    }

    private fun picked(r: ActivityResult): Array<Uri>? {
        if (r.resultCode != RESULT_OK) return null
        val d = r.data ?: return null
        d.clipData?.let { c -> return Array(c.itemCount) { c.getItemAt(it).uri } }
        return d.data?.let { arrayOf(it) }
    }

    /** window.halcyonAndroid in the page (web/src/push.js). Called on a WebView thread. */
    private inner class Bridge {
        private fun trusted() = pageOrigin == serverOrigin

        @JavascriptInterface
        fun pushState(): String {
            if (!trusted()) return "{}"
            val ctx: Context = this@MainActivity
            return JSONObject().put("available", firebase()).put("on", Prefs.pushOn(ctx))
                .put("permission", if (Notifications.allowed(ctx)) "granted" else "default")
                .put("token", Prefs.token(ctx) ?: JSONObject.NULL).put("device", deviceName).toString()
        }

        /** An answer that takes a while; it comes back through window.halcyonAndroidResolve(id, result). */
        @JavascriptInterface
        fun call(id: Int, method: String) {
            if (!trusted()) return
            runOnUiThread {
                val resolve = { res: JSONObject -> web.evaluateJavascript("window.halcyonAndroidResolve && window.halcyonAndroidResolve($id, $res)", null) }
                when (method) {
                    "enable" -> enablePush(resolve)
                    else -> resolve(JSONObject().put("error", "Unknown: $method"))
                }
            }
        }

        @JavascriptInterface
        fun setOn(on: Boolean) { if (trusted()) Prefs.setPushOn(this@MainActivity, on) }

        @JavascriptInterface
        fun ready() = runOnUiThread {
            if (!trusted()) return@runOnUiThread
            ready = true
            pending?.let { open(it) }
            pending = null
        }

        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            if (trusted()) downloads.saveBytes(Base64.decode(base64, Base64.DEFAULT), name, mime)
        }

        @JavascriptInterface
        fun retry() = runOnUiThread { load(last) }

        @JavascriptInterface
        fun changeServer() = runOnUiThread { startActivity(Intent(this@MainActivity, ConnectActivity::class.java)) }
    }
}

/** Long-press on the app icon: always opens that place, also when the app is already running. */
object Shortcuts {
    fun publish(ctx: Context) {
        val list = listOf(
            Triple("compose", R.string.sc_compose to R.string.sc_compose_short, "#/compose"),
            Triple("mail", R.string.sc_mail to R.string.sc_mail, "#/mail/unified"),
            Triple("calendar", R.string.sc_calendar to R.string.sc_calendar, "#/calendar"),
            Triple("tasks", R.string.sc_tasks to R.string.sc_tasks, "#/tasks"),
            Triple("contacts", R.string.sc_contacts to R.string.sc_contacts, "#/contacts"),
        )
        val icons = mapOf("compose" to R.drawable.sc_compose, "mail" to R.drawable.sc_mail, "calendar" to R.drawable.sc_calendar,
            "tasks" to R.drawable.sc_tasks, "contacts" to R.drawable.sc_contacts)
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx).coerceAtLeast(4)
        val shortcuts = list.take(max).mapIndexed { rank, (id, names, route) ->
            ShortcutInfoCompat.Builder(ctx, id)
                .setLongLabel(ctx.getString(names.first))
                .setShortLabel(ctx.getString(names.second))
                .setIcon(IconCompat.createWithResource(ctx, icons.getValue(id)))
                .setRank(rank)
                .setIntent(Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra(MainActivity.EXTRA_ROUTE, route))
                .build()
        }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(ctx, shortcuts) }
    }
}
