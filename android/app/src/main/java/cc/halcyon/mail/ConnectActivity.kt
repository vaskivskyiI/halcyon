package cc.halcyon.mail

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.doAfterTextChanged
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException

/** First start (and "Change server"): the server's address, checked before it is saved; a CA of one's own. */
class ConnectActivity : ComponentActivity() {
    private lateinit var url: EditText
    private lateinit var error: TextView
    private lateinit var go: Button
    private val pool = Executors.newSingleThreadExecutor()

    private val pickCa = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@registerForActivityResult
        try {
            val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            Toast.makeText(this, "Added: ${Trust.add(this, bytes)}", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Not a certificate: ${e.message}", Toast.LENGTH_LONG).show()
        }
        showCas()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_connect)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }
        url = findViewById(R.id.url)
        error = findViewById(R.id.error)
        go = findViewById(R.id.go)
        val warn = findViewById<TextView>(R.id.warn)
        url.doAfterTextChanged { warn.visibility = if (it.toString().trim().startsWith("http://", true)) View.VISIBLE else View.GONE }
        url.setText(Prefs.server(this) ?: BuildConfig.DEFAULT_SERVER.let { if (it.isEmpty() || it.contains("://")) it else "https://$it" })
        url.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_GO) { connect(); true } else false }
        go.setOnClickListener { connect() }
        findViewById<Button>(R.id.addCa).setOnClickListener {
            pickCa.launch(arrayOf("application/x-x509-ca-cert", "application/x-pem-file", "application/pkix-cert", "application/octet-stream", "*/*"))
        }
        findViewById<Button>(R.id.clearCa).setOnClickListener { Trust.clear(this); showCas() }
        showCas()
    }

    private fun showCas() {
        val cas = Trust.cas(this)
        findViewById<TextView>(R.id.cas).text = if (cas.isEmpty()) getString(R.string.ca_none) else cas.joinToString("\n") { "✓ " + Trust.name(it) }
        findViewById<Button>(R.id.clearCa).visibility = if (cas.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun connect() {
        val server = Prefs.normalize(url.text.toString()) ?: return fail("Enter the server address, e.g. https://mail.example.com")
        error.visibility = View.GONE
        go.isEnabled = false
        go.setText(R.string.connect_checking)
        pool.execute {
            val problem = try {
                val c = URL("$server/api/health").openConnection() as HttpURLConnection
                if (c is HttpsURLConnection) c.sslSocketFactory = Trust.socketFactory(this)
                c.connectTimeout = 15000
                c.readTimeout = 15000
                val body = if (c.responseCode == 200) c.inputStream.bufferedReader().use { it.readText() } else ""
                if (!body.contains("\"ok\"")) "No Halcyon server answers at $server (HTTP ${c.responseCode})." else null
            } catch (e: SSLException) {
                "The server's certificate is not trusted by this phone. If it comes from your own CA, add that CA certificate below (or install it in Android's settings). (${e.message})"
            } catch (e: Exception) {
                "$server cannot be reached: ${e.message}"
            }
            runOnUiThread {
                go.isEnabled = true
                go.setText(R.string.connect_go)
                if (problem != null) return@runOnUiThread fail(problem)
                Prefs.setServer(this, server)
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
        }
    }

    private fun fail(text: String) {
        error.text = text
        error.visibility = View.VISIBLE
    }
}
