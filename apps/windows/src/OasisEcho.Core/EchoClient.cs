using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace OasisEcho.Core;

/// <summary>A reply's audio, as the server's tts.chunk event carries it.</summary>
public sealed record TtsChunk(string TurnId, string? Text, short[] Pcm, int SampleRate, bool Final, bool Filler);

/// <summary>
/// The Oasis Echo server API the macOS app uses (default http://127.0.0.1:9187):
/// WS /audio (streaming listener: start, Float32 16 kHz PCM, end → stt.final), POST /turn ({text}), GET /events (SSE).
/// </summary>
public sealed class EchoClient : IClipRecognizer, IDisposable
{
    private readonly HttpClient _http;

    public EchoClient(Uri baseUrl, HttpMessageHandler? handler = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = baseUrl;
        _http.Timeout = Timeout.InfiniteTimeSpan; // per call via tokens; /events stays open
    }

    public Uri BaseUrl => _http.BaseAddress!;

    /// <summary>Whether the server answers /config.</summary>
    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(3));
            using var res = await _http.GetAsync("/config", cts.Token).ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException) { return false; }
    }

    /// <summary>
    /// One clip through the server's /audio WebSocket, the streaming listener the macOS app
    /// uses: {"type":"start"}, the Float32 16 kHz audio, {"type":"end"} → {"type":"stt.final"}.
    /// </summary>
    public async Task<string> RecognizeAsync(float[] samples16k, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        var b = new UriBuilder(BaseUrl) { Scheme = BaseUrl.Scheme == "https" ? "wss" : "ws", Path = "/audio" };
        await ws.ConnectAsync(b.Uri, ct).ConfigureAwait(false);
        var id = $"win-{Guid.NewGuid():N}";
        await SendJsonAsync(ws, new { type = "start", utteranceId = id }, ct).ConfigureAwait(false);
        var bytes = new byte[samples16k.Length * 4];
        Buffer.BlockCopy(samples16k, 0, bytes, 0, bytes.Length);
        for (var i = 0; i < bytes.Length; i += 32_000)
        {
            var n = Math.Min(32_000, bytes.Length - i);
            await ws.SendAsync(new ArraySegment<byte>(bytes, i, n), WebSocketMessageType.Binary, true, ct).ConfigureAwait(false);
        }
        await SendJsonAsync(ws, new { type = "end", utteranceId = id }, ct).ConfigureAwait(false);

        var buf = new byte[64 * 1024];
        while (!ct.IsCancellationRequested)
        {
            using var msg = new MemoryStream();
            WebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(buf, ct).ConfigureAwait(false);
                if (r.MessageType == WebSocketMessageType.Close) return "";
                msg.Write(buf, 0, r.Count);
            } while (!r.EndOfMessage);
            if (r.MessageType != WebSocketMessageType.Text) continue;
            using var doc = JsonDocument.Parse(msg.ToArray());
            var root = doc.RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == "stt.final"
                && (!root.TryGetProperty("utteranceId", out var u) || u.ValueKind != JsonValueKind.String || u.GetString() == id))
            {
                var text = root.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None).ConfigureAwait(false); } catch { /* best effort */ }
                return text;
            }
        }
        ct.ThrowIfCancellationRequested();
        return "";
    }

    private static Task SendJsonAsync(ClientWebSocket ws, object value, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)), WebSocketMessageType.Text, true, ct);

    public async Task SendTurnAsync(string text, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(new { text });
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var res = await _http.PostAsync("/turn", content, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>Server-sent events until <paramref name="ct"/> is cancelled or the stream ends.</summary>
    public async IAsyncEnumerable<(string Event, string Data)> EventsAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/events");
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await foreach (var ev in SseParser.ReadAsync(stream, ct).ConfigureAwait(false)) yield return ev;
    }

    /// <summary>A tts.chunk event's audio, or null when it carries none (text-only).</summary>
    public static TtsChunk? ParseTtsChunk(string data)
    {
        using var doc = JsonDocument.Parse(data);
        var r = doc.RootElement;
        if (!r.TryGetProperty("audio", out var audio) || audio.ValueKind != JsonValueKind.String) return null;
        var bytes = Convert.FromBase64String(audio.GetString()!);
        var pcm = new short[bytes.Length / 2];
        Buffer.BlockCopy(bytes, 0, pcm, 0, pcm.Length * 2);
        return new TtsChunk(
            r.TryGetProperty("turnId", out var id) ? id.GetString() ?? "" : "",
            r.TryGetProperty("text", out var tx) ? tx.GetString() : null,
            pcm,
            r.TryGetProperty("sampleRate", out var sr) ? sr.GetInt32() : 24_000,
            r.TryGetProperty("final", out var f) && f.ValueKind == JsonValueKind.True,
            r.TryGetProperty("filler", out var fl) && fl.ValueKind == JsonValueKind.True);
    }

    /// <summary>The finished turn's id from a turn.complete event.</summary>
    public static string? ParseTurnComplete(string data)
    {
        using var doc = JsonDocument.Parse(data);
        return doc.RootElement.TryGetProperty("turn", out var t) && t.TryGetProperty("id", out var id) ? id.GetString() : null;
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>Minimal text/event-stream reader: "event:" and "data:" lines, blank line ends an event.</summary>
public static class SseParser
{
    public static async IAsyncEnumerable<(string Event, string Data)> ReadAsync(Stream stream, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        string ev = "message";
        var data = new StringBuilder();
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null) yield break;
            if (line.Length == 0)
            {
                if (data.Length > 0) yield return (ev, data.ToString());
                ev = "message";
                data.Clear();
                continue;
            }
            if (line.StartsWith(':')) continue;
            if (line.StartsWith("event:")) ev = line[6..].Trim();
            else if (line.StartsWith("data:")) { if (data.Length > 0) data.Append('\n'); data.Append(line[5..].TrimStart()); }
        }
    }
}
