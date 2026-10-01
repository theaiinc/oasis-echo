namespace OasisEcho.Core;

/// <summary>Turns a short clip (16 kHz mono float) into text. The app uses the Echo server's /audio listener.</summary>
public interface IClipRecognizer
{
    Task<string> RecognizeAsync(float[] samples16k, CancellationToken ct);
}

/// <summary>
/// "Hey Echo" detection, ported from the macOS WakeWordDetector: a cheap energy VAD runs
/// all the time; when speech starts, the clip around it is recognized once and checked for
/// the wake phrase. Unlike the macOS version, it waits for the phrase to be said (until a
/// short pause, at most <see cref="MaxPhraseMs"/>) and recognizes the audio from just
/// before the speech started, not the oldest audio in the buffer.
/// </summary>
public sealed class WakeWordDetector
{
    public const int SampleRate = 16_000;
    /// <summary>Audio kept from before speech started (the VAD fires a few windows late).</summary>
    public const int PreRollMs = 400;
    /// <summary>Longest stretch recognized for the wake phrase (macOS captured 3 s).</summary>
    public const int MaxPhraseMs = 3000;
    /// <summary>Ignore further triggers for this long after a detection (macOS: 3 s).</summary>
    public static readonly TimeSpan Cooldown = TimeSpan.FromSeconds(3);

    private readonly IClipRecognizer _recognizer;
    private readonly RingBuffer _ring = new(SampleRate * 6);
    private readonly EnergyVad _vad;
    private readonly Func<DateTime> _now;
    private int _samplesSinceStart = -1;
    private bool _recognizing;
    private DateTime _cooldownUntil = DateTime.MinValue;

    public WakeWordDetector(IClipRecognizer recognizer, Func<DateTime>? now = null, float threshold = 0.018f)
    {
        _recognizer = recognizer;
        _now = now ?? (() => DateTime.UtcNow);
        _vad = new EnergyVad(SampleRate, threshold, windowMs: 20, confirmWindows: 3, endSilenceMs: 400);
        _vad.SpeechStarted += () =>
        {
            if (_recognizing || _now() < _cooldownUntil || Paused) return;
            _samplesSinceStart = 0;
        };
        _vad.SpeechEnded += () => { if (_samplesSinceStart >= 0) Recognize(); };
    }

    /// <summary>The wake phrase was heard; the argument is anything said after it in the same breath.</summary>
    public event Action<string>? Detected;
    /// <summary>A recognition pass ran (for logs): transcript, matched.</summary>
    public event Action<string, bool>? Heard;

    /// <summary>While paused (e.g. during an Echo turn) audio is ignored, as on macOS.</summary>
    public bool Paused { get; private set; }

    public void Pause() { Paused = true; _samplesSinceStart = -1; _vad.Reset(); _ring.Clear(); }
    public void Resume() { Paused = false; }

    /// <summary>Feed 16 kHz mono samples from the mic.</summary>
    public void Push(ReadOnlySpan<float> samples)
    {
        if (Paused) return;
        _ring.Append(samples);
        _vad.Push(samples);
        if (_samplesSinceStart >= 0)
        {
            _samplesSinceStart += samples.Length;
            if (_samplesSinceStart >= SampleRate * MaxPhraseMs / 1000) Recognize();
        }
    }

    private void Recognize()
    {
        var take = _samplesSinceStart + SampleRate * PreRollMs / 1000;
        _samplesSinceStart = -1;
        if (_recognizing) return;
        var clip = _ring.Latest(take);
        if (clip.Length < SampleRate * 3 / 10) return; // under 0.3 s, as on macOS
        _recognizing = true;
        _ = RunAsync(clip);
    }

    private async Task RunAsync(float[] clip)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var text = await _recognizer.RecognizeAsync(clip, cts.Token).ConfigureAwait(false);
            var matched = WakePhrase.TryMatch(text, out var rest);
            Heard?.Invoke(text, matched);
            if (matched && !Paused)
            {
                _cooldownUntil = _now() + Cooldown;
                Detected?.Invoke(rest);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or System.Net.WebSockets.WebSocketException or System.Text.Json.JsonException)
        {
            Heard?.Invoke($"(recognition failed: {ex.Message})", false);
        }
        finally
        {
            _recognizing = false;
        }
    }
}
