"""
SWE Irrigation Game — Pyodide-compatible version.
Pure NumPy solver, Panel UI, static HTML via `panel convert`.

Run locally:   panel serve game/app.py --port 5006
Static export: panel convert game/app.py --to pyodide-worker --out dist
"""
import numpy as np
import panel as pn
from bokeh.plotting import figure
from bokeh.models import FreehandDrawTool, ColumnDataSource, LinearColorMapper
from bokeh.palettes import Blues256
from pathlib import Path
from time import time as get_time

IMG = Path(__file__).parent / "images"

# ══════════════════════════════════════════════════════
# Parameters
# ══════════════════════════════════════════════════════
SCALE = 5
NX = NY = 60 * SCALE            # 300 interior cells
NG = 5                           # ghost cells for raster display
Q_INFLOW = 0.01
H_INFLOW = 0.1
END_TIME = 60.0
TICK_PERIOD = 150                # ms between UI updates

# Boundary openings [row_start, row_end] in interior cell coords
O_IN  = [[SCALE * 35, SCALE * 45]]
O_OUT = [[SCALE * 20, SCALE * 30], [SCALE * 45, SCALE * 55]]
O_TOP = [[SCALE * 15, SCALE * 25], [SCALE * 40, SCALE * 45]]
O_BOT = [[SCALE * 30, SCALE * 40]]
N_GAUGES = len(O_TOP) + len(O_OUT) + len(O_BOT)  # 5


def _wall_segs(openings):
    """Complement of openings → list of wall segments."""
    w, p = [], 0
    for a, b in openings:
        w.append([p, a]); p = b
    w.append([p, NX])
    return w


# ══════════════════════════════════════════════════════
# SWE Finite-Volume Solver (Pure NumPy, float32)
# ══════════════════════════════════════════════════════
F = np.float32
GRAVITY = F(9.81)
WET_TOL = F(1e-6)
CFL_NUM = F(0.45)
DT_MIN, DT_MAX = F(1e-4), F(0.5)
N_ELEM = NX + 2                 # 1 ghost cell on each side
XL, XR = F(-10.0), F(10.0)
DX = F((XR - XL) / N_ELEM)
HALF = F(0.5)
SOLVER_BUDGET = 0.08            # max seconds to spend per tick


def _init_Q():
    Q = np.zeros((4, N_ELEM, N_ELEM), dtype=np.float32)
    Q[0] = F(0.01)
    _bc(Q)
    return Q


def _wd(Q):
    """Zero out dry cells (h <= WET_TOL) in-place."""
    dry = Q[0] <= WET_TOL
    Q[0][dry] = 0
    Q[1][dry] = 0
    Q[2][dry] = 0


def _bc(Q):
    """Apply boundary conditions in-place."""
    # East — reflective wall with outflow openings
    Q[0, :, -1] = Q[0, :, -2]
    Q[1, :, -1] = -Q[1, :, -2]
    for a, b in O_OUT:
        Q[1, a:b, -1] = np.maximum(Q[1, a:b, -2], 0)
    Q[2, :, -1] = Q[2, :, -2]
    Q[3, :, -1] = Q[3, :, -2]

    # West — inflow
    Q[0, :, 0] = Q[0, :, 1]
    for a, b in O_IN:
        Q[0, a:b, 0] = np.maximum(Q[0, a:b, 1], F(H_INFLOW))
    Q[1, :, 0] = -Q[1, :, 1]
    for a, b in O_IN:
        Q[1, a:b, 0] = np.where(Q[1, a:b, 1] >= 0, F(Q_INFLOW), Q[1, a:b, 1])
    Q[2, :, 0] = Q[2, :, 1]
    Q[3, :, 0] = Q[3, :, 1]

    # North — reflective wall with outflow openings
    Q[0, -1, :] = Q[0, -2, :]
    Q[1, -1, :] = Q[1, -2, :]
    Q[2, -1, :] = -Q[2, -2, :]
    for a, b in O_TOP:
        Q[2, -1, a:b] = np.maximum(Q[2, -2, a:b], 0)
    Q[3, -1, :] = Q[3, -2, :]

    # South — reflective wall with outflow openings
    Q[0, 0, :] = Q[0, 1, :]
    Q[1, 0, :] = Q[1, 1, :]
    Q[2, 0, :] = -Q[2, 1, :]
    for a, b in O_BOT:
        Q[2, 0, a:b] = np.minimum(Q[2, 1, a:b], 0)
    Q[3, 0, :] = Q[3, 1, :]


def _flux(q):
    """SWE flux in x and y directions (float32)."""
    h = q[0]
    sh = np.where(h > 0, h, F(1))
    u = np.where(h > 0, q[1] / sh, F(0))
    v = np.where(h > 0, q[2] / sh, F(0))
    z = np.zeros_like(h)
    hu = h * u
    hv = h * v
    hh = GRAVITY * h * h * HALF
    Fx = np.array([hu, hu * u + hh, hu * v, z])
    Fy = np.array([hv, hu * v, hv * v + hh, z])
    return Fx, Fy


def _step(Q):
    """One FVM time step (float32).  Modifies Q in-place, returns dt."""
    _wd(Q)

    # Constant reconstruction — copies to avoid aliasing
    Qi = Q[:, 1:-1, 1:-1].copy()
    Qn = Q[:, 2:,   1:-1].copy()
    Qs = Q[:, :-2,  1:-1].copy()
    Qe = Q[:, 1:-1, 2:  ].copy()
    Qw = Q[:, 1:-1, :-2 ].copy()

    # Reflective wall for obstacle neighbours (Q[3] > 0)
    for Qj in (Qn, Qs, Qw, Qe):
        m = Qj[3] > 0
        Qj[0][m] =  Qi[0][m]
        Qj[1][m] = -Qi[1][m]
        Qj[2][m] = -Qi[2][m]

    Fi, Gi = _flux(Qi)
    Fn, Gn = _flux(Qn)
    Fs, Gs = _flux(Qs)
    Fe, Ge = _flux(Qe)
    Fw, Gw = _flux(Qw)

    # Max wave speed (Rusanov)
    h = Q[0]
    sh = np.where(h > 0, h, F(1))
    c = np.sqrt(GRAVITY * np.maximum(h, F(0)))
    s = max(
        float((np.where(h > 0, np.abs(Q[1] / sh), F(0)) + c).max()),
        float((np.where(h > 0, np.abs(Q[2] / sh), F(0)) + c).max()),
        1e-10,
    )
    dt = float(max(DT_MIN, min(CFL_NUM * DX / F(s), DT_MAX)))

    # Lax-Friedrichs numerical fluxes
    sf = F(s)
    def _lf(ql, qr, fl, fr):
        d = sf * (qr - ql); d[3] = 0
        return HALF * (fl + fr - d)

    Fw_f = _lf(Qw, Qi, Fw, Fi)
    Fe_f = _lf(Qi, Qe, Fi, Fe)
    Gn_f = _lf(Qi, Qn, Gi, Gn)
    Gs_f = _lf(Qs, Qi, Gs, Gi)

    Q[:, 1:-1, 1:-1] = Qi + F(dt / float(DX)) * (Fw_f - Fe_f + Gs_f - Gn_f)

    _wd(Q)
    _bc(Q)
    return dt


# ══════════════════════════════════════════════════════
# Rasterization (draw strokes → obstacle grid)
# ══════════════════════════════════════════════════════
def _raster_line(seg, w=3):
    """Rasterize one polyline onto a (NX+2·NG, NY+2·NG) grid."""
    pad = NG + w
    Np = max(NX, NY) + 2 * pad
    xs_all, ys_all = [], []
    for i in range(1, len(seg)):
        d = np.hypot(seg[i, 0] - seg[i - 1, 0], seg[i, 1] - seg[i - 1, 1])
        n = max(int(Np * d + 1), 2)
        xs_all.extend(np.linspace(seg[i - 1, 0], seg[i, 0], n).tolist())
        ys_all.extend(np.linspace(seg[i - 1, 1], seg[i, 1], n).tolist())
    xs = np.asarray(xs_all)
    ys = np.asarray(ys_all)
    ix = np.clip((xs * (NY + NG + w)).astype(int), 0, NY + 2 * pad - 1)
    iy = np.clip((ys * (NX + NG + w)).astype(int), 0, NX + 2 * pad - 1)
    buf = np.zeros((NX + 2 * pad, NY + 2 * pad), dtype=np.uint8)
    for wx in range(1, w + 1):
        for wy in range(1, w + 1):
            buf[iy + wy, ix + wx] += 1
    return buf[w:-w, w:-w]


def _rasterize(raster, data):
    """Rasterize all freehand strokes from a ColumnDataSource dict."""
    if "xs" in data and "ys" in data:
        for xs, ys in zip(data["xs"], data["ys"]):
            seg = np.column_stack([np.asarray(xs), np.asarray(ys)])
            if len(seg) >= 2:
                raster = raster + _raster_line(seg)
        raster = (raster > 0).astype(np.uint8) * 255
    return raster


# ══════════════════════════════════════════════════════
# Panel UI
# ══════════════════════════════════════════════════════
pn.extension("gridstack")
from panel.layout.gridstack import GridStack

# ─── Game state ───────────────────────────────────────
state = dict(
    Q=_init_Q(),
    raster=np.zeros((NX + 2 * NG, NY + 2 * NG), dtype=np.uint8),
    time=0.0,
    running=False,
    finished=False,
    submitted=False,
    outflow=[0.0] * N_GAUGES,
    scores=[],
)

# ─── Indicator widgets ────────────────────────────────
bars = [
    pn.indicators.Progress(name="", value=0, max=100, width=50, bar_color="success")
    for _ in range(N_GAUGES)
]
w_time = pn.indicators.Number(
    name="Zeit", value=END_TIME, font_size="36pt", format="{value:.1f}"
)
w_score = pn.indicators.Number(
    name="Punkte",
    value=0,
    font_size="36pt",
    colors=[(200, "red"), (400, "gold"), (450, "green")],
)
w_hs = pn.pane.Markdown("## Highscore\n")

# ─── Bokeh canvas (draw + flow image) ────────────────
canvas = figure(
    tools=[],
    toolbar_location=None,
    x_range=(0, 1),
    y_range=(0, 1),
    height=NX,
    width=NY,
    sizing_mode="stretch_both",
)
canvas.xaxis.visible = canvas.yaxis.visible = False
canvas.grid.grid_line_color = None
canvas.toolbar.logo = None

fh_src = ColumnDataSource(data=dict(xs=[], ys=[]))
fh_rend = canvas.multi_line("xs", "ys", source=fh_src, line_width=2)
fh_tool = FreehandDrawTool(renderers=[fh_rend])
canvas.add_tools(fh_tool)
canvas.toolbar.active_drag = fh_tool

cmap = LinearColorMapper(palette=Blues256, low=0, high=255, nan_color="black")


def _render():
    """Generate the (NX+2·NG, NY+2·NG) flow image with NaN for walls."""
    Q, r = state["Q"], state["raster"]
    ng = NG
    # Scale water height to 0-255
    flow = np.minimum(Q[0, 1:-1, 1:-1] * 1275.0, 255.0)
    flow = np.where(r[ng:-ng, ng:-ng] > 0, np.nan, flow)
    # Mark boundary walls as NaN
    for a, b in _wall_segs(O_IN):
        flow[a:b, :ng] = np.nan
    for a, b in _wall_segs(O_OUT):
        flow[a:b, -ng:] = np.nan
    for a, b in _wall_segs(O_TOP):
        flow[-ng:, a:b] = np.nan
    for a, b in _wall_segs(O_BOT):
        flow[:ng, a:b] = np.nan
    # Full image with ghost-cell inflow/outflow ports
    out = np.full((NX + 2 * ng, NY + 2 * ng), np.nan, dtype=np.float64)
    out[ng:-ng, ng:-ng] = flow
    out = np.where(r > 0, np.nan, out)
    # Fill port regions with adjacent flow values
    for a, b in O_IN:
        out[ng + a : ng + b, :ng] = flow[a:b, 0:1]
    for a, b in O_OUT:
        out[ng + a : ng + b, -ng:] = flow[a:b, -1:]
    for a, b in O_TOP:
        out[-ng:, ng + a : ng + b] = flow[-1:, a:b]
    for a, b in O_BOT:
        out[:ng, ng + a : ng + b] = flow[0:1, a:b]
    return out


img_src = ColumnDataSource(data=dict(image=[_render()]))
canvas.image(
    "image", x=0, y=0, dw=1, dh=1, color_mapper=cmap, source=img_src, level="image"
)


# ─── Score logic ──────────────────────────────────────
def _score_from(val, goal=3.0):
    return min(100, max(0, int(val / goal * 100)))


def _on_bar_change(*_):
    s = sum(b.value for b in bars)
    if s == 500 and not state["finished"]:
        tf = 1 + (1 - np.exp(-(END_TIME - state["time"]) / END_TIME))
        s = int(s * tf + 0.4)
        state["finished"] = True
        state["running"] = False
    w_score.value = int(s)


for b in bars:
    b.param.watch(_on_bar_change, "value")


def _on_time_change(*_):
    if state["finished"] and not state["submitted"]:
        state["submitted"] = True
        state["scores"].append(w_score.value)
        state["scores"].sort(reverse=True)
        del state["scores"][10:]
        w_hs.object = "# Highscore\n" + "\n".join(
            f"{i + 1}. {s}" for i, s in enumerate(state["scores"])
        )


w_time.param.watch(_on_time_change, "value")


# ─── Simulation tick (periodic callback) ─────────────
def _tick():
    t_render = get_time()
    img_src.data = dict(image=[_render()])
    t_render = get_time() - t_render

    if not state["running"]:
        return

    t_solve = get_time()
    Q = state["Q"]
    dt_acc = 0.0
    n_steps = 0
    deadline = get_time() + SOLVER_BUDGET
    while get_time() < deadline:
        dt = _step(Q)
        state["time"] += dt
        dt_acc += dt
        n_steps += 1
        if state["time"] >= END_TIME:
            state["running"] = False
            state["finished"] = True
            state["time"] = END_TIME
            break
    t_solve = get_time() - t_solve

    # Accumulate outflow at gauge openings
    of = state["outflow"]
    ig = 0
    for a, b in O_TOP:
        of[ig] += float(np.sum(Q[2, -2, a:b]) * dt_acc)
        ig += 1
    for i, (a, b) in enumerate(O_OUT):
        of[3 - i] += float(np.sum(Q[1, a:b, -2]) * dt_acc)
        ig += 1
    for a, b in O_BOT:
        of[ig] += float(np.sum(-Q[2, 1, a:b]) * dt_acc)
        ig += 1

    for i, v in enumerate(of):
        bars[i].value = _score_from(v)
    w_time.value = END_TIME - state["time"]

    # Push rasterized obstacles into solver field
    Q[3, 1:-1, 1:-1] = state["raster"][NG:-NG, NG:-NG]

    print(
        f"[perf] render={t_render*1000:.1f}ms  "
        f"solver={t_solve*1000:.1f}ms  "
        f"({n_steps} steps, dt_acc={dt_acc:.4f})"
    )


pn.state.add_periodic_callback(_tick, period=TICK_PERIOD)


# ─── Buttons ─────────────────────────────────────────
def _do_raster():
    state["raster"] = _rasterize(state["raster"], fh_src.data)
    fh_src.data = dict(xs=[], ys=[])


btn_start = pn.widgets.Button(name="Schleuse öffnen", button_type="primary")


def _on_start(ev):
    if not state["running"]:
        state["running"] = True
        btn_start.disabled = True
        _do_raster()


btn_start.on_click(_on_start)

btn_clear = pn.widgets.Button(name="Skizze löschen", button_type="primary")


def _on_clear(ev):
    fh_src.data = dict(xs=[], ys=[])
    state["raster"][:] = 0


btn_clear.on_click(_on_clear)

btn_reset = pn.widgets.Button(name="Zurücksetzen", button_type="primary")


def _on_reset(ev):
    state["Q"] = _init_Q()
    state["raster"][:] = 0
    state["time"] = 0.0
    state["running"] = False
    state["finished"] = False
    state["submitted"] = False
    state["outflow"][:] = [0.0] * N_GAUGES
    for b in bars:
        b.value = 0
    w_time.value = END_TIME
    w_score.value = 0
    btn_start.disabled = False
    fh_src.data = dict(xs=[], ys=[])


btn_reset.on_click(_on_reset)

# ─── Face images (reactive to progress bars) ─────────
_img_paths = {
    "sad": str(IMG / "sad.png"),
    "neutral": str(IMG / "neutral.png"),
    "happy": str(IMG / "happy.png"),
}


def _mk_face():
    return pn.pane.Image(_img_paths["sad"], sizing_mode="stretch_both")


def _mk_face_fn(pane):
    def fn(val):
        key = "sad" if val < 50 else ("happy" if val > 75 else "neutral")
        pane.object = _img_paths[key]
        return pane

    return fn


faces = [_mk_face() for _ in range(N_GAUGES)]
face_w = [pn.bind(_mk_face_fn(faces[i]), bars[i].param.value) for i in range(N_GAUGES)]

# ─── Help overlay ─────────────────────────────────────
_help_on = [False]
gif_w = pn.pane.GIF(str(IMG / "tutorial.gif"), visible=False, sizing_mode="stretch_both")
btn_help = pn.widgets.Button(name="?", button_type="primary", width=40)


def _toggle_help(ev):
    _help_on[0] = not _help_on[0]
    if _help_on[0]:
        gif_w.object = None
        gif_w.object = str(IMG / "tutorial.gif")
        gif_w.visible = True
        canvas.visible = False
    else:
        gif_w.visible = False
        canvas.visible = True


btn_help.on_click(_toggle_help)

# ══════════════════════════════════════════════════════
# Layout (GridStack)
# ══════════════════════════════════════════════════════
app = GridStack(
    sizing_mode="stretch_both", min_height=600, allow_resize=False, allow_drag=False
)

# Row 0 — score + header
app[0:2, 0:2] = w_score
app[0, 2:12] = pn.Row(
    pn.pane.Markdown(
        "## Gesucht: Ingenieur für antike Bewässerungssysteme\n\n"
        "Male dein Bewässerungssystem und öffne das Schleuse. "
        "**Ziel**: Fülle die Gärten - so schnell wie möglich!"
    )
)

# Row 1 — top gauges
app[1, 2:4] = pn.Spacer()
app[1, 4:6] = pn.Row(face_w[0], bars[0])
app[1, 6] = pn.Spacer()
app[1, 7:9] = pn.Row(face_w[1], bars[1])
app[1, 10:12] = pn.Spacer()

# Left column — timer, inflow image, highscore
app[2:4, 0:2] = pn.Column(w_time)
app[4:6, 0:2] = pn.Row(
    pn.Spacer(height=50),
    pn.pane.PNG(
        str(IMG / "inflow.png"), fixed_aspect=True, sizing_mode="stretch_both"
    ),
    sizing_mode="stretch_both",
)
app[6:11, 0:2] = pn.Row(w_hs)

# Centre — canvas + help overlay
app[2:10, 2:10] = pn.Column(canvas, gif_w, margin=5)

# Right column — east outflow gauges
app[2, 10] = pn.Spacer()
app[3, 10] = pn.Column(face_w[2])
app[4, 10] = pn.Column(bars[2])
app[5:6, 10] = pn.Row()
app[6, 10] = pn.Column(face_w[3])
app[7, 10] = pn.Column(bars[3])
app[8:10, 10] = pn.Spacer()
app[2:10, 11] = pn.Spacer()

# Row 10 — bottom gauge
app[10, 2:6] = pn.Spacer()
app[10, 6:8] = pn.Row(face_w[4], bars[4])
app[10, 8:10] = pn.Spacer()

# Row 11 — buttons + logo
app[11, 0:2] = pn.Row(btn_help)
app[11, 2:10] = pn.Row(btn_start, btn_clear, btn_reset)
app[10, 10:12] = pn.Spacer()
app[11, 10:12] = pn.Row(
    pn.pane.PNG(
        str(IMG / "logo_mbd.png"), fixed_aspect=True, sizing_mode="stretch_both"
    ),
    sizing_mode="stretch_both",
)

app.servable()
