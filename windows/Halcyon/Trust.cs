using System.Security.Cryptography.X509Certificates;

namespace Halcyon;

/// <summary>CA certificates the user added in the connect window (%APPDATA%\Halcyon\windows\ca). A server certificate that
/// Windows does not trust is accepted only for the configured server's host, only when it chains to one of these CAs
/// and is otherwise valid (name, dates). CAs installed in Windows' own store need nothing here.</summary>
public static class Trust
{
    static string Dir => Path.Combine(Config.Dir, "ca");

    public static List<X509Certificate2> All()
    {
        var list = new List<X509Certificate2>();
        if (!Directory.Exists(Dir)) return list;
        foreach (var f in Directory.GetFiles(Dir))
        {
            try { list.Add(Read(f)); } catch { /* not a certificate */ }
        }
        return list;
    }

    static X509Certificate2 Read(string file)
    {
        var text = File.ReadAllText(file);
        return text.Contains("-----BEGIN CERTIFICATE-----") ? X509Certificate2.CreateFromPem(text) : new X509Certificate2(File.ReadAllBytes(file));
    }

    /// <summary>Copies a .cer/.crt/.pem file in; returns the CA's subject. Throws when it is not a CA certificate.</summary>
    public static string Add(string file)
    {
        var cert = Read(file);
        var ca = cert.Extensions.OfType<X509BasicConstraintsExtension>().FirstOrDefault();
        if (ca is { CertificateAuthority: false }) throw new InvalidOperationException("This is a server certificate, not a CA certificate. Add the certificate of the CA that issued it.");
        Directory.CreateDirectory(Dir);
        File.WriteAllBytes(Path.Combine(Dir, cert.Thumbprint + ".cer"), cert.Export(X509ContentType.Cert));
        return cert.Subject;
    }

    public static void Clear() { if (Directory.Exists(Dir)) Directory.Delete(Dir, true); }

    public static bool Accepts(X509Certificate2? cert, string host, string server)
    {
        if (cert == null || !string.Equals(host, new Uri(server).Host, StringComparison.OrdinalIgnoreCase)) return false;
        var cas = All();
        if (cas.Count == 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.CustomTrustStore.AddRange(cas.ToArray());
        return chain.Build(cert) && cert.MatchesHostname(host);
    }
}
