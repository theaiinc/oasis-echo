using System.Diagnostics;
using System.Drawing;

namespace OasisEcho;

/// <summary>The notification-area icon and its menu (the macOS menu bar item's counterpart).</summary>
public sealed class TrayApp : ApplicationContext
{
    private readonly Settings _settings = Settings.Load();
    private readonly NotifyIcon _icon;
    private readonly ToolStripMenuItem _status = new("Starting…") { Enabled = false };
    private readonly ToolStripMenuItem _listen = new("Listen for \"Hey Echo\"") { CheckOnClick = true };
    private readonly EchoSession _session;
    private readonly SynchronizationContext _ui;

    public TrayApp()
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _session = new EchoSession(_settings);
        _session.Status += (text) => _ui.Post((_) => SetStatus(text), null);

        _listen.Checked = _settings.WakeWordEnabled;
        _listen.CheckedChanged += (_, _) =>
        {
            _settings.WakeWordEnabled = _listen.Checked;
            _settings.Save();
            _session.SetListening(_listen.Checked);
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add(_status);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_listen);
        menu.Items.Add(new ToolStripMenuItem($"Server: {_settings.ServerUrl}") { Enabled = false });
        menu.Items.Add("Edit settings…", null, (_, _) => Open(SettingsPath()));
        menu.Items.Add("Open log", null, (_, _) => Open(Log.FilePath));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => ExitThread());

        _icon = new NotifyIcon { Icon = LoadIcon(), Text = "Oasis Echo", ContextMenuStrip = menu, Visible = true };
        Log.Info($"started; server {_settings.ServerUrl}, wake word {(_settings.WakeWordEnabled ? "on" : "off")}");
        _session.Start();
    }

    private void SetStatus(string text)
    {
        _status.Text = text;
        _icon.Text = text.Length > 60 ? "Oasis Echo" : $"Oasis Echo: {text}";
    }

    private static string SettingsPath()
    {
        var path = Path.Combine(Settings.Dir, "settings.json");
        if (!File.Exists(path)) Settings.Load().Save();
        return path;
    }

    private static void Open(string path)
    {
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        catch (Exception ex) { Log.Info($"open {path}: {ex.Message}"); }
    }

    private static Icon LoadIcon()
    {
        using var stream = typeof(TrayApp).Assembly.GetManifestResourceStream("tray.png");
        if (stream is null) return SystemIcons.Application;
        using var bmp = new Bitmap(stream);
        return Icon.FromHandle(new Bitmap(bmp, new Size(32, 32)).GetHicon());
    }

    protected override void ExitThreadCore()
    {
        _icon.Visible = false;
        _icon.Dispose();
        _session.Dispose();
        base.ExitThreadCore();
    }
}
