package cc.halcyon.mail

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
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
 * Firebase Cloud Messaging: the server sends high-priority messages (title, body, url, tag, kind, type, silent, as —
 * server/src/notifications.js) with a notification part that Google Play services shows itself while the app is in
 * the background; in the foreground the app draws it from the data. "action=close" takes notifications back (the mail
 * was read, the task done, the event is over).
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Prefs.setToken(this, token)
        // Registered right away: a token that changes while the app stays closed would otherwise get nothing.
        if (Prefs.pushOn(this)) Server.register(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        if (d["action"] == "close") return Notifications.cancel(this, d["tags"].orEmpty().split('\n'))
        if (!Prefs.pushOn(this)) return
        Notifications.show(this, d)
    }
}

/** A notification swiped away here: the server takes it back on the user's other devices. */
class DismissReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val tag = i.getStringExtra(MainActivity.EXTRA_TAG).orEmpty()
        if (tag.isNotEmpty()) Server.closed(ctx, tag, i.getStringExtra(MainActivity.EXTRA_AS).orEmpty())
    }
}

object Notifications {
    const val MAIL = "mail"
    const val MAIL_SILENT = "mail_silent"
    const val REMINDERS = "reminders"

    fun channels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        // The earlier silent channel had low importance: its notifications went to the silent section without
        // showing. Silent mail now pops up like the rest, only without sound.
        nm.deleteNotificationChannel("mail_quiet")
        nm.createNotificationChannels(listOf(
            NotificationChannel(MAIL, ctx.getString(R.string.ch_mail), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(MAIL_SILENT, ctx.getString(R.string.ch_mail_quiet), NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null); enableVibration(false) },
            NotificationChannel(REMINDERS, ctx.getString(R.string.ch_reminders), NotificationManager.IMPORTANCE_HIGH),
        ))
    }

    fun allowed(ctx: Context) = NotificationManagerCompat.from(ctx).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    private fun icon(type: String?) = when (type) {
        "event" -> R.drawable.ic_notify_event
        "task" -> R.drawable.ic_notify_task
        "mail" -> R.drawable.ic_notify_mail
        else -> R.drawable.ic_notify
    }

    @SuppressLint("MissingPermission") // allowed() checked it
    fun show(ctx: Context, d: Map<String, String>) {
        if (!allowed(ctx)) return
        channels(ctx)
        val reminder = d["kind"] == "reminder"
        val silent = d["silent"] == "true"
        val channel = if (reminder) REMINDERS else if (silent) MAIL_SILENT else MAIL
        val tag = d["tag"].orEmpty().ifEmpty { d["kind"].orEmpty() }
        val open = Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_ROUTE, d["url"].orEmpty().ifEmpty { "#/mail/unified" })
            .putExtra(MainActivity.EXTRA_AS, d["as"].orEmpty())
            .putExtra(MainActivity.EXTRA_TAG, tag)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(ctx, tag.hashCode(), open, flags)
        val dismissed = PendingIntent.getBroadcast(ctx, tag.hashCode(), Intent(ctx, DismissReceiver::class.java)
            .putExtra(MainActivity.EXTRA_TAG, tag).putExtra(MainActivity.EXTRA_AS, d["as"].orEmpty()), flags)
        val body = d["body"].orEmpty()
        val n = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(icon(d["type"]))
            .setColor(ContextCompat.getColor(ctx, R.color.brand))
            .setContentTitle(d["title"].orEmpty().ifEmpty { "Halcyon" })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (reminder) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_EMAIL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setSilent(silent && !reminder)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setDeleteIntent(dismissed)
            .build()
        try { NotificationManagerCompat.from(ctx).notify(tag, 1, n) } catch (_: SecurityException) { }
    }

    /** Takes notifications back: drawn by the app (id 1) or by Google Play services from the notification part (id 0). */
    fun cancel(ctx: Context, tags: List<String>) {
        val nm = NotificationManagerCompat.from(ctx)
        for (t in tags.filter { it.isNotEmpty() }) { nm.cancel(t, 1); nm.cancel(t, 0) }
    }
}
