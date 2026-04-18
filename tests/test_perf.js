/**
 * GUI performance measurement — page load + per-tab switch timings.
 *
 * Serves the production zoomy_gui/ files on a local HTTP server, launches
 * headless Chromium, records:
 *
 *   - domContentLoaded / load times
 *   - bytes + count of resources fetched until network-idle, grouped by
 *     URL prefix (cards/, snippets/, previews/, CDN, other)
 *   - per-tab activation time: click the tab button, measure time until
 *     the page is idle again
 *
 * Writes a markdown table to tests/perf_report.md.
 *
 * Run: `node test_perf.js`
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");
const REPORT = path.join(__dirname, "perf_report.md");
const PORT = 8767;

const MIME = {
    ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".py": "text/x-python", ".svg": "image/svg+xml",
    ".png": "image/png", ".gif": "image/gif",
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
            res.writeHead(200, {
                "Content-Type": MIME[ext] || "application/octet-stream",
                "Cache-Control": "no-store",
            });
            res.end(fs.readFileSync(filePath));
        });
        server.listen(PORT, "127.0.0.1", () => resolve(server));
    });
}


function categorise(url) {
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) return "cdn";
    const p = url.slice(`http://127.0.0.1:${PORT}/`.length);
    if (p.startsWith("cards/"))    return "cards";
    if (p.startsWith("snippets/")) return "snippets";
    if (p.startsWith("previews/")) return "previews";
    if (p === "version.json")      return "version";
    if (p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".html"))
        return "app";
    if (p.endsWith(".py"))         return "py";
    return "other";
}


function summarise(resources) {
    const by = {};
    for (const r of resources) {
        const key = categorise(r.name);
        by[key] ||= { count: 0, bytes: 0, avg_ms: 0, total_ms: 0 };
        by[key].count += 1;
        by[key].bytes += r.transferSize || 0;
        by[key].total_ms += r.duration || 0;
    }
    for (const k of Object.keys(by)) by[k].avg_ms = by[k].total_ms / by[k].count;
    return by;
}


async function waitForNetworkIdle(page, idleMs = 500, timeoutMs = 30000) {
    const start = Date.now();
    let lastPending = -1;
    let quiet = 0;
    while (Date.now() - start < timeoutMs) {
        const pending = await page.evaluate(() => performance
            .getEntriesByType("resource")
            .filter(r => r.responseEnd === 0).length);
        if (pending === 0) {
            if (lastPending === 0) quiet += 50;
            if (quiet >= idleMs) return;
        } else {
            quiet = 0;
        }
        lastPending = pending;
        await new Promise(r => setTimeout(r, 50));
    }
}


function table(rows) {
    const cols = ["tab", "activation_ms", "category", "count", "bytes", "avg_ms"];
    const out = ["| " + cols.join(" | ") + " |",
                 "|" + cols.map(() => "---").join("|") + "|"];
    for (const r of rows) {
        out.push("| " + cols.map(c => r[c] ?? "").join(" | ") + " |");
    }
    return out.join("\n");
}


async function main() {
    console.log("Starting local server…");
    const server = await startServer();

    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setCacheEnabled(false);   // isolate each run

    console.log("Loading page…");
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 60000 });
    const navigationMs = Date.now() - t0;

    // Wait for the tab bar to be populated.
    await page.waitForSelector(".tab-btn", { timeout: 15000 });
    await waitForNetworkIdle(page, 500, 15000);

    const loadResources = await page.evaluate(() => performance
        .getEntriesByType("resource")
        .map(r => ({ name: r.name, transferSize: r.transferSize, duration: r.duration })));

    const tabIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".tab-btn")).map(b => b.dataset.tab));
    console.log("Tabs found:", tabIds.join(", "));

    const rows = [];
    // Row 0 — initial load
    const loadSummary = summarise(loadResources);
    for (const [cat, s] of Object.entries(loadSummary)) {
        rows.push({
            tab: "(initial load)",
            activation_ms: navigationMs,
            category: cat,
            count: s.count,
            bytes: s.bytes,
            avg_ms: s.avg_ms.toFixed(1),
        });
    }

    // Each tab activation
    for (const tab of tabIds) {
        await page.evaluate(() => performance.clearResourceTimings());
        const ts = Date.now();
        await page.evaluate(t => {
            const b = document.querySelector(`.tab-btn[data-tab="${t}"]`);
            if (b) b.click();
        }, tab);
        await waitForNetworkIdle(page, 400, 10000);
        const ms = Date.now() - ts;

        const res = await page.evaluate(() => performance
            .getEntriesByType("resource")
            .map(r => ({ name: r.name, transferSize: r.transferSize, duration: r.duration })));
        const byCat = summarise(res);

        if (Object.keys(byCat).length === 0) {
            rows.push({ tab, activation_ms: ms, category: "(no new resources)", count: "", bytes: "", avg_ms: "" });
        } else {
            for (const [cat, s] of Object.entries(byCat)) {
                rows.push({
                    tab,
                    activation_ms: ms,
                    category: cat,
                    count: s.count,
                    bytes: s.bytes,
                    avg_ms: s.avg_ms.toFixed(1),
                });
            }
        }
        console.log(`  ${tab}: ${ms} ms, ${res.length} resources`);
    }

    await browser.close();
    server.close();

    const md = [
        "# GUI perf report",
        "",
        `Generated: ${new Date().toISOString()}`,
        "",
        `- navigation (DOMContentLoaded + idle): ${navigationMs} ms`,
        "",
        table(rows),
        "",
    ].join("\n");

    fs.writeFileSync(REPORT, md);
    console.log(`Wrote ${REPORT}`);
}


main().catch(err => { console.error(err); process.exit(1); });
