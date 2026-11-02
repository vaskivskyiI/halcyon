using System.Text.Json;

namespace Halcyon;

/// <summary>%APPDATA%\Halcyon\windows\config.json: the server and the window's place. The WebView2 profile (cookies,
/// cache) lives in %LOCALAPPDATA%\Halcyon\windows\WebView2. Its own folder: %APPDATA%\Halcyon\config.json belongs to
/// the Electron app (desktop/), which may be installed too.</summary>
public sealed class Config
{
    public string Server { get; set; } = "";
    public bool CloseToTray { get; set; } = true;
    public int[]? Bounds { get; set; } // x, y, width, height of the normal (not maximised) window
    public bool Maximized { get; set; }
    public bool TrayHintShown { get; set; }

    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Halcyon", "windows");
    public static string LocalDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Halcyon", "windows");
    static string FilePath => Path.Combine(Dir, "config.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static Config Load()
    {
        try { return JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath), Json) ?? new Config(); }
        catch { return new Config(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, FilePath, true);
    }

    /// <summary>"mail.example.com" → "https://mail.example.com"; no trailing slash, no path beyond the base.</summary>
    public static string? Normalize(string input)
    {
        var s = input.Trim().TrimEnd('/');
        if (s.Length == 0) return null;
        if (!s.Contains("://")) s = "https://" + s;
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http") || string.IsNullOrEmpty(u.Host)) return null;
        return (u.GetLeftPart(UriPartial.Authority) + u.AbsolutePath).TrimEnd('/');
    }

    public static string Origin(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : "";
}
