using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Halcyon;

/// <summary>Per-user (HKCU) registrations and small Windows shell helpers. Nothing here needs administrator rights.</summary>
public static class Shell
{
    public const string AppId = "Halcyon.Windows";        // AppUserModelID: toasts, taskbar grouping
    public const string Protocol = "halcyon-windows";      // toast clicks start the app with halcyon-windows:open?…
    const string MailtoProgId = "Halcyon.Windows.mailto";
    const string Client = @"Software\Clients\Mail\Halcyon";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "HalcyonWindows"; // the Electron app uses its own entry

    public static string Exe => Environment.ProcessPath ?? Application.ExecutablePath;
    static string Command => $"\"{Exe}\" \"%1\"";

    /// <summary>Written on every start, so a moved or updated app still gets its links and toast clicks.</summary>
    public static void Register()
    {
        SetCurrentProcessExplicitAppUserModelID(AppId);
        RegisterAppId();
        using (var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Protocol}"))
        {
            k.SetValue("", "URL:Halcyon");
            k.SetValue("URL Protocol", "");
            using var c = k.CreateSubKey(@"shell\open\command");
            c.SetValue("", Command);
        }
        // mailto: Windows lets the user choose the default (Settings → Default apps); the app only offers itself.
        using (var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{MailtoProgId}"))
        {
            k.SetValue("", "Halcyon mail link");
            k.SetValue("URL Protocol", "");
            using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", $"\"{Exe}\",0");
            using var c = k.CreateSubKey(@"shell\open\command");
            c.SetValue("", Command);
        }
        using (var k = Registry.CurrentUser.CreateSubKey(Client))
        {
            k.SetValue("", "Halcyon");
            using var cap = k.CreateSubKey("Capabilities");
            cap.SetValue("ApplicationName", "Halcyon");
            cap.SetValue("ApplicationDescription", "Mail, calendar and contacts on your Halcyon server");
            cap.SetValue("ApplicationIcon", $"\"{Exe}\",0");
            using var u = cap.CreateSubKey("URLAssociations");
            u.SetValue("mailto", MailtoProgId);
        }
        using (var k = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications")) k.SetValue("Halcyon", $@"{Client}\Capabilities");
        // Start at login keeps pointing at this copy of the app.
        if (StartsAtLogin) StartsAtLogin = true;
        SHChangeNotify(0x08000000, 0, 0, 0); // SHCNE_ASSOCCHANGED
    }

    /// <summary>Before a toast: without the name it shows under (AppUserModelId) Windows drops toasts without an error,
    /// so everything is written again when something removed it meanwhile (an older copy's uninstaller runs --unregister).</summary>
    public static void EnsureRegistered()
    {
        using (var r = Registry.CurrentUser.OpenSubKey($@"Software\Classes\AppUserModelId\{AppId}")) if (r?.GetValue("DisplayName") is string) return;
        Log.Write("registration was removed: written again");
        Register();
    }

    static void RegisterAppId()
    {
        using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{AppId}");
        k.SetValue("DisplayName", "Halcyon");
        var icon = Icons.ToastIcon("mail");
        if (icon != null) k.SetValue("IconUri", icon);
        k.SetValue("IconBackgroundColor", "FF2563EB");
    }

    /// <summary>Uninstall: Halcyon.exe --unregister.</summary>
    public static void Unregister()
    {
        foreach (var k in new[] { $@"Software\Classes\AppUserModelId\{AppId}", $@"Software\Classes\{Protocol}", $@"Software\Classes\{MailtoProgId}", Client, Self })
            Registry.CurrentUser.DeleteSubKeyTree(k, false);
        using (var r = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true)) r?.DeleteValue("Halcyon", false);
        using (var r = Registry.CurrentUser.OpenSubKey(RunKey, true)) r?.DeleteValue(RunName, false);
        SHChangeNotify(0x08000000, 0, 0, 0);
    }

    public static bool StartsAtLogin
    {
        get { using var r = Registry.CurrentUser.OpenSubKey(RunKey); return r?.GetValue(RunName) is string; }
        set
        {
            using var r = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) r.SetValue(RunName, $"\"{Exe}\" --hidden"); else r.DeleteValue(RunName, false);
        }
    }

    /// <summary>Settings → Default apps, at Halcyon's page where Windows 11 has one.</summary>
    public static void ChooseMailtoDefault()
    {
        try { Open("ms-settings:defaultapps?registeredAppUser=Halcyon"); }
        catch { Open("ms-settings:defaultapps"); }
    }

    public static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    // Halcyon and Inkwell (notes) open each other's links in their apps: each one says where it is and which server it
    // shows (HKCU\Software\<app>\Windows: Exe, Server), and takes links with --link <url>.
    const string Self = @"Software\Halcyon\Windows", Inkwell = @"Software\Inkwell\Windows";

    public static void Announce(string server)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(Self);
            k.SetValue("Exe", Exe);
            k.SetValue("Server", Config.Origin(server));
        }
        catch { /* registry refused: Inkwell's links then open in the browser */ }
    }

    /// <summary>A web link leaving the app: Inkwell's app for a page of its server when it is installed, else the browser.</summary>
    public static void OpenLink(string url)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(Inkwell);
            if (k?.GetValue("Exe") is string exe && k.GetValue("Server") is string server && server.Length > 0 && File.Exists(exe)
                && Config.Origin(url).Equals(server, StringComparison.OrdinalIgnoreCase))
            {
                AllowAnyForeground();
                var p = new ProcessStartInfo(exe) { UseShellExecute = false };
                p.ArgumentList.Add("--link");
                p.ArgumentList.Add(url);
                Process.Start(p);
                return;
            }
        }
        catch (Exception x) { Log.Write("inkwell: " + x.Message); }
        Open(url);
    }

    public static string Downloads
    {
        get
        {
            try
            {
                if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, 0, out var p) == 0)
                {
                    var s = Marshal.PtrToStringUni(p);
                    Marshal.FreeCoTaskMem(p);
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    /// <summary>A free file name in a folder: "name (2).ext" when "name.ext" exists.</summary>
    public static string FreeName(string dir, string name)
    {
        name = string.Join("_", name.Split(Path.GetInvalidFileNameChars())).Trim();
        if (name.Length == 0) name = "download";
        var path = Path.Combine(dir, name);
        for (var i = 2; File.Exists(path); i++) path = Path.Combine(dir, $"{Path.GetFileNameWithoutExtension(name)} ({i}){Path.GetExtension(name)}");
        return path;
    }

    /// <summary>Brings a window of this app to the front (Windows allows it after a click on its toast or tray icon,
    /// or when the starting instance handed over with AllowSetForegroundWindow).</summary>
    public static void Front(Form f)
    {
        if (!f.Visible) f.Show();
        if (f.WindowState == FormWindowState.Minimized) ShowWindow(f.Handle, 9); // SW_RESTORE
        f.Activate();
        SetForegroundWindow(f.Handle);
    }

    public static void AllowAnyForeground() => AllowSetForegroundWindow(-1);

    // Taskbar overlay (the unread badge on the taskbar button).
    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eee6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList3
    {
        void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h);
        void MarkFullscreenWindow(IntPtr h, [MarshalAs(UnmanagedType.Bool)] bool full);
        void SetProgressValue(IntPtr h, ulong done, ulong total); void SetProgressState(IntPtr h, int flags);
        void RegisterTab(IntPtr tab, IntPtr main); void UnregisterTab(IntPtr tab); void SetTabOrder(IntPtr tab, IntPtr before);
        void SetTabActive(IntPtr tab, IntPtr main, uint reserved); void ThumbBarAddButtons(IntPtr h, uint n, IntPtr buttons);
        void ThumbBarUpdateButtons(IntPtr h, uint n, IntPtr buttons); void ThumbBarSetImageList(IntPtr h, IntPtr list);
        void SetOverlayIcon(IntPtr h, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string? description);
    }
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] class TaskbarList { }
    static ITaskbarList3? taskbar;

    public static void Overlay(IntPtr window, Icon? icon, string description)
    {
        try
        {
            if (taskbar == null) { taskbar = (ITaskbarList3)new TaskbarList(); taskbar.HrInit(); }
            taskbar.SetOverlayIcon(window, icon?.Handle ?? IntPtr.Zero, icon == null ? null : description);
        }
        catch { /* no taskbar (e.g. Explorer restarting) */ }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("shell32.dll")] static extern void SHChangeNotify(int eventId, uint flags, IntPtr a, IntPtr b);
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(in Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
}
