/**
 * Shared test fixtures: local HTTP server with optional COI headers and a
 * small puppeteer helper set used by multiple test files.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");
const MIME = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".py": "text/x-python",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

/**
 * Start a tiny static server rooted at the GUI dir.
 *   options.port: TCP port (default 8770)
 *   options.coi: if true, inject COOP/COEP/CORP headers on every response.
 *   options.quiet: if true, suppress request logging.
 */
function startServer(options) {
    options = options || {};
    const port = options.port || 8770;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let urlPath = req.url.split("?")[0];
            if (urlPath === "/") urlPath = "/index.html";
            const filePath = path.join(GUI_DIR, urlPath);
            if (!filePath.startsWith(GUI_DIR) || !fs.existsSync(filePath)) {
                res.writeHead(404); res.end("Not Found"); return;
            }
            const ext = path.extname(filePath);
            const headers = {
                "Content-Type": MIME[ext] || "application/octet-stream",
                "Cache-Control": "no-store",
            };
            if (options.coi) {
                headers["Cross-Origin-Embedder-Policy"] = "require-corp";
                headers["Cross-Origin-Opener-Policy"] = "same-origin";
                headers["Cross-Origin-Resource-Policy"] = "same-origin";
            }
            res.writeHead(200, headers);
            res.end(fs.readFileSync(filePath));
        });
        server.listen(port, "127.0.0.1", () => resolve({
            server,
            url: `http://127.0.0.1:${port}/`,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

async function waitForWorkerReady(page, timeoutMs) {
    await page.waitForFunction(() => {
        const el = document.getElementById("debug-log");
        return el && el.textContent.includes("Python runtime ready");
    }, { timeout: timeoutMs || 240000 });
}

async function clickTab(page, tabId) {
    await page.evaluate((t) => {
        const b = document.querySelector(`.tab-btn[data-tab="${t}"]`);
        if (b) b.click();
    }, tabId);
    await new Promise((r) => setTimeout(r, 200));
}

module.exports = { GUI_DIR, startServer, waitForWorkerReady, clickTab };
