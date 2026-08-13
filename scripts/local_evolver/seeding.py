"""Central RNG seeding for reproducible evolver runs (C4).

The whole pipeline consumes three global RNG sources:

  * ``random``          — walk-forward random parameter search
  * ``numpy.random``    — bootstrap / misc statistical helpers
  * ``torch``           — Monte Carlo GBM paths and MPT random portfolios

``seed_all`` pins all of them so any run can be replayed exactly. Call it
once at the CLI entry point (``evolver.py``); ``generate_report`` re-invokes
it when a seed is supplied so programmatic users get the same guarantee.
"""

import random

import numpy as np
import torch
from constants import DEFAULT_SEED

__all__ = ["DEFAULT_SEED", "make_python_rng", "seed_all"]


def seed_all(seed: int) -> None:
    """Seed ``random``, ``numpy.random`` and ``torch`` global state."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def make_python_rng(seed: int) -> random.Random:
    """Create an independent, seeded ``random.Random`` for isolated sections."""
    return random.Random(seed)
