/**
 * Param widget round-trip tests. Each widget kind (Number, Integer,
 * Boolean, String, Selector/ObjectSelector, generic-number fallback) is
 * instantiated via window.renderParamWidgets, driven with a synthetic
 * DOM event, and asserted to deliver the correctly-typed value to the
 * onChange callback. This guards the Phase 2 refactor: the widget layer
 * is small but load-bearing, and a regression in it (wrong type coercion,
 * missed event wiring) is easy to miss visually.
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8771, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    // We don't need Pyodide to be ready — renderParamWidgets is pure JS —
    // but waiting until the full page is responsive avoids a race.
    await page.waitForFunction(() =>
        typeof window.renderParamWidgets === "function", { timeout: 60000 });

    let failed = false;
    function fail(msg) { console.error("  \u2716 " + msg); failed = true; }
    function pass(msg) { console.log("  \u2713 " + msg); }

    const cases = [
        {
            name: "Integer slider",
            schema: { params: { N: { type: "Integer", default: 10, bounds: [1, 100], step: 1 } } },
            selector: 'input[type="range"]',
            drive: (el) => { el.value = "42"; el.dispatchEvent(new Event("input", { bubbles: true })); },
            expect: ["N", 42],
            expectType: "number",
            expectInt: true,
        },
        {
            name: "Number slider",
            schema: { params: { x: { type: "Number", default: 0.5, bounds: [0, 1] } } },
            selector: 'input[type="range"]',
            drive: (el) => { el.value = "0.25"; el.dispatchEvent(new Event("input", { bubbles: true })); },
            expect: ["x", 0.25],
            expectType: "number",
        },
        {
            name: "Boolean checkbox",
            schema: { params: { flag: { type: "Boolean", default: false } } },
            selector: 'input[type="checkbox"]',
            drive: (el) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); },
            expect: ["flag", true],
            expectType: "boolean",
        },
        {
            name: "String text input",
            schema: { params: { name: { type: "String", default: "hello" } } },
            selector: 'input[type="text"]',
            drive: (el) => { el.value = "world"; el.dispatchEvent(new Event("change", { bubbles: true })); },
            expect: ["name", "world"],
            expectType: "string",
        },
        {
            name: "ObjectSelector dropdown",
            schema: { params: { mode: { type: "ObjectSelector", default: "a", objects: ["a", "b", "c"] } } },
            selector: "select",
            drive: (el) => { el.value = "b"; el.dispatchEvent(new Event("change", { bubbles: true })); },
            expect: ["mode", "b"],
            expectType: "string",
        },
        {
            name: "Generic Number (no bounds)",
            schema: { params: { tol: { type: "Number", default: 1e-6 } } },
            selector: 'input[type="number"]',
            drive: (el) => { el.value = "0.001"; el.dispatchEvent(new Event("change", { bubbles: true })); },
            expect: ["tol", 0.001],
            expectType: "number",
        },
    ];

    for (const c of cases) {
        const result = await page.evaluate((cc) => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            let captured = null;
            const widgets = window.renderParamWidgets(cc.schema, (n, v) => { captured = [n, v, typeof v]; });
            host.appendChild(widgets);
            const el = widgets.querySelector(cc.selector);
            if (!el) { host.remove(); return { ok: false, reason: "selector '" + cc.selector + "' not found in widgets html:\n" + widgets.innerHTML }; }
            // Drive the event. We inline the drive logic by reconstructing
            // it here since functions don't serialize cleanly through
            // page.evaluate.
            if (cc.selector === 'input[type="range"]') { el.value = String(cc.expect[1]); el.dispatchEvent(new Event("input", { bubbles: true })); }
            else if (cc.selector === 'input[type="checkbox"]') { el.checked = cc.expect[1]; el.dispatchEvent(new Event("change", { bubbles: true })); }
            else if (cc.selector === 'input[type="text"]' || cc.selector === 'input[type="number"]' || cc.selector === "select") { el.value = String(cc.expect[1]); el.dispatchEvent(new Event("change", { bubbles: true })); }
            host.remove();
            return { ok: true, captured };
        }, c);

        if (!result.ok) { fail(c.name + ": " + result.reason); continue; }
        if (!result.captured) { fail(c.name + ": onChange was not invoked"); continue; }
        const [n, v, tv] = result.captured;
        if (n !== c.expect[0]) { fail(c.name + ": expected name '" + c.expect[0] + "', got '" + n + "'"); continue; }
        if (v !== c.expect[1]) { fail(c.name + ": expected value " + JSON.stringify(c.expect[1]) + ", got " + JSON.stringify(v)); continue; }
        if (tv !== c.expectType) { fail(c.name + ": expected typeof '" + c.expectType + "', got '" + tv + "'"); continue; }
        if (c.expectInt && !Number.isInteger(v)) { fail(c.name + ": expected Number.isInteger, got " + v); continue; }
        pass(c.name + " -> " + JSON.stringify([n, v]) + " (" + tv + ")");
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
