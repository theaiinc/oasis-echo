using System.Text;
using OasisEcho.Core;
using Xunit;

public class WakePhraseTests
{
    [Theory]
    [InlineData("Hey Echo.", true, "")]
    [InlineData("hey, echo what's on my calendar today?", true, "what's on my calendar today?")]
    [InlineData("Hay echo, play some music", true, "play some music")]
    [InlineData("Hey Echo Oasis, start a meeting", true, "start a meeting")]
    [InlineData("I heard an echo in the hall", false, "")]
    [InlineData("", false, "")]
    public void Matches_like_macOS_and_keeps_the_rest(string text, bool matched, string rest)
    {
        Assert.Equal(matched, WakePhrase.TryMatch(text, out var r));
        Assert.Equal(rest, r);
    }
}

public class RingBufferTests
{
    [Fact]
    public void Latest_returns_the_newest_samples_even_when_full()
    {
        var ring = new RingBuffer(5);
        ring.Append(new float[] { 1, 2, 3, 4, 5, 6, 7 });
        Assert.Equal(new float[] { 5, 6, 7 }, ring.Latest(3));
        Assert.Equal(new float[] { 3, 4, 5, 6, 7 }, ring.Latest(10));
    }
}

public class WakeWordDetectorTests
{
    private sealed class FakeRecognizer : IClipRecognizer
    {
        public string Reply = "Hey Echo";
        public readonly List<float[]> Clips = new();
        public Task<string> RecognizeAsync(float[] s, CancellationToken ct) { Clips.Add(s); return Task.FromResult(Reply); }
    }

    private static float[] Tone(int ms, float amp) =>
        Enumerable.Range(0, 16 * ms).Select((i) => (float)(Math.Sin(i / 6.0) * amp)).ToArray();

    private static void Feed(WakeWordDetector d, float[] pcm)
    {
        for (var i = 0; i < pcm.Length; i += 320) d.Push(pcm.AsSpan(i, Math.Min(320, pcm.Length - i)));
    }

    [Fact]
    public async Task Detects_the_phrase_and_recognizes_the_speech_not_the_old_audio()
    {
        var rec = new FakeRecognizer();
        var d = new WakeWordDetector(rec);
        string? heard = null;
        d.Detected += (rest) => heard = rest;
        Feed(d, Tone(5000, 0.001f));          // 5 s of quiet fills the buffer
        Feed(d, Tone(900, 0.2f));             // "Hey Echo"
        Feed(d, Tone(600, 0.001f));           // pause ends it
        await Task.Delay(50);
        Assert.Equal("", heard);
        var clip = Assert.Single(rec.Clips);
        // The clip covers the speech plus a short pre-roll, not the old silence.
        Assert.InRange(clip.Length, 16 * 900, 16 * (900 + WakeWordDetector.PreRollMs + 600));
        Assert.True(clip.Skip(clip.Length / 3).Take(1600).Max(Math.Abs) > 0.1f);
    }

    [Fact]
    public async Task Ignores_speech_that_is_not_the_phrase_and_respects_pause_and_cooldown()
    {
        var rec = new FakeRecognizer { Reply = "what time is it" };
        var now = DateTime.UtcNow;
        var d = new WakeWordDetector(rec, () => now);
        var count = 0;
        d.Detected += (_) => count++;
        Feed(d, Tone(900, 0.2f)); Feed(d, Tone(600, 0.001f)); await Task.Delay(20);
        Assert.Equal(0, count);

        rec.Reply = "hey echo, what's new";
        Feed(d, Tone(900, 0.2f)); Feed(d, Tone(600, 0.001f)); await Task.Delay(20);
        Assert.Equal(1, count);
        Feed(d, Tone(900, 0.2f)); Feed(d, Tone(600, 0.001f)); await Task.Delay(20);
        Assert.Equal(1, count); // within the 3 s cooldown

        now += TimeSpan.FromSeconds(4);
        d.Pause();
        Feed(d, Tone(900, 0.2f)); Feed(d, Tone(600, 0.001f)); await Task.Delay(20);
        Assert.Equal(1, count); // paused during a turn
        d.Resume();
        Feed(d, Tone(900, 0.2f)); Feed(d, Tone(600, 0.001f)); await Task.Delay(20);
        Assert.Equal(2, count);
    }

    [Fact]
    public async Task Caps_a_long_utterance_at_the_max_phrase_length()
    {
        var rec = new FakeRecognizer { Reply = "blah" };
        var d = new WakeWordDetector(rec);
        Feed(d, Tone(6000, 0.2f)); // talking for 6 s without a pause
        await Task.Delay(20);
        Assert.NotEmpty(rec.Clips);
        Assert.All(rec.Clips, (c) => Assert.True(c.Length <= 16 * (WakeWordDetector.MaxPhraseMs + WakeWordDetector.PreRollMs) + 320));
    }
}

public class EchoClientTests
{
    [Fact]
    public async Task Parses_server_sent_events_and_tts_chunks()
    {
        var pcm = new short[] { 1, -2, 300 };
        var bytes = new byte[6]; Buffer.BlockCopy(pcm, 0, bytes, 0, 6);
        var stream = new MemoryStream(Encoding.UTF8.GetBytes(
            ": connected\n\nevent: tts.chunk\ndata: {\"turnId\":\"t1\",\"text\":\"Hi.\",\"sampleRate\":24000,\"final\":true,\"filler\":false,\"audio\":\"" + Convert.ToBase64String(bytes) + "\"}\n\nevent: turn.complete\ndata: {\"turn\":{\"id\":\"t1\"}}\n\n"));
        var events = new List<(string, string)>();
        await foreach (var e in SseParser.ReadAsync(stream, CancellationToken.None)) events.Add(e);
        Assert.Equal(new[] { "tts.chunk", "turn.complete" }, events.Select((e) => e.Item1));
        var chunk = EchoClient.ParseTtsChunk(events[0].Item2)!;
        Assert.Equal(pcm, chunk.Pcm);
        Assert.Equal(24000, chunk.SampleRate);
        Assert.True(chunk.Final);
        Assert.Equal("t1", EchoClient.ParseTurnComplete(events[1].Item2));
        Assert.Null(EchoClient.ParseTtsChunk("{\"turnId\":\"t1\",\"text\":\"no audio\",\"sampleRate\":24000}"));
    }

    [Fact]
    public void Resamples_48k_stereo_to_16k_mono()
    {
        var r = new Resampler(48_000, 2);
        var outLen = 0;
        for (var i = 0; i < 10; i++) outLen += r.To16k(new float[4800 * 2]).Length; // 10 × 100 ms
        Assert.InRange(outLen, 15_990, 16_010);
    }
}
