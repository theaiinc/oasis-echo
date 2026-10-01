namespace OasisEcho;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One instance per user, like the macOS SingleInstanceLock.
        using var mutex = new Mutex(true, @"Local\OasisEcho.SingleInstance", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp());
    }
}
