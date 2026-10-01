namespace OasisEcho.Core;

/// <summary>
/// RMS voice activity on fixed windows, like the macOS detector (threshold 0.018, a few
/// loud windows in a row to fire), plus end-of-speech after a run of quiet windows.
/// </summary>
public sealed class EnergyVad
{
    private readonly int _windowSamples;
    private readonly float _threshold;
    private readonly int _confirmWindows;
    private readonly int _endWindows;
    private readonly List<float> _window = new();
    private int _loudRun;
    private int _quietRun;

    /// <param name="sampleRate">Rate of the samples pushed in.</param>
    /// <param name="threshold">RMS above which a window is speech (macOS: 0.018).</param>
    /// <param name="windowMs">Window length (macOS taps ~21 ms buffers).</param>
    /// <param name="confirmWindows">Loud windows in a row before speech starts (macOS: 3).</param>
    /// <param name="endSilenceMs">Quiet after speech before it ends.</param>
    public EnergyVad(int sampleRate = 16_000, float threshold = 0.018f, int windowMs = 20, int confirmWindows = 3, int endSilenceMs = 700)
    {
        _windowSamples = Math.Max(1, sampleRate * windowMs / 1000);
        _threshold = threshold;
        _confirmWindows = confirmWindows;
        _endWindows = Math.Max(1, endSilenceMs / windowMs);
    }

    public bool InSpeech { get; private set; }

    public event Action? SpeechStarted;
    public event Action? SpeechEnded;

    public void Push(ReadOnlySpan<float> samples)
    {
        foreach (var s in samples)
        {
            _window.Add(s);
            if (_window.Count < _windowSamples) continue;
            double sum = 0;
            foreach (var v in _window) sum += v * v;
            var rms = Math.Sqrt(sum / _window.Count);
            _window.Clear();
            Step(rms > _threshold);
        }
    }

    private void Step(bool loud)
    {
        if (loud) { _loudRun++; _quietRun = 0; } else { _quietRun++; _loudRun = 0; }
        if (!InSpeech && _loudRun >= _confirmWindows)
        {
            InSpeech = true;
            SpeechStarted?.Invoke();
        }
        else if (InSpeech && _quietRun >= _endWindows)
        {
            InSpeech = false;
            SpeechEnded?.Invoke();
        }
    }

    public void Reset() { _window.Clear(); _loudRun = 0; _quietRun = 0; InSpeech = false; }
}
