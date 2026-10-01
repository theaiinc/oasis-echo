namespace OasisEcho.Core;

/// <summary>Mic audio (any rate, interleaved channels) to 16 kHz mono float, by averaging channels and linear interpolation.</summary>
public sealed class Resampler
{
    private readonly int _inRate;
    private readonly int _channels;
    private double _pos;
    private float _last;

    public Resampler(int inRate, int channels) { _inRate = inRate; _channels = Math.Max(1, channels); }

    public float[] To16k(ReadOnlySpan<float> interleaved)
    {
        var frames = interleaved.Length / _channels;
        var mono = new float[frames];
        for (var f = 0; f < frames; f++)
        {
            float sum = 0;
            for (var c = 0; c < _channels; c++) sum += interleaved[f * _channels + c];
            mono[f] = sum / _channels;
        }
        if (_inRate == 16_000) return mono;
        var step = _inRate / 16_000.0;
        var outList = new List<float>((int)(frames / step) + 2);
        while (_pos < frames)
        {
            var i = (int)_pos;
            var frac = (float)(_pos - i);
            var a = i == 0 && frac < 0 ? _last : mono[i];
            var b = i + 1 < frames ? mono[i + 1] : mono[i];
            outList.Add(a + (b - a) * frac);
            _pos += step;
        }
        _pos -= frames;
        if (frames > 0) _last = mono[^1];
        return outList.ToArray();
    }
}
