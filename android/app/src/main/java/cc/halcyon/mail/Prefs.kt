package cc.halcyon.mail

import android.content.Context

/** What the app remembers: the server, and whether this device gets push from it (with its current FCM token). */
object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("halcyon", Context.MODE_PRIVATE)

    fun server(ctx: Context): String? = p(ctx).getString("server", null)

    fun setServer(ctx: Context, url: String) {
        // Another server: push has to be turned on there again.
        if (url != server(ctx)) p(ctx).edit().putString("server", url).putBoolean("push_on", false).apply()
    }

    fun pushOn(ctx: Context) = p(ctx).getBoolean("push_on", false)
    fun setPushOn(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("push_on", on).apply()

    fun token(ctx: Context): String? = p(ctx).getString("fcm_token", null)
    fun setToken(ctx: Context, token: String?) = p(ctx).edit().putString("fcm_token", token).apply()

    /** "https://mail.example.com" from what was typed (no path, no trailing slash; https when no scheme). */
    fun normalize(input: String): String? {
        var s = input.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = android.net.Uri.parse(s)
        if (u.scheme !in listOf("http", "https") || u.host.isNullOrEmpty()) return null
        val path = u.path?.trimEnd('/').orEmpty()
        return "${u.scheme}://${u.authority}$path"
    }
}
