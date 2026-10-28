"""Experiment B: shallow-water waves running up a beach, with foam.

A 1D nonlinear shallow-water (Saint-Venant) solver on a sloping beach. The
shallow-water equations cannot overturn a crest, so a breaking wave shows up
as a bore: the front steepens into a near-vertical step and keeps running up
the sand. That bore is exactly where foam should be born.

The foam field follows the stage 1 rule, now with real transport:

    dF/dt + u dF/dx = S - F / tau

S comes from a breaking detector, u is the water velocity, and foam left on
dry sand decays slowly, which leaves foam lines at the run-up limit.

We compare breaking detectors from the literature on where they fire:
  - steep front:     d(eta)/dx < -0.35 (face looking toward the beach)
  - convergence:     -du/dx > 0.6 (water piling up)
  - Froude:          u / sqrt(g h) > 0.6 (crest particles catching the wave)
  - breaking switch: local wave height / still depth > 0.78, the McCowan
                     limit used to switch on breaking in hybrid Boussinesq
                     surf models

The plain shallow-water equations have no dispersion, so waves steepen into
bores long before a real wave would break. A foam source built on steepness
alone therefore whitewashes the whole sea; gating it with the breaking switch
puts foam back in the surf zone. Both foam fields are plotted.

Run:  python experiments/swe_runup.py   (needs numpy + matplotlib, ~20 s)
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

G = 9.81
FIGURES = Path(__file__).parent / "figures"
DRY = 1e-3


def bed(x: np.ndarray, x_toe: float, depth: float, slope: float) -> np.ndarray:
    """Flat sea floor at -depth, then a plane beach rising from x_toe."""
    return np.where(x < x_toe, -depth, -depth + slope * (x - x_toe))


def minmod(a, b):
    return np.where(a * b > 0, np.sign(a) * np.minimum(abs(a), abs(b)), 0.0)


class Beach1D:
    def __init__(self, length=160.0, dx=0.08, depth=3.0, slope=1 / 20, x_toe=60.0,
                 amplitude=0.45, period=8.0):
        self.dx = dx
        self.x = np.arange(dx / 2, length, dx)
        self.z = bed(self.x, x_toe, depth, slope)
        self.depth = depth
        self.amplitude = amplitude
        self.omega = 2 * math.pi / period
        self.h = np.maximum(-self.z, 0.0)
        self.hu = np.zeros_like(self.h)
        self.t = 0.0

    # Hydrostatic reconstruction (Audusse et al. 2004) keeps the lake at rest
    # exactly at rest and handles wet/dry cells; Rusanov flux; MUSCL slopes.
    def flux(self, h, hu):
        z = self.z
        u = np.where(h > DRY, hu / np.maximum(h, DRY), 0.0)
        eta = h + z
        # pad with boundary cells: wave maker on the left, wall on the right
        eta_in = self.amplitude * math.sin(self.omega * self.t) * min(self.t / 8, 1)
        u_in = eta_in * math.sqrt(G / self.depth)   # incoming long wave
        etap = np.concatenate(([eta_in], eta, [eta[-1]]))
        zp = np.concatenate(([-self.depth], z, [z[-1]]))
        up = np.concatenate(([u_in], u, [-u[-1]]))
        dEta = minmod(etap[1:-1] - etap[:-2], etap[2:] - etap[1:-1])
        dU = minmod(up[1:-1] - up[:-2], up[2:] - up[1:-1])
        dEta = np.concatenate(([0.0], dEta, [0.0]))
        dU = np.concatenate(([0.0], dU, [0.0]))
        # left/right states at each interface i+1/2 (between cell i and i+1)
        etaL = etap[:-1] + 0.5 * dEta[:-1]
        etaR = etap[1:] - 0.5 * dEta[1:]
        uL = up[:-1] + 0.5 * dU[:-1]
        uR = up[1:] - 0.5 * dU[1:]
        hL = np.maximum(etaL - zp[:-1], 0.0)
        hR = np.maximum(etaR - zp[1:], 0.0)
        zface = np.maximum(zp[:-1], zp[1:])
        hLs = np.maximum(hL + zp[:-1] - zface, 0.0)
        hRs = np.maximum(hR + zp[1:] - zface, 0.0)
        uL = np.where(hL > DRY, uL, 0.0)
        uR = np.where(hR > DRY, uR, 0.0)
        a = np.maximum(abs(uL) + np.sqrt(G * hLs), abs(uR) + np.sqrt(G * hRs))
        fh = 0.5 * (hLs * uL + hRs * uR) - 0.5 * a * (hRs - hLs)
        fq = 0.5 * (hLs * uL**2 + 0.5 * G * hLs**2 + hRs * uR**2 + 0.5 * G * hRs**2) - 0.5 * a * (hRs * uR - hLs * uL)
        # well-balancing source terms from the reconstruction
        sL = 0.5 * G * (hL**2 - hLs**2)   # acts on the cell left of the face
        sR = 0.5 * G * (hR**2 - hRs**2)   # acts on the cell right of the face
        return fh, fq, sL, sR, a

    def step(self, cfl=0.4):
        h, hu = self.h, self.hu
        _, _, _, _, a = self.flux(h, hu)
        dt = cfl * self.dx / max(a.max(), 1e-6)
        h0, hu0 = h.copy(), hu.copy()
        for stage in range(2):  # Heun (SSP-RK2)
            fh, fq, sL, sR, _ = self.flux(self.h, self.hu)
            dh = -(fh[1:] - fh[:-1]) / self.dx
            dq = -((fq[1:] + sL[1:]) - (fq[:-1] + sR[:-1])) / self.dx
            hn = self.h + dt * dh
            qn = self.hu + dt * dq
            if stage == 1:
                hn = 0.5 * (h0 + hn)
                qn = 0.5 * (hu0 + qn)
            hn = np.maximum(hn, 0.0)
            qn = np.where(hn > DRY, qn, 0.0)
            self.h, self.hu = hn, qn
        self.t += dt
        return dt


def advect_and_fade(foam, x, u, dt, source, wet, tau_wet=4.0, tau_dry=25.0):
    back = np.clip(x - u * dt, x[0], x[-1])           # semi-Lagrangian
    foam = np.interp(back, x, foam)
    tau = np.where(wet, tau_wet, tau_dry)             # stranded foam lasts longer
    return np.maximum(foam * np.exp(-dt / tau), source)


def run(seconds=110.0, record_every=0.1):
    sim = Beach1D()
    x, dx = sim.x, sim.dx
    still_depth = np.maximum(-sim.z, 0.05)
    shore = x[np.argmin(abs(sim.z))]
    period = 2 * math.pi / sim.omega
    foam_naive = np.zeros_like(x)
    foam_gated = np.zeros_like(x)
    eta_hi = np.zeros_like(x)
    eta_lo = np.zeros_like(x)
    stack = {"eta": [], "naive": [], "gated": []}
    times = []
    fired = {"steep front": [], "convergence": [], "Froude": [], "breaking switch": []}
    next_record = 0.0
    while sim.t < seconds:
        dt = sim.step()
        h = sim.h
        wet = h > 0.02
        u = np.where(wet, sim.hu / np.maximum(h, DRY), 0.0)
        eta = np.where(h > 0.01, h + sim.z, np.nan)
        eta0 = np.nan_to_num(eta, nan=0.0)

        # Local wave height: envelopes that relax toward the surface over a period.
        eta_hi = np.maximum(eta0, eta_hi - (eta_hi - eta0) * dt / period)
        eta_lo = np.minimum(eta0, eta_lo + (eta0 - eta_lo) * dt / period)
        height = eta_hi - eta_lo

        # --- breaking detectors (only after the inflow ramp has settled)
        deta = np.gradient(eta0, dx)
        dudx = np.gradient(u, dx)
        steep = wet & (deta < -0.35)
        converge = wet & (-dudx > 0.6)
        froude = wet & (u / np.sqrt(G * np.maximum(h, DRY)) > 0.6)
        switch = wet & (height / still_depth > 0.78) & (x < shore)
        if sim.t > 30:
            for name, m in (("steep front", steep), ("convergence", converge),
                            ("Froude", froude), ("breaking switch", switch)):
                if m.any():
                    fired[name].append(x[m].min())

        # --- foam sources
        front = np.clip((-deta - 0.2) * 3.0, 0, 1) * wet
        swash_tip = (wet & (h < 0.15) & (u > 0.5) & (x > shore - 2)).astype(float) * 0.8
        foam_naive = advect_and_fade(foam_naive, x, u, dt, front, wet)
        foam_gated = advect_and_fade(foam_gated, x, u, dt, np.maximum(front * switch, swash_tip), wet)

        if sim.t >= next_record:
            stack["eta"].append(eta.copy())
            stack["naive"].append(foam_naive.copy())
            stack["gated"].append(foam_gated.copy())
            times.append(sim.t)
            next_record += record_every
    return sim, np.array(times), {k: np.array(v) for k, v in stack.items()}, fired


def main() -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from shoaling import shoal

    FIGURES.mkdir(exist_ok=True)
    sim, times, stack, fired = run()
    eta, foam = stack["eta"], stack["gated"]
    x = sim.x
    shore = x[np.argmin(abs(sim.z))]
    toe = x[np.argmax(sim.z > sim.z[0])]

    print("1D shallow-water run-up (slope 1:20, offshore depth 3 m, a = 0.45 m, T = 8 s)")
    print(f"  beach toe (start of the slope) is {shore - toe:.1f} m seaward of the still shoreline")
    for name, xs in fired.items():
        if xs:
            first = np.median(xs)
            print(f"  {name:<16} typically fires from {shore - first:5.1f} m seaward of the still shoreline")
        else:
            print(f"  {name:<16} never fired")
    _, _, _, b = shoal(1 / 20, 2 * sim.amplitude, 8.0)
    print(f"  linear theory + H/h = 0.78 predicts breaking {b.x_break:5.1f} m from the shoreline (depth {b.h_break:.2f} m)")
    wet_late = ~np.isnan(eta[times > 60])
    runup_x = x[np.nonzero(wet_late.any(axis=0))[0].max()]
    print(f"  maximum run-up reaches {runup_x - shore:4.1f} m past the still shoreline, "
          f"{(sim.z[np.argmin(abs(x - runup_x))]):.2f} m above still water")
    dry_now = np.isnan(eta[-1]) & (x > shore)
    print(f"  foam still on dry sand at the end: max {foam[-1][dry_now].max() if dry_now.any() else 0:.2f}")
    for name in ("naive", "gated"):
        cover = (stack[name][times > 60][:, (x > toe) & (x < shore)] > 0.3).mean()
        offshore = (stack[name][times > 60][:, x < toe] > 0.3).mean()
        print(f"  foam cover ({name} source): {cover:.0%} of the sloping surf area, {offshore:.0%} offshore")

    # --- timestack: what a coastal camera looking along the beach records
    view = (x > 40) & (x < shore + 12)
    late = times > 50
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.8), dpi=130, sharey=True)
    ext = [x[view][0] - shore, x[view][-1] - shore, times[late][-1], times[late][0]]
    im0 = axes[0].imshow(eta[late][:, view], aspect="auto", extent=ext, cmap="RdBu_r", vmin=-0.8, vmax=0.8)
    axes[0].set_title("water level η (m)", fontsize=10)
    axes[0].set_xlabel("x from still shoreline (m)")
    axes[0].set_ylabel("time (s)")
    fig.colorbar(im0, ax=axes[0], fraction=0.046)
    sea = np.where(np.isnan(eta[late][:, view]), 0.0, 1.0)
    titles = {"naive": "foam from steep fronts only", "gated": "foam gated by H/h > 0.78, plus swash tip"}
    for ax, name in zip(axes[1:], ("naive", "gated")):
        rgb = np.zeros(sea.shape + (3,))
        rgb[...] = np.array([0.85, 0.77, 0.6])            # sand
        rgb[sea > 0] = np.array([0.05, 0.3, 0.42])         # water
        f = np.clip(stack[name][late][:, view], 0, 1)[..., None]
        rgb = rgb * (1 - f) + f * np.array([1.0, 1.0, 1.0])
        ax.imshow(rgb, aspect="auto", extent=ext)
        ax.set_title(titles[name], fontsize=10)
        ax.set_xlabel("x from still shoreline (m)")
    for ax in axes:
        ax.axvline(0, color="k", lw=0.5, ls=":")
        ax.axvline(toe - shore, color="k", lw=0.5, ls="--")
    fig.suptitle("Timestack of a shallow-water surf zone: bores form, run up, and strand foam on the sand", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGURES / "swe_timestack.png")

    # --- snapshot profile
    fig, ax = plt.subplots(figsize=(9, 3), dpi=130)
    k = np.argmin(abs(times - (times[-1] - 2.5)))
    ax.fill_between(x - shore, sim.z, sim.z.min() - 0.2, color="#d9c49b")
    ax.plot(x - shore, eta[k], color="#1f6f8b", lw=1.5)
    ax.scatter((x - shore)[foam[k] > 0.3], eta[k][foam[k] > 0.3] + 0.05, s=2, color="#e07a5f", label="foam > 0.3")
    ax.set_xlim(-20, 12)
    ax.set_ylim(-1.3, 1.3)
    ax.set_xlabel("x from still shoreline (m)")
    ax.set_title(f"Profile at t = {times[k]:.1f} s: bore front and foam", fontsize=10)
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(FIGURES / "swe_profile.png")
    print(f"Figures written to {FIGURES}")


if __name__ == "__main__":
    main()
