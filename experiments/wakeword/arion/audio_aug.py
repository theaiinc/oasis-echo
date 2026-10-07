"""Audio sources + augmentation for the Arion wake-word training (16 kHz mono float32 in [-1, 1])."""
import io, os, glob, hashlib
import numpy as np
import soundfile as sf
from scipy import signal

SR = 16000
ROOT = "/Volumes/Data/dev/wakeword-arion"


def load_wav(path):
    a, sr = sf.read(path, dtype="float32", always_2d=True)
    a = a[:, 0]
    if sr != SR:
        g = np.gcd(sr, SR)
        a = signal.resample_poly(a, SR // g, sr // g).astype(np.float32)
    return a


def trim(a, top_db=35):
    import librosa
    t, _ = librosa.effects.trim(a, top_db=top_db, frame_length=512, hop_length=128)
    return t if len(t) > 1600 else a


def split_of(name, test_frac=0.2):
    h = int(hashlib.md5(name.encode()).hexdigest(), 16) % 1000
    return "test" if h < test_frac * 1000 else "train"


# ---------------------------------------------------------------- noise ---
def _colored(n, rng, beta):
    """1/f^beta noise."""
    X = rng.standard_normal(n // 2 + 1) + 1j * rng.standard_normal(n // 2 + 1)
    f = np.fft.rfftfreq(n, 1 / SR); f[0] = f[1]
    X /= f ** (beta / 2)
    x = np.fft.irfft(X, n)
    return (x / (np.std(x) + 1e-9)).astype(np.float32)


def _band(x, lo, hi, order=2):
    lo = max(lo, 10); hi = min(hi, SR / 2 - 100)
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def _slow(n, rng, rate_hz=0.3, depth=0.3):
    k = max(4, int(n / SR * rate_hz) + 4)
    pts = rng.standard_normal(k)
    env = np.interp(np.linspace(0, k - 1, n), np.arange(k), pts)
    return (1 + depth * np.tanh(env)).astype(np.float32)


def car_noise(n, rng):
    """Procedural car-cabin noise: engine harmonics + tyre/road rumble + wind + optional fan/indicator/rain."""
    t = np.arange(n) / SR
    speed = rng.uniform(0, 1)  # 0 = idle, 1 = highway
    # engine: 4-cyl firing frequency, slowly varying RPM
    rpm = rng.uniform(750, 3200) * _slow(n, rng, 0.2, 0.15)
    f0 = rpm / 60 * 2
    phase = 2 * np.pi * np.cumsum(f0) / SR
    eng = sum((rng.uniform(0.3, 1.0) / k) * np.sin(k * phase + rng.uniform(0, 6)) for k in range(1, 9))
    eng = eng * _slow(n, rng, 2, 0.1) + 0.3 * _band(_colored(n, rng, 1), 30, 400)
    road = _band(_colored(n, rng, 2), 20, 600) * (0.3 + speed) + 0.4 * speed * _band(_colored(n, rng, 1), 200, 1500)
    wind = _band(_colored(n, rng, 1), 300, 3500) * speed ** 2 * _slow(n, rng, 0.5, 0.5)
    x = rng.uniform(0.4, 1.2) * eng / (np.std(eng) + 1e-9) + rng.uniform(0.6, 1.5) * road / (np.std(road) + 1e-9)
    x += rng.uniform(0.2, 1.0) * wind / (np.std(wind) + 1e-9) if speed > 0.3 else 0
    if rng.random() < 0.5:  # A/C fan
        x += rng.uniform(0.1, 0.5) * _band(_colored(n, rng, 0.5), 150, 5000)
    if rng.random() < 0.2:  # indicator ticks
        tick = np.zeros(n, np.float32)
        per = int(SR / rng.uniform(1.4, 1.8)); off = rng.integers(0, per)
        click = np.exp(-np.arange(200) / 25) * rng.standard_normal(200)
        for s in range(off, n - 200, per):
            tick[s:s + 200] += click; s2 = s + per // 2
            if s2 < n - 200: tick[s2:s2 + 200] += 0.7 * click
        x += rng.uniform(0.5, 3) * tick
    if rng.random() < 0.1:  # rain on roof
        r = (rng.random(n) < 0.003) * rng.standard_normal(n)
        x += rng.uniform(0.5, 2) * _band(r.astype(np.float32), 500, 6000) * 8
    # gentle bump transients
    if rng.random() < 0.3 and n > 8000:
        for _ in range(rng.integers(1, 4)):
            s = rng.integers(0, max(1, n - 4000))
            x[s:s + 4000] += rng.uniform(1, 4) * np.exp(-np.arange(4000) / 600) * np.sin(2 * np.pi * rng.uniform(15, 40) * np.arange(4000) / SR)
    x = x.astype(np.float32)
    return x / (np.std(x) + 1e-9)


class Pool:
    """Random crops from a list of long arrays."""
    def __init__(self, arrays):
        self.a = [x for x in arrays if len(x) > SR]
    def crop(self, n, rng):
        x = self.a[rng.integers(len(self.a))]
        if len(x) <= n:
            x = np.tile(x, n // len(x) + 1)
        s = rng.integers(0, len(x) - n + 1)
        y = x[s:s + n]
        return y / (np.std(y) + 1e-9)


def parquet_audio(path, limit=None):
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(path)
    n = 0
    for b in pf.iter_batches(batch_size=32, columns=["audio"]):
        for rec in b.column("audio").to_pylist():
            a, sr = sf.read(io.BytesIO(rec["bytes"]), dtype="float32", always_2d=True)
            a = a[:, 0]
            if sr != SR:
                g = np.gcd(sr, SR); a = signal.resample_poly(a, SR // g, sr // g).astype(np.float32)
            yield a
            n += 1
            if limit and n >= limit:
                return


def musan_noise(split):
    fs = sorted(glob.glob(f"{ROOT}/data/musan/noise/*/*.wav"))
    return [load_wav(f) for f in fs if split_of(os.path.basename(f)) == split]


# ----------------------------------------------------------------- RIR ---
def car_rir(rng):
    """Small, heavily damped cabin: RT60 40-250 ms, a few early reflections."""
    rt60 = rng.uniform(0.04, 0.25)
    L = int(SR * rt60 * 1.2)
    t = np.arange(L) / SR
    h = rng.standard_normal(L) * np.exp(-6.9 * t / rt60)
    h = _band(h.astype(np.float32), 100, 7000)
    h[0] = 0
    d = np.zeros(L, np.float32); d[0] = 1
    for _ in range(rng.integers(2, 6)):
        k = rng.integers(16, min(L - 1, 160)); d[k] += rng.uniform(-0.5, 0.5)
    h = d + rng.uniform(0.1, 0.5) * h / (np.abs(h).max() + 1e-9)
    return h / np.sqrt((h ** 2).sum())


def mic_eq(x, rng):
    lo = rng.uniform(60, 300)
    hi = rng.choice([rng.uniform(3300, 4000), rng.uniform(5000, 7900)], p=[0.25, 0.75])
    return _band(x, lo, hi, order=2)


def speed(x, rng, lo=0.88, hi=1.15):
    f = rng.uniform(lo, hi)
    return signal.resample(x, int(len(x) / f)).astype(np.float32)


class Backgrounds:
    def __init__(self, split, rng, with_music=True, with_speech=True):
        self.rng = rng
        self.musan = Pool(musan_noise(split))
        gt = "validation" if split == "train" else "test"
        self.music = Pool(list(parquet_audio(f"{ROOT}/data/gtzan_{gt}-00000-of-00001.parquet"))) if with_music else None
        fl = "train" if split == "train" else "test"
        self.babble = Pool(list(parquet_audio(f"{ROOT}/data/fleurs_vi_{fl}.parquet", limit=300))) if with_speech else None

    def sample(self, n):
        rng = self.rng
        r = rng.random()
        x = car_noise(n, rng)
        if r < 0.45:
            pass
        elif r < 0.65 and self.music:
            x = x + rng.uniform(0.3, 2.0) * self.music.crop(n, rng)
        elif r < 0.8 and self.babble:
            x = x + rng.uniform(0.2, 0.7) * self.babble.crop(n, rng)
        else:
            x = x * rng.uniform(0, 1) + self.musan.crop(n, rng)
        return (x / (np.std(x) + 1e-9)).astype(np.float32)


def mix(speech, noise, snr_db):
    ps = np.mean(speech ** 2) + 1e-12
    pn = np.mean(noise ** 2) + 1e-12
    return speech + noise * np.sqrt(ps / (pn * 10 ** (snr_db / 10)))


def to_int16(x, rng=None, peak=None):
    if peak is None:
        peak = rng.uniform(0.05, 0.9) if rng is not None else 0.5
    x = x / (np.abs(x).max() + 1e-9) * peak
    return (np.clip(x, -1, 1) * 32767).astype(np.int16)


def augment_utt(x, rng, rir_p=0.6):
    x = speed(x, rng)
    if rng.random() < rir_p:
        x = signal.fftconvolve(x, car_rir(rng))[: len(x) + 800].astype(np.float32)
    if rng.random() < 0.7:
        x = mic_eq(x, rng)
    return x
