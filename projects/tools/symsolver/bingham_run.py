import shutil

import numpy as np

import zoomy_core.model.initial_conditions as IC
from zoomy_core.numerics import NumericalSystemModel, ReconstructionSpec
from zoomy_core.symsolver.numpy_backend import SymbolicHyperbolicSolverNumpy
from zoomy_core.systemmodel import SystemModel

sm = SystemModel.from_model(model)
z_c = H0 - tau_y / a
sm.initial_conditions = IC.Project3D(
    sm,
    height=lambda x: H0 * (1 + seed * np.sin(2 * np.pi * x[0] / wave_length)),
    velocity=lambda x, zeta: a * H0 / lambda_s + a / nu * np.where(
        zeta * H0 <= z_c, z_c * zeta * H0 - (zeta * H0)**2 / 2, z_c**2 / 2))
sm.aux_initial_conditions = IC.Constant(constants=lambda n: np.zeros(n))
display(sm.describe())

nu_eff = nu + tau_y / eps_reg
rate = max((2 * level + 1) * nu_eff * 12 / H0**2, (level + 1)**2 * lambda_s / H0)
nsm = NumericalSystemModel.from_system_model(
    sm, reconstruction=ReconstructionSpec(order=1), dt_max=0.4 / rate)

time_end = settings["time_end"] * tscale
solver = SymbolicHyperbolicSolverNumpy(time_end=time_end, cfl=0.9, dt_write=time_end / 80,
                                       output="output/simulation.h5")
Q, Qaux = solver.setup(mesh, nsm)
time, Q, Qaux = solver.run(Q, Qaux)
shutil.copy("output/simulation.h5", "simulation.h5")
