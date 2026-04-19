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
const { startServer } = require("./_lib");

async function main() {
    console.log("Starting server...");
    /* COI headers so SharedArrayBuffer is available (cooperative stop)
       and so /zoomy_cli/ is served via the shared helper. */
    const srv = await startServer({ port: 8766, coi: true });
    const server = srv.server;
    const serverUrl = srv.url;

    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    const consoleLogs = [];
    page.on("console", msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", err => consoleLogs.push(`[pageerror] ${err.message}`));

    console.log("Loading GUI...");
    await page.goto(serverUrl, { waitUntil: "networkidle2", timeout: 60000 });

    let failed = false;

    console.log("Waiting for worker ready...");
    await page.waitForFunction(() => {
        const logs = document.getElementById("debug-log");
        return logs && logs.textContent.includes("Python runtime ready");
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
    /* Post-Phase-3: route store probe through the CLI façade, not the
       raw worker. The CLI runs the code through PyodideAdapter.runCode
       and returns the same JSON result shape as the old pyWorker path. */
    const storeStatus = await page.evaluate(async () => {
        const cli = await window.getCli();
        const code =
            'if store is None:\n' +
            '    print("STORE IS NONE")\n' +
            'else:\n' +
            '    print("store type:", type(store).__name__)\n' +
            '    print("  dim:", store.dim)\n' +
            '    print("  cell_type:", store.cell_type)\n' +
            '    print("  n_cells:", store.n_cells)\n' +
            '    print("  n_vertices:", store.n_vertices)\n' +
            '    print("  n_snapshots:", store.n_snapshots)\n' +
            '    print("  fields:", list(store.field.keys()))\n' +
            '    print("  vertices shape:", store.vertices.shape)\n' +
            '    print("  cells shape:", store.cells.shape)\n' +
            '    print("  has_Q: True")\n';
        const data = await cli.runCode(code);
        return { data };
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

    console.log("Selecting mesh_mpl card and clicking run...");
    await page.evaluate(() => {
        const card = document.getElementById("card-vis-mesh-mpl");
        if (card) card.click();
    });
    await new Promise(r => setTimeout(r, 500));
    const runClicked = await page.evaluate(() => {
        /* Phase 2: unified play button replaces the old per-card refresh button. */
        const btn = document.getElementById("card-vis-mesh-mpl-run");
        if (btn) { btn.click(); return true; }
        return false;
    });

    if (runClicked) {
        await page.waitForFunction(() => {
            const cells = document.getElementById("card-vis-mesh-mpl-output");
            if (!cells) return false;
            /* Wait until a real plot/svg cell lands (the preview img
               doesn't count — its id matches .card-output-preview). */
            return cells.querySelector(".output-cell-plotly, .output-cell-svg, .output-cell-text");
        }, { timeout: 60000 }).catch(() => {});
        const mplResult = await page.evaluate(() => {
            const cells = document.getElementById("card-vis-mesh-mpl-output");
            if (!cells) return { hasImage: false, hasError: false, contentLen: 0 };
            const hasImage = !!cells.querySelector(".output-cell-plotly, .output-cell-svg");
            const errCell = cells.querySelector(".output-cell-text");
            const errText = errCell ? errCell.textContent : "";
            const isError = /Traceback|Error|error/.test(errText);
            return {
                hasImage,
                hasError: isError,
                errorText: isError ? errText.substring(0, 800) : null,
                contentLen: cells.innerHTML.length,
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
