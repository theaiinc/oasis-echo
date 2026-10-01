using NAudio.Wave;

namespace OasisEcho;

/// <summary>Plays reply audio (16-bit mono PCM chunks) in order; tells when the queue has run dry.</summary>
public sealed class Player : IDisposable
{
    private WaveOutEvent? _out;
    private BufferedWaveProvider? _buffer;
    private int _rate;

    public void Enqueue(short[] pcm, int sampleRate)
    {
        if (_buffer is null || sampleRate != _rate)
        {
            // A new rate (Kokoro is 24 kHz, VieNeu 48 kHz): start a fresh output for it.
            Stop();
            _rate = sampleRate;
            _buffer = new BufferedWaveProvider(new WaveFormat(sampleRate, 16, 1)) { BufferDuration = TimeSpan.FromMinutes(3), DiscardOnBufferOverflow = true };
            _out = new WaveOutEvent { DesiredLatency = 120 };
            _out.Init(_buffer);
            _out.Play();
        }
        var bytes = new byte[pcm.Length * 2];
        Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
        _buffer.AddSamples(bytes, 0, bytes.Length);
    }

    /// <summary>A short two-note chime: "I'm listening".</summary>
    public void Chime()
    {
        const int rate = 24_000;
        var pcm = new short[rate * 22 / 100];
        for (var i = 0; i < pcm.Length; i++)
        {
            var t = (double)i / rate;
            var freq = t < 0.1 ? 880 : 1320;
            var env = Math.Min(1, Math.Min(i / 240.0, (pcm.Length - i) / 480.0));
            pcm[i] = (short)(Math.Sin(2 * Math.PI * freq * t) * 6000 * env);
        }
        Enqueue(pcm, rate);
    }

    public bool IsPlaying => _buffer is not null && _buffer.BufferedBytes > 0;

    public void Stop()
    {
        _out?.Stop();
        _out?.Dispose();
        _out = null;
        _buffer = null;
    }

    public void Dispose() => Stop();
}
