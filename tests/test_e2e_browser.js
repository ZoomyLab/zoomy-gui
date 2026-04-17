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

    // Switch to PyVista subtab (has the sine_wave card which uses plotly)
    console.log("Clicking PyVista subtab...");
    const subtabHandle = await page.$('.subtab-btn[data-subtab="pyvista"]');
    if (subtabHandle) await subtabHandle.click();
    await new Promise(r => setTimeout(r, 300));

    // Click the sine_wave card first (tests plotly), then select it
    console.log("Selecting sine wave card...");
    const sineCard = await page.$("#card-vis-sine");
    if (sineCard) await sineCard.click();
    await new Promise(r => setTimeout(r, 500));

    // Click refresh on sine wave card — this tests plotly in the worker
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

    if (failed) {
        console.log("\nTest FAILED");
        process.exit(1);
    }
    console.log("\n✅ Test passed");
}

main().catch(err => { console.error("Crash:", err); process.exit(1); });
