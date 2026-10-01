using NAudio.CoreAudioApi;
using NAudio.Wave;
using OasisEcho.Core;

namespace OasisEcho;

/// <summary>The default microphone through WASAPI, delivered as 16 kHz mono float.</summary>
public sealed class Mic : IDisposable
{
    private WasapiCapture? _capture;
    private Resampler? _resampler;

    public event Action<float[]>? Samples;
    public event Action<string>? Failed;

    public void Start()
    {
        Stop();
        var capture = new WasapiCapture(); // default capture device, shared mode
        var fmt = capture.WaveFormat;
        _resampler = new Resampler(fmt.SampleRate, fmt.Channels);
        capture.DataAvailable += (_, e) =>
        {
            var floats = ToFloat(e.Buffer, e.BytesRecorded, fmt);
            if (floats.Length > 0) Samples?.Invoke(_resampler!.To16k(floats));
        };
        capture.RecordingStopped += (_, e) => { if (e.Exception is not null) Failed?.Invoke(e.Exception.Message); };
        capture.StartRecording();
        _capture = capture;
        Log.Info($"mic: {fmt.SampleRate} Hz, {fmt.Channels} ch, {fmt.Encoding} {fmt.BitsPerSample}-bit");
    }

    /// <summary>KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: WASAPI's shared-mode mix format is usually 32-bit float in an extensible header.</summary>
    private static readonly Guid IeeeFloatSubFormat = new("00000003-0000-0010-8000-00aa00389b71");

    private static float[] ToFloat(byte[] buf, int n, WaveFormat fmt)
    {
        if (fmt.Encoding == WaveFormatEncoding.IeeeFloat || (fmt is WaveFormatExtensible ext && ext.SubFormat == IeeeFloatSubFormat))
        {
            var f = new float[n / 4];
            Buffer.BlockCopy(buf, 0, f, 0, f.Length * 4);
            return f;
        }
        if (fmt.BitsPerSample == 16)
        {
            var f = new float[n / 2];
            for (var i = 0; i < f.Length; i++) f[i] = BitConverter.ToInt16(buf, i * 2) / 32768f;
            return f;
        }
        if (fmt.BitsPerSample == 32)
        {
            var f = new float[n / 4];
            for (var i = 0; i < f.Length; i++) f[i] = BitConverter.ToInt32(buf, i * 4) / 2147483648f;
            return f;
        }
        return Array.Empty<float>();
    }

    public void Stop()
    {
        try { _capture?.StopRecording(); } catch { /* already stopped */ }
        _capture?.Dispose();
        _capture = null;
    }

    public void Dispose() => Stop();
}
