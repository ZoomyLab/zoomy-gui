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
    const out = await page.evaluate(async () => {
        try {
            const cli = await _readyCli();
            const code =
                "from zoomy_core.model.models.sme_model import SMEInviscid\n" +
                "model = SMEInviscid(level=0)\n" +
                "model.describe";
            /* jedi uses 1-indexed rows; col 0-indexed. Cursor at end of
               line 3, column = length of "model.describe". */
            const res = await cli.complete(code, 3, "model.describe".length);
            return { ok: true, res };
        } catch (e) {
            return { ok: false, err: String(e) };
        }
    });
    if (!out.ok) { fail("cli.complete threw: " + out.err); }
    else {
        const comps = (out.res && out.res.completions) || [];
        console.log("  " + comps.length + " completions; first 5:", comps.slice(0, 5).map(c => c.name).join(", "));
        if (!comps.length) fail("no completions returned");
        if (!comps.some(c => c.name === "describe")) fail("`describe` missing from completions");
        else pass("jedi returned `describe` for model.<cursor>");
    }

    await browser.close();
    await srv.close();
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
