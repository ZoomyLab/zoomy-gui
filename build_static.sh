#!/bin/bash
set -e

echo "Converting Panel app to static Pyodide site..."
panel convert main_static.py \
  --to pyodide-worker \
  --out ./dist \
  --requirements numpy plotly matplotlib

echo ""
echo "Done! Static site is in ./dist/"
echo "To preview locally:"
echo "  cd dist && python -m http.server 8000"
echo "  Then open http://localhost:8000/main_static.html"
