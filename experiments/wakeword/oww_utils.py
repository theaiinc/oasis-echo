"""Shared utilities for OpenWakeWord experiment scripts."""

import numpy as np


def flatten_features(x):
    """Flatten batched feature arrays for sklearn."""
    return [i.flatten() for i in x]
