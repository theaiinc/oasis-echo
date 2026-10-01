namespace OasisEcho.Core;

/// <summary>Mono float32 ring buffer that keeps the most recent <see cref="Capacity"/> samples.</summary>
public sealed class RingBuffer
{
    private readonly float[] _buf;
    private int _head;

    public RingBuffer(int capacity) => _buf = new float[capacity];

    public int Capacity => _buf.Length;
    public int Count { get; private set; }

    public void Append(ReadOnlySpan<float> data)
    {
        foreach (var s in data)
        {
            _buf[_head] = s;
            _head = (_head + 1) % _buf.Length;
        }
        Count = Math.Min(Count + data.Length, _buf.Length);
    }

    /// <summary>
    /// The newest <paramref name="n"/> samples, oldest first. (The macOS detector read the
    /// OLDEST samples instead, so once the buffer was full the window ended before the
    /// speech that triggered it.)
    /// </summary>
    public float[] Latest(int n)
    {
        var r = Math.Min(n, Count);
        var outBuf = new float[r];
        var start = (_head - r + _buf.Length) % _buf.Length;
        for (var i = 0; i < r; i++) outBuf[i] = _buf[(start + i) % _buf.Length];
        return outBuf;
    }

    public void Clear() { Count = 0; _head = 0; }
}
