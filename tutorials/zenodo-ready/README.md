# Zenodo Upload Instructions

Upload the tutorial ZIP files from this directory to Zenodo for persistent,
DOI-citable distribution.

## Steps

1. Go to https://zenodo.org and log in
2. Click "New Upload"
3. Upload the `.zip` file (e.g., `getting-started.zip`)
4. Fill in metadata:
   - **Title**: Zoomy Tutorial — Getting Started
   - **Upload type**: Dataset
   - **Description**: Pre-configured Zoomy simulation sessions for the Getting Started tutorial
   - **Keywords**: zoomy, simulation, tutorial, shallow-water-equations
5. Publish and note the **record ID** from the URL (e.g., `https://zenodo.org/record/12345` → ID is `12345`)

## Usage

Once published, users can load the tutorial directly in the GUI:

```
https://mbd-rwth.github.io/Zoomy/gui/?project=zenodo:12345/getting-started.zip
```

Or with auto-detection (loads the first .zip in the record):

```
https://mbd-rwth.github.io/Zoomy/gui/?project=zenodo:12345
```
