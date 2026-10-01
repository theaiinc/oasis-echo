namespace OasisEcho.Core;

/// <summary>"Hey Echo" in a transcript, with the same misrecognitions the macOS detector accepts.</summary>
public static class WakePhrase
{
    /// <summary>Ported from WakeWordDetector.swift's wakePatterns.</summary>
    public static readonly string[] Patterns =
    {
        "hey echo", "hey, echo", "hey echo oasis", "hey ecko", "hay echo",
        "he echo", "the echo", "a echo", "he ecko",
    };

    /// <summary>
    /// Whether <paramref name="transcript"/> contains the wake phrase, and anything said after
    /// it ("Hey Echo, what's on today?" → "what's on today?") so it can be answered at once.
    /// </summary>
    public static bool TryMatch(string transcript, out string rest)
    {
        rest = "";
        var lowered = transcript.ToLowerInvariant().Trim();
        if (lowered.Length == 0) return false;
        // Longest first, so "hey echo oasis" wins over "hey echo".
        foreach (var p in Patterns.OrderByDescending((x) => x.Length))
        {
            var at = lowered.IndexOf(p, StringComparison.Ordinal);
            if (at < 0) continue;
            rest = transcript[(at + p.Length)..].TrimStart(' ', ',', '.', '!', '?', ':', ';', '-').Trim();
            return true;
        }
        return false;
    }
}
