using System.Net.Http;
using System.Text.RegularExpressions;

namespace Halcyon;

/// <summary>The server address, checked with GET /api/health before it is saved. A private CA's certificate can be
/// added here for a server whose certificate Windows does not trust.</summary>
public sealed class ConnectForm : Form
{
    public string Server { get; private set; } = "";
    readonly TextBox url = new() { PlaceholderText = "https://mail.example.com", Dock = DockStyle.Top };
    readonly Label note = new() { AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = Color.FromArgb(0x92, 0x40, 0x0e), Visible = false };
    readonly Label error = new() { AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = Color.FromArgb(0x99, 0x1b, 0x1b), Visible = false };
    readonly Label cas = new() { AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = SystemColors.GrayText };
    readonly Button connect = new() { Text = "Connect", AutoSize = true, Padding = new Padding(10, 2, 10, 2) };
    static readonly Regex Lan = new(@"^http://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/:]+\.(lan|local|internal|home\.arpa)(:|/|$))", RegexOptions.IgnoreCase);

    public ConnectForm(string current, string? problem)
    {
        Text = "Halcyon — Server";
        Icon = Icons.App;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Font = new Font("Segoe UI", 9.5f);
        Padding = new Padding(20);

        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Dock = DockStyle.Fill };
        var title = new Label { Text = "Connect to your Halcyon server", AutoSize = true, Font = new Font(Font.FontFamily, 13f, FontStyle.Bold), Margin = new Padding(0, 0, 0, 6) };
        var hint = new Label { Text = "The address you open Halcyon at in a browser. Mail, calendar and AI run on the server; this app shows it in its own window, with notifications and mailto: links.", AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = SystemColors.GrayText, Margin = new Padding(0, 0, 0, 12) };
        url.Width = 440;
        url.Text = current;
        url.TextChanged += (_, _) => Check();
        var addCa = new LinkLabel { Text = "Add CA certificate…", AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
        addCa.LinkClicked += (_, _) => AddCa();
        var clearCa = new LinkLabel { Text = "Remove added CA certificates", AutoSize = true };
        clearCa.LinkClicked += (_, _) => { Trust.Clear(); ShowCas(); };
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Width = 440, Margin = new Padding(0, 16, 0, 0) };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(10, 2, 10, 2) };
        buttons.Controls.Add(connect);
        buttons.Controls.Add(cancel);
        buttons.MinimumSize = new Size(440, 0);
        connect.Click += async (_, _) => await Save();
        AcceptButton = connect;
        CancelButton = cancel;

        foreach (Control c in new Control[] { title, hint, url, note, error, addCa, cas, clearCa, buttons }) layout.Controls.Add(c);
        Controls.Add(layout);
        if (!string.IsNullOrEmpty(problem)) Fail(problem);
        Check();
        ShowCas();
    }

    void Check()
    {
        var v = url.Text.Trim();
        note.Visible = v.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !Lan.IsMatch(v);
        note.Text = "Plain http: passwords and mail would cross the network unencrypted. Use https, or http only on your own network or a VPN.";
    }

    void ShowCas()
    {
        var list = Trust.All();
        cas.Text = list.Count == 0 ? "No CA certificates added (only needed for a server with a certificate from your own CA)." : "Trusted for this server: " + string.Join("; ", list.Select(c => c.GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType.SimpleName, false)));
    }

    void AddCa()
    {
        using var d = new OpenFileDialog { Title = "CA certificate", Filter = "Certificates (*.cer;*.crt;*.pem;*.der)|*.cer;*.crt;*.pem;*.der|All files|*.*" };
        if (d.ShowDialog(this) != DialogResult.OK) return;
        try { Trust.Add(d.FileName); error.Visible = false; }
        catch (Exception e) { Fail(e.Message); }
        ShowCas();
    }

    void Fail(string text) { error.Text = text; error.Visible = true; }

    async Task Save()
    {
        var server = Config.Normalize(url.Text);
        if (server == null) { Fail("Enter the server's address, e.g. https://mail.example.com"); return; }
        connect.Enabled = false;
        error.Visible = false;
        UseWaitCursor = true;
        try
        {
            await Health(server);
            Server = server;
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception e) { Fail(e.Message); }
        finally { connect.Enabled = true; UseWaitCursor = false; }
    }

    /// <summary>Is a Halcyon server answering there? Certificates are checked like the window does (Trust).</summary>
    public static async Task Health(string server)
    {
        var host = new Uri(server).Host;
        using var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, cert, _, errors) => errors == System.Net.Security.SslPolicyErrors.None || Trust.Accepts(cert, host, server),
        };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        HttpResponseMessage r;
        try { r = await http.GetAsync(server + "/api/health"); }
        catch (HttpRequestException e) when (e.InnerException is System.Security.Authentication.AuthenticationException)
        { throw new Exception($"The certificate of {host} is not trusted. If it comes from your own CA, add that CA certificate below (or install it in Windows)."); }
        catch (HttpRequestException e) { throw new Exception($"{server} cannot be reached: {e.Message}"); }
        catch (TaskCanceledException) { throw new Exception($"{server} did not answer within 10 seconds."); }
        if (!r.IsSuccessStatusCode) throw new Exception($"{server} answered {(int)r.StatusCode} {r.ReasonPhrase} — is this the address of a Halcyon server?");
        var body = await r.Content.ReadAsStringAsync();
        if (!body.TrimStart().StartsWith("{")) throw new Exception($"{server} is not a Halcyon server (its /api/health did not answer as Halcyon does).");
    }
}
