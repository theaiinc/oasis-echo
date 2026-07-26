import base64
import importlib.util
from pathlib import Path
import unittest

import numpy as np

_MODULE_PATH = Path(__file__).with_name("funasr-bridge.py")
_SPEC = importlib.util.spec_from_file_location("funasr_bridge", _MODULE_PATH)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
FunasrBridge = _MODULE.FunasrBridge


class FakeSpeakerModel:
    def generate(self, input):
        # A deterministic embedding is enough to verify protocol behavior;
        # CAM++ integration is exercised by the real model in production.
        value = float(np.mean(input))
        return [{"spk_embedding": np.array([[value, 1.0, 0.0]], dtype=np.float32)}]


class FunasrSpeakerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.bridge = FunasrBridge()
        self.bridge.speaker_model = FakeSpeakerModel()
        self.samples = np.ones(16000, dtype=np.float32)
        self.bridge._buffer = self.samples.copy()
        self.encoded = base64.b64encode(self.samples.tobytes()).decode("ascii")

    def test_enroll_and_compare_returns_cosine_score(self):
        enrolled = self.bridge.cmd_speaker("enroll", self.encoded, 16000)
        self.assertTrue(enrolled["ok"])
        compared = self.bridge.cmd_speaker("compare")
        self.assertTrue(compared["ok"])
        self.assertAlmostEqual(compared["score"], 1.0, places=6)

    def test_reference_bank_is_bounded(self):
        for _ in range(20):
            self.bridge.cmd_speaker("enroll", self.encoded, 16000)
        self.assertEqual(len(self.bridge._speaker_references), 12)

    def test_compare_without_reference_is_compatible(self):
        result = self.bridge.cmd_speaker("compare")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "no reference")


if __name__ == "__main__":
    unittest.main()
