"""Perceptual comparison of two renders of the same board (numpy + Pillow only).

Both images are converted to grayscale, scaled to the same width, cropped to the common
height and compared with SSIM (Wang et al. 2004, 8x8 uniform windows, the standard
K1=0.01 / K2=0.03 constants) plus a plain normalized mean absolute difference.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


def _gray(path: Path, width: int) -> np.ndarray:
    im = Image.open(path).convert("L")
    h = max(1, round(im.height * width / im.width))
    return np.asarray(im.resize((width, h), Image.LANCZOS), dtype=np.float64)


def _box_mean(a: np.ndarray, r: int) -> np.ndarray:
    """Mean over r x r windows (valid region), via an integral image."""
    s = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), axis=0), axis=1)
    return (s[r:, r:] - s[:-r, r:] - s[r:, :-r] + s[:-r, :-r]) / (r * r)


def ssim(a: np.ndarray, b: np.ndarray, window: int = 8) -> float:
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _box_mean(a, window), _box_mean(b, window)
    var_a = _box_mean(a * a, window) - mu_a**2
    var_b = _box_mean(b * b, window) - mu_b**2
    cov = _box_mean(a * b, window) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))
    return float(s.mean())


def ssim_ink(a: np.ndarray, b: np.ndarray, window: int = 8, paper: float = 250.0) -> float:
    """SSIM averaged over the windows where either render has ink.

    A dashboard is mostly paper; plain SSIM rewards two blank pages for agreeing about
    nothing. Restricting the mean to windows whose local mean is darker than ``paper`` in
    either image scores what was actually drawn — and still punishes ink drawn in the
    wrong place, since the other image is paper there.
    """
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _box_mean(a, window), _box_mean(b, window)
    var_a = _box_mean(a * a, window) - mu_a**2
    var_b = _box_mean(b * b, window) - mu_b**2
    cov = _box_mean(a * b, window) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))
    mask = (mu_a < paper) | (mu_b < paper)
    return float(s[mask].mean()) if mask.any() else 1.0


def row_profile_corr(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson correlation of the two renders' per-row ink profiles: 1.0 when every band
    of content (title, KPI row, chart row, table) sits at the same height."""
    pa, pb = (255 - a).mean(axis=1), (255 - b).mean(axis=1)
    if pa.std() == 0 or pb.std() == 0:
        return 0.0
    return float(np.corrcoef(pa, pb)[0, 1])


def compare(a_path: Path, b_path: Path, width: int = 220, crop_bottom: int = 0) -> dict[str, float]:
    """Similarity of two page renders scaled to ``width`` px: plain SSIM, ink-weighted
    SSIM, row-profile correlation and normalized mean difference.

    ``crop_bottom`` drops that many (scaled) rows from the bottom of both — the footers
    differ by design (dct prints "Data as of …", the Dive its build stamp).
    """
    a, b = _gray(a_path, width), _gray(b_path, width)
    h = min(a.shape[0], b.shape[0]) - crop_bottom
    a, b = a[:h], b[:h]
    ha, hb = Image.open(a_path).height, Image.open(b_path).height
    return {
        "ssim": ssim(a, b),
        "ssim_ink": ssim_ink(a, b),
        "profile_corr": row_profile_corr(a, b),
        "ndiff": float(np.abs(a - b).mean() / 255.0),
        "height_ratio": min(ha, hb) / max(ha, hb),
    }


def _crop_gray(path: Path, box: tuple[float, float, float, float], width: int) -> np.ndarray:
    x, y, w, h = box
    im = Image.open(path).convert("L").crop((round(x), round(y), round(x + w), round(y + h)))
    hh = max(1, round(im.height * width / im.width))
    return np.asarray(im.resize((width, hh), Image.LANCZOS), dtype=np.float64)


def compare_region(a_path: Path, a_box, b_path: Path, b_box, width: int = 200) -> dict[str, float]:
    """SSIM of one chart card in each render (both crops scaled to ``width`` px and
    cropped to the common height), so vertical drift between cards does not count."""
    a, b = _crop_gray(a_path, a_box, width), _crop_gray(b_path, b_box, width)
    h = min(a.shape[0], b.shape[0])
    a, b = a[:h], b[:h]
    return {"ssim": ssim(a, b), "ssim_ink": ssim_ink(a, b), "ndiff": float(np.abs(a - b).mean() / 255.0)}
