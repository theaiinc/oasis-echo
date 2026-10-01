using System.Text.Json;

namespace OasisEcho;

/// <summary>%APPDATA%\OasisEcho\settings.json</summary>
public sealed class Settings
{
    public string ServerUrl { get; set; } = "http://127.0.0.1:9187";
    public bool WakeWordEnabled { get; set; } = true;
    /// <summary>RMS level a 20 ms window must pass to count as speech (macOS: 0.018).</summary>
    public float VadThreshold { get; set; } = 0.018f;

    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OasisEcho");
    private static string FilePath => Path.Combine(Dir, "settings.json");

    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings(); }
        catch { return new Settings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

/// <summary>%APPDATA%\OasisEcho\oasis-echo.log (the macOS app logs to the unified log under "wakeword").</summary>
public static class Log
{
    private static readonly object Gate = new();
    public static string FilePath => Path.Combine(Settings.Dir, "oasis-echo.log");

    public static void Info(string message)
    {
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Settings.Dir);
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 2_000_000) File.Delete(FilePath);
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
            }
            catch { /* logging must never break the app */ }
        }
    }
}
