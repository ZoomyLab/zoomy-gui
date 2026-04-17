/**
 * The test I should have written first.
 *
 * Exercises the COMPLETE user path:
 *   1. Load the GUI
 *   2. Click "Run simulation" (btn-run-sim) with default selections
 *   3. Wait for the simulation to complete
 *   4. Verify store_meta indicates data was captured
 *   5. Switch to visualization, click refresh
 *   6. Verify a non-empty image/plot was produced
 *
 * This catches bugs like "auto_save_from_scope didn't find Q" or
 * "simulation failed silently".
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");
const PORT = 8766;
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".py": "text/x-python", ".svg": "image/svg+xml" };

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
            res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
                                 "Cache-Control": "no-store" });
            res.end(fs.readFileSync(filePath));
        });
        server.listen(PORT, "127.0.0.1", () => resolve(server));
    });
}

async function main() {
    console.log("Starting server...");
    const server = await startServer();

    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    const consoleLogs = [];
    page.on("console", msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", err => consoleLogs.push(`[pageerror] ${err.message}`));

    console.log("Loading GUI...");
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2", timeout: 60000 });

    let failed = false;

    console.log("Waiting for worker ready...");
    await page.waitForFunction(() => {
        const logs = document.getElementById("debug-log");
        return logs && logs.textContent.includes("Execution stack ready");
    }, { timeout: 240000 });

    // Click Run Simulation
    console.log("Clicking btn-run-sim...");
    await page.click("#btn-run-sim");

    // Wait for simulation to complete (status card reaches "idle" with a last run time,
    // or log shows "Pyodide result received")
    console.log("Waiting for simulation to finish (up to 5 min)...");
    await page.waitForFunction(() => {
        const logs = document.getElementById("debug-log");
        return logs && (logs.textContent.includes("Pyodide result received") ||
                        logs.textContent.includes("Pyodide error"));
    }, { timeout: 300000 });

    // Check if the store got populated by executing a query
    console.log("\nChecking store state...");
    const storeStatus = await page.evaluate(() => {
        return new Promise((resolve) => {
            const id = Date.now();
            const h = (ev) => {
                if (ev.data.id !== id) return;
                _pyWorker.removeEventListener("message", h);
                resolve(ev.data);
            };
            _pyWorker.addEventListener("message", h);
            _pyWorker.postMessage({
                cmd: "run_code", id: id, code: `
print("store.data keys:", list(store.data.keys()) if store.data else "EMPTY")
if store.data:
    print("  fields:", store.fields)
    print("  n_snapshots:", store.data.get("n_snapshots", 0))
    print("  n_cells:", store.data.get("n_cells", "?"))
    print("  dim:", store.data.get("dim", "?"))
    print("  has_Q:", store.data.get("Q") is not None)
    print("  has_vertices:", store.data.get("vertices") is not None)
    print("  has_cells:", store.data.get("cells") is not None)
    print("  coords shape:", store.data.get("coords").shape if store.data.get("coords") is not None else None)
`,
            });
        });
    });
    const storeResult = JSON.parse(storeStatus.data || "{}");
    console.log("Store status:");
    console.log(storeResult.output);
    if (storeResult.status !== "success") {
        console.error("Store query error:", storeResult.output);
    }

    // Print the last 40 lines of debug log to diagnose simulation failure
    console.log("\n=== DEBUG LOG (last portion) ===");
    const logText = await page.evaluate(() =>
        (document.getElementById("debug-log") || {}).textContent || "");
    const lines = logText.split("\n");
    console.log(lines.slice(Math.max(0, lines.length - 30)).join("\n"));

    // NOW click the Visualization tab, find mesh_mpl card, click refresh, check result
    console.log("\nGoing to Visualization tab...");
    await page.evaluate(() => {
        document.querySelector('.tab-btn[data-tab="visualization"]').click();
    });
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
        const btn = document.querySelector('.subtab-btn[data-subtab="matplotlib"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));

    console.log("Selecting mesh_mpl card and clicking refresh...");
    await page.evaluate(() => {
        const card = document.getElementById("card-vis-mesh-mpl");
        if (card) card.click();
    });
    await new Promise(r => setTimeout(r, 500));
    const refreshClicked = await page.evaluate(() => {
        const btn = document.getElementById("card-vis-mesh-mpl-refresh");
        if (btn) { btn.click(); return true; }
        return false;
    });

    if (refreshClicked) {
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
                errorText: pre ? pre.textContent.substring(0, 800) : null,
                contentLen: inter ? inter.innerHTML.length : 0,
            };
        });
        console.log("Mesh viewer result:", mplResult);
        if (mplResult.hasError) {
            console.error("❌ Viz produced error:", mplResult.errorText);
            failed = true;
        } else if (!mplResult.hasImage) {
            console.error("❌ Viz did not render an image (len=" + mplResult.contentLen + ")");
            failed = true;
        } else {
            console.log("  ✅ Mesh viewer rendered image (" + mplResult.contentLen + " bytes)");
        }
    }

    console.log("\n=== BROWSER CONSOLE ===");
    consoleLogs.slice(-20).forEach(l => console.log(" ", l.substring(0, 300)));

    await browser.close();
    server.close();

    // Assertions (failed was declared earlier)
    if (!storeResult.output.includes("has_Q: True")) {
        console.error("❌ store.Q is not populated after Run Simulation");
        failed = true;
    }
    if (logText.includes("Pyodide error")) {
        console.error("❌ Simulation produced a Pyodide error");
        failed = true;
    }

    if (failed) {
        console.log("\n❌ FAILED");
        process.exit(1);
    }
    console.log("\n✅ PASSED");
}

main().catch(err => { console.error("Crashed:", err); process.exit(1); });
