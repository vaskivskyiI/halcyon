using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Halcyon;

/// <summary>The user's Halcyon server in WebView2, with a tray icon, the unread badge, toasts for what the web app
/// notifies and mailto: links. The page talks to this window through window.halcyonDesktop (the same surface the
/// Electron preload gives it, see Bridge.js) and a Notification shim, so web/src needs no changes.</summary>
public sealed class MainForm : Form
{
    const string Home = "#/mail/unified";
    readonly Config config;
    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
    readonly NotifyIcon tray = new();
    CoreWebView2Environment? env;
    string? scriptId;
    string startRoute;
    bool pageOk, quitting, hiddenStart;
    int unread;
    string badgeUrl = "";
    Icon? overlay;
    readonly HashSet<string> openAfter = new();

    string Server => config.Server;
    string Origin => Config.Origin(config.Server);

    public MainForm(Config config, string[] args)
    {
        this.config = config;
        startRoute = LinkRoute(args) ?? RouteOf(args) ?? Home;
        Text = "Halcyon";
        Icon = Icons.App;
        MinimumSize = new Size(380, 500);
        AutoScaleMode = AutoScaleMode.Dpi;
        Size = new Size(1400, 900);
        StartPosition = FormStartPosition.CenterScreen;
        if (config.Bounds is { Length: 4 } b)
        {
            var r = new Rectangle(b[0], b[1], Math.Max(b[2], 380), Math.Max(b[3], 500));
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) { StartPosition = FormStartPosition.Manual; Bounds = r; }
        }
        if (config.Maximized) WindowState = FormWindowState.Maximized;
        Controls.Add(web);
        BuildTray();
        ResizeEnd += (_, _) => KeepBounds();
        Resize += (_, _) => { if (WindowState != FormWindowState.Minimized) config.Maximized = WindowState == FormWindowState.Maximized; };
        Shown += (_, _) => ApplyBadge();
        VisibleChanged += (_, _) => { if (Visible) ApplyBadge(); };
        HandleCreated += async (_, _) => await Init();
    }

    /// <summary>Started at login: the page runs (for notifications and the unread count) with the window hidden.</summary>
    public void StartHidden()
    {
        hiddenStart = true;
        _ = Handle;     // HandleCreated → Init
        _ = web.Handle; // WebView2 starts once its own window exists
    }

    protected override void SetVisibleCore(bool value) => base.SetVisibleCore(!hiddenStart && value);

    void KeepBounds()
    {
        if (WindowState != FormWindowState.Normal) return;
        config.Bounds = new[] { Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height };
        Save();
    }

    void Save() { try { config.Save(); } catch (Exception e) { Log.Write("config: " + e.Message); } }

    async Task Init()
    {
        try
        {
            env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Config.LocalDir, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show("Halcyon needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and most Windows 10 PCs. Open the download page?", "Halcyon", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                Shell.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            Quit();
            return;
        }
        var core = web.CoreWebView2;
        core.Settings.UserAgent += $" HalcyonWindows/{Application.ProductVersion.Split('+')[0]}";
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = true;
        core.DocumentTitleChanged += (_, _) => { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Halcyon" : core.DocumentTitle; };
        core.WebMessageReceived += (_, e) => Message(core, e, true);
        core.NavigationStarting += (_, e) =>
        {
            var u = e.Uri;
            if (u.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; Go(Compose(u)); return; }
            if (Ours(u) || u.StartsWith("about:") || u.StartsWith("data:")) { pageOk = false; return; }
            // The window only ever shows the server; everything else opens in the default browser.
            e.Cancel = true;
            if (u.StartsWith("http:") || u.StartsWith("https:")) Shell.OpenLink(u);
        };
        core.NavigationCompleted += (_, e) =>
        {
            var src = core.Source;
            if (e.IsSuccess) { pageOk = Ours(src); return; }
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled || !Ours(src)) return;
            pageOk = false;
            Problem(e.WebErrorStatus is CoreWebView2WebErrorStatus.CertificateIsInvalid or CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect or CoreWebView2WebErrorStatus.CertificateExpired
                ? $"The certificate of {new Uri(Server).Host} is not trusted by this PC. If it comes from your own CA, add that CA certificate (Change server → Add CA certificate) or install it in Windows."
                : $"{Server} cannot be reached{(e.WebErrorStatus == CoreWebView2WebErrorStatus.Unknown ? "" : $" ({e.WebErrorStatus})")}. Check the network or VPN, or whether the server is running.");
        };
        Wire(core);
        await Inject();
        core.Navigate($"{Server}/{startRoute}");
    }

    /// <summary>What the main window and its pop-ups share: links, downloads, certificates.</summary>
    void Wire(CoreWebView2 core)
    {
        core.NewWindowRequested += (_, e) => NewWindow(core, e);
        core.LaunchingExternalUriScheme += (_, e) =>
        {
            if (!e.Uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) return; // other schemes: Edge's own prompt
            e.Cancel = true;
            Go(Compose(e.Uri));
        };
        core.DownloadStarting += (_, e) =>
        {
            var url = e.DownloadOperation.Uri;
            var name = Path.GetFileName(e.ResultFilePath);
            if (openAfter.Remove(url))
            {
                // A preview (?inline=1): opened in the default app for that file type, like the Android app does.
                var dir = Path.Combine(Path.GetTempPath(), "Halcyon", Guid.NewGuid().ToString("N")[..8]);
                Directory.CreateDirectory(dir);
                e.ResultFilePath = Path.Combine(dir, name);
                e.Handled = true;
                e.DownloadOperation.StateChanged += (_, _) =>
                {
                    if (e.DownloadOperation.State == CoreWebView2DownloadState.Completed) try { Shell.Open(e.DownloadOperation.ResultFilePath); } catch (Exception x) { Log.Write("open: " + x.Message); }
                };
                return;
            }
            var downloads = Shell.Downloads;
            Directory.CreateDirectory(downloads);
            e.ResultFilePath = Shell.FreeName(downloads, name);
        };
        core.ServerCertificateErrorDetected += (_, e) =>
        {
            try
            {
                var host = new Uri(e.RequestUri).Host;
                if (Trust.Accepts(e.ServerCertificate.ToX509Certificate2(), host, Server)) e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
            }
            catch (Exception x) { Log.Write("certificate: " + x.Message); }
        };
    }

    /// <summary>window.open / target=_blank. The server's files download (previews open in their app), its pages and
    /// sign-in pop-ups (OAuth needs its opener) get a window of this app, other links open in the browser.</summary>
    async void NewWindow(CoreWebView2 from, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var u = e.Uri;
        if (u.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) { e.Handled = true; Go(Compose(u)); return; }
        if (Ours(u) && Uri.TryCreate(u, UriKind.Absolute, out var uri) && uri.AbsolutePath.Contains("/api/") && !uri.AbsolutePath.Contains("/api/oauth/"))
        {
            e.Handled = true;
            Download(from, u);
            return;
        }
        if (Ours(u) || u.Length == 0 || u.StartsWith("about:blank"))
        {
            var deferral = e.GetDeferral();
            try
            {
                var popup = new PopupForm(e.WindowFeatures);
                popup.Show(this);
                await popup.Web.EnsureCoreWebView2Async(env);
                var core = popup.Web.CoreWebView2;
                core.Settings.UserAgent = web.CoreWebView2.Settings.UserAgent;
                core.WebMessageReceived += (_, m) => Message(core, m, false);
                core.NavigationStarting += (_, n) =>
                {
                    if (!n.Uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) return;
                    n.Cancel = true;
                    Go(Compose(n.Uri));
                };
                Wire(core);
                if (scriptId != null) await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge());
                e.NewWindow = core;
                e.Handled = true;
            }
            catch (Exception x) { Log.Write("popup: " + x.Message); }
            finally { deferral.Complete(); }
            return;
        }
        e.Handled = true;
        if (u.StartsWith("http:") || u.StartsWith("https:")) Shell.OpenLink(u);
    }

    /// <summary>A file of the server, fetched by the page itself (session cookie, no navigation away).</summary>
    void Download(CoreWebView2 core, string url)
    {
        var preview = url.Contains("inline=1");
        url = url.Replace("inline=1", "inline=0");
        if (preview) openAfter.Add(url);
        core.ExecuteScriptAsync($"(() => {{ const a = document.createElement('a'); a.href = {JsonSerializer.Serialize(url)}; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }})()");
    }

    async Task Inject()
    {
        var core = web.CoreWebView2;
        if (scriptId != null) core.RemoveScriptToExecuteOnDocumentCreated(scriptId);
        scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge());
    }

    string Bridge()
    {
        using var s = typeof(MainForm).Assembly.GetManifestResourceStream("Bridge.js")!;
        using var r = new StreamReader(s);
        return r.ReadToEnd().Replace("__ORIGIN__", JsonSerializer.Serialize(Origin)).Replace("__VERSION__", JsonSerializer.Serialize(Application.ProductVersion.Split('+')[0]));
    }

    bool Ours(string url) => Origin.Length > 0 && Config.Origin(url).Equals(Origin, StringComparison.OrdinalIgnoreCase);

    /// <summary>Messages from Bridge.js (only from the server's pages) and from the error page (retry / change server).</summary>
    void Message(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs e, bool main)
    {
        JsonNode? m;
        try { m = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        var type = (string?)m?["type"];
        var local = e.Source.StartsWith("about:") || e.Source.StartsWith("data:");
        if (main && local)
        {
            if (type == "retry") web.CoreWebView2.Navigate($"{Server}/{Home}");
            if (type == "changeServer") ChangeServer();
            return;
        }
        if (!Ours(e.Source) || m == null) return;
        switch (type)
        {
            case "notify": Notify(m); break;
            case "close":
                var tag = ToastTag((string?)m["tag"], (string?)m["page"], (int?)m["id"]);
                try { Toasts.Remove(tag); } catch (Exception x) { Log.Write("toast remove: " + x.Message); }
                break;
            case "badge":
                if (!main) break;
                unread = (int?)m["count"] ?? 0;
                badgeUrl = (string?)m["dataUrl"] ?? "";
                ApplyBadge();
                break;
            case "show": Shell.Front(this); break;
            case "changeServer": ChangeServer(); break;
            case "info":
                var reply = new JsonObject { ["type"] = "reply", ["rid"] = (int?)m["rid"] ?? 0, ["value"] = new JsonObject { ["version"] = Application.ProductVersion.Split('+')[0], ["mode"] = "remote", ["serverUrl"] = Server, ["shell"] = "windows" } };
                core.PostWebMessageAsJson(reply.ToJsonString());
                break;
        }
    }

    static string ToastTag(string? tag, string? page, int? id) => !string.IsNullOrEmpty(tag) ? tag : $"n{page}-{id}";

    // Tags come from the server (notifications.js): mail-<id>, mail-batch-<folder>, rem-e<event>-<start>, rem-t<task>.
    static string KindOf(string tag) => tag.StartsWith("mail") ? "mail" : tag.StartsWith("rem-e") ? "calendar" : tag.StartsWith("rem-t") ? "task" : "other";
    static string RouteOfTag(string tag) =>
        tag.StartsWith("mail-batch") ? Home : tag.StartsWith("mail-") && long.TryParse(tag[5..], out var id) ? $"{Home}/{id}" :
        tag.StartsWith("rem-e") ? "#/calendar" : tag.StartsWith("rem-t") ? "#/tasks" : "";

    void Notify(JsonNode m)
    {
        var page = (string?)m["page"] ?? "";
        var id = (int?)m["id"] ?? 0;
        var tag = ToastTag((string?)m["tag"], page, id);
        var route = (string?)m["route"] ?? "";
        if (!route.StartsWith("#/")) route = RouteOfTag(tag);
        var launch = $"{Shell.Protocol}:open?page={Uri.EscapeDataString(page)}&id={id}&route={Uri.EscapeDataString(route)}";
        // Buttons (Mark read, Snooze, Mark done …; server notify-actions.js): pressed, the page asks the server to do it.
        var reference = (string?)m["ref"] ?? "";
        var shared = (string?)m["as"] ?? "";
        var buttons = new List<(string Label, string Uri)>();
        if (reference.Length > 0 && m["actions"] is JsonArray list)
            foreach (var a in list.OfType<JsonObject>())
            {
                var label = (string?)a["title"] ?? "";
                var action = (string?)a["id"] ?? "";
                var url = (string?)a["url"] ?? "";
                if (label.Length == 0 || action.Length == 0) continue;
                // A button that goes somewhere: Join opens the meeting in the browser; Reply opens the app at the reply
                // (a toast cannot hand typed text to an unpackaged app over its protocol).
                if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) buttons.Add((label, url));
                else if (url.StartsWith("#/")) buttons.Add((label, $"{Shell.Protocol}:open?page=&id=0&route={Uri.EscapeDataString(url)}"));
                else buttons.Add((label, $"{Shell.Protocol}:action?ref={Uri.EscapeDataString(reference)}&action={Uri.EscapeDataString(action)}&tag={Uri.EscapeDataString(tag)}&as={Uri.EscapeDataString(shared)}"));
            }
        var important = (bool?)m["important"] ?? false;
        try { Toasts.Show((string?)m["title"] ?? "Halcyon", (string?)m["body"] ?? "", tag, (bool?)m["silent"] ?? false, important ? "important" : KindOf(tag), launch, buttons); }
        catch (Exception x) { Log.Write("toast: " + x.Message); }
    }

    void ApplyBadge()
    {
        tray.Icon = Icons.Tray(unread, SystemInformation.SmallIconSize.Width);
        tray.Text = unread > 0 ? $"Halcyon — {unread} unread" : "Halcyon";
        if (!IsHandleCreated || !Visible) return;
        var next = unread > 0 ? Icons.FromDataUrl(badgeUrl, SystemInformation.SmallIconSize.Width) : null;
        Shell.Overlay(Handle, next, $"{unread} unread");
        overlay?.Dispose();
        overlay = next;
    }

    /// <summary>A second start of the app (mailto: link, toast click, Start menu) handed its arguments over.</summary>
    public void Arrive(string[] args)
    {
        // A toast's button: done in the background (the window stays where it is).
        var button = args.FirstOrDefault(a => a.StartsWith(Shell.Protocol + ":action?", StringComparison.OrdinalIgnoreCase));
        if (button != null)
        {
            var q = HttpUtility.ParseQueryString(new Uri(button).Query);
            if (pageOk) web.CoreWebView2.PostWebMessageAsJson(new JsonObject { ["type"] = "notification-action", ["ref"] = q["ref"] ?? "", ["action"] = q["action"] ?? "", ["tag"] = q["tag"] ?? "", ["as"] = q["as"] ?? "" }.ToJsonString());
            try { Toasts.Remove(q["tag"] ?? ""); } catch (Exception x) { Log.Write("toast remove: " + x.Message); }
            return;
        }
        hiddenStart = false;
        Shell.Front(this);
        if (LinkRoute(args) is string link) { Go(link); return; }
        var click = args.FirstOrDefault(a => a.StartsWith(Shell.Protocol + ":", StringComparison.OrdinalIgnoreCase));
        if (click != null && pageOk)
        {
            var q = HttpUtility.ParseQueryString(new Uri(click).Query);
            var route = q["route"] ?? "";
            var msg = new JsonObject { ["type"] = "notification-click", ["page"] = q["page"] ?? "", ["id"] = int.TryParse(q["id"], out var id) ? id : 0, ["route"] = route.StartsWith("#/") ? route : "" };
            web.CoreWebView2.PostWebMessageAsJson(msg.ToJsonString());
            return;
        }
        var r = RouteOf(args);
        if (r != null) Go(r);
    }

    /// <summary>Where a start's arguments point: a mailto: link → a new message, a toast → its place.</summary>
    static string? RouteOf(string[] args)
    {
        foreach (var a in args)
        {
            if (a.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) return Compose(a);
            if (a.StartsWith(Shell.Protocol + ":", StringComparison.OrdinalIgnoreCase) && Uri.TryCreate(a, UriKind.Absolute, out var u))
            {
                var route = HttpUtility.ParseQueryString(u.Query)["route"] ?? "";
                return route.StartsWith("#/") ? route : Home; // only places inside the web app: any program may start this
            }
        }
        return null;
    }

    /// <summary>--link &lt;url&gt; (from Inkwell's app): a page of this server → its route; another address opens in the
    /// browser (Inkwell only hands over links to this server, but any program may start the app).</summary>
    string? LinkRoute(string[] args)
    {
        var i = Array.IndexOf(args, "--link");
        if (i < 0 || i + 1 >= args.Length) return null;
        var url = args[i + 1];
        if (!Ours(url)) { if (url.StartsWith("http:") || url.StartsWith("https:")) Shell.Open(url); return Home; }
        var rest = url[Math.Min(url.Length, Server.Length)..].TrimStart('/');
        return url.StartsWith(Server, StringComparison.OrdinalIgnoreCase) && rest.StartsWith("#/") ? rest : Home;
    }

    static string Compose(string mailto) => "#/compose?url=" + Uri.EscapeDataString(mailto);

    /// <summary>Moves the running page to a route; a page that is not loaded (yet) is loaded there.</summary>
    void Go(string route)
    {
        Shell.Front(this);
        if (web.CoreWebView2 == null) { startRoute = route; return; }
        if (pageOk) web.CoreWebView2.ExecuteScriptAsync($"location.hash = {JsonSerializer.Serialize(route)}");
        else web.CoreWebView2.Navigate($"{Server}/{route}");
    }

    void Problem(string text)
    {
        var esc = HttpUtility.HtmlEncode(text);
        web.CoreWebView2.NavigateToString($$"""
            <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
            <body style="font-family:'Segoe UI',system-ui,sans-serif;padding:40px 32px;max-width:640px">
            <h2 style="margin:0 0 10px">Halcyon</h2><p style="line-height:1.5">{{esc}}</p>
            <button onclick="chrome.webview.postMessage({type:'retry'})" style="height:36px;padding:0 18px;border:0;border-radius:8px;background:#2563EB;color:#fff;font-weight:600;cursor:pointer">Try again</button>
            <button onclick="chrome.webview.postMessage({type:'changeServer'})" style="height:36px;padding:0 14px;border:0;background:none;color:#2563EB;font-weight:600;cursor:pointer">Change server</button>
            </body>
            """);
    }

    void ChangeServer()
    {
        Shell.Front(this);
        using var f = new ConnectForm(Server, null);
        if (f.ShowDialog(this) != DialogResult.OK) return;
        config.Server = f.Server;
        Save();
        Shell.Announce(Server);
        if (web.CoreWebView2 == null) return;
        _ = Inject().ContinueWith(_ => BeginInvoke(() => web.CoreWebView2.Navigate($"{Server}/{Home}")));
    }

    void BuildTray()
    {
        tray.Icon = Icons.Tray(0, SystemInformation.SmallIconSize.Width);
        tray.Text = "Halcyon";
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Halcyon", null, (_, _) => { hiddenStart = false; Shell.Front(this); });
        menu.Items.Add("New message", null, (_, _) => { hiddenStart = false; Go("#/compose"); });
        menu.Items.Add("Calendar", null, (_, _) => { hiddenStart = false; Go("#/calendar"); });
        menu.Items.Add(new ToolStripSeparator());
        var login = new ToolStripMenuItem("Start at login") { CheckOnClick = true };
        login.Click += (_, _) => { try { Shell.StartsAtLogin = login.Checked; } catch (Exception x) { Log.Write("run key: " + x.Message); } };
        var keep = new ToolStripMenuItem("Keep running in the tray when closed") { CheckOnClick = true, Checked = config.CloseToTray };
        keep.Click += (_, _) => { config.CloseToTray = keep.Checked; Save(); };
        menu.Items.Add(login);
        menu.Items.Add(keep);
        menu.Items.Add("Use Halcyon for mailto: links…", null, (_, _) => Shell.ChooseMailtoDefault());
        menu.Items.Add("Change server…", null, (_, _) => { hiddenStart = false; ChangeServer(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => Quit());
        menu.Opening += (_, _) => login.Checked = Shell.StartsAtLogin;
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) { hiddenStart = false; Shell.Front(this); } };
        tray.Visible = true;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing && config.CloseToTray)
        {
            e.Cancel = true;
            Hide();
            if (!config.TrayHintShown)
            {
                config.TrayHintShown = true;
                Save();
                tray.ShowBalloonTip(5000, "Halcyon is still running", "Notifications keep coming. Quit from the tray icon's menu.", ToolTipIcon.None);
            }
            return;
        }
        KeepBounds();
        tray.Visible = false;
        base.OnFormClosing(e);
    }

    void Quit()
    {
        quitting = true;
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { tray.Dispose(); overlay?.Dispose(); }
        base.Dispose(disposing);
    }
}

/// <summary>A window the page opened (sign-in pop-up, print preview, a page of the app in its own window).</summary>
public sealed class PopupForm : Form
{
    public readonly WebView2 Web = new() { Dock = DockStyle.Fill };

    public PopupForm(CoreWebView2WindowFeatures f)
    {
        Text = "Halcyon";
        Icon = Icons.App;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterParent;
        Size = f.HasSize ? new Size((int)Math.Max(f.Width, 400), (int)Math.Max(f.Height, 300) + 40) : new Size(1100, 800);
        Controls.Add(Web);
        Web.CoreWebView2InitializationCompleted += (_, e) =>
        {
            if (!e.IsSuccess) return;
            Web.CoreWebView2.DocumentTitleChanged += (_, _) => Text = string.IsNullOrEmpty(Web.CoreWebView2.DocumentTitle) ? "Halcyon" : Web.CoreWebView2.DocumentTitle;
            Web.CoreWebView2.WindowCloseRequested += (_, _) => Close();
        };
    }
}

static class Log
{
    public static void Write(string line)
    {
        try
        {
            Directory.CreateDirectory(Config.LocalDir);
            var file = Path.Combine(Config.LocalDir, "halcyon.log");
            if (File.Exists(file) && new FileInfo(file).Length > 1_000_000) File.Delete(file);
            File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
        }
        catch { }
    }
}
