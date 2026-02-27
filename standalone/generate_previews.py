import os
import glob
import json
import plotly.graph_objects as go
import numpy as np

# Configuration
SNIPPETS_DIR = "snippets"
OUTPUT_DIR = "previews"
MANIFEST_FILE = "snippets.json"

os.makedirs(OUTPUT_DIR, exist_ok=True)


def generate_previews():
    snippet_files = glob.glob(os.path.join(SNIPPETS_DIR, "*.py"))
    snippet_names = []

    for filepath in snippet_files:
        filename = os.path.basename(filepath)
        name_only = filename.replace(".py", "")
        snippet_names.append(name_only)

        print(f"🎨 Generating SVG preview for: {filename}...")

        with open(filepath, "r", encoding="utf-8") as f:
            code = f.read()

        scope = {"np": np, "go": go}

        try:
            exec(code, scope)
            if "fig" in scope:
                fig = scope["fig"]
                output_path = os.path.join(OUTPUT_DIR, f"{name_only}.svg")

                if isinstance(fig, dict):
                    fig = go.Figure(fig)

                # Export as SVG for crisp previews
                fig.write_image(output_path, format="svg")
                print(f"   ✅ Saved to {output_path}")
        except Exception as e:
            print(f"   ❌ Error executing {filename}: {e}")

    # Save the manifest so the webpage knows what to load
    with open(MANIFEST_FILE, "w") as f:
        json.dump(snippet_names, f)
    print(f"\n📂 Manifest saved to {MANIFEST_FILE}")


if __name__ == "__main__":
    generate_previews()
