package cc.halcyon.mail

import android.content.Context
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * CA certificates the user added in the app (a server with a certificate from their own CA). The phone's own trust
 * store (system and user-installed CAs, network_security_config.xml) is always used first; these come on top, for
 * the WebView (onReceivedSslError) and for the app's own downloads.
 */
object Trust {
    private fun dir(ctx: Context) = File(ctx.filesDir, "ca").apply { mkdirs() }
    private val factory: CertificateFactory get() = CertificateFactory.getInstance("X.509")

    fun cas(ctx: Context): List<X509Certificate> = dir(ctx).listFiles().orEmpty().sortedBy { it.name }.mapNotNull { f ->
        runCatching { factory.generateCertificate(f.inputStream()) as X509Certificate }.getOrNull()
    }

    /** Adds a certificate (PEM or DER); returns its subject. */
    fun add(ctx: Context, bytes: ByteArray): String {
        val cert = factory.generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
        val sha = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
        File(dir(ctx), "$sha.crt").writeBytes(cert.encoded)
        return name(cert)
    }

    fun clear(ctx: Context) = dir(ctx).listFiles().orEmpty().forEach { it.delete() }

    fun name(c: X509Certificate): String =
        Regex("CN=([^,]+)").find(c.subjectX500Principal.name)?.groupValues?.get(1) ?: c.subjectX500Principal.name

    private fun custom(ctx: Context): X509TrustManager? {
        val list = cas(ctx).ifEmpty { return null }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        list.forEachIndexed { i, c -> ks.setCertificateEntry("ca$i", c) }
        return tm(ks)
    }

    private fun tm(ks: KeyStore?): X509TrustManager {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(ks)
        return f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** The phone's trust store, then the CAs added here. */
    fun trustManager(ctx: Context): X509TrustManager {
        val system = tm(null)
        val mine = custom(ctx) ?: return system
        return object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                try { system.checkServerTrusted(chain, authType) } catch (e: Exception) { mine.checkServerTrusted(chain, authType) }
            }
            override fun getAcceptedIssuers() = system.acceptedIssuers + mine.acceptedIssuers
        }
    }

    fun socketFactory(ctx: Context): SSLSocketFactory =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager(ctx)), null) }.socketFactory

    /**
     * The WebView refused a certificate: accept it only for the user's own server, when the one problem is the
     * issuer (not the name or the dates) and a CA added here signed it.
     */
    fun acceptsWebView(ctx: Context, error: SslError): Boolean {
        val bad = listOf(SslError.SSL_IDMISMATCH, SslError.SSL_EXPIRED, SslError.SSL_NOTYETVALID, SslError.SSL_DATE_INVALID)
        if (bad.any { error.hasError(it) }) return false
        val server = Prefs.server(ctx) ?: return false
        if (Uri.parse(error.url).host != Uri.parse(server).host) return false
        val mine = custom(ctx) ?: return false
        val cert = x509(error.certificate) ?: return false
        return runCatching { mine.checkServerTrusted(arrayOf(cert), if (cert.publicKey.algorithm == "EC") "ECDHE_ECDSA" else "ECDHE_RSA") }.isSuccess
    }

    private fun x509(c: SslCertificate): X509Certificate? {
        if (Build.VERSION.SDK_INT >= 29) return c.x509Certificate
        // Before Android 10 the certificate is only reachable through its saved state.
        val bytes = SslCertificate.saveState(c).getByteArray("x509-certificate") ?: return null
        return runCatching { factory.generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate }.getOrNull()
    }
}
