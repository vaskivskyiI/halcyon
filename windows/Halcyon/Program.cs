using System.IO.Pipes;
using System.Security.Principal;
using System.Text;

namespace Halcyon;

static class Program
{
    // One running copy per user: a second start (mailto: link, toast click, Start menu) hands its arguments over a
    // pipe that only this user can open, and the first one comes to the front.
    static readonly string Pipe = "Halcyon.Windows." + (WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName);

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Contains("--unregister")) { Shell.Unregister(); return; }
        using var mutex = new Mutex(true, @"Local\Halcyon.Windows", out var first);
        if (!first) { HandOver(args); return; }

        ApplicationConfiguration.Initialize();
        try { Shell.Register(); } catch { /* registry refused: links and toast clicks just won't reach the app */ }

        var config = Config.Load();
        if (string.IsNullOrEmpty(config.Server))
        {
            using var connect = new ConnectForm(config.Server, null);
            if (connect.ShowDialog() != DialogResult.OK) return;
            config.Server = connect.Server;
            config.Save();
        }
        Shell.Announce(config.Server);
        var main = new MainForm(config, args);
        Listen(main);
        Application.Run(new AppContext(main, args.Contains("--hidden")));
    }

    static void HandOver(string[] args)
    {
        try
        {
            Shell.AllowAnyForeground();
            using var c = new NamedPipeClientStream(".", Pipe, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            c.Connect(3000);
            var data = Encoding.UTF8.GetBytes(string.Join("\n", args.Length > 0 ? args : new[] { "--show" }));
            c.Write(data);
        }
        catch { /* the first copy is just closing */ }
    }

    static void Listen(MainForm main)
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var s = new NamedPipeServerStream(Pipe, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly);
                    s.WaitForConnection();
                    using var r = new StreamReader(s, Encoding.UTF8);
                    var args = r.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    if (main.IsHandleCreated) main.BeginInvoke(() => main.Arrive(args));
                }
                catch { Thread.Sleep(500); }
            }
        }) { IsBackground = true, Name = "single-instance" };
        t.Start();
    }

    /// <summary>Runs until Quit; the window may be hidden (tray) the whole time.</summary>
    sealed class AppContext : ApplicationContext
    {
        public AppContext(MainForm main, bool hidden)
        {
            main.FormClosed += (_, _) => ExitThread();
            if (hidden) main.StartHidden(); else main.Show();
        }
    }
}
