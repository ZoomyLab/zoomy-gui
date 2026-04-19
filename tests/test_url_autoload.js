/**
 * ?project=<url> autoload path. Configures selections, serialises the
 * project zip, drops it on disk next to the GUI, then loads the page
 * with ?project=<url> and checks that selections came back from the
 * URL-provided file. This covers the "share a link with a pre-
 * configured session" workflow.
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { startServer, waitForWorkerReady } = require("./_lib");

const ZIP_PATH = path.join(__dirname, "..", "_autoload_test.zip");

async function snapshotSelections(page) {
    return page.evaluate(() => {
        const out = {};
        ["model", "mesh", "solver", "visualization"].forEach(t => {
            const m = window.managers[t];
            out[t] = m ? m.selectedId : null;
        });
        return out;
    });
}

async function main() {
    const srv = await startServer({ port: 8782, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });

    // --- Step 1: build a zip with selections chosen and write it to disk.
    const page = await browser.newPage();
    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);
    await page.evaluate(() => {
        const pick = t => {
            const m = window.managers[t];
            if (m && m.cards.length) m.select("card-" + m.cards[0].id);
        };
        pick("model"); pick("mesh"); pick("solver");
    });
    const chosen = await snapshotSelections(page);
    console.log("Chose:", JSON.stringify(chosen));

    const b64 = await page.evaluate(async () => {
        const zip = buildProjectZip();
        const blob = await zip.generateAsync({ type: "blob" });
        return await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(",")[1]);
            reader.readAsDataURL(blob);
        });
    });
    fs.writeFileSync(ZIP_PATH, Buffer.from(b64, "base64"));
    console.log("Wrote zip to", ZIP_PATH, "(" + fs.statSync(ZIP_PATH).size + " bytes)");
    await page.close();

    // --- Step 2: open a fresh page with ?project=... and check it loads.
    const page2 = await browser.newPage();
    const params = "?project=" + encodeURIComponent("_autoload_test.zip");
    console.log("Opening " + srv.url + params);
    await page2.goto(srv.url + params, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page2);
    /* The autoload path runs after worker ready. Give it a moment to
       apply the downloaded zip before probing. */
    await page2.waitForFunction(() => {
        const el = document.getElementById("debug-log");
        return el && /Auto-loading project from URL/.test(el.textContent);
    }, { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    const restored = await snapshotSelections(page2);
    console.log("After URL autoload:", JSON.stringify(restored));

    let failed = false;
    ["model", "mesh", "solver"].forEach(k => {
        if (restored[k] === chosen[k]) console.log("  \u2713 autoloaded " + k + " = " + chosen[k]);
        else { console.error("  \u2716 " + k + ": expected " + chosen[k] + ", got " + restored[k]); failed = true; }
    });

    await browser.close();
    await srv.close();
    try { fs.unlinkSync(ZIP_PATH); } catch (e) {}
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); try { fs.unlinkSync(ZIP_PATH); } catch (_) {} process.exit(1); });
