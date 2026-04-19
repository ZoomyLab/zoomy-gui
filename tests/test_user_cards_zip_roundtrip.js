/**
 * Save/Load ZIP round-trip for user-authored cards.
 *
 * 1. Create a hand-authored user model card + upload a tiny .msh mesh.
 * 2. Build a project ZIP via window._zoomyBuildProjectZipWithUserCards().
 * 3. Delete both user cards (they're gone from IDB).
 * 4. Feed the ZIP back through window.loadProject().
 * 5. Assert both cards are back, mesh bytes intact, and that the
 *    mesh card still runs (i.e. bytes land in Pyodide's VFS).
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8776, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);

    let failed = 0;
    const fail = (m) => { console.error("  \u2716 " + m); failed++; };
    const pass = (m) => console.log("  \u2713 " + m);

    // --- 1. Seed: a model card (newUserCard) + a .msh upload.
    console.log("Seed two user cards:");
    await page.evaluate(() => { window.prompt = () => "RoundtripModel"; window.confirm = () => true; });
    await clickTab(page, "model");
    await page.evaluate(() => document.getElementById("btn-new-card-model").click());
    await page.waitForFunction(
        () => window.managers.model.cards.find((c) => c.title === "RoundtripModel"),
        { timeout: 10000 },
    );
    pass("created RoundtripModel");

    await clickTab(page, "mesh");
    const fixtureBytes = fs.readFileSync(path.join(__dirname, "fixtures", "tiny.msh"));
    const fixtureBase64 = fixtureBytes.toString("base64");
    const meshCardId = await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const file = new File([u8], "tiny.msh");
        return await window.uploadMeshFile(file);
    }, fixtureBase64);
    if (!meshCardId) { fail("upload failed"); }
    else pass("uploaded tiny.msh → " + meshCardId);

    const modelCardId = await page.evaluate(() => {
        const c = window.managers.model.cards.find((c) => c.title === "RoundtripModel");
        return c ? c.id : null;
    });

    // --- 2. Build ZIP.
    console.log("Build ZIP:");
    const zipBytes = await page.evaluate(async () => {
        const zip = await window._zoomyBuildProjectZipWithUserCards();
        const blob = await zip.generateAsync({ type: "blob" });
        const ab = await blob.arrayBuffer();
        return Array.from(new Uint8Array(ab));
    });
    pass("zip built (" + zipBytes.length + " bytes)");

    // Peek inside the ZIP to assert user-card paths + binary .msh.
    const zipContents = await page.evaluate(async (bytes) => {
        const u8 = new Uint8Array(bytes);
        // JSZip is loaded already — just use the global on window.
        const z = await window.JSZip.loadAsync(u8);
        const out = { names: [], hasMsh: false, mshSize: 0 };
        const ps = Object.keys(z.files);
        for (const n of ps) {
            if (z.files[n].dir) continue;
            out.names.push(n);
            if (n.endsWith(".msh")) {
                const ab = await z.files[n].async("arraybuffer");
                out.hasMsh = true;
                out.mshSize = ab.byteLength;
            }
        }
        return out;
    }, zipBytes);
    const userPaths = zipContents.names.filter((n) => n.indexOf("cards/sessions/") === 0);
    if (userPaths.length >= 3) pass("zip contains " + userPaths.length + " user-card files");
    else fail("expected >=3 user-card files in zip, got " + userPaths.length + ": " + JSON.stringify(userPaths));
    if (zipContents.hasMsh && zipContents.mshSize === fixtureBytes.length) pass("mesh.msh bytes preserved (" + zipContents.mshSize + " B)");
    else fail("mesh.msh missing or truncated: size=" + zipContents.mshSize + " expected=" + fixtureBytes.length);

    // --- 3. Delete both cards (removes them from IndexedDB).
    console.log("Delete both user cards:");
    await page.evaluate((mid, meshid) => {
        document.getElementById("card-" + mid + "-trash").click();
        document.getElementById("card-" + meshid + "-trash").click();
    }, modelCardId, meshCardId);
    await page.waitForFunction(
        (mid, meshid) => {
            const m = window.managers.model.cards.find((c) => c.id === mid);
            const x = window.managers.mesh.cards.find((c) => c.id === meshid);
            return !m && !x;
        },
        { timeout: 10000 },
        modelCardId, meshCardId,
    );
    pass("both user cards deleted");

    // --- 4. Load the ZIP back.
    console.log("Load ZIP back:");
    await page.evaluate(async (bytes) => {
        const u8 = new Uint8Array(bytes);
        const blob = new Blob([u8]);
        await window._zoomyLoadProject(blob);
    }, zipBytes);
    /* loadProject triggers reloadCards — wait for the card to appear. */
    try {
        await page.waitForFunction(
            (mid) => window.managers.model.cards.find((c) => c.id === mid) ? true : false,
            { timeout: 15000 }, modelCardId,
        );
        pass("RoundtripModel restored after load");
    } catch (e) { fail("RoundtripModel missing after load"); }
    try {
        await page.waitForFunction(
            (mid) => window.managers.mesh.cards.find((c) => c.id === mid) ? true : false,
            { timeout: 15000 }, meshCardId,
        );
        pass("uploaded mesh card restored after load");
    } catch (e) { fail("uploaded mesh card missing after load"); }

    // --- 5. Verify mesh bytes still run (end-to-end hydration).
    console.log("Run restored mesh card:");
    await clickTab(page, "mesh");
    await page.evaluate((cid) => {
        const el = document.getElementById("card-" + cid);
        if (el) el.classList.remove("collapsed");
        const edit = document.getElementById("card-" + cid + "-edit");
        if (edit) edit.click();
    }, meshCardId);
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate((cid) => document.getElementById("card-" + cid + "-run").click(), meshCardId);
    try {
        await page.waitForFunction(
            (cid) => {
                const out = document.getElementById("card-" + cid + "-output");
                return out && /Loaded tiny\.msh:/.test(out.textContent || "");
            },
            { timeout: 180000 }, meshCardId,
        );
        pass("restored mesh card runs end-to-end");
    } catch (e) { fail("restored mesh card never showed 'Loaded tiny.msh:'"); }

    // Clean up so re-runs stay deterministic.
    await page.evaluate((mid, meshid) => {
        const a = document.getElementById("card-" + mid + "-trash");
        const b = document.getElementById("card-" + meshid + "-trash");
        if (a) a.click();
        if (b) b.click();
    }, modelCardId, meshCardId);

    if (pageErrors.length) {
        for (const e of pageErrors) fail("page error: " + e);
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED — " + failed + " assertion(s)"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
