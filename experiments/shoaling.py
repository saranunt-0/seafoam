"""Experiment A: where and how does a wave break on a sloping beach?

Linear wave theory over a plane beach h(x) = m * x (x = distance from the
shoreline). Wave height grows by energy-flux conservation (shoaling) until it
hits the McCowan limit H = 0.78 h; the Iribarren number then predicts whether
the breaker spills, plunges or surges (Battjes 1974).

These numbers set the defaults of the Blender "SF Shore Waves" node.

Run:  python experiments/shoaling.py   (needs numpy + matplotlib)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

G = 9.81
GAMMA = 0.78  # McCowan breaking index H/h
FIGURES = Path(__file__).parent / "figures"


def wavenumber(omega: float, h: np.ndarray | float) -> np.ndarray:
    """Solve the dispersion relation w^2 = g k tanh(k h) for k (Newton)."""
    h = np.asarray(h, dtype=float)
    k = omega**2 / G / np.sqrt(np.tanh(omega**2 * h / G))  # Eckart's guess
    for _ in range(30):
        t = np.tanh(k * h)
        f = G * k * t - omega**2
        df = G * t + G * k * h * (1 - t**2)
        k = k - f / df
    return k


def group_velocity(omega: float, h: np.ndarray) -> np.ndarray:
    k = wavenumber(omega, h)
    kh = k * h
    c = omega / k
    return 0.5 * c * (1 + 2 * kh / np.sinh(2 * kh))


@dataclass
class Breaking:
    slope: float
    H0: float
    T: float
    L0: float
    iribarren: float
    breaker: str
    x_break: float
    h_break: float
    H_break: float


def breaker_type(xi0: float) -> str:
    # Battjes (1974), offshore Iribarren number
    if xi0 < 0.5:
        return "spilling"
    if xi0 < 3.3:
        return "plunging"
    return "surging/collapsing"


def shoal(slope: float, H0: float, T: float, x_max: float = 2000.0, n: int = 20000):
    omega = 2 * math.pi / T
    L0 = G * T**2 / (2 * math.pi)
    x = np.linspace(x_max, 0.01, n)  # walk shoreward
    h = slope * x
    cg0 = G * T / (4 * math.pi)
    H = H0 * np.sqrt(cg0 / group_velocity(omega, h))
    broken = np.nonzero(H >= GAMMA * h)[0]
    i = broken[0]
    xi0 = slope / math.sqrt(H0 / L0)
    result = Breaking(slope, H0, T, L0, xi0, breaker_type(xi0), x[i], h[i], H[i])
    return x, h, H, result


def greens_law(h: np.ndarray, h_ref: float, H_ref: float) -> np.ndarray:
    return H_ref * (h_ref / h) ** 0.25


def main() -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    FIGURES.mkdir(exist_ok=True)

    # --- 1. One beach in detail: 1:30 slope, 1.2 m, 8 s swell.
    x, h, H, b = shoal(1 / 30, 1.2, 8.0)
    shallow = h < 0.05 * b.L0
    h_ref = h[shallow][0]
    H_green = greens_law(h, h_ref, H[shallow][0])

    print("Reference beach (slope 1:30, H0 = 1.2 m, T = 8 s)")
    print(f"  deep-water wavelength L0 = {b.L0:.1f} m")
    print(f"  breaks at x = {b.x_break:.1f} m from the shoreline, depth {b.h_break:.2f} m, height {b.H_break:.2f} m")
    print(f"  shoaling gain at the break point H_b / H0 = {b.H_break / b.H0:.2f}")
    print(f"  Iribarren xi0 = {b.iribarren:.2f} -> {b.breaker}")
    i_b = np.argmin(abs(x - b.x_break))
    print(f"  Green's law at the break point: {H_green[i_b]:.2f} m (linear theory {H[i_b]:.2f} m)")

    fig, ax = plt.subplots(figsize=(8, 3.6), dpi=130)
    mask = x < 150
    ax.fill_between(x[mask], -h[mask], -h[mask].max() - 0.3, color="#d9c49b", label="seabed")
    ax.plot(x[mask], np.where(x[mask] >= b.x_break, H[mask], np.nan), color="#1f6f8b", lw=2, label="wave height H (linear shoaling)")
    ax.plot(x[mask], np.where(x[mask] >= b.x_break, H_green[mask], np.nan), "--", color="#1f6f8b", lw=1, label="Green's law H ∝ h^-1/4")
    ax.plot(x[mask], np.where(x[mask] < b.x_break, GAMMA * h[mask], np.nan), color="#e07a5f", lw=2, label="surf zone, H = 0.78 h")
    ax.axvline(b.x_break, color="#555", lw=0.8, ls=":")
    ax.annotate(f"break point\nh = {b.h_break:.2f} m, H = {b.H_break:.2f} m", (b.x_break, b.H_break),
                xytext=(b.x_break - 8, b.H_break - 1.6), fontsize=8, arrowprops=dict(arrowstyle="->", lw=0.6))
    ax.set_xlim(150, 0)
    ax.set_xlabel("distance from shoreline (m)  ←  waves travel toward the beach")
    ax.set_ylabel("metres")
    ax.set_title("Shoaling and breaking on a 1:30 beach (H0 = 1.2 m, T = 8 s)", fontsize=10)
    ax.legend(fontsize=7, loc="upper left")
    fig.tight_layout()
    fig.savefig(FIGURES / "shoaling.png")

    # --- 2. Breaker type map over beach slope and wave steepness.
    print("\nBreaker type by beach slope (T = 8 s)")
    print(f"  {'slope':>7} {'H0 m':>5} {'xi0':>6} {'type':<20} {'h_b m':>6} {'x_b m':>6}")
    rows = []
    for slope in (1 / 50, 1 / 30, 1 / 15, 1 / 8, 1 / 4):
        for H0 in (0.5, 1.2, 2.5):
            _, _, _, r = shoal(slope, H0, 8.0)
            rows.append(r)
            print(f"  1:{1 / slope:<5.0f} {H0:5.1f} {r.iribarren:6.2f} {r.breaker:<20} {r.h_break:6.2f} {r.x_break:6.1f}")

    fig, ax = plt.subplots(figsize=(6, 4), dpi=130)
    steep = np.logspace(-3, -1, 200)
    slopes = np.logspace(-2.2, -0.3, 200)
    S, M = np.meshgrid(steep, slopes)
    XI = M / np.sqrt(S)
    ax.contourf(S, M, XI, levels=[0, 0.5, 3.3, 1e9], colors=["#cfe8ef", "#7fb7c9", "#2f6f87"])
    ax.contour(S, M, XI, levels=[0.5, 3.3], colors="k", linewidths=0.6)
    for r in rows:
        ax.plot(r.H0 / r.L0, r.slope, "o", ms=4, color="#e07a5f")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("deep-water steepness H0 / L0")
    ax.set_ylabel("beach slope tan β")
    ax.text(0.03, 0.012, "spilling", fontsize=9)
    ax.text(0.0016, 0.03, "plunging", fontsize=9, color="white")
    ax.text(0.0013, 0.3, "surging", fontsize=9, color="white")
    ax.set_title("Breaker type from the Iribarren number (Battjes 1974)", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / "breaker_types.png")
    print(f"\nFigures written to {FIGURES}")


if __name__ == "__main__":
    main()
