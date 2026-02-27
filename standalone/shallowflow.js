/**
 * ShallowFlow Core Engine
 * Manages the Pyodide runtime, global shared state, and simulation injection.
 */

// Global registry for Python and UI state
window.pyodideInstance = null;

/**
 * Initializes the Pyodide environment and pre-loads scientific libraries.
 * Attached to window to ensure cross-block accessibility.
 */
window.getPyodide = async function() {
    if (window.pyodideInstance) return window.pyodideInstance;
    
    const toast = document.getElementById('loading-toast');
    if (toast) {
        toast.style.display = 'block';
        toast.innerHTML = "🌀 Initializing Python Engine (Downloading ~20MB)...";
    }
    
    console.log("ShallowFlow: Starting Pyodide...");
    window.pyodideInstance = await loadPyodide();
    
    await window.pyodideInstance.loadPackage("micropip");
    const micropip = window.pyodideInstance.pyimport("micropip");
    
    console.log("ShallowFlow: Installing scientific stack (NumPy, Plotly, Matplotlib)...");
    await micropip.install(['numpy', 'plotly', 'matplotlib']);
    
    console.log("ShallowFlow: Loading engine.py...");
    const engineCode = await fetch('engine.py').then(r => r.text());
    await window.pyodideInstance.runPythonAsync(engineCode);
    
    if (toast) toast.style.display = 'none';
    console.log("ShallowFlow: Python Engine Ready.");
    return window.pyodideInstance;
};

/**
 * Injects a simulation block into a target div.
 * Handles Ace Editor setup, SVG preview loading, and execution logic.
 */
window.createSimulation = async function({targetId, codeUrl, staticImgUrl}) {
    const container = document.getElementById(targetId);
    if (!container) {
        console.error(`ShallowFlow Error: Target div #${targetId} not found.`);
        return;
    }

    // 1. Build Component Structure
    // We use a separate div for the interactive plot to allow for clean cross-fading
    container.innerHTML = `
        <div class="sim-ui">
            <div class="sim-plot" id="${targetId}-plot" style="position:relative; height:400px; background:#fff; overflow:hidden;">
                <img id="${targetId}-preview" src="${staticImgUrl}" 
                     style="width:100%; height:100%; object-fit: contain; transition: opacity 0.4s ease;">
                
                <div id="${targetId}-interactive" 
                     style="width:100%; height:100%; position:absolute; top:0; left:0; visibility:hidden; opacity:0; transition: opacity 0.4s ease;">
                </div>
            </div>
            
            <div class="sim-controls">
                <span class="sim-label">Source: ${codeUrl}</span>
                <button class="run-btn" id="${targetId}-btn">&#9654; Run Simulation</button>
            </div>
            
            <div class="sim-editor" id="${targetId}-editor" style="height:250px; border-top: 1px solid #e2e8f0;"></div>
        </div>
    `;

    // 2. Fetch the Default Code Snippet
    let defaultCode = "";
    try {
        defaultCode = await fetch(codeUrl).then(r => r.text());
    } catch (err) {
        console.error(`ShallowFlow Error: Could not fetch snippet at ${codeUrl}`);
        defaultCode = "# Error: Snippet not found.";
    }

    // 3. Initialize the Ace Editor
    const editor = ace.edit(`${targetId}-editor`);
    editor.setTheme("ace/theme/monokai");
    editor.session.setMode("ace/mode/python");
    editor.setOptions({
        fontSize: "14px",
        showPrintMargin: false,
        useSoftTabs: true,
        tabSize: 4
    });
    editor.setValue(defaultCode, -1);

    // 4. Bind Execution to the Button
    document.getElementById(`${targetId}-btn`).onclick = async () => {
        const btn = document.getElementById(`${targetId}-btn`);
        const previewImg = document.getElementById(`${targetId}-preview`);
        const interactiveDiv = document.getElementById(`${targetId}-interactive`);
        
        btn.disabled = true;
        const originalLabel = btn.innerText;
        btn.innerText = "⏳ Computing...";
        
        try {
            // Wake up or retrieve the singleton Python instance
            const py = await window.getPyodide();
            
            // Execute the code via the process_code function in engine.py
            const userCode = editor.getValue();
            const resultJson = py.globals.get('process_code')(userCode);
            const result = JSON.parse(resultJson);
            
            if (result.status === "success") {
                if (result.plot_type === 'plotly') {
                    const data = JSON.parse(result.plot_data);
                    
                    // Render the live Plotly chart
                    Plotly.newPlot(interactiveDiv, data.data, data.layout, {responsive: true});
                    
                    // Trigger the visual transition: SVG out, Interactive in
                    previewImg.style.opacity = '0';
                    setTimeout(() => {
                        previewImg.style.display = 'none';
                        interactiveDiv.style.visibility = 'visible';
                        interactiveDiv.style.opacity = '1';
                    }, 400);

                } else if (result.plot_type === 'matplotlib') {
                    previewImg.style.display = 'none';
                    interactiveDiv.style.visibility = 'visible';
                    interactiveDiv.style.opacity = '1';
                    interactiveDiv.innerHTML = `<img src="data:image/svg;base64,${result.plot_data}" style="max-width:100%; height:auto; display:block; margin:auto;">`;
                }
            } else {
                console.error("Python Traceback:\n" + result.output);
                alert("Python Error: See browser console for traceback.");
            }
        } catch (err) {
            console.error("ShallowFlow Runtime Error:", err);
            alert("Runtime Error: " + err.message);
        } finally {
            btn.disabled = false;
            btn.innerText = originalLabel;
        }
    };
};
