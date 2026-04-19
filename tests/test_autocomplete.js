/**
 * End-to-end autocomplete via jedi in Pyodide.
 *
 * Drives the real CLI against a synthetic buffer:
 *     from zoomy_core.model.models.sme_model import SMEInviscid
 *     model = SMEInviscid(level=0)
 *     model.describe<cursor>
 *
 * The first call pays the one-time micropip install of jedi (~2 MB);
 * subsequent calls are ~30-100 ms. We bump the per-call timeout to
 * accommodate the cold install.
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

    console.log("Requesting completion via CLI (jedi micropip install on first call)…");

    /* Case 1: `model.describe` — prefix match on member name. */
    const case1 = await page.evaluate(async () => {
        const cli = await _readyCli();
        const code =
            "from zoomy_core.model.models.sme_model import SMEInviscid\n" +
            "model = SMEInviscid(level=0)\n" +
            "model.describe";
        return await cli.complete(code, 3, "model.describe".length);
    });
    const l1 = (case1 && case1.completions) || [];
    console.log("  [model.describe] " + l1.length + " items; first 5:", l1.slice(0, 5).map(c => c.name).join(", "));
    if (!l1.some(c => c.name === "describe")) fail("`describe` missing from completions");
    else pass("jedi returned `describe` for model.<cursor>");

    /* Case 2: `model.describe(` — inside a call. The signature-
       supplement path should add ALL params of the callable even on
       the first completion, so Ace doesn't have to re-query. */
    const case2 = await page.evaluate(async () => {
        const cli = await _readyCli();
        const code =
            "from zoomy_core.model.models.sme_model import SMEInviscid\n" +
            "model = SMEInviscid(level=0)\n" +
            "model.describe(";
        return await cli.complete(code, 3, "model.describe(".length);
    });
    const l2 = (case2 && case2.completions) || [];
    const params = l2.filter(c => c.type === "param").map(c => c.name);
    console.log("  [model.describe(] " + l2.length + " items; params: " + params.join(", "));
    if (!params.length) fail("expected at least one param-type completion inside model.describe(");
    else pass(params.length + " param(s) returned for model.describe(<cursor>");

    await browser.close();
    await srv.close();
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
