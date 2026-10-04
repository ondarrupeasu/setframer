# SetFrameR

Frame a 3D virtual set (glTF / GLB + HDRI) with a camera matched to your real one, and export it as a
**vMix Virtual Set**: rendered background, UV maps for the screens and the chroma-keyed presenter, shot presets —
plus a foreground layer for ATEM / Ultimatte keying and a clean live output for the control room.

Static PWA — no backend, no build, nothing uploaded: everything runs in the browser (WebGL).
Teaching tool of CIFP Tartanga LHII (Realización A/V) · https://setframer.cinemafilmak.com

- Export format: [`docs/EXPORT_FORMAT.md`](docs/EXPORT_FORMAT.md) · sample set: [`examples/DemoStudio`](examples/DemoStudio)
- Check an exported set without vMix: `tools/simulate_vmix.py` (composites it like vMix does)
- Run locally: `python3 tools/devserver.py` → http://localhost:8791

Uses [three.js](https://threejs.org) (MIT, vendored in `vendor/three`) and fflate (MIT).
