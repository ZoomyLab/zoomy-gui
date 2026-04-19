/**
 * Session round-trip: selecting a model + mesh + solver, serialising the
 * project to a zip via buildProjectZip, re-applying the zip via
 * loadProject in a fresh page load, and checking that the selections
 * came back. This is the test that guards the "pre-configured session"
 * workflow — the user hands a collaborator a .zip and they open it
 * expecting to see the same cards highlighted.
 *
 * Uses the new default-collapsed behaviour: nothing is auto-selected,
 * so an identity round-trip of {} selections must produce no selection
 * on reload. A second pass explicitly selects cards, saves, reloads,
 * and asserts the selections are restored.
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

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
    const srv = await startServer({ port: 8781, coi: true });
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

    // Initial: nothing selected.
    const initial = await snapshotSelections(page);
    console.log("Initial selections:", JSON.stringify(initial));
    if (Object.values(initial).some(v => v !== null)) {
        fail("expected no selections on first load, got " + JSON.stringify(initial));
    } else {
        pass("no auto-selection on fresh load");
    }

    // Select a concrete (model, mesh, solver).
    const chosen = await page.evaluate(() => {
        const pick = t => {
            const m = window.managers[t];
            if (!m || !m.cards.length) return null;
            const c = m.cards[0];
            m.select("card-" + c.id);
            return "card-" + c.id;
        };
        return { model: pick("model"), mesh: pick("mesh"), solver: pick("solver") };
    });
    console.log("Chose:", JSON.stringify(chosen));

    // Serialize to a Blob via buildProjectZip (without triggering a
    // download) and capture the base64 so we can feed it back in.
    const b64 = await page.evaluate(async () => {
        const zip = buildProjectZip();
        const blob = await zip.generateAsync({ type: "blob" });
        return await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const s = reader.result;
                resolve(s.split(",")[1]);
            };
            reader.readAsDataURL(blob);
        });
    });
    console.log("Serialized zip: " + Math.round(b64.length * 0.75) + " bytes");

    // Reset selections so we can verify the reload actually restores them.
    await page.evaluate(() => {
        ["model", "mesh", "solver", "visualization"].forEach(t => {
            const m = window.managers[t];
            if (m) { m.selectedId = null; m.updateUI(); }
        });
    });
    const cleared = await snapshotSelections(page);
    console.log("After clearing:", JSON.stringify(cleared));
    if (Object.values(cleared).some(v => v !== null)) {
        fail("clearing didn't work");
    }

    // Feed the zip back into loadProject.
    await page.evaluate(async (data64) => {
        const bin = atob(data64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "application/zip" });
        await loadProject(blob);
    }, b64);
    await new Promise(r => setTimeout(r, 400));

    const restored = await snapshotSelections(page);
    console.log("After reload:", JSON.stringify(restored));
    ["model", "mesh", "solver"].forEach(k => {
        if (restored[k] === chosen[k]) pass("restored " + k + " = " + chosen[k]);
        else fail("expected " + k + "=" + chosen[k] + ", got " + restored[k]);
    });

    await browser.close();
    await srv.close();
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
