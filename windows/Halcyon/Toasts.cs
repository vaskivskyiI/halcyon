using System.Runtime.InteropServices;
using System.Security;

namespace Halcyon;

/// <summary>Windows toast notifications through the WinRT ABI directly (no Windows SDK projection, which would add
/// ~25 MB). The app is unpackaged: its AppUserModelID is registered under HKCU (Shell.Register) and a click starts
/// the app through its own protocol (halcyon-windows:open?…), which the running instance receives (Program).</summary>
public static unsafe class Toasts
{
    public const string Group = "halcyon";
    static readonly Guid IID_ManagerStatics = new("50AC103F-D235-4598-BBEF-98FE4D1A3AD4");
    static readonly Guid IID_ManagerStatics2 = new("7AB93C52-0E48-4750-BA9D-1A4113981847");
    static readonly Guid IID_ToastFactory = new("04124B20-82C6-4229-B109-FD9ED4662B53");
    static readonly Guid IID_Toast2 = new("9DFB9FD1-143A-490E-90BF-B9FBA7132DE7");
    static readonly Guid IID_XmlDocumentIO = new("6CD0E74E-EE65-4489-9EBF-CA43E87BA637");
    static readonly Guid IID_XmlDocument = new("F7F3A506-1E87-42D6-BCFB-B8C809FA5494");

    /// <summary>Shows (or, with the same tag, replaces) a toast. kind picks the icon: mail, calendar, task, other.</summary>
    public static void Show(string title, string body, string tag, bool silent, string kind, string launch)
    {
        var icon = Icons.ToastIcon(kind);
        var x = $"<toast launch=\"{Esc(launch)}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\">" +
                $"<text hint-maxLines=\"2\">{Esc(title)}</text>" + (body.Length > 0 ? $"<text>{Esc(body)}</text>" : "") +
                (icon != null ? $"<image placement=\"appLogoOverride\" src=\"{Esc(new Uri(icon).AbsoluteUri)}\"/>" : "") +
                "</binding></visual>" + (silent ? "<audio silent=\"true\"/>" : "") + "</toast>";
        IntPtr doc = 0, io = 0, xmlDoc = 0, factory = 0, toast = 0, toast2 = 0, statics = 0, notifier = 0;
        try
        {
            doc = Activate("Windows.Data.Xml.Dom.XmlDocument");
            io = Query(doc, IID_XmlDocumentIO);
            using (var h = new HString(x)) Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(io, 6))(io, h.Ptr)); // LoadXml
            xmlDoc = Query(doc, IID_XmlDocument);
            factory = Factory("Windows.UI.Notifications.ToastNotification", IID_ToastFactory);
            Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr*, int>)Slot(factory, 6))(factory, xmlDoc, &toast)); // CreateToastNotification
            toast2 = Query(toast, IID_Toast2);
            using (var t = new HString(Tag(tag))) Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(toast2, 6))(toast2, t.Ptr)); // put_Tag
            using (var g = new HString(Group)) Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(toast2, 8))(toast2, g.Ptr)); // put_Group
            statics = Factory("Windows.UI.Notifications.ToastNotificationManager", IID_ManagerStatics);
            using (var id = new HString(Shell.AppId)) Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr*, int>)Slot(statics, 7))(statics, id.Ptr, &notifier)); // CreateToastNotifierWithId
            Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(notifier, 6))(notifier, toast)); // Show
        }
        finally { Release(doc, io, xmlDoc, factory, toast, toast2, statics, notifier); }
    }

    /// <summary>Removes a toast from the screen and from the notification centre.</summary>
    public static void Remove(string tag)
    {
        IntPtr statics = 0, history = 0;
        try
        {
            statics = Factory("Windows.UI.Notifications.ToastNotificationManager", IID_ManagerStatics2);
            Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Slot(statics, 6))(statics, &history)); // get_History
            using var t = new HString(Tag(tag));
            using var g = new HString(Group);
            using var id = new HString(Shell.AppId);
            Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr, IntPtr, int>)Slot(history, 8))(history, t.Ptr, g.Ptr, id.Ptr)); // RemoveGroupedTagWithId
        }
        finally { Release(statics, history); }
    }

    // Windows takes at most 64 characters for a tag.
    static string Tag(string tag) => tag.Length <= 64 ? tag : tag[..64];
    static string Esc(string s) => SecurityElement.Escape(s) ?? "";

    static void* Slot(IntPtr o, int i) => (*(void***)o)[i];
    static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    static IntPtr Query(IntPtr o, Guid iid) { Check(Marshal.QueryInterface(o, in iid, out var p)); return p; }
    static void Release(params IntPtr[] ps) { foreach (var p in ps) if (p != 0) Marshal.Release(p); }

    static IntPtr Factory(string cls, Guid iid)
    {
        using var h = new HString(cls);
        Check(RoGetActivationFactory(h.Ptr, in iid, out var f));
        return f;
    }

    static IntPtr Activate(string cls)
    {
        using var h = new HString(cls);
        Check(RoActivateInstance(h.Ptr, out var o));
        return o;
    }

    sealed class HString : IDisposable
    {
        public readonly IntPtr Ptr;
        public HString(string s) => Check(WindowsCreateString(s, (uint)s.Length, out Ptr));
        public void Dispose() { if (Ptr != 0) WindowsDeleteString(Ptr); }
    }

    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string src, uint length, out IntPtr hstring);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, in Guid iid, out IntPtr factory);
    [DllImport("combase.dll")] static extern int RoActivateInstance(IntPtr classId, out IntPtr instance);
}
