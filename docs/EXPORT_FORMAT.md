# SetFrameR export format

SetFrameR exports a **vMix Virtual Set** (vMix "Virtual Set Specification 1.0"), unchanged. Any app that composites
it the way vMix does (e.g. a browser vMix simulator) can load it as-is. Sample: [`examples/DemoStudio/`](../examples/DemoStudio)
(and what it should look like composited with test cards: `examples/DemoStudio_simulated.png`).

## Delivery
- A **folder** named after the set, delivered as `<Name>.zip` (folder inside) or written straight to disk.
- Not a `.gtzip`, not a vMix preset. vMix loads it with *Add Input → Virtual Set → Browse* (pick the folder).

## Files
| File | What |
| --- | --- |
| `config.xml` | Layer stack + zoom presets (below). The only file that defines structure. |
| `Background.png` | Rendered set, 8-bit RGB(A) sRGB, output resolution. Screens show their original material. |
| `Screen<A-D>_uv.png` | One **UV map** per screen surface (0–4 of them). |
| `Talent_uv.png` | UV map of the presenter card (0–1). |
| `Foreground.png` | *Optional.* Only the props the user marked "in front of presenter" (a desk), 8-bit RGBA with real alpha, same camera. **Not referenced by config.xml** (vMix already hides the presenter behind them through the Talent UV map) — it is for compositing elsewhere: ATEM / Ultimatte foreground fill+key, or a top layer in your own compositor if you key the camera yourself. |
| `blank.png` | Fully transparent placeholder, output resolution (the "image" of dynamic inputs). |
| `setframer.json` | SetFrameR metadata, informative only (camera, lens, zooms, hidden props). vMix ignores it. |

Resolution = the one chosen at export: **1920×1080** (default), 3840×2160 or 1280×720. Every PNG in a set has the same size.

## config.xml
```xml
<virtualSet>
  <input name="Background" x="0" y="0" zoomX="1" zoomY="1" rotateX="0" rotateY="0" rotateZ="0" cropping="0,0,1,1" dynamic="false">Background.png</input>
  <input name="Screen A" … dynamic="true" uvmap="ScreenA_uv.png">blank.png</input>
  <input name="Screen B" … dynamic="true" uvmap="ScreenB_uv.png">blank.png</input>
  <input name="Talent"   … dynamic="true" uvmap="Talent_uv.png">blank.png</input>
  <zoom name="Full" x="0" y="0" zoom="1" />
  <zoom name="Medium Shot" x="0" y="0" zoom="1.6" />
  <zoom name="Close Up" x="0" y="0" zoom="2.5" />
</virtualSet>
```
- `<input>` elements are **layers, bottom → top** (max 10). SetFrameR always writes: Background, then Screens A…D, then Talent.
- `dynamic="false"`: a still image (the element text is the file).
- `dynamic="true"` + `uvmap`: a slot for a **live input** chosen by the operator in vMix. The element text (`blank.png`)
  is what shows while nothing is assigned.
- SetFrameR always writes `x=y=0, zoomX=zoomY=1, rotate*=0, cropping=0,0,1,1` (no extra 2D transform per layer).
  vMix lets users nudge layers and re-export, so a robust reader should still honour those attributes.
- `<zoom>` = camera/shot presets: a **2D crop/scale of the whole composite** (no perspective change), `zoom` ≥ 1,
  centred. SetFrameR writes `x=y=0`; the exact meaning of non-zero `x/y` in vMix is **not verified yet** (treat as an
  offset of the zoom centre, in vMix's position units).

## UV map encoding (verified against vMix's own `uvmapsample.zip`)
16-bit **RGBA** PNG, `gAMA` chunk = 1/2.2 (values themselves are linear; don't gamma-decode them).
For every output pixel:
- `u = R / 65536`, `v = G / 65536` → where to sample the live input, in its own frame, **v from the TOP**
  (vMix: `R = floor(x/W · 65536)`, `G = floor(y/H · 65536)`).
- `B = 0`.
- `A / 65535` = coverage of this layer at that pixel. 0 = the layer draws nothing there. SetFrameR antialiases edges
  (fractional A at HD); vMix's sample is all-or-nothing — whether vMix honours partial A is **not verified yet**.

Compositing one dynamic layer (what `tools/simulate_vmix.py` does, and what vMix appears to do):
```
src  = input_frame.sample(u * input_w, v * input_h)        // nearest or bilinear
a    = (A / 65535) * src.alpha                             // src.alpha = the input's own key (chroma) alpha
out  = out * (1 - a) + src.rgb * a
```
Occlusion is already baked in: wherever set geometry (a desk, a column) is in front of a screen or the presenter,
that layer's A is 0. So the **Talent layer goes on top** and the desk still hides the presenter's legs.

## Talent (the chroma-keyed presenter)
- A vertical 16:9 card standing on the set floor, facing the camera. Its UV map maps the **whole camera frame**
  (keyed) onto it: `u` left→right, `v` top→bottom of the presenter's camera picture.
- So the operator assigns the **keyed camera input** (alpha from chroma key) to "Talent"; the input's own alpha
  cuts the presenter out, the UV map places, scales and occludes them. No separate x/y/scale numbers to apply.
- Card size = how much the REAL camera frames at the presenter's distance (height in metres, informative, in
  `setframer.json` is the camera, not the card — the card is fully described by the UV map).

## setframer.json (informative)
`{ app, created, w, h, set, view:{pos,target,focal,sensor}, camera:{tilt,pan,dist,height,focal,sensor,fovV,fovH},
zooms:[{name,zoom}], hiddenObjects:[names] }` — units metres / degrees / mm.

## Rendering it in WebGL (hints)
- Upload each UV map as a **16-bit or float texture** (8-bit loses precision: 1/256 of the input is ~7 px at 1080p).
  Browsers decode PNG to 8 bits in `<img>`/`createImageBitmap`; decode the PNG yourself (e.g. UPNG.js / fast-png)
  to keep 16 bits, then `RG16UI`/`RGBA16UI` or convert to `RG32F` (u, v) + `R8` (coverage).
- Per dynamic layer, one full-screen pass: `uvA = texture(uvmap, st); col = texture(input, uvA.xy); a = uvA.w * col.a`.
- Zoom preset = scale the final composite about its centre by `zoom` (crop to frame).
