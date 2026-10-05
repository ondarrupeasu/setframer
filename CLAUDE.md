# SetFrameR

**Qué es:** PWA (sin backend, sin build) que carga un **set virtual 3D (glTF/GLB) + HDRI**, deja encuadrar con la
cámara casada a la real (sensor + óptica del catálogo de ClapperQR, altura, tilt, pan) y **exporta un Virtual Set de
vMix**. Los alumnos de Tartanga ya ponen el fondo del croma con vMix → esa es la salida natural. Brief original:
`BRIEF.md` (allí ponía escritorio PySide6; **se cambió a PWA el 4-oct-2026**, decisión de Alex).

## Formato vMix Virtual Set (verificado)
- Una **carpeta**: `config.xml` + PNGs. vMix: *Add Input → Virtual Set → Browse* (no hace falta ninguna carpeta especial).
- `<input>` = capa (abajo → arriba, **máx. 10**). `dynamic="true" uvmap="X.png"` = entrada en vivo mapeada.
- **UV map** (sacado de `uvmapsample.zip` oficial): PNG **RGBA 16 bit**, `gAMA` 1/2.2, **R = u·65536, G = v·65536**
  (lineal, v hacia ABAJO), B = 0, A = cobertura.
- `<zoom name x y zoom>` = planos. Son **recortes 2D** (sin cambio de perspectiva). `x/y` NO verificados → exportamos
  centrados (0,0); el ajuste fino se hace en vMix y su Export.

## Cómo se genera (vmixset.js)
- `Background.png` = render normal (sin helpers; pantallas con su material original).
- Por cada pantalla (Screen A–D) y el **Talent**: pase UV con la MISMA cámara → set en depth-only + objetivo escribiendo
  sus UV normalizadas con depth ≤ (+ polygonOffset). Así lo que tapa (mesa, columna) recorta el mapa solo.
  Supersampling 2× hasta HD (bordes con cobertura parcial); 1× en 4K (memoria).
- **Talent** = tarjeta vertical en el suelo, mirando a cámara, alto = lo que la cámara REAL encuadra en el presentador
  (≈2,2 m plano entero), ancho 16:9. Se mapea ahí la entrada de cámara keyada.
- Pantallas: UV del propio mesh normalizadas a su rango (glTF ya es v-abajo); sin UV → proyección planar. Rot/espejos
  por pantalla. En el visor se ve una **carta de ajuste** con la misma transformación → orientación comprobable a ojo.

## Robustez con sets reales (probado con *News Room* de Sketchfab)
- **Suelo** = la cota más baja con mucha superficie horizontal (`findFloor`), no el bounding box: los sets traen
  fotos de fondo/cielos que cuelgan metros por debajo. El encuadre inicial usa la extensión de ese suelo.
- **Orientación de pantallas automática** (`autoOrient`): mide hacia dónde crecen u/v en el mundo y elige rot/espejos
  para que el vídeo salga derecho y sin espejo visto desde cámara (los UV de Sketchfab vienen a menudo invertidos).
- **Objetos (atrezo)**: panel *Objects* → seleccionar (resaltado al pasar el ratón), ocultar, mover/rotar con
  TransformControls (rotar solo en vertical), Reset. "Objeto" = nodo bajo el contenedor del glTF (`objectOf`).
  Ocultos/movidos se respetan en todos los pases de export; los helpers/gizmos nunca salen.
- **Unidades**: glTF debería ir en metros, pero hay descargas en cm o pulgadas. Al cargar se elige la primera unidad
  (m, cm, in, mm) que da al set una altura creíble (2,2–12 m); selector *Units* para corregir. (*News Studio* = pulgadas.)
- **Materiales spec-gloss** (`KHR_materials_pbrSpecularGlossiness`, three.js ya no lo soporta → salían blanco metal):
  `convertSpecGloss` los rehace a metal/rough al cargar.
- **Navegación**: la rueda va HACIA EL CURSOR (paso ∝ distancia a lo que hay debajo; atraviesa paredes), no al pivote
  de OrbitControls (que se quedaba frenado). Doble clic = nuevo pivote. *View from* Front/Back/Left/Right; si desde
  fuera una pared tapa la vista, la cámara se pone dentro, en el centro del suelo (caso *News Studio Prime*).
- **Mover objetos**: se arrastra el propio objeto sobre el plano horizontal; el gizmo solo deja la flecha Y.
- **Proyectos** (`project.js`): IndexedDB (`projects` = JSON + miniatura; `files` = set + HDRI, solo se reescriben si
  cambia su firma). Autosave cada 4 s en el slot `autosave` → al abrir, barra *Restore last session*. Archivo portable
  `.setframer` = zip {project.json, set/…, hdri/…}. Los objetos se direccionan por **ruta de índices** desde la raíz
  (`pathOf`/`byPath`), no por uuid (cambia en cada carga). `V.snapshot()`/`V.restore()` + la UI en `app.js:collect/applyProject`.
- **Vista previa de planos**: botón *View* en cada shot → `camera.zoom` (= recorte centrado de vMix, nítido). Los
  exports fuerzan `zoom = 1` (renderPNG y buildVirtualSet); `layout()` lo restaura.
- **Salida limpia** (`output.html`, `openOutput`): ventana aparte 1920×1080 que vMix captura (Desktop Capture / NDI Screen
  Capture) y manda al ATEM como fondo. Cada frame: render limpio (sin helpers, pantallas con material original, sin
  cámara en vivo) → `drawImage` a la ventana → render normal para el visor. Con la salida abierta el buffer del visor
  es 1920 de ancho. (En el navegador del panel de Claude no se abren ventanas aparte: se probó con un iframe.)
- **Primer plano** (*In front of presenter* en Objects): `Foreground.png` con alpha por *difference matting* (render sobre
  negro y sobre blanco; el resto del set en depth-only). Va en el zip del set pero NO en `config.xml` (vMix ya oculta al
  presenter con el UV map); es para ATEM/Ultimatte (fill+key). Botón *Foreground PNG only*.
- **Cámara en vivo** (panel Live): `getUserMedia` (capturadora o webcam) → capa a pantalla completa sobre el set solo en el
  visor, nunca en export ni en la salida. Croma tipo OBS (distancia CbCr BT.709, similarity/smoothness/spill) +
  cuentagotas. OJO: three.js entrega las VideoTexture SIN decodificar a un ShaderMaterial → el croma trabaja en sRGB tal cual.
- `<img>.decode()` se cuelga con la pestaña en segundo plano → usar `createImageBitmap`.
- **Luz para sets sin luz** (Lighting): muchos glTF de Sketchfab traen solo color — la «gracia» la pone el visor de
  Sketchfab (sol, sombras, AO) y no viaja en el archivo. *Sun* = DirectionalLight con sombras (cámara de sombra que
  envuelve el set, temperatura de color), *Ambient occlusion* = GTAOPass vía EffectComposer (cámara propia solo con la
  capa 0: la tarjeta del presentador vive en la capa 1 y no oscurece nada), *Sky* = `objects/Sky.js` renderizado a un
  cubemap (fondo) + PMREM (luz), sigue al sol; ×`SKY_GAIN` (0,05) porque va en unidades físicas. Todo apagado por
  defecto (los platós de TV traen la luz horneada). `draw()` = único punto de render del visor/salida/export.
- **Luces colocables** (panel Lights): SpotLight/PointLight reales (decay 2, `candela()` = intensidad), color por
  temperatura, sombra opcional (1024), *glow* = Sprite aditivo en el grupo `glows` (sale en el fondo exportado; se
  oculta en los pases UV y de primer plano). Punto de arrastre en `helpers` (capa 1). Las luces que trae el glTF
  (KHR_lights_punctual) se listan como «from the file» (fuerza ×, sombra, apagar). Sin rebotes (eso = hornear en Blender).
  OJO: la propiedad `cone` es el ángulo; la guía visual es `coneHelper`.

- **Post (AO / profundidad de campo)** (`draw()`): solo el SET pasa por el EffectComposer (RenderPass → GTAO → DoF →
  OutputPass); el *overlay* (`OVERLAY` = `helpers` + `glows`: tarjeta del presentador, gizmos, glows) se pinta después,
  nítido, contra la profundidad del set (pase depth-only propio en `depthRT` + `depthCopy` escribe `gl_FragDepth` en
  pantalla). DoF físico: CoC = (f²/N)·|z−S|/(z·(S−f)) → píxeles con el ancho de sensor; gather en disco golden-angle
  (160 muestras, tope 4,5 % del ancho — con 2 % todo saturaba y tele/angular/iris parecían iguales) + pase de suavizado (`DofSmoothShader`) contra el grano. Rango nítido en la UI (`dofRange`, CoC = sensor/1500). *Follow presenter* = foco en el presentador, o en el pivote si no hay. El iris NO
  toca la exposición (a propósito). OJO: el OutputPass hace tone mapping de TODO → un fondo de color liso salía más
  oscuro (Neutral aplasta los oscuros); por eso el RenderPass limpia a alpha 0, el fondo de color se pinta directo en
  pantalla (`bgScene`) y el OutputPass se compone encima en premultiplicado.
- **Niebla**: `THREE.Fog` lineal (Start/End m). Sale en fondo y primer plano, no en el presentador ni en el HDRI/cielo.
  La tarjeta del presentador tiene `fog:false`.

## Ficheros
`index.html` · `app.js` (UI) · `project.js` (guardar/abrir proyectos) · `output.html` (salida limpia) · `viewer.js` (three.js: escena, carga, cámara, roles, picking, PNG) · `vmixset.js`
(pases UV, PNG 16 bit propio, config.xml, zip con fflate) · `demo.js` (plató procedural para probar sin assets) ·
`lenses.json` (copia de `qrclapper/lenses.json`) · `vendor/three` (r186, solo lo que se usa, offline) ·
`casa-estilo.css` + `report.js` (copias de `missioncontrol/shared`, no editar aquí) · `sw.js` network-first.

## Probar
- Servidor: `.claude/launch.json` → `tools/devserver.py` (puerto 8791, **sin caché**: con http.server a secas el
  navegador se queda con módulos viejos). Botón **Demo studio**. Sets reales de prueba en `samples/` (gitignored).
- **`tools/simulate_vmix.py <carpeta-set>`** compone como vMix (cartas de ajuste + silueta de presentador) → valida
  orientación/oclusión sin vMix: `uv run --with numpy --with pillow --with pypng tools/simulate_vmix.py <dir>`.

## Deploy
**En vivo: https://setframer.cinemafilmak.com** · repo público `ondarrupeasu/setframer` · GitHub Pages desde `main`
(raíz), `CNAME` en el repo, HTTPS forzado (cert. aprobado 4-oct-2026). Push a `main` = publicado. Al cambiar ficheros
del shell, subir `CACHE` en `sw.js`. OJO: Pages manda `max-age=600`; el SW pide todo con `cache:'no-cache'` (revalida
por ETag) — sin eso, tras un deploy se mezclaban módulos viejos y nuevos durante 10 min (fallos raros «que se arreglan solos»). `samples/` (sets de Sketchfab) y `setframer/` (restos PySide6) no se suben.

## Pendiente / a verificar en vMix real (tvstudio)
- Que vMix respete la **cobertura parcial** (alpha intermedio) del UV map en los bordes.
- Semántica de `x/y` de `<zoom>`; si vMix usa la resolución completa del fondo 4K al hacer zoom en proyecto HD.
- Iconos PNG para la PWA, idiomas (eu/es/en como SoundLab?).
- Restos del arranque PySide6 a borrar a mano: `setframer/`, `.venv/`.
