# Malpasset SME(1): old JAX solver against the new symbolic JAX solver

Runs made 2026-10-13 with the GUI session's own `build_mesh` + `build_model`
(`malpasset-session.zip`, folder "Malpasset dam break"). Settings: SME level 1, dimension 3,
Navier closure (nu = 1, lambda_s = 0.5), wet_dry_eps = 1e-3, desingularize, clamp, order 1,
CFL 0.4, riemann `hr` (`PositiveNonconservativeHLL`), explicit, `geo_malpasset-small.msh`
(26,000 cells), float64, t_end = 120 s, snapshots every 5 s.

| run | solver | difference |
|---|---|---|
| A | old `zoomy_jax.fvm.solver_jax.HyperbolicSolver` | `positivity_method="zhang_shu"`. This configuration is rejected and kept only as a check. |
| B | old `HyperbolicSolver` | `positivity_method=""`. **This is the old reference.** |
| C | new `SymbolicHyperbolicSolverJax` | the session's run code (default `cfl_wave_speed=faces`) |
| C-cells | new | `cfl_wave_speed=cells`, which is the old solver's CFL rule. Diagnostic only. |

**Spectrum.** All runs use `SME(..., symbolic_spectrum=True)`, the closed-form spectrum
that the thesis case `malpasset_sme_jax.py` uses. The model inlined in the session omits this
flag. With the flag off, the old solver cannot run. One evaluation of its eigensolve-based CFL
takes 95 s on the L40S, and the time loop had not compiled after 14 min. The new solver then
falls back to a power-iteration wave speed times 1.06. The effect of that fallback (run "Cnum")
is reported at the end.

**Hardware.** A, B and C ran on GPU 3. Both solvers are **not reproducible run to run on the
GPU**: two identical runs drift apart from round-off. To separate solver differences from that
noise, every run was repeated on the CPU (8 cores, deterministic). The figure uses those CPU
runs.

## Numbers

### t = 120 s, GPU runs

| pair | max abs(dh) [m] | L1(dh)/L1(h) | wet-area XOR [m^2] |
|---|---|---|---|
| A - B | 1.93 | 1.30e-4 | 9,680 |
| **C - B** | **2.02** | **3.94e-4** | **25,823** |
| C - A | 1.29 | 3.93e-4 | 23,508 |
| B2 - B (B run twice: noise floor) | 1.09 | 1.30e-4 | 13,390 |
| C2 - C (C run twice: noise floor) | 5.70 | 1.14e-4 | 4,965 |

Volume:
- 93,922,330.11 m^3 in every run.
- Drift is at most 2e-15 relative.
- h_min = 0 throughout A, B and C.

Wet area (h > 1e-3) at 120 s:
- B: 6,524,772 m^2
- A: 6,526,534 m^2
- C: 6,540,265 m^2

Front:
- Measure: the furthest flooded valley cell (x < 9 km; the cells near the sea get 1e-3 m films).
- At 10 / 30 / 60 / 120 s it lies at x = 4,927 / 5,237 / 5,572 / 5,758 m in **all** runs.
- The front position is identical at the resolution of the cell centres.

### Snapshots, deterministic CPU runs

| pair | t [s] | max abs(dh) [m] | L1(dh)/L1(h) | wet-area XOR [m^2] |
|---|---|---|---|---|
| A - B | 10, 30, 60, 120 | 0 | 0 (bitwise equal) | 0 |
| C - B | 10 | 2.93 | 8.0e-5 | 7,205 |
| C - B | 30 | 2.24 | 3.2e-4 | 20,930 |
| C - B | 60 | 4.52 | 3.6e-4 | 16,810 |
| C - B | 120 | 8.45 | 4.6e-4 | 16,978 |
| C-cells - B | 10 | 0.136 | 5.5e-5 | 3,736 |
| C-cells - B | 30 | 0.954 | 1.4e-4 | 19,175 |
| C-cells - B | 60 | 0.938 | 1.8e-4 | 12,412 |
| C-cells - B | 120 | 0.836 | 2.5e-4 | 7,722 |

The same solver on GPU and on CPU also differs at 120 s:
- B: L1 3.0e-4, max 1.05 m
- C: L1 2.4e-4, max 8.4 m

At the late snapshots, a max abs(dh) of a few metres in single cells of the gorge lies inside the noise.

### Water released into the initially dry valley [m^3]

This is the most robust systematic measure.

| run | 10 s | 30 s | 60 s | 120 s |
|---|---|---|---|---|
| old: A, B, B2, B-cpu | 411,856 | 1,104,408 | 2,170,147-2,170,169 | 4,048,696-4,048,952 |
| new, old CFL rule: C-cells, C-cells-cpu | 411,856 | 1,104,408 | 2,170,143-2,170,153 | 4,048,702-4,048,992 |
| **new default: C, C2, C-cpu** | 411,854 | **1,105,360** | **2,173,281-2,173,303** | **4,053,208-4,053,343** (+0.11 %) |
| Cnum: session model as shipped, numerical spectrum | 427,439 | 1,134,471 | 2,221,329 | 4,149,336 (+2.5 %) |

## Diagnosis, one change at a time

1. **The Zhang-Shu cap does nothing at order 1.**
   - On the CPU, A and B are bitwise equal at every snapshot.
   - The code agrees: `solver_jax.py` passes `positivity=self.positivity_method` to the
     reconstruction only `if order >= 2`. The `zhang_shu` flag is therefore inert at order 1.
   - The A - B difference on the GPU is the GPU's own run-to-run noise. It equals B2 - B.
   - The cap did not alter the old results.
2. **The spatial operator is the same.**
   - Both solvers ran from the same initial condition at a matched constant dt, on the CPU.
   - At dt = 0.03938 s (the old solver's first step), steps 1 to 3 agree to abs(dh) at most
     7e-15 and abs(dq) at most 2e-13.
   - At dt = 0.01 s, step 1 agrees to abs(dh) at most 4e-16 and abs(dq) at most 1e-14.
   - The flux, the hydrostatic reconstruction, the KP `hinv` and the clamp therefore agree to
     round-off.
   - The one-cell difference of 0.556 against 0.523 m seen earlier does not reproduce with this
     model.
3. **Round-off is amplified by the explicit moment source in thin cells.** In the same matched
   run, the first moment of a 2.08 mm deep cell evolves per step as
   q_x_1 = -1.6e-10, then +4.6e-6, then -3.2e-2:
   - The factor per step is -2.8e4, which equals 1 - dt * 12 * nu / h^2.
   - The Newtonian moment damping is therefore explicitly unstable wherever h < sqrt(6 nu dt),
     about 0.3 m.
   - The growth stops only at the momentum clamp, abs(q) = 30 (h - 1e-3). At 120 s, 853 of
     7,858 wet cells sit at that cap, which is 90 % of the cells with h < 0.3 m.
   - The cells then hold a sign-flipping limit cycle that turns any perturbation into O(cap)
     differences. This is also why each solver drifts run to run on the GPU.
   - Control with the same comparison and nu = lambda_s = 0, dt matched by the cell rule:
     C-cells - B stays at max abs(dh) = 6e-14 at 10 s and 5.8e-6 m (L1 1.1e-10) at 120 s.
4. **The time-step rule is the systematic part.**
   - The new solver takes its CFL speed from the Riemann problem at the hydrostatically
     reconstructed face states (`cfl_wave_speed=faces`). The old solver takes the cell
     eigenvalues (`eigenvalues_cfl`).
   - Evaluated on the old run's states, the two rules give the same dt at 0, 5, 30, 60 and
     120 s. At 10 s the face rule gives a 0.9 % larger dt (1.653e-2 against 1.638e-2 s).
   - Switching only this rule in the new solver (C-cells) has three effects:
     - The released volume returns to the old value: +0.11 % becomes -0.004 %, inside the old
       runs' spread.
     - At 10 s, max abs(dh) falls from 2.93 to 0.14 m.
     - At 120 s, L1 falls from 4.6e-4 to 2.5e-4.
   - Without the stiff source, the rule alone accounts for only 3.5e-3 m (L1 1.3e-7) at 10 s.

## Conclusion

C differs from B because of the **time-step sequence**, made large by the **explicit, stiff
Navier/Newtonian moment source in shallow cells**:

- The new default CFL rule (face wave speeds at the reconstructed states) occasionally allows
  about 1 % larger steps than the old cell-eigenvalue rule.
- With nu = 1 m^2/s, explicit stepping is unstable for the first moment wherever h < ~0.3 m,
  and only the momentum clamp bounds it.
- Together these shift the gorge bore. The new run has released 0.11 % more water at 120 s,
  with differences of metres in single cells.
- The flood front position and the volume are unchanged. The wet area agrees within 0.25 %.

Ruled out as the cause:
- **Zhang-Shu:** inert at order 1; A and B are bitwise equal.
- **Fluxes and reconstruction:** identical to round-off.
- **`hinv` / wet-dry handling:** identical to round-off. It does take part in the amplifier
  through the clamp.

Beyond the systematic part, a noise level of L1 of about 1e-4 at 120 s is intrinsic to this
explicit configuration on any hardware.

## Side findings

- **The session model omits `symbolic_spectrum=True`**, which the thesis model sets. As
  shipped, the new solver uses a power-iteration wave speed times 1.06:
  - It is about 10 times further from B (L1 3.7e-3 at 120 s; +2.5 % released water).
  - It produced h_min = -1.3e-5 (one cell stays at -1.7e-7).
  - The closed-form runs keep h >= 0.
- The old solver with the numerical spectrum is unusable: 95 s per CFL eigensolve on the GPU.

Figure `malpasset_old_vs_new.png` / `.pdf` (CPU runs A, B, C; t = 120 s):
- (a) h of B
- (b) h of C, same colour limits as (a)
- (c) h_C - h_B, symmetric-log colour scale (linear within 1 mm), limits ±8.45 m
- (d) wet area against t for A, B, C and C-cells; the inset shows the difference to B

The maps plot cell values. Dry cells (h <= 1e-3) are left unpainted in (a) and (b).
