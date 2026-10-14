"""SME | VOF live coupling — the meshes.

Each reduced arm (`ARMS`, the model cell) is a 1-D mesh of 120 cells on its domain
(dx = 5 mm). The resolved arm is the VOF tank x in [0, 1.5] m, 0.4 m high, 120 x 40
cells (`TANK`, `zoomy_foam.vof.Tank`; its 40 cells over the height are the column
samples NZ), still water H_LOW; the run cell writes its blockMesh case on the
OpenFOAM backend.
"""
from zoomy_core.mesh import LSQMesh

N_ARM = 120
TANK = dict(lx=1.5, ly=0.4, nx=120, ny=NZ, h0=H_LOW)


def arm_mesh(name):
    """The 1-D mesh of the reduced arm `name`."""
    (x0, x1), _, _ = ARMS[name]
    return LSQMesh.create_1d(domain=(x0, x1), n_inner_cells=N_ARM)


mesh = arm_mesh("Swe")
