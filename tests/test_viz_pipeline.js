/**
 * End-to-end visualization pipeline test using headless Pyodide.
 *
 * Prerequisites: cd to this directory and run `npm install pyodide`,
 * or set up in a temp dir.
 *
 * Usage: node test_viz_pipeline.js
 *
 * Tests:
 *   1. engine.py loads without error
 *   2. mesh_2d_mpl.py runs and produces matplotlib SVG
 *   3. mesh_3d_plotly.py runs and produces Plotly JSON
 *   4. store_meta is populated with fields and snapshot count
 */
const { loadPyodide } = require("pyodide");
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");

async function main() {
    console.log("Loading Pyodide + packages...");
    const py = await loadPyodide();
    await py.loadPackage(["matplotlib", "numpy", "micropip"]);
    await py.pyimport("micropip").install(["plotly"]);

    // Load engine
    const engineCode = fs.readFileSync(path.join(GUI_DIR, "engine.py"), "utf8");
    await py.runPythonAsync(engineCode);

    // Populate store with fake data
    await py.runPythonAsync(`
import numpy as np

class FakeMesh2D:
    def __init__(self):
        nx, ny = 5, 5
        x = np.linspace(0, 1, nx + 1); y = np.linspace(0, 1, ny + 1)
        xx, yy = np.meshgrid(x, y)
        self.vertices = np.column_stack([xx.ravel(), yy.ravel()])
        cells = []
        for j in range(ny):
            for i in range(nx):
                n0 = j * (nx + 1) + i
                cells.append([n0, n0 + 1, n0 + nx + 2, n0 + nx + 1])
        self.cells = np.array(cells)
        self.cell_centers = np.array([self.vertices[c].mean(0) for c in self.cells])
        self.dim = 2

class FakeModel:
    variables = type("V", (), {"keys": lambda s: ["h", "hu"]})()

mesh = FakeMesh2D(); model = FakeModel()
n_cells = len(mesh.cells)
store.save(mesh, model, np.random.rand(2, n_cells),
           Q_timeline=np.random.rand(10, 2, n_cells),
           times=np.linspace(0, 1, 10))
`);

    // Test 1: matplotlib 2D viz
    const snippet2d = fs.readFileSync(path.join(GUI_DIR, "snippets/mesh_2d_mpl.py"), "utf8");
    const r2d = JSON.parse(py.globals.get("process_code")(snippet2d));
    console.log("\nTest 1: mesh_2d_mpl.py");
    console.log("  status:", r2d.status, "plot_type:", r2d.plot_type);
    if (r2d.status !== "success" || r2d.plot_type !== "matplotlib") {
        console.error("  ❌ FAIL");
        console.error("  output:", r2d.output.substring(0, 500));
        process.exit(1);
    }
    console.log("  ✅ PASS (SVG", r2d.plot_data.length, "bytes)");

    // Test 2: plotly 3D viz
    const snippet3d = fs.readFileSync(path.join(GUI_DIR, "snippets/mesh_3d_plotly.py"), "utf8");
    const r3d = JSON.parse(py.globals.get("process_code")(snippet3d));
    console.log("\nTest 2: mesh_3d_plotly.py");
    console.log("  status:", r3d.status, "plot_type:", r3d.plot_type);
    if (r3d.status !== "success" || r3d.plot_type !== "plotly") {
        console.error("  ❌ FAIL");
        console.error("  output:", r3d.output.substring(0, 500));
        process.exit(1);
    }
    console.log("  ✅ PASS (JSON", r3d.plot_data.length, "bytes)");

    // Test 3: store_meta
    console.log("\nTest 3: store_meta");
    if (!r2d.store_meta || !r2d.store_meta.fields || r2d.store_meta.n_snapshots !== 10) {
        console.error("  ❌ FAIL:", r2d.store_meta);
        process.exit(1);
    }
    console.log("  ✅ PASS:", JSON.stringify(r2d.store_meta));

    console.log("\nAll tests passed.");
}

main().catch(err => { console.error("Test crashed:", err); process.exit(1); });
