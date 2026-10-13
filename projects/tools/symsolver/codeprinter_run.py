import shutil

import numpy as np

import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
from zoomy_core.symsolver.numpy_backend import SymbolicHyperbolicSolverNumpy

nsm.attach_boundary_conditions(BC.BoundaryConditions([
    BC.Wall(tag="left", momentum_field_indices=[[2]]),
    BC.Wall(tag="right", momentum_field_indices=[[2]])]))
nsm.initial_conditions = IC.RP(
    high=lambda n: np.array([0.0, 2.0, 0.0]),
    low=lambda n: np.array([0.0, 1.0, 0.0]),
    jump_position_x=5.0)
nsm.aux_initial_conditions = IC.Constant(constants=lambda n: np.zeros(n))

time_end = settings["time_end"]
solver = SymbolicHyperbolicSolverNumpy(time_end=time_end, cfl=0.9, dt_write=time_end / 39,
                                       output="output/simulation.h5")
Q, Qaux = solver.setup(mesh, nsm)
time, Q, Qaux = solver.run(Q, Qaux)
shutil.copy("output/simulation.h5", "simulation.h5")
