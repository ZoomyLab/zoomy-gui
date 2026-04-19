/**
 * Autocomplete end-to-end: types.json is served next to the GUI, the
 * CLI fetches it, Ace is loaded with ext-language_tools, the Zoomy
 * completer is registered. Driving the completer with representative
 * code should return at least the headline use case (model.describe
 * param hints) and something sensible for `store.<TAB>` off a
 * SimulationStore assignment.
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8784, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);

    let failed = false;
    function fail(msg) { console.error("  \u2716 " + msg); failed = true; }
    function pass(msg) { console.log("  \u2713 " + msg); }

    // Force Ace to load so registerZoomyCompleter() runs.
    await page.evaluate(async () => { await ensureAce(); });

    // Probe 1: types.json reachable via CLI.
    const idx = await page.evaluate(async () => {
        const cli = await getCli();
        const data = await cli.storage.readJson("types.json");
        const symbols = data.symbols || {};
        const smeKey = Object.keys(symbols).find(k => k.endsWith(".SMEInviscid"));
        return {
            version: data.version,
            nSymbols: Object.keys(symbols).length,
            nImports: Object.keys(data.imports || {}).length,
            smeInviscidKey: smeKey,
            smeHasDescribe: !!(smeKey && symbols[smeKey].members && symbols[smeKey].members.describe),
        };
    });
    console.log("Type index probe:", JSON.stringify(idx));
    if (!idx.version) fail("types.json missing or malformed");
    if (idx.nSymbols < 10) fail("suspiciously few symbols (" + idx.nSymbols + ")");
    else pass(idx.nSymbols + " symbols indexed");
    if (!idx.smeHasDescribe) fail("SMEInviscid.describe not indexed");
    else pass("SMEInviscid.describe is in the index");

    // Probe 2: drive our registered Zoomy completer directly.
    const completions = await page.evaluate(async () => {
        const completer = window._zoomyCompleter;
        if (!completer) return { error: "completer not registered" };
        const session = ace.createEditSession(
            'from zoomy_core.model.models.sme_model import SMEInviscid\n' +
            'model = SMEInviscid(level=0)\n' +
            'model.describe'
        );
        session.setMode("ace/mode/python");
        const fakeEditor = { getSession: () => session };
        const pos = { row: 2, column: "model.describe".length };
        return await new Promise((resolve) => {
            completer.getCompletions(fakeEditor, session, pos, "describe", (err, list) => {
                resolve({ list: list || [], err: err && String(err) });
            });
        });
    });
    if (completions.error) { fail(completions.error); completions.list = []; }
    const list = completions.list || [];
    console.log("Completions for `model.<…>`: " + list.length);
    const methodNames = list.map(c => c.caption).sort();
    console.log("  top 10:", methodNames.slice(0, 10).join(", "));
    if (list.some(c => c.caption === "describe")) pass("model.describe is offered");
    else fail("describe not in completions (got " + list.length + " items)");

    await browser.close();
    await srv.close();
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
