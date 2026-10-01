using OasisEcho.Core;

namespace OasisEcho;

/// <summary>
/// What "Hey Echo" starts, as on macOS (wake word → Echo mode → capture): a chime, the
/// request recorded until a pause, sent to the server as a turn, and the spoken reply
/// played. The wake word is paused for the whole turn so the reply can't re-trigger it.
/// </summary>
public sealed class EchoSession : IDisposable
{
    private readonly Settings _settings;
    private readonly EchoClient _client;
    private readonly Mic _mic = new();
    private readonly Player _player = new();
    private readonly WakeWordDetector _wake;
    private readonly CancellationTokenSource _life = new();
    private readonly object _gate = new();

    // Capturing the request after the wake word.
    private List<float>? _request;
    private EnergyVad? _requestVad;
    private DateTime _requestStarted;
    private bool _requestSpoke;

    // The turn in flight: the reply has finished when its turn.complete has come and playback has drained.
    private bool _inTurn;
    private bool _turnComplete;
    private DateTime _turnStarted;

    public event Action<string>? Status;

    public EchoSession(Settings settings)
    {
        _settings = settings;
        _client = new EchoClient(new Uri(settings.ServerUrl));
        _wake = new WakeWordDetector(_client, threshold: settings.VadThreshold);
        _wake.Heard += (text, matched) => Log.Info($"wakeword: {(matched ? "DETECTED" : "no match")}: '{text}'");
        _wake.Detected += OnWake;
        _mic.Samples += OnSamples;
        _mic.Failed += (msg) => { Log.Info($"mic failed: {msg}"); Status?.Invoke("Microphone unavailable"); };
    }

    public bool Listening { get; private set; }

    public void Start()
    {
        _ = ListenToServerAsync(_life.Token);
        _ = WatchdogAsync(_life.Token);
        SetListening(_settings.WakeWordEnabled);
    }

    public void SetListening(bool on)
    {
        Listening = on;
        if (on)
        {
            try { _mic.Start(); Status?.Invoke("Listening for \"Hey Echo\""); }
            catch (Exception ex) { Log.Info($"mic start failed: {ex.Message}"); Status?.Invoke("Microphone unavailable"); }
        }
        else
        {
            _mic.Stop();
            Status?.Invoke("Wake word off");
        }
    }

    private void OnSamples(float[] samples)
    {
        lock (_gate)
        {
            if (_request is not null) { CaptureRequest(samples); return; }
            if (!_inTurn) _wake.Push(samples);
        }
    }

    private void OnWake(string rest)
    {
        lock (_gate)
        {
            if (_inTurn || _request is not null) return;
            _wake.Pause();
            _inTurn = true;
            _turnComplete = false;
            _turnStarted = DateTime.UtcNow;
        }
        Log.Info($"wake: '{rest}'");
        if (rest.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length >= 2)
        {
            // "Hey Echo, what's new today?": the request came with the wake phrase.
            _ = SendAsync(rest);
            return;
        }
        _player.Chime();
        Status?.Invoke("Listening…");
        lock (_gate)
        {
            _request = new List<float>();
            _requestSpoke = false;
            _requestStarted = DateTime.UtcNow;
            _requestVad = new EnergyVad(WakeWordDetector.SampleRate, _settings.VadThreshold, endSilenceMs: 900);
            _requestVad.SpeechStarted += () => _requestSpoke = true;
            _requestVad.SpeechEnded += () => FinishRequest();
        }
    }

    private void CaptureRequest(float[] samples)
    {
        // Skip the chime's own sound for its first 300 ms.
        if ((DateTime.UtcNow - _requestStarted).TotalMilliseconds < 300) return;
        _request!.AddRange(samples);
        _requestVad!.Push(samples);
        var elapsed = DateTime.UtcNow - _requestStarted;
        if (!_requestSpoke && elapsed > TimeSpan.FromSeconds(6)) { Log.Info("request: nothing said"); EndTurn(); }
        else if (elapsed > TimeSpan.FromSeconds(20)) FinishRequest();
    }

    private void FinishRequest()
    {
        float[] audio;
        lock (_gate)
        {
            if (_request is null) return;
            audio = _request.ToArray();
            _request = null;
            _requestVad = null;
        }
        Status?.Invoke("Thinking…");
        _ = TranscribeAndSendAsync(audio);
    }

    private async Task TranscribeAndSendAsync(float[] audio)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var text = (await _client.RecognizeAsync(audio, cts.Token)).Trim();
            Log.Info($"request: '{text}'");
            if (text.Length == 0) { EndTurn(); return; }
            await SendAsync(text);
        }
        catch (Exception ex)
        {
            Log.Info($"request failed: {ex.Message}");
            Status?.Invoke("Couldn't reach the Echo server");
            EndTurn();
        }
    }

    private async Task SendAsync(string text)
    {
        try
        {
            Status?.Invoke("Thinking…");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await _client.SendTurnAsync(text, cts.Token);
        }
        catch (Exception ex)
        {
            Log.Info($"turn failed: {ex.Message}");
            Status?.Invoke("Couldn't reach the Echo server");
            EndTurn();
        }
    }

    private async Task ListenToServerAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await foreach (var (ev, data) in _client.EventsAsync(ct))
                {
                    if (ev == "tts.chunk" && _inTurn)
                    {
                        var chunk = EchoClient.ParseTtsChunk(data);
                        if (chunk is not null) { _player.Enqueue(chunk.Pcm, chunk.SampleRate); Status?.Invoke("Speaking…"); }
                    }
                    else if (ev == "turn.complete" && _inTurn)
                    {
                        _turnComplete = true;
                    }
                }
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                Log.Info($"events: {ex.Message}; retrying");
                Status?.Invoke("Waiting for the Echo server…");
            }
            if (!ct.IsCancellationRequested) await Task.Delay(TimeSpan.FromSeconds(3), ct).ContinueWith((_) => { });
        }
    }

    /// <summary>Ends a turn once its reply has played, or after a minute whatever happened.</summary>
    private async Task WatchdogAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(250, ct).ContinueWith((_) => { });
            if (!_inTurn || _request is not null) continue;
            var done = _turnComplete && !_player.IsPlaying;
            if (done || DateTime.UtcNow - _turnStarted > TimeSpan.FromSeconds(60)) EndTurn();
        }
    }

    private void EndTurn()
    {
        lock (_gate)
        {
            _request = null;
            _requestVad = null;
            _inTurn = false;
            _turnComplete = false;
            _wake.Resume();
        }
        if (Listening) Status?.Invoke("Listening for \"Hey Echo\"");
    }

    public void Dispose()
    {
        _life.Cancel();
        _mic.Dispose();
        _player.Dispose();
        _client.Dispose();
    }
}
