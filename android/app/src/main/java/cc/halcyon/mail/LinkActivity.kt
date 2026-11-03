package cc.halcyon.mail

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Links handed over by Inkwell (cc.inkwell.notes): a link to this app's server opens here, anything else in the
 * browser. Invisible; Inkwell sends every outside link this way while Halcyon is installed, and Halcyon does the same
 * for Inkwell (Links.outside).
 */
class LinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val u = intent.getStringExtra(Links.EXTRA_URL)?.let(Uri::parse)
        val server = Prefs.server(this)?.let(Uri::parse)
        if (u != null && server != null && Links.origin(u) == Links.origin(server)) {
            // The place in the web app: everything after the server address (its pages are #/… routes).
            val route = u.toString().removePrefix(Prefs.server(this)!!).trimStart('/').let { if (it.startsWith("#/")) it else "#/mail/unified" }
            startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra(MainActivity.EXTRA_ROUTE, route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        } else if (u != null) Links.browser(this, u)
        finish()
    }
}

object Links {
    const val EXTRA_URL = "url"
    private const val INKWELL = "cc.inkwell.notes"

    fun origin(u: Uri) = "${u.scheme}://${u.authority}".lowercase()

    fun browser(ctx: Context, u: Uri) {
        try { ctx.startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (_: ActivityNotFoundException) { android.widget.Toast.makeText(ctx, ctx.getString(R.string.no_app, u.toString()), android.widget.Toast.LENGTH_LONG).show() }
    }

    /** A web link leaving the app: to Inkwell when it is installed (it opens its own server's pages, the rest in the browser). */
    fun outside(ctx: Context, u: Uri) {
        if (u.scheme == "http" || u.scheme == "https") {
            try { return ctx.startActivity(Intent("$INKWELL.OPEN_LINK").setPackage(INKWELL).putExtra(EXTRA_URL, u.toString())) }
            catch (_: ActivityNotFoundException) { } catch (_: SecurityException) { }
        }
        browser(ctx, u)
    }
}
