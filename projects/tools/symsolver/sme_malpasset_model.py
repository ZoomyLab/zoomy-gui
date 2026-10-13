"""``MalpassetSME`` — the Malpasset model on the canonical, dimension-general
``SME`` (Shallow Moment Equations) from ``zoomy_core.model.models``.

Now that the official ``SME`` is dimension-agnostic (``dimension=2`` → 1-D
``[b, h, q_0, q_1, …]``; ``dimension=3`` → 2-D map ``[b, h, q_x_0, q_x_1,
q_y_0, q_y_1, …]``) and consumes **composable closures** (the old
``MaterialModel`` was deleted), this class is a thin wrapper:

  SME(level, dimension, closures=[Newtonian(), NavierSlip(), StressFree()])

plus the Malpasset-specific NUMERICS this case needs on the real wet/dry mesh:

  * a KP-desingularized ``hinv`` aux (``update_aux_variables``) so the raw
    ``1/h`` in the conservative flux stays finite at the shoreline,
  * the closed-form normal-projected HSWME eigenvalue spectrum,
  * a per-cell momentum cap (``update_variables``) — h never floored.

``level=0`` ≡ SWE.  Eigenvalues (Koellermeier & Rominger 2020, rotational
invariance): ``u_n = (Σ_d q_{d,0}·n_d)·hinv``, ``α₁ₙ = −(Σ_d q_{d,1}·n_d)·hinv``,
``λ ∈ {0, u_n∓√(g·h+α₁ₙ²), u_n + c_i·α₁ₙ (leggauss roots), u_n (tangential)}``.
"""
from __future__ import annotations

import numpy as np
import sympy as sp

from zoomy_core.model.models import SME
from zoomy_core.model.models.closures import (
    Closure, Newtonian, NavierSlip, StressFree, ElderViscosity, RoughWall,
    WallFunctionBed, ManningFriction)
from zoomy_core.misc.misc import ZArray
from zoomy_core.systemmodel import SystemModel


def malpasset_closures():
    """Viscous Newtonian bulk + Navier-slip bed + stress-free surface — the
    composable closures replacing the deleted ``MaterialModel``.  ``nu`` and
    ``lambda_s`` are set via the model parameters (defaults below)."""
    return [Newtonian(), NavierSlip(), StressFree()]


def _zeta_p(s, cap=0.5):
    """Near-wall reference height ζ_p = z_p/h, CLAMPED to [·, cap].  Without the
    cap, a thin cell (h < z_p) gives ζ_p > 1, so ``velocity_at(ζ_p)`` EXTRAPOLATES
    the modal velocity profile far outside [0,1] (φ₁(ζ_p)=2ζ_p−1 grows without
    bound) → a garbage friction velocity and over-excited moments at the shoreline
    (seen as |α₁|/|u| p90~2, max~22 even when the run stays finite).  Cap < 1 keeps
    the reference a genuine near-bed height for any depth."""
    return sp.Min(s.par.z_p / s.depth, sp.Float(cap))


class WallFunctionElder(Closure):
    """Wall-function Elder eddy viscosity — the *moment-stable* turbulent bulk
    closure (case-local; the proper replacement for plain ``ElderViscosity``).

    Plain Elder ``ν_t = κ·u_star·h·ζ(1−ζ)`` makes the SME first moment RUN AWAY
    in deep water for two reasons, both fixed here:

    1. **u_⋆ is a constant parameter, decoupled from the bed law.** A constant
       ``u_star`` cannot track the flow, so the moment-damping it provides is an
       arbitrary number rather than the real bed stress (this is the same fix done
       case-side).  Here ``u_⋆`` is COMPUTED from the wall function, the SAME
       friction velocity the bed drag uses (pair with :class:`WallFunctionBed`)::

           C_f = (κ / ln(z_p/z_0))²,   z_0 = k_s/30,
           U_p = u(ζ_p),  ζ_p = z_p/h   (the near-wall reference velocity, NOT
                                         the bed trace u(0), which collapses in a
                                         truncated moment expansion),
           u_⋆ = √(C_f) |U_p|.

    2. **Plain Elder ν_t VANISHES at the wall (ζ=0).** The moment damping lives
       where the shear is — at the bed — so a ν_t that → 0 there cannot damp the
       growing first moment.  We add the offset log-layer mixing length
       ``ℓ = κ(z + z_p)`` (Nezu–Nakagawa), giving::

           ν_t = κ u_⋆ (1−ζ)(h ζ + z_p)
               = κ u_⋆ z_p   at the bed (ζ=0)   → finite near-wall damping,
               = 0           at the surface (ζ=1) → stress-free consistent,
               ≈ κ u_⋆ h ζ(1−ζ)  in the bulk    → the Elder parabola.

    Result: both the bed momentum sink (``WallFunctionBed``: ρu_⋆²) and the bulk
    damping (∝ κ u_⋆ z_p at the wall) are set by the SAME computed u_⋆ and stay
    finite regardless of the moment amplitude, so the equilibrium shear
    ``α₁/u ≈ √(C_f)/κ`` is bounded and depth-INDEPENDENT (no runaway).  See
    ``equilibrium_check.py`` for the symbolic equilibrium-vs-depth proof."""
    closes = "bulk"; requires = ("u",)

    def register(self, m):
        m.parameter("kappa", 0.41)
        m.parameter("k_s", 1e-3)
        m.parameter("z_p", 0.1)
        m.parameter("nu", 0.0)        # molecular floor; ν_t dominates
        m.parameter("u_eps", 1e-3)    # speed-regularization (finite IMEX Jacobian)

    def _ustar(self, s):
        """Computed wall-function friction velocity ``u_⋆ = √(C_f)·√(U_p²+u_eps²)``
        with the near-wall reference velocity ``U_p = u(ζ_p)`` (alias-safe: slot 0
        of ``velocity_at`` is THIS axis' velocity in the diagonal bulk call).  The
        ``u_eps`` floor under the root keeps ∂u_⋆/∂U finite at U=0 — a bare
        ``|U_p|`` has a singular derivative there, which NaNs the IMPLICIT (IMEX)
        cell-wise Newton on the at-rest initial condition."""
        Cf = (s.par.kappa / sp.log(s.par.z_p / (s.par.k_s / 30))) ** 2
        Up = s.velocity_at(_zeta_p(s))[0]
        return sp.sqrt(Cf) * sp.sqrt(Up ** 2 + s.par.u_eps ** 2)

    def expression(self, s):
        z = s.depth * s.zeta
        nu_t = s.par.kappa * self._ustar(s) * (1 - s.zeta) * (z + s.par.z_p)
        return s.par.rho * (s.par.nu + nu_t) * s.dz(s.u)


class MixingLength(Closure):
    """Prandtl MIXING-LENGTH eddy viscosity ``ν_t = ℓ²·|∂_z u|`` — the algebraic,
    GRADIENT-based turbulent bulk closure, and the one form that cannot let the
    first moment run away.

    Why not :class:`WallFunctionElder` (or plain Elder, or the ``C_μk²/ε`` wall
    floor):  all of them key ν_t to a VELOCITY (``u_⋆ = √C_f·|u(ζ_p)|``, or
    ``√k``), never to the shear.  In the moment projection the moment sink is
    then ``−c·ν_t·α₁`` with ``ν_t ∝ |u − α₁|``, i.e. LINEAR in α₁ with a
    coefficient that SHRINKS as α₁ grows — the shear destroys the very mixing
    that should limit it.  MEASURED on this case: ``d S[q₁]/d q₁`` turns
    POSITIVE for ``α₁ > u/2`` at every depth ≥ 0.5 m, and the Elder level-1
    march dies at t ≈ 16.7 s with dt collapsing 2500×.

    Keying ν_t to the gradient instead makes the sink ``−c·|α₁|·α₁`` —
    QUADRATIC, with derivative ``−2c|α₁| < 0`` for every α₁.  Unconditionally
    self-limiting, no cap, no threshold.  This is the algebraic reduction of the
    same mechanism that keeps k–ε bounded (its ε-equation destruction term
    ``−C₂ε²/k`` is quadratic for exactly this reason), under local equilibrium
    P = ε.

    Mixing length: ``ℓ = κ·(z + z₀)·√(1 − ζ)`` with ``z₀ = k_s/30`` (Nikuradse).
    The ``z₀`` offset keeps ℓ finite at the bed — SME resolves only ABOVE the
    wall layer — and the ``√(1−ζ)`` factor takes ℓ to zero at the free surface,
    which is what reproduces the log profile and the parabolic ν_t under local
    equilibrium.  Equilibrium shear is then ``α₁/u ≈ √C_f/κ``, i.e. the SAME
    log-law value the wall function targets, but reached through a quadratic
    sink rather than a collapsing linear one.

    Nonlinear in ζ ⇒ build the model with ``quadrature_order > 0``.  ``eps_reg``
    regularizes ``|∂_z u|`` so the source jacobian stays finite at rest (the
    point-implicit source assembles ``I − dt·J`` on a motionless reservoir)."""
    closes = "bulk"; requires = ("u",)

    def register(self, m):
        m.parameter("kappa", 0.41)
        m.parameter("k_s", 5e-2)      # Nikuradse roughness; rocky valley ~0.05-0.3 m
        m.parameter("nu", 1e-6)       # molecular floor
        m.parameter("eps_reg", 1e-3)  # |du/dz| regularization

    def expression(self, s):
        z = s.depth * s.zeta
        z_0 = s.par.k_s / 30
        ell = s.par.kappa * (z + z_0) * sp.sqrt(1 - s.zeta)
        dudz = s.dz(s.u)
        nu_t = ell ** 2 * sp.sqrt(dudz ** 2 + s.par.eps_reg ** 2)
        return s.par.rho * (s.par.nu + nu_t) * dudz


class SmoothWallFunctionBed(WallFunctionBed):
    """``WallFunctionBed`` with a REGULARIZED slip-speed magnitude so the implicit
    (IMEX) source Jacobian is finite at rest.  Core ``WallFunctionBed`` forms the
    drag from a bare ``√(ΣU²)`` whose ∂/∂U is singular at U=0 — the cell-wise
    Newton then NaNs on the at-rest initial condition (the whole reservoir is
    motionless at t=0).  Here ``|U| → √(ΣU² + u_eps²)`` (the same trick
    ``ManningFriction`` uses with its ``1e-12`` floor), leaving the drag itself
    unchanged for any moving flow."""

    def register(self, m):
        super().register(m)
        m.parameter("u_eps", 1e-3)
        m.parameter("zeta_p", 0.15)   # matching height as a FRACTION of h

    def _Cf(self, s):
        """Log-law drag with the matching height taken as a FRACTION of the
        depth, ``z_p = zeta_p·h``, rather than core's fixed absolute ``z_p``.

        Core pins ``z_p = 0.1 m``, so ``zeta_p = z_p/h`` DRIFTS with the flow:
        0.01 in the 10 m reservoir, but 0.5 (mid-depth, at the case's cap) once
        h < 0.2 m.  The log law is then matched outside the near-wall layer
        precisely in the shallow flood front — the region that sets the transit
        time.  Fixing the FRACTION keeps the matching point inside the near-wall
        layer at every depth, which is standard wall-function practice.

        A useful consequence: ``C_f = (κ/ln(zeta_p·h/z_0))²`` now carries a
        genuine DEPTH dependence, rising as the water shallows — the same trend
        Manning fakes empirically with ``h^{-1/3}``, but derived from the log
        profile, and far gentler because ``ln`` grows so slowly.

        The ``Max(·, e)`` floor holds the logarithm ≥ 1 (hence ``C_f ≤ κ² =
        0.168``) instead of letting it pass through zero and flip sign once the
        matching height drops below the roughness length in a drying cell."""
        z0 = s.par.k_s / 30
        zp = s.par.zeta_p * s.depth
        return (s.par.kappa / sp.log(sp.Max(zp / z0, sp.exp(1)))) ** 2

    def traction(self, s):
        Cf = self._Cf(s)
        ut = s.u_tangent_at(s.par.zeta_p)
        speed = sp.sqrt(sum(u ** 2 for u in ut) + s.par.u_eps ** 2)
        return {"normal": None,
                "tangent": [s.par.rho * Cf * speed * u for u in ut]}

    def expression(self, s):
        Up = s.velocity_at(s.par.zeta_p)[0]
        return (s.par.rho * self._Cf(s) * Up
                * sp.sqrt(Up ** 2 + s.par.u_eps ** 2))


class SmoothManningFriction(ManningFriction):
    """``ManningFriction`` with a REGULARIZED speed, so its source jacobian is
    finite at rest — the Manning twin of :class:`SmoothWallFunctionBed`.

    Core :meth:`ManningFriction.traction` (the path the moment hierarchy takes;
    the depth-averaged scalar :meth:`expression` is a different leg) builds the
    bed stress from a bare ``|U_t| = √(Σ u_{t,α}²)``.  In TWO horizontals that
    magnitude's derivative ``∂|U|/∂u_x = u_x/√(u_x²+u_y²)`` is 0/0 at rest, so
    the jacobian is singular exactly where every Malpasset run starts: the
    reservoir is motionless at t=0.

    Explicitly stepped that is harmless — nothing ever evaluates the jacobian.
    It bites the POINT-IMPLICIT source (``source_treatment="linearized"``),
    which assembles ``A = I − dt·J`` per cell: MEASURED on this model at
    dimension=3, q=0, h=55 m, 2 of the 16 jacobian entries come out non-finite,
    so ``A`` is NaN in every cell on step 1 and the run dies immediately.
    (Measured the other way too: the same model at dimension=2 marches fine,
    because in one horizontal the magnitude collapses to ``Abs(u)`` and the
    0/0 never forms — which is why a 1-D probe does NOT catch this.)

    ``|U| → √(Σ u² + u_eps²)`` removes the singularity and leaves the drag
    itself unchanged for any moving flow (at u_eps = 1e-3 m/s the correction is
    below the wet/dry noise floor).  Same trick, same parameter name, and the
    same reason as :class:`SmoothWallFunctionBed` — which the case already
    carries for the wall-function bed."""

    def register(self, m):
        super().register(m)
        m.parameter("u_eps", 1e-3)

    def traction(self, s):
        h = s.depth
        h_eff = sp.Max(h, sp.Float(self.h_floor)) if self.h_floor > 0 else h
        Cf = s.par.g * s.par.n ** 2 / h_eff ** sp.Rational(1, 3)
        speed = sp.sqrt(sum(ut ** 2 for ut in s.u_tangent) + s.par.u_eps ** 2)
        return {"normal": None,
                "tangent": [s.par.rho * Cf * speed * ut for ut in s.u_tangent]}


def malpasset_elder_closures():
    """Moment-STABLE turbulent closure set: :class:`WallFunctionElder` bulk eddy
    viscosity + :class:`WallFunctionBed` rough-wall log-law bed drag + stress-
    free surface.  Both build their friction velocity from the SAME wall function
    (``u_⋆=√(C_f)|u(ζ_p)|``) evaluated at the near-wall reference height ζ_p —
    NOT at the bed trace ``u(0)`` (which collapses as the first moment grows and
    lets the flow accelerate without bound).  This is the fair, non-runaway
    closure for asking whether SME moments (level ≥ 1) buy anything on Malpasset.
    ``k_s`` (Nikuradse roughness) and ``z_p`` (reference height) are the knobs.

    (The plain ``[ElderViscosity(), RoughWall(), StressFree()]`` set is kept in
    :func:`malpasset_elder_closures_naive` for the runaway comparison.)"""
    return [WallFunctionElder(), SmoothWallFunctionBed(), StressFree()]


def malpasset_manning_closures():
    """Newtonian bulk + Manning bed friction + stress-free surface — the
    canonical TELEMAC-equivalent friction law (same as :class:`MalpassetSWE`'s
    ``n``), composable with the moment hierarchy: :class:`ManningFriction`
    already ships a ``traction()`` for the SME/VAM bottom trace, so this is a
    direct reuse, not a new closure."""
    return [Newtonian(), SmoothManningFriction(h_floor=MANNING_H_FRICTION_FLOOR),
            StressFree()]


def malpasset_mixinglength_closures():
    """GRADIENT-based turbulent set: :class:`MixingLength` bulk (nu_t = l^2|du/dz|)
    + :class:`SmoothWallFunctionBed` rough-wall log-law bed drag + stress-free
    surface.  The bed law constrains the BOTTOM velocity (not the bulk, as
    Manning does) and the mixing length then propagates that shear upward, with a
    QUADRATIC moment sink that is self-limiting by construction.  Requires
    ``quadrature_order > 0`` (the bulk stress is nonlinear in zeta)."""
    return [MixingLength(), SmoothWallFunctionBed(), StressFree()]


#: Mixing-length set: roughness k_s is THE calibration knob (rocky valley
#: 0.05-0.3 m; the elder default 1e-3 m is glass-smooth and under-frictions).
MALPASSET_MIXINGLENGTH_PARAMS = {"g": 9.81, "rho": 1.0, "kappa": 0.41,
                                 "k_s": 5e-2, "z_p": 0.1, "nu": 1e-6,
                                 "eps_reg": 1e-3, "u_eps": 1e-3}


def malpasset_elder_closures_naive():
    """The ORIGINAL Elder set that RUNS AWAY — plain parabolic ``ElderViscosity``
    (constant ``u_star``, ν_t→0 at the wall) + ``RoughWall`` (bed drag from the
    collapsing trace ``u(0)``).  Kept only as the negative control in
    ``equilibrium_check.py``; do not use it for production runs."""
    return [ElderViscosity(), RoughWall(), StressFree()]


# ── Malpasset-matched parameters ────────────────────────────────────────────
# Newtonian/Navier-slip set: g, viscosity nu, Navier-slip lambda_s.
MALPASSET_SME_PARAMS = {"g": 9.81, "rho": 1.0, "nu": 1.0, "lambda_s": 0.5}
# Wall-function Elder/Bed set: kappa (von Karman), k_s (Nikuradse roughness),
# z_p (near-wall reference height). NO u_star — the friction velocity u_⋆ is
# COMPUTED from the wall function (u_⋆=√(C_f)|u(ζ_p)|), shared by bulk and bed.
MALPASSET_ELDER_PARAMS = {"g": 9.81, "rho": 1.0, "kappa": 0.41,
                          "k_s": 1e-3, "z_p": 0.1,
                          "nu": 1e-6,    # molecular floor; ν_t dominates
                          "u_eps": 1e-3}  # speed reg. → finite IMEX Jacobian
# Manning set: g, bulk viscosity nu, Manning roughness n (matches MalpassetSWE
# / the TELEMAC reference: n=0.033 ≈ Strickler 30).
MALPASSET_MANNING_PARAMS = {"g": 9.81, "rho": 1.0, "nu": 1.0, "n": 0.033}
#: Depth floor inside the Manning denominator, ``max(h, floor)^(1/3)``.
#:
#: WHY A FLOOR AT ALL: ``ManningFriction`` defaults to ``h_floor=0.0``, leaving a
#: BARE ``h**(1/3)``.  That is finite for h>0, but the instant the order-2 path
#: puts a cell at h<0 (the documented positivity regression — order 1 never
#: does) a fractional power of a negative number is NaN in float64 and the whole
#: field cascades within one step.  Measured: order-2 Manning runs went NaN at
#: t=10-11 s, while the older order-2 NAVIER runs — a LINEAR bed law with no
#: fractional power — merely reached h_min = -656 m and stayed finite.  The
#: floor does not fix the negative depth; it stops a wrong state from becoming
#: an unreadable one.
#:
#: WHY IT IS 0 HERE — the floor is the WRONG instrument and this case does not
#: use it.  :class:`MalpassetSWE` carries ``0.5``, which caps the friction rate
#: in every cell shallower than half a metre, i.e. across the whole advancing
#: toe: at h=1 cm the cap is a factor ~3.7 (1/h^(1/3) = 4.64 against
#: 1/0.5^(1/3) = 1.26).  That silently rewrites the front dynamics this case
#: exists to measure, and shrinking it only trades one arbitrary constant for
#: another.  The stiffness it was papering over is removed properly by the
#: POINT-IMPLICIT source instead — build the NSM with
#: ``source_treatment="linearized"`` and the friction is applied as
#: ``(I − dt·J)⁻¹ S`` with the consistent jacobian, which is unconditionally
#: stable in the stiff limit and drives ``u → 0`` as ``h → 0`` by construction,
#: with the true ``h^(1/3)`` kept everywhere.  Order 1 never produces h<0, so
#: the bare power is safe there; where order 2 DOES (the documented positivity
#: regression) the fix belongs in that regression, not in a friction floor.
MANNING_H_FRICTION_FLOOR = 0.0


class MalpassetSME:
    """Malpasset Shallow Moment model = canonical ``SME`` + wet/dry numerics.

    Parameters
    ----------
    level : int
        Moment truncation ``N_u`` (0 ≡ SWE, 1 = first moment, …).
    dimension : int
        ``2`` = 1 horizontal (1-D), ``3`` = 2 horizontals (the 2-D map).
    closures : list | None
        Composable stress closures; defaults to Newtonian + NavierSlip +
        StressFree (:func:`malpasset_closures`).
    parameters : dict
        Physical parameter values (g, rho, nu, lambda_s).
    """

    def __init__(self, *, level: int = 1, dimension: int = 3,
                 closures=None, parameters: dict | None = None,
                 eps: float = 1e-2, u_max: float = 30.0, clamp: bool = False,
                 desingularize: bool = True, moment_dry_eps: float | None = None,
                 quadrature_order: int = 0,
                 symbolic_spectrum: bool = True,
                 boundary_conditions=None, initial_conditions=None,
                 aux_initial_conditions=None):
        self.level = int(level)
        self.dimension = int(dimension)
        self._nh = self.dimension - 1                # number of horizontals
        self.eps = float(eps)            # wet/dry threshold for the wavespeed gate
        self.u_max = float(u_max)        # velocity cap for the momentum clamp
        self.clamp = bool(clamp)         # per-cell momentum cap on/off
        self.desingularize = bool(desingularize)  # hinv-aux KP 1/h regularization
        # Depth below which the HIGHER MOMENTS (never the mean) are smoothly
        # damped to zero by ``update_variables``.  Deliberately BELOW the KP
        # ``wet_dry_eps``: KP's ``hinv`` already owns how the velocity behaves
        # at ``eps``, so cutting the moments at the same depth puts the two
        # regularizations in competition over the same cells.  Default eps/10.
        self._moment_dry_eps_arg = moment_dry_eps
        self._hinv_sym = None
        self._hinv_update = None
        self.closures = list(closures) if closures is not None else malpasset_closures()
        self.values = dict(MALPASSET_SME_PARAMS)
        if parameters:
            self.values.update({k: float(v) for k, v in parameters.items()})
        # expose the wet/dry threshold as the canonical model parameter
        # ``wet_dry_eps`` (the single source of truth the FVM riemann solver and
        # the jax reconstruction read) instead of baking ``self.eps`` as a sympy
        # literal.  Default from ``eps``; an explicit parameter override wins.
        self.values.setdefault("wet_dry_eps", self.eps)
        self.eps = float(self.values["wet_dry_eps"])   # keep the attr in sync
        self.moment_dry_eps = (float(self._moment_dry_eps_arg)
                               if self._moment_dry_eps_arg else self.eps / 10.0)
        self.boundary_conditions = boundary_conditions
        self.initial_conditions = initial_conditions
        self.aux_initial_conditions = aux_initial_conditions
        # The canonical, dimension-general SME does the derivation + closure.
        # ``symbolic_spectrum=True`` keeps the CLOSED-FORM beta-HSWME spectrum
        # (zoomy_core SME param, default False since core@48ceef8).  The default
        # is right for derivation and postprocessing — it cuts an SME(2) build
        # from 122 s to 23 s — but it moves the eigenvalues to a PER-FACE
        # NUMERICAL EIGENSOLVE at every step, and a Malpasset march is 132,740
        # steps.  Measured on this case, 26,000 cells, level 1, order 1,
        # t_end = 2000 s: closed form 173 s total (1.3 ms/step, run of
        # 2026-08-10); numerical spectrum ~19 s/step, i.e. ~33 days for the
        # same march.  So the case opts back in: the build cost is paid once
        # and cached, the per-step cost is paid 132,740 times.
        #
        # Level 4 is the exception — the symbolic decomposition grows ~9x per
        # level and does not return in reasonable time there, so a level-4 run
        # has to pass ``symbolic_spectrum=False`` and accept the eigensolve.
        # quadrature_order > 0: Gauss-Legendre projection in zeta, REQUIRED by
        # any bulk closure that is nonlinear in zeta (MixingLength, Bingham,
        # k-epsilon).  0 keeps the analytic projection for the linear ones.
        self._sme = SME(level=self.level, dimension=self.dimension,
                        closures=self.closures, parameters=self.values,
                        quadrature_order=int(quadrature_order),
                        symbolic_spectrum=bool(symbolic_spectrum))

    # ── runtime SystemModel ─────────────────────────────────────────────────
    @property
    def system_model(self) -> SystemModel:
        sm = SystemModel.from_model(self._sme)
        # NO hand-rolled regularization here: the 1/h desingularization
        # (`hinv` aux) is the NSM default (`default_operations = [desingularize_hinv()]`).
        # ⚠ (2026-07-17): the dry eigenvalue gate is NO LONGER a default —
        # it was split (guard/gate) and made opt-in per backend. This SME
        # reference keeps it, so each NSM build here passes
        # `extra_operations=[gate_eigenvalues_dry()]` explicitly (see the case's
        # from_system_model call sites: model.py / malpasset_sme_jax.py /
        # test_malpasset_sme.py / equilibrium_1d / reproducer_1d).  The canonical
        # SME also provides its own Koellermeier-Rominger eigenvalues, so the
        # former `_register_hinv_aux` / `_register_spectrum` are gone (they
        # double-desingularized on top of the NSM default → ~45x per-step slowdown).
        if self.clamp:
            self._register_state_clamp(sm)
        if self.boundary_conditions is not None:
            sm.attach_boundary_conditions(
                self.boundary_conditions,
                aux_bcs=getattr(self, "aux_boundary_conditions", None))
        return sm

    # ── momentum naming (dimension-agnostic) ────────────────────────────────
    def _mom_name(self, d, m):
        """Name of the (direction ``d``, mode ``m``) momentum state: ``q_<m>``
        for 1 horizontal (1-D), ``q_<x|y>_<m>`` for 2 horizontals (2-D)."""
        return f"q_{m}" if self._nh == 1 else f"q_{('x', 'y')[d]}_{m}"

    # KP-desingularized inverse depth (the regularization the model carries as
    # a proper ``hinv`` aux; recomputed each step from h by the solver's
    # update_qaux — now a uniform framework hook, not a driver subclass).
    @staticmethod
    def kp_hinv(h, eps):
        """``hinv = √2·h/√(h⁴ + max(h,eps)⁴)`` — equals ``1/h`` for ``h ≥ eps``
        but → 0 (not ``1/eps``) as ``h → 0``, so ``u = q·hinv → 0`` at the
        shoreline.  Evaluates symbolically (sympy) or numerically (numpy/jax)."""
        import sympy as _sp
        Max = _sp.Max if isinstance(h, _sp.Basic) else max
        sqrt = _sp.sqrt if isinstance(h, _sp.Basic) else (lambda x: x ** 0.5)
        # UNSIGNED numerator (Max(h,0)): honours the Symbol("hinv", positive=True)
        # this aux declares. A RAW signed `h` lets a transient negative-h cell flip
        # hinv negative → u=q·hinv wrong-sign → wrong-sign HLL eigenvalues →
        # anti-dissipative wet/dry-front wavespeed runaway → NaN (jax audit).
        return sqrt(2) * Max(h, 0) / sqrt(h ** 4 + Max(h, eps) ** 4)

    def _register_hinv_aux(self, sm):
        """Register ``hinv`` as a proper auxiliary field — the model-supplied
        ``1/h`` regularization layer.

        The SME flux/source carry RAW ``1/h`` (and ``1/h²``) from the
        conservative change of variables ``u = q/h``.  In near-dry cells
        ``q/h`` blows up the velocity → ``dt → 0``.  Instead of dividing by
        ``h`` we carry a desingularized inverse depth as a named aux ``hinv``
        and replace every ``h^{-n}`` in the operators by ``hinv^{n}``.  The aux
        is refreshed each step from the current ``h`` by the solver's
        ``update_qaux`` via :attr:`update_aux_variables` (KP :meth:`kp_hinv`).
        Naming it ``hinv`` also lets the Audusse Riemann solver re-regularize it
        at the hydrostatically reconstructed faces (``riemann_solvers``)."""
        import itertools
        hs = next(s for s in sm.state if str(s) == "h")
        eps = sm.parameters.wet_dry_eps                # canonical parameter
        hinv = sp.Symbol("hinv", positive=True)        # the aux field symbol
        self._hinv_sym = hinv
        self._hinv_update = self.kp_hinv(hs, eps)       # symbolic KP(h)

        def _hfactor(s):
            """For a negative power ``base^n`` (n<0) in which ``h`` is an EXACT
            divisor of ``base`` (so ``base = h·R`` with R h-free), return the
            desingularized ``hinv^{-n}·R^n`` — i.e. pull the ``h`` out and turn
            ``1/h`` into the bounded aux ``hinv``.  Covers a bare ``h`` (R=1), a
            product ``(h·B)^n``, AND — crucially — an ADD denominator where h is a
            common factor, e.g. the wall-function projection's
            ``1/(h·ln(z_p/z_0)²)`` whose base sympy stores as
            ``-h·log(k_s)²+2h·log(k_s)log(z_p)+…`` (an Add).  That last form keeps
            a RAW 1/h that the bare-``h``/``Mul`` matchers miss; at a dry cell h=0
            the base→0 so 1/base→inf and (0·inf)→NaN in the moment source, which
            poisons the implicit solve and kills the 2-D moments."""
            R = sp.cancel(s.base / hs)         # base / h
            return hinv ** (-s.exp) * R ** s.exp

        def sub(e):
            if not isinstance(e, sp.Basic):
                return e
            return e.replace(
                lambda s: (isinstance(s, sp.Pow) and s.exp.is_number
                           and s.exp.is_negative and s.base.has(hs)
                           and not sp.cancel(s.base / hs).has(hs)),
                _hfactor)

        def map_array(M):
            if M is None:
                return None
            if isinstance(M, sp.MatrixBase):
                return M.applyfunc(sub)
            flat = [sub(M[idx]) for idx in
                    itertools.product(*[range(s) for s in M.shape])]
            return (ZArray(flat, M.shape) if isinstance(M, ZArray)
                    else sp.Array(flat).reshape(*M.shape))

        sm.flux = map_array(sm.flux)
        sm.source = map_array(sm.source)
        sm.nonconservative_matrix = map_array(sm.nonconservative_matrix)
        sm.hydrostatic_pressure = map_array(sm.hydrostatic_pressure)
        for nm in ("diffusion_matrix", "diffusion_matrix_explicit"):
            if getattr(sm, nm, None) is not None:
                setattr(sm, nm, map_array(getattr(sm, nm)))
        sm.aux_state = list(sm.aux_state) + [hinv]
        # update_aux_variables MUST be a FULL-length aux vector. The JAX
        # `update_qaux` writes it as a PREFIX slice `Qaux[:len(update)]` and then
        # overwrites the LSQ derivative-aux rows. A 1-row `[hinv_update]` lands
        # hinv in aux row 0 (a derivative slot) where the LSQ walk clobbers it,
        # leaving hinv's real (last) slot ≡ 0 — which silently zeroes the ENTIRE
        # SME moment source (every term is ∝ hinv) AND the SME bed friction, so
        # SME(level≥1) degenerates to inviscid SWE. Emit passthrough on every
        # existing aux row and the KP formula in hinv's own slot, so the prefix
        # write covers all rows and only hinv survives the derivative walk.
        # [Proper fix = library `update_qaux` honouring aux indices: task 0017.]
        upd = list(sm.aux_state)          # passthrough: row i -> its aux symbol
        upd[-1] = self._hinv_update       # hinv slot -> KP(h)
        sm.update_aux_variables = ZArray(upd)
        sm.refresh_derived_operators(eigenvalues=False)

    def _register_spectrum(self, sm):
        """Normal-projected HSWME spectrum (dimension-agnostic).

        Velocity ``u_n = q_n · inv`` with ``inv`` = the KP-desingularized
        ``hinv`` (when ``desingularize``; dry speeds stay bounded, no gate) or a
        floored ``1/max(h, eps)`` + a ``h ≤ eps`` gate (the legacy clamp path)."""
        Nu = self.level
        eps = sm.parameters.wet_dry_eps                # canonical parameter
        by = {str(s_): s_ for s_ in sm.state}
        h_s = by["h"]
        h_safe = sp.Max(h_s, eps)
        nrm = sm.normal
        if self.desingularize:
            inv = self._hinv_sym if self._hinv_sym is not None else self.kp_hinv(h_s, eps)
        else:
            inv = 1 / h_safe
        u_n = sum(by[self._mom_name(d, 0)] * nrm[d] for d in range(self._nh)) * inv
        if Nu >= 1:
            a1_n = -sum(by[self._mom_name(d, 1)] * nrm[d]
                        for d in range(self._nh)) * inv
        else:
            a1_n = sp.S.Zero
        c_wave = sp.sqrt(sm.parameters.g * h_safe + a1_n ** 2)
        lams = [sp.S.Zero, u_n - c_wave, u_n + c_wave]
        if Nu >= 1:
            roots = np.polynomial.legendre.leggauss(Nu)[0]   # roots of P_Nu
            lams += [u_n + sp.Float(float(cc)) * a1_n for cc in roots]
        while len(lams) < sm.n_equations:        # tangential moments advect at u_n
            lams.append(u_n)
        assert len(lams) == sm.n_equations, (len(lams), sm.n_equations)
        if not self.desingularize:               # KP keeps dry speeds bounded;
            cond = sp.Function("conditional")    # gate only needed on the clamp path
            lams = [cond(h_s > eps, lam, sp.S.Zero) for lam in lams]
        sm.eigenvalues = sp.Matrix(sm.n_equations, 1, lams)

    def _register_state_clamp(self, sm):
        """Per-cell ``update_variables`` momentum cap — the SME analogue of
        :meth:`MalpassetSWE.update_variables`: cap the DEPTH-AVERAGED momentum
        to ``|q| ≤ h_wet·u_max`` (``h_wet = max(h-eps, 0)``) so the bounded
        velocity ``u = q·hinv ≤ u_max`` keeps the CFL wave-speed finite at the
        wet/dry front.  ``h`` is NEVER touched (no h-floor → mass conserved).

        MODE 0 ONLY.  This used to cap every ``q_*`` row, moments included, so
        ``alpha_1 = q_*_1/h`` was held to the SAME ``u_max`` as the mean velocity
        -- a bound the moment amplitude has no physical reason to obey, and one
        that was BINDING: measured on the 26k order-2 march, |alpha_1| sat at the
        cap in 7,666 cell-snapshots.  Capping alpha_1 substitutes a numerical
        limiter for the closure that is supposed to bound the moment, so the
        moment hierarchy could not express the faster characteristics
        ``u ± sqrt(g h + alpha_1^2)`` that are its whole point.  The higher modes
        now pass through untouched.

        NOTE the cap is still applied per COMPONENT, so in two horizontals the
        mode-0 vector speed saturates at ``u_max·sqrt(2)`` (measured 42.42 for
        u_max=30) and the limit is direction-dependent rather than rotationally
        invariant.  Left as-is here because it is the pre-existing behaviour of
        the mode-0 cap; flagged in ``--u-max``."""
        eps = sp.Float(self.eps)
        u_max = sp.Float(self.u_max)
        h_s = sm.state[list(map(str, sm.state)).index("h")]
        h_wet = sp.Max(h_s - eps, sp.S.Zero)
        cap_lim = h_wet * u_max

        def cap(q):
            return sp.Max(-cap_lim, sp.Min(q, cap_lim))

        def is_mode0(nm):
            """``q_0`` (1 horizontal) / ``q_x_0``, ``q_y_0`` (2 horizontals)."""
            return nm.startswith("q_") and nm.rsplit("_", 1)[-1] == "0"

        # DRY-STATE CONSISTENCY, applied to EVERY mode.  This is not a limiter:
        # a cell holding no water carries neither momentum nor a velocity
        # PROFILE, so every q_* must vanish with the depth.  It rides here
        # because the mode-0 cap used to deliver it as a side effect
        # (``cap_lim = max(h-eps,0)*u_max`` is exactly 0 below eps, so capping
        # zeroed the dry cells).  Exempting the moments from the cap therefore
        # silently removed it from them, and MEASURED on the Elder level-1 run
        # that is what killed the march: dry cells kept a finite q_1 while h
        # -> 0, so a_1 = q_1/h reached 1.7e6 at h = 1.5e-6 with q_0 EXACTLY 0
        # (69 such cells at t=9 s, 108 by t=16 s).  The eigenvalue divides by
        # the RAW depth -- lambda = (n.q_0 +- sqrt(g h^3 |n|^2 + (n.q_1)^2))/h
        # -- so those cells leak into the wet interior (an 8 m deep cell held
        # alpha_1 = 228 m/s by t=16 s) and dt collapses at t ~ 16.7 s.
        #
        # SMOOTH, and on its OWN threshold BELOW the KP one.  Two reasons not to
        # reuse ``eps``:  the KP ``hinv`` regularization already governs how the
        # velocity behaves at ``eps``, and a moment cut at the same depth would
        # fight it; and a Min/Max ramp is only C^0, so its kink sits right where
        # the wet/dry front lives and feeds the reconstruction a discontinuous
        # derivative.  ``1 - exp(-(h/eps_m)^2)`` is C^infinity, is 0 at h=0, and
        # is 1 to machine precision by h ~ 6*eps_m (1 - e^-36), so it is a true
        # no-op in any cell with water while damping the moments smoothly to
        # zero as the cell dries.
        eps_m = sp.Float(self.moment_dry_eps)
        wet = 1 - sp.exp(-(h_s / eps_m) ** 2)

        new = []
        for s_ in sm.state:
            nm = str(s_)
            if is_mode0(nm):
                new.append(cap(s_))          # cap already vanishes when dry
            elif nm.startswith("q_"):
                new.append(s_ * wet)         # higher moments: dry-zero ONLY
            else:                            # h and b — untouched
                new.append(s_)
        sm.update_variables = ZArray(new)
