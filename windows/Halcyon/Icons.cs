using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Halcyon;

/// <summary>The app icon (halcyon.ico, made by windows/tools/make-icon.ps1), the per-kind toast icons and the tray
/// icon with the unread count, drawn with GDI+ so no image files ship besides the .ico.</summary>
public static class Icons
{
    static Icon? app;
    public static Icon App => app ??= new Icon(typeof(Icons).Assembly.GetManifestResourceStream("halcyon.ico")!);
    public static Icon AppSized(int size) => new(App, size, size);

    static string IconDir => Path.Combine(Config.LocalDir, "icons");

    /// <summary>Writes the toast icons (once per start) and returns the file for a kind; null if it cannot be written.</summary>
    public static string? ToastIcon(string kind)
    {
        var file = Path.Combine(IconDir, kind + ".png");
        if (File.Exists(file) && File.GetLastWriteTimeUtc(file) > started) return file;
        try
        {
            Directory.CreateDirectory(IconDir);
            using var bmp = Draw(kind, 96);
            bmp.Save(file, ImageFormat.Png);
            return file;
        }
        catch { return File.Exists(file) ? file : null; }
    }
    static readonly DateTime started = DateTime.UtcNow.AddSeconds(-5);

    /// <summary>Gradient rounded square with a white glyph, 64×64 units scaled to size (like web/public/icon.svg).</summary>
    public static Bitmap Draw(string kind, int size)
    {
        var (from, to) = kind switch
        {
            "calendar" => (Color.FromArgb(0x2d, 0xd4, 0xbf), Color.FromArgb(0x0d, 0x94, 0x88)),
            "task" => (Color.FromArgb(0x4a, 0xde, 0x80), Color.FromArgb(0x16, 0xa3, 0x4a)),
            "other" => (Color.FromArgb(0xa7, 0x8b, 0xfa), Color.FromArgb(0x7c, 0x3a, 0xed)),
            _ => (Color.FromArgb(0x38, 0xbd, 0xf8), Color.FromArgb(0x25, 0x63, 0xeb)),
        };
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Transparent);
        g.ScaleTransform(size / 64f, size / 64f);
        using (var sq = Rounded(0, 0, 64, 64, 14))
        using (var grad = new LinearGradientBrush(new PointF(0, 0), new PointF(64, 64), from, to)) g.FillPath(grad, sq);
        using var white = new SolidBrush(Color.FromArgb(242, 255, 255, 255));
        using var soft = new SolidBrush(Color.FromArgb(178, 255, 255, 255));
        using var pen = new Pen(Color.White, 5) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        switch (kind)
        {
            case "calendar":
                using (var page = Rounded(14, 16, 36, 34, 5)) g.FillPath(white, page);
                using (var top = Rounded(14, 16, 36, 10, 5)) g.FillPath(soft, top);
                g.FillRectangle(soft, 14, 21, 36, 5);
                using (var ring = new SolidBrush(Color.White)) { g.FillRectangle(ring, 22, 12, 4, 9); g.FillRectangle(ring, 38, 12, 4, 9); }
                using (var dot = new SolidBrush(to)) foreach (var (cx, cy) in new[] { (22, 32), (32, 32), (42, 32), (22, 41), (32, 41) }) g.FillRectangle(dot, cx - 3, cy - 3, 6, 6);
                break;
            case "task":
                g.FillEllipse(soft, 13, 13, 38, 38);
                g.DrawLines(pen, new[] { new PointF(22, 33), new PointF(29, 40), new PointF(43, 25) });
                break;
            case "other": // bell
                using (var bell = new GraphicsPath())
                {
                    bell.AddArc(19, 14, 26, 26, 180, 180);
                    bell.AddLine(45, 27, 46, 40); bell.AddLine(46, 40, 50, 44); bell.AddLine(50, 44, 14, 44); bell.AddLine(14, 44, 18, 40); bell.AddLine(18, 40, 19, 27);
                    bell.CloseFigure();
                    g.FillPath(white, bell);
                }
                g.FillEllipse(white, 27, 45, 10, 8);
                break;
            default: // envelope, as in the app icon
                using (var body = new GraphicsPath())
                {
                    body.AddLine(12, 22, 32, 36); body.AddLine(32, 36, 52, 22); body.AddLine(52, 22, 52, 42);
                    body.AddArc(44, 38, 8, 8, 0, 90); body.AddLine(48, 46, 16, 46); body.AddArc(12, 38, 8, 8, 90, 90); body.CloseFigure();
                    g.FillPath(white, body);
                }
                using (var flap = new GraphicsPath())
                {
                    flap.AddArc(12, 16, 8, 8, 180, 90); flap.AddLine(16, 16, 48, 16); flap.AddArc(44, 16, 8, 8, 270, 90); flap.AddLine(52, 20, 32, 34); flap.CloseFigure();
                    g.FillPath(soft, flap);
                }
                break;
        }
        return bmp;
    }

    static GraphicsPath Rounded(float x, float y, float w, float h, float r)
    {
        var p = new GraphicsPath();
        p.AddArc(x, y, 2 * r, 2 * r, 180, 90); p.AddArc(x + w - 2 * r, y, 2 * r, 2 * r, 270, 90);
        p.AddArc(x + w - 2 * r, y + h - 2 * r, 2 * r, 2 * r, 0, 90); p.AddArc(x, y + h - 2 * r, 2 * r, 2 * r, 90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>The tray icon, with a red dot when there is unread mail (the count itself is in the tooltip: 16 px
    /// leave no room for digits).</summary>
    public static Icon Tray(int unread, int size)
    {
        using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var ico = AppSized(size);
            g.DrawIcon(ico, new Rectangle(0, 0, size, size));
            if (unread > 0)
            {
                float d = size * 0.5f;
                using var ring = new SolidBrush(Color.White);
                using var red = new SolidBrush(Color.FromArgb(0xdc, 0x26, 0x26));
                g.FillEllipse(ring, size - d - 0.5f, -0.5f, d + 1, d + 1);
                g.FillEllipse(red, size - d, 0, d, d);
            }
        }
        return FromBitmap(bmp);
    }

    /// <summary>The badge the web app draws (App.jsx badgeImage) as a data: URL, for the taskbar overlay.</summary>
    public static Icon? FromDataUrl(string? dataUrl, int size)
    {
        if (string.IsNullOrEmpty(dataUrl)) return null;
        var i = dataUrl.IndexOf("base64,", StringComparison.Ordinal);
        if (i < 0) return null;
        try
        {
            using var ms = new MemoryStream(Convert.FromBase64String(dataUrl[(i + 7)..]));
            using var src = new Bitmap(ms);
            using var bmp = new Bitmap(src, size, size);
            return FromBitmap(bmp);
        }
        catch { return null; }
    }

    /// <summary>An Icon that owns a copy of the bitmap's HICON (Icon.FromHandle alone would leak it).</summary>
    static Icon FromBitmap(Bitmap bmp)
    {
        var h = bmp.GetHicon();
        try { return (Icon)Icon.FromHandle(h).Clone(); }
        finally { DestroyIcon(h); }
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
}
