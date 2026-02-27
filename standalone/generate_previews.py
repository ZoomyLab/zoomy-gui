import os
import glob
import plotly.graph_objects as go
import numpy as np

# Configuration
SNIPPETS_DIR = "snippets"
OUTPUT_DIR = "previews"

os.makedirs(OUTPUT_DIR, exist_ok=True)


def generate_previews():
    snippet_files = glob.glob(os.path.join(SNIPPETS_DIR, "*.py"))

    for filepath in snippet_files:
        filename = os.path.basename(filepath)
        print(f"🎨 Generating SVG preview for: {filename}...")

        with open(filepath, "r", encoding="utf-8") as f:
            code = f.read()

        scope = {"np": np, "go": go}

        try:
            exec(code, scope)
            if "fig" in scope:
                fig = scope["fig"]
                # Change extension to .svg
                output_path = os.path.join(OUTPUT_DIR, filename.replace(".py", ".svg"))

                if isinstance(fig, dict):
                    fig = go.Figure(fig)

                # Export as SVG
                fig.write_image(output_path, format="svg")
                print(f"   ✅ Saved to {output_path}")
        except Exception as e:
            print(f"   ❌ Error: {e}")


if __name__ == "__main__":
    generate_previews()
