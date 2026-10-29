package cc.halcyon.mail

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging: the server sends high-priority data messages (title, body, url, tag, kind, silent, as —
 * server/src/notifications.js); the app draws the notification itself, so it looks and opens the same in every state.
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // The web app registers it with the server the next time it starts (push.js).
        Prefs.setToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (!Prefs.pushOn(this)) return
        Notifications.show(this, message.data)
    }
}

object Notifications {
    const val MAIL = "mail"
    const val MAIL_QUIET = "mail_quiet"
    const val REMINDERS = "reminders"

    fun channels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel(MAIL, ctx.getString(R.string.ch_mail), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(MAIL_QUIET, ctx.getString(R.string.ch_mail_quiet), NotificationManager.IMPORTANCE_LOW).apply { setSound(null, null); enableVibration(false) },
            NotificationChannel(REMINDERS, ctx.getString(R.string.ch_reminders), NotificationManager.IMPORTANCE_HIGH),
        ))
    }

    fun allowed(ctx: Context) = NotificationManagerCompat.from(ctx).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    @SuppressLint("MissingPermission") // allowed() checked it
    fun show(ctx: Context, d: Map<String, String>) {
        if (!allowed(ctx)) return
        channels(ctx)
        val reminder = d["kind"] == "reminder"
        val channel = if (reminder) REMINDERS else if (d["silent"] == "true") MAIL_QUIET else MAIL
        val tag = d["tag"].orEmpty().ifEmpty { d["kind"].orEmpty() }
        val open = Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_ROUTE, d["url"].orEmpty().ifEmpty { "#/mail/unified" })
            .putExtra(MainActivity.EXTRA_AS, d["as"].orEmpty())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(ctx, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = d["body"].orEmpty()
        val n = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ContextCompat.getColor(ctx, R.color.brand))
            .setContentTitle(d["title"].orEmpty().ifEmpty { "Halcyon" })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (reminder) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_EMAIL)
            .setPriority(if (channel == MAIL_QUIET) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setSilent(channel == MAIL_QUIET)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try { NotificationManagerCompat.from(ctx).notify(tag, 1, n) } catch (_: SecurityException) { }
    }
}
