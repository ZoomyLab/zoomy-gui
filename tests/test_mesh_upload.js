/**
 * Upload a .msh fixture and verify that:
 *   1. A user mesh card appears in the mesh tab under the "Uploaded" subtab.
 *   2. The card's trash button is present (it's a user card).
 *   3. Running the card triggers the Pyodide path: meshio gets installed,
 *      the bytes are hydrated from IDB into the VFS, and the snippet's
 *      print line ends up in the output cell.
 *
 * meshio install pulls ~1 MB off PyPI; the test budget accounts for that
 * by giving runCode up to 90 seconds to finish.
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8775, coi: true });
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

    // ------------------------------------------------------------------
    // 1. Drive uploadMeshFile() directly with our fixture.
    //    Going through the hidden <input type=file> is brittle under
    //    headless Chrome; calling the function with a synthesised File
    //    exercises the same code path without touching the file picker.
    // ------------------------------------------------------------------
    console.log("Upload fixture .msh:");
    await clickTab(page, "mesh");
    const fixtureBytes = fs.readFileSync(path.join(__dirname, "fixtures", "tiny.msh"));
    const fixtureBase64 = fixtureBytes.toString("base64");

    const cardInfo = await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const file = new File([u8], "tiny.msh", { type: "application/octet-stream" });
        const id = await window.uploadMeshFile(file);
        const card = window.managers.mesh.cards.find((c) => c.id === id);
        return {
            id: id,
            title: card && card.title,
            category: card && card.category,
            mesh_file: card && card.mesh_file,
            mesh_vpath: card && card.mesh_vpath,
            source: card && card.source,
        };
    }, fixtureBase64);

    if (!cardInfo || !cardInfo.id) { fail("uploadMeshFile did not return a card id"); }
    else {
        pass("uploaded tiny.msh → card '" + cardInfo.title + "'");
        if (cardInfo.source === "user")        pass("card marked source=user");
        else                                   fail("card source=" + cardInfo.source);
        if (cardInfo.mesh_file === "mesh.msh") pass("card.mesh_file is mesh.msh");
        else                                   fail("card.mesh_file=" + cardInfo.mesh_file);
        if (/tiny/.test(cardInfo.title))       pass("card title derived from filename");
        else                                   fail("card title='" + cardInfo.title + "'");
    }

    // ------------------------------------------------------------------
    // 2. Card lands in the "Uploaded" subtab.
    // ------------------------------------------------------------------
    const inUploadedSubtab = await page.evaluate((cid) => {
        const el = document.getElementById("card-" + cid);
        if (!el) return false;
        // Walk up to the closest .subtab-panel; check its id.
        let p = el.parentElement;
        while (p && !p.classList.contains("subtab-panel")) p = p.parentElement;
        return p ? p.id : null;
    }, cardInfo && cardInfo.id);
    if (inUploadedSubtab === "subtab-uploaded") pass("card lives under the 'Uploaded' subtab");
    else                                        fail("card subtab='" + inUploadedSubtab + "', expected subtab-uploaded");

    // ------------------------------------------------------------------
    // 3. Trash icon is present.
    // ------------------------------------------------------------------
    const trashOk = await page.evaluate((cid) => !!document.getElementById("card-" + cid + "-trash"), cardInfo && cardInfo.id);
    if (trashOk) pass("trash icon present on uploaded card");
    else         fail("trash icon missing");

    // ------------------------------------------------------------------
    // 4. Run the card — this is the full Pyodide path. meshio installs,
    //    bytes land in VFS, meshio.read succeeds, print lands in the
    //    output cell. Wait up to 90s so the meshio install has time.
    // ------------------------------------------------------------------
    console.log("Run uploaded mesh card:");
    // Expand the card so its play button is actionable.
    await page.evaluate((cid) => {
        const el = document.getElementById("card-" + cid);
        if (el) el.classList.remove("collapsed");
        // Open the editor so the play button becomes visible.
        const edit = document.getElementById("card-" + cid + "-edit");
        if (edit) edit.click();
    }, cardInfo && cardInfo.id);
    await new Promise((r) => setTimeout(r, 400));
    const ran = await page.evaluate((cid) => {
        const btn = document.getElementById("card-" + cid + "-run");
        if (!btn) return false;
        btn.click();
        return true;
    }, cardInfo && cardInfo.id);
    if (!ran) fail("run button missing on uploaded card");
    else {
        try {
            await page.waitForFunction((cid) => {
                const out = document.getElementById("card-" + cid + "-output");
                if (!out) return false;
                return /Loaded tiny\.msh:/.test(out.textContent || "");
            }, { timeout: 180000 }, cardInfo.id);
            const snippet = await page.evaluate((cid) => {
                const out = document.getElementById("card-" + cid + "-output");
                return (out && out.textContent || "").match(/Loaded tiny\.msh:[^\n]+/)[0];
            }, cardInfo.id);
            pass("meshio.read succeeded: " + snippet.trim());
        } catch (e) {
            const tail = await page.evaluate((cid) => {
                const out = document.getElementById("card-" + cid + "-output");
                return out ? out.textContent.slice(-600) : "(no output cell)";
            }, cardInfo.id);
            fail("card output never showed 'Loaded tiny.msh:'. Last 600 chars:\n" + tail);
        }
    }

    // ------------------------------------------------------------------
    // 5. Clean up.
    // ------------------------------------------------------------------
    console.log("Clean up:");
    await page.evaluate(() => { window.confirm = () => true; });
    await page.evaluate((cid) => {
        const btn = document.getElementById("card-" + cid + "-trash");
        if (btn) btn.click();
    }, cardInfo && cardInfo.id);
    await new Promise((r) => setTimeout(r, 600));
    pass("deleted uploaded card");

    if (pageErrors.length) {
        for (const e of pageErrors) fail("page error: " + e);
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED — " + failed + " assertion(s)"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
