using OasisEcho.Core;
using Xunit;

/// <summary>
/// Against a real Echo server, only when ECHO_TEST_SERVER is set (e.g. http://127.0.0.1:9187)
/// and ECHO_TEST_WAKE_WAV / ECHO_TEST_OTHER_WAV point at 16 kHz mono float WAVs of
/// "Hey Echo, …" and of something else.
/// </summary>
public class LiveServerTests
{
    private static float[] Wav(string path)
    {
        var b = File.ReadAllBytes(path);
        var at = 12;
        while (at + 8 <= b.Length && System.Text.Encoding.ASCII.GetString(b, at, 4) != "data") at += 8 + BitConverter.ToInt32(b, at + 4);
        var n = BitConverter.ToInt32(b, at + 4) / 4;
        var f = new float[n];
        Buffer.BlockCopy(b, at + 8, f, 0, n * 4);
        return f;
    }

    private static async Task<(string? rest, List<string> heard)> Run(EchoClient client, string wav)
    {
        var d = new WakeWordDetector(client);
        string? rest = null;
        var heard = new List<string>();
        var done = new TaskCompletionSource();
        d.Detected += (r) => rest = r;
        d.Heard += (t, _) => { heard.Add(t); done.TrySetResult(); };
        var quiet = new float[16_000];
        var audio = quiet.Concat(Wav(wav).Select((x) => x * 0.6f)).Concat(quiet).ToArray();
        for (var i = 0; i < audio.Length; i += 320) d.Push(audio.AsSpan(i, Math.Min(320, audio.Length - i)));
        await Task.WhenAny(done.Task, Task.Delay(30_000));
        return (rest, heard);
    }

    [Fact]
    public async Task Hears_the_wake_phrase_through_the_servers_listener()
    {
        var server = Environment.GetEnvironmentVariable("ECHO_TEST_SERVER");
        if (string.IsNullOrEmpty(server)) return;
        using var client = new EchoClient(new Uri(server));
        var (rest, heard) = await Run(client, Environment.GetEnvironmentVariable("ECHO_TEST_WAKE_WAV")!);
        Console.WriteLine($"wake clip heard as: {string.Join(" | ", heard)}  → rest: '{rest}'");
        Assert.NotNull(rest);
        Assert.Contains("time", rest!, StringComparison.OrdinalIgnoreCase);

        var (other, heard2) = await Run(client, Environment.GetEnvironmentVariable("ECHO_TEST_OTHER_WAV")!);
        Console.WriteLine($"other clip heard as: {string.Join(" | ", heard2)}");
        Assert.Null(other);
    }
}
