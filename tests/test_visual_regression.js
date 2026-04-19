/**
 * Per-tab visual regression test.
 *
 * Loads the GUI in a headless Chromium viewport at a fixed size, takes a
 * full-page screenshot of each tab, and diffs against a committed baseline
 * under `tests/baselines/`. pixelmatch tolerates tiny anti-aliasing jitter
 * via the threshold argument (0.1 is a good default).
 *
 * Usage:
 *   node test_visual_regression.js              # diff against baselines (fails if any tab drifts)
 *   node test_visual_regression.js --update     # overwrite baselines (reviewer runs this deliberately)
 *
 * The diff images are written next to the test output as *.diff.png when a
 * regression is detected, so a human can inspect what moved.
 *
 * Notes:
 *  - We explicitly avoid anything that animates (loading toasts etc.) by
 *    waiting for the worker-ready log line before capturing.
 *  - The "dashboard" tab's "last finished" status can include the current
 *    time; we mask that region via a DOM override that rewrites the
 *    timestamp before capture.
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default || require("pixelmatch");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

const VIEWPORT = { width: 1280, height: 900 };
const TABS = ["dashboard", "model", "mesh", "solver", "visualization"];
const BASELINE_DIR = path.join(__dirname, "baselines");
const OUT_DIR = path.join(__dirname, "_visual_out");

async function main() {
    const update = process.argv.includes("--update");
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const srv = await startServer({ port: 8772, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
        defaultViewport: VIEWPORT,
    });
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);

    // Freeze any dynamic bits: dashboard "last finished" timestamp, the
    // gui-version footer (commit hash varies per deploy), and the toast
    // stack (the "Autocomplete ready" confirmation is timer-dismissed
    // and would otherwise be caught mid-fade at random offsets).
    await page.evaluate(() => {
        const gv = document.getElementById("gui-version");
        if (gv) gv.textContent = "vBASELINE";
        const statusEl = document.querySelector("#card-dash-run .card-description");
        if (statusEl) statusEl.dataset.visualFreeze = "1";
        const toasts = document.getElementById("toast-stack");
        if (toasts) toasts.style.display = "none";
        // The dashboard debug log's contents are inherently time-
        // dependent (timestamps, worker install ordering). Freeze it
        // to a fixed placeholder so changes to install plumbing don't
        // show up as false visual regressions on the dashboard tab.
        const log = document.getElementById("debug-log");
        if (log) log.innerHTML = '<div style="padding:8px;color:#888">[log masked for visual regression]</div>';
    });

    let failed = 0;
    let updated = 0;

    for (const tabId of TABS) {
        await clickTab(page, tabId);
        // Give the page a moment to settle after tab switch.
        await new Promise((r) => setTimeout(r, 500));
        // Wait for any pending image loads (esp. mesh tab previews).
        await page.evaluate(() => new Promise((resolve) => {
            const imgs = Array.from(document.images).filter((i) => !i.complete);
            if (!imgs.length) return resolve();
            let left = imgs.length;
            const done = () => { if (--left <= 0) resolve(); };
            imgs.forEach((i) => { i.addEventListener("load", done, { once: true }); i.addEventListener("error", done, { once: true }); });
            // Backstop: never wait more than 5s.
            setTimeout(resolve, 5000);
        }));

        // Puppeteer \u2265 24 returns a Uint8Array; pngjs wants a Buffer.
        const shotRaw = await page.screenshot({ type: "png", fullPage: false });
        const shotBuf = Buffer.from(shotRaw);
        const baselinePath = path.join(BASELINE_DIR, tabId + ".png");

        if (update || !fs.existsSync(baselinePath)) {
            fs.writeFileSync(baselinePath, shotBuf);
            console.log((update ? "  updated baseline: " : "  \u2713 new baseline: ") + tabId + ".png");
            updated++;
            continue;
        }

        // Diff against committed baseline.
        const shotPng = PNG.sync.read(shotBuf);
        const baselinePng = PNG.sync.read(fs.readFileSync(baselinePath));
        if (shotPng.width !== baselinePng.width || shotPng.height !== baselinePng.height) {
            console.error("  \u2716 " + tabId + ": size mismatch (baseline=" +
                baselinePng.width + "x" + baselinePng.height + ", got=" +
                shotPng.width + "x" + shotPng.height + ")");
            const outPath = path.join(OUT_DIR, tabId + ".got.png");
            fs.writeFileSync(outPath, shotBuf);
            console.error("    saved: " + outPath);
            failed++;
            continue;
        }
        const diffPng = new PNG({ width: shotPng.width, height: shotPng.height });
        const diffPixels = pixelmatch(
            shotPng.data, baselinePng.data, diffPng.data,
            shotPng.width, shotPng.height,
            { threshold: 0.1, includeAA: true, alpha: 0.3 }
        );
        const total = shotPng.width * shotPng.height;
        const pct = (100 * diffPixels / total).toFixed(3);
        // 0.5% tolerance — generous enough for font/AA jitter; tight
        // enough to catch layout shifts.
        if (diffPixels / total > 0.005) {
            const diffPath = path.join(OUT_DIR, tabId + ".diff.png");
            const gotPath = path.join(OUT_DIR, tabId + ".got.png");
            fs.writeFileSync(diffPath, PNG.sync.write(diffPng));
            fs.writeFileSync(gotPath, shotBuf);
            console.error("  \u2716 " + tabId + ": " + pct + "% pixels differ (" + diffPixels + "/" + total + ")");
            console.error("    diff: " + diffPath);
            console.error("    got:  " + gotPath);
            failed++;
        } else {
            console.log("  \u2713 " + tabId + ": " + pct + "% drift");
        }
    }

    await browser.close();
    await srv.close();

    if (update) { console.log("\n\u2705 baselines updated (" + updated + " tabs)"); return; }
    if (failed) { console.log("\n\u274c FAILED — " + failed + " tab(s) drifted. Re-run with --update if the change was intentional."); process.exit(1); }
    console.log("\n\u2705 PASSED (" + (TABS.length - updated) + " diffed, " + updated + " fresh baselines)");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
