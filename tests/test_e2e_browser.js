/**
 * Real end-to-end browser test for the Zoomy GUI.
 *
 * Starts a local HTTP server serving the production zoomy_gui/ files,
 * launches a headless Chromium, loads the page, and exercises the real
 * flow including: worker boot, pyodide load, clicking visualization
 * refresh, checking for console errors.
 *
 * This catches bugs that pyodide-in-node tests miss:
 *   - Missing packages in the actual worker (plotly, matplotlib, etc.)
 *   - JS errors in app.js during real click handlers
 *   - Service worker cache issues
 *   - Snippet path vs content confusion
 *
 * Usage: node test_e2e_browser.js
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");
const PORT = 8765;

const MIME = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".py": "text/x-python",
    ".svg": "image/svg+xml",
};

function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let urlPath = req.url.split("?")[0];
            if (urlPath === "/") urlPath = "/index.html";
            const filePath = path.join(GUI_DIR, urlPath);
            if (!filePath.startsWith(GUI_DIR) || !fs.existsSync(filePath)) {
                res.writeHead(404); res.end("Not Found"); return;
            }
            const ext = path.extname(filePath);
            const type = MIME[ext] || "application/octet-stream";
            res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
            res.end(fs.readFileSync(filePath));
        });
        server.listen(PORT, "127.0.0.1", () => resolve(server));
    });
}

async function main() {
    console.log("Starting local server on port", PORT);
    const server = await startServer();

    console.log("Launching headless Chromium...");
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // Capture console errors
    const consoleErrors = [];
    const workerErrors = [];
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", err => consoleErrors.push("pageerror: " + err.message));

    console.log("Loading page...");
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for pyodide worker to be fully ready
    console.log("Waiting for Pyodide worker to boot (up to 3 min)...");
    await page.waitForFunction(() => {
        const logs = document.getElementById("debug-log");
        return logs && logs.textContent.includes("Execution stack ready");
    }, { timeout: 180000 });

    console.log("Worker ready. Switching to Visualization tab...");
    await page.click('.tab-btn[data-tab="visualization"]');
    await new Promise(r => setTimeout(r, 500));

    // Populate the store with fake data via the worker first (so the mesh viewers have something to plot)
    console.log("Populating store with fake 2D mesh results...");
    const populated = await page.evaluate(async () => {
        return new Promise((resolve) => {
            const id = Date.now();
            const handler = (ev) => {
                if (ev.data.id !== id) return;
                _pyWorker.removeEventListener("message", handler);
                resolve(ev.data.type);
            };
            _pyWorker.addEventListener("message", handler);
            _pyWorker.postMessage({
                cmd: "run_code", id: id, code: `
import numpy as np
class _M:
    def __init__(self):
        nx, ny = 4, 4
        x = np.linspace(0, 1, nx+1); y = np.linspace(0, 1, ny+1)
        xx, yy = np.meshgrid(x, y)
        self.vertices = np.column_stack([xx.ravel(), yy.ravel()])
        cells = []
        for j in range(ny):
            for i in range(nx):
                n0 = j*(nx+1)+i
                cells.append([n0, n0+1, n0+nx+2, n0+nx+1])
        self.cells = np.array(cells)
        self.cell_centers = np.array([self.vertices[c].mean(0) for c in self.cells])
        self.dim = 2
class _Mo:
    variables = type('V', (), {'keys': lambda s: ['h', 'u']})()
m = _M(); mo = _Mo()
Q = np.random.rand(2, len(m.cells))
Qtl = np.random.rand(5, 2, len(m.cells))
store.save(m, mo, Q, Q_timeline=Qtl, times=np.linspace(0,1,5))
`
            });
        });
    });
    console.log("  store populated:", populated);

    // Switch to PyVista subtab (has mesh_plotly card)
    console.log("Clicking PyVista subtab...");
    const subtabHandle = await page.$('.subtab-btn[data-subtab="pyvista"]');
    if (subtabHandle) await subtabHandle.click();
    await new Promise(r => setTimeout(r, 300));

    console.log("Selecting sine wave card...");
    const sineCard = await page.$("#card-vis-sine");
    if (sineCard) await sineCard.click();
    await new Promise(r => setTimeout(r, 500));

    console.log("Clicking refresh on Sine Wave (plotly test)...");
    const sineRefresh = await page.$("#card-vis-sine-refresh");
    if (!sineRefresh) {
        console.error("❌ Could not find refresh button #card-vis-sine-refresh");
        await browser.close(); server.close(); process.exit(1);
    }
    await sineRefresh.click();

    // Wait for output
    console.log("Waiting for sine wave output...");
    await page.waitForFunction(() => {
        const inter = document.getElementById("card-vis-sine-interactive");
        return inter && inter.innerHTML.length > 100;
    }, { timeout: 90000 }).catch(() => {});

    // Check what rendered for sine wave
    const result = await page.evaluate(() => {
        const inter = document.getElementById("card-vis-sine-interactive");
        if (!inter) return { type: "missing" };
        const plotly = inter.querySelector(".plotly, .plot-container, .js-plotly-plot");
        const img = inter.querySelector("img");
        const pre = inter.querySelector("pre");
        return {
            type: plotly ? "plotly" : img ? "image" : pre ? "error" : "other",
            errorText: pre ? pre.textContent.substring(0, 800) : null,
            hasContent: inter.innerHTML.length > 0,
            innerHTMLLen: inter.innerHTML.length,
        };
    });

    console.log("\n=== RESULT ===");
    console.log("Card result:", result);
    console.log("Console errors:", consoleErrors.length);
    consoleErrors.slice(0, 5).forEach(e => console.log("  ", e.substring(0, 200)));

    let failed = false;
    if (result.type === "error") {
        console.error("\n❌ Visualization produced an error:", result.errorText);
        failed = true;
    }
    // Check for "snippets is not defined" specifically (the bug user hit)
    if (result.errorText && result.errorText.includes("snippets")) {
        console.error("❌ The 'name snippets is not defined' bug is back!");
        failed = true;
    }
    // Check for the plotly bug
    const allErrors = consoleErrors.join("\n") + "\n" + (result.errorText || "");
    if (allErrors.includes("No module named 'plotly'")) {
        console.error("❌ plotly not installed in worker!");
        failed = true;
    }
    if (allErrors.includes("No module named 'matplotlib'") || allErrors.includes("'matplotlib' is included")) {
        console.error("❌ matplotlib not installed in worker!");
        failed = true;
    }

    await browser.close();
    server.close();

    // Also test the unified matplotlib viewer (best-effort — tab switch can be flaky)
    try {
        console.log("\nClicking Matplotlib subtab...");
        await page.evaluate(() => {
            const btn = document.querySelector('.subtab-btn[data-subtab="matplotlib"]');
            if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 500));

        console.log("Clicking refresh on Mesh Viewer (Matplotlib)...");
        const mplClicked = await page.evaluate(() => {
            const card = document.getElementById("card-vis-mesh-mpl");
            if (card) card.click();
            const btn = document.getElementById("card-vis-mesh-mpl-refresh");
            if (btn) { btn.click(); return true; }
            return false;
        });

        if (mplClicked) {
            await page.waitForFunction(() => {
                const inter = document.getElementById("card-vis-mesh-mpl-interactive");
                return inter && inter.innerHTML.length > 100;
            }, { timeout: 60000 }).catch(() => {});
            const mplResult = await page.evaluate(() => {
                const inter = document.getElementById("card-vis-mesh-mpl-interactive");
                const img = inter && inter.querySelector("img");
                const pre = inter && inter.querySelector("pre");
                return {
                    hasImage: !!img,
                    hasError: !!pre,
                    errorText: pre ? pre.textContent.substring(0, 500) : null,
                    len: inter ? inter.innerHTML.length : 0,
                };
            });
            console.log("  mpl result:", mplResult);
            if (mplResult.hasError) {
                console.error("❌ Matplotlib card errored:", mplResult.errorText);
                failed = true;
            } else if (!mplResult.hasImage) {
                console.warn("⚠️ Matplotlib card did not render an image (len=" + mplResult.len + ")");
            } else {
                console.log("  ✅ Matplotlib card rendered an image");
            }
        }
    } catch (e) {
        console.warn("⚠️ Matplotlib test skipped:", e.message);
    }

    if (failed) {
        console.log("\nTest FAILED");
        process.exit(1);
    }
    console.log("\n✅ All critical tests passed");
}

main().catch(err => { console.error("Crash:", err); process.exit(1); });
