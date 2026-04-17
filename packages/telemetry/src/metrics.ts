export type Labels = Record<string, string | number>;

type CounterEntry = { name: string; labels: Labels; value: number };
type HistogramEntry = { name: string; labels: Labels; values: number[] };

export class Metrics {
  private readonly counters = new Map<string, CounterEntry>();
  private readonly histograms = new Map<string, HistogramEntry>();

  private key(name: string, labels: Labels): string {
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return `${name}{${parts.join(',')}}`;
  }

  inc(name: string, labels: Labels = {}, delta = 1): void {
    const k = this.key(name, labels);
    const existing = this.counters.get(k);
    if (existing) {
      existing.value += delta;
    } else {
      this.counters.set(k, { name, labels, value: delta });
    }
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const k = this.key(name, labels);
    const existing = this.histograms.get(k);
    if (existing) {
      existing.values.push(value);
    } else {
      this.histograms.set(k, { name, labels, values: [value] });
    }
  }

  snapshot(): {
    counters: CounterEntry[];
    histograms: Array<HistogramEntry & { p50: number; p95: number; p99: number; count: number }>;
  } {
    return {
      counters: Array.from(this.counters.values()),
      histograms: Array.from(this.histograms.values()).map((h) => {
        const sorted = [...h.values].sort((a, b) => a - b);
        return {
          ...h,
          count: sorted.length,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          p99: percentile(sorted, 0.99),
        };
      }),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}
