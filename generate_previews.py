"""Generate visualization preview SVGs and update cards/visualizations/generated.json.

Scans snippets/ for .py files, executes them to produce Plotly figures,
exports as SVG, and writes card entries to generated.json.

Usage:
    python generate_previews.py
"""

import os
import glob
import json
import plotly.graph_objects as go
import numpy as np

SNIPPETS_DIR = os.path.join(os.path.dirname(__file__), "snippets")
PREVIEW_DIR = os.path.join(os.path.dirname(__file__), "previews")
GENERATED_JSON = os.path.join(os.path.dirname(__file__), "cards", "visualizations", "generated.json")
MANIFEST_FILE = os.path.join(os.path.dirname(__file__), "snippets.json")

os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(os.path.dirname(GENERATED_JSON), exist_ok=True)


def generate_previews():
    snippet_files = sorted(glob.glob(os.path.join(SNIPPETS_DIR, "*.py")))
    snippet_names = []
    cards = []

    for filepath in snippet_files:
        filename = os.path.basename(filepath)
        name_only = filename.replace(".py", "")
        snippet_names.append(name_only)

        card_id = "vis-gen-" + name_only
        title = name_only.replace("_", " ").title()
        preview_name = name_only + ".svg"
        preview_path = os.path.join(PREVIEW_DIR, preview_name)

        print(f"Generating preview for {filename}...", end=" ")

        with open(filepath, "r", encoding="utf-8") as f:
            code = f.read()

        scope = {"np": np, "go": go}
        try:
            exec(code, scope)
            if "fig" in scope:
                fig = scope["fig"]
                if isinstance(fig, dict):
                    fig = go.Figure(fig)
                fig.write_image(preview_path, format="svg")
                print("OK")
            else:
                print("SKIP (no fig)")
                preview_name = None
        except Exception as e:
            print(f"SKIP ({e})")
            preview_name = None

        card = {
            "id": card_id,
            "title": title,
            "source": "generated",
            "snippet": "snippets/" + filename,
            "description": title,
        }
        if preview_name:
            card["preview"] = "previews/" + preview_name
        cards.append(card)

    # Write generated cards
    with open(GENERATED_JSON, "w") as f:
        json.dump(cards, f, indent=2)
    print(f"\nWrote {len(cards)} cards to {GENERATED_JSON}")

    # Also save snippet manifest for backward compat
    with open(MANIFEST_FILE, "w") as f:
        json.dump(snippet_names, f)


if __name__ == "__main__":
    generate_previews()
