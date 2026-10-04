# SetFrameR — visor de sets virtuales → fondo fijo para croma

> **Proyecto NUEVO.** Arrancar en su **sesión propia** en esta carpeta (`~/Proyectos/setframer`).
> App de ESCRITORIO de la suite (-R). Nombre: **SetFrameR** · bundle_id `es.cinemafilmak.setframer`.
> Carpeta creada 4-oct-2026 por MissionControl (nombre confirmado por Alex).

## Qué es (y el problema que resuelve)
En el plató de Tartanga probaron **producción virtual sobre croma** con Unreal Engine (fondos virtuales + tracking de
cámara para la perspectiva). Funciona pero **hay que calibrar un montón y es un lío para los alumnos**.
**SetFrameR = la versión sencilla:** un **visor 3D ligero** (Win+Mac) que **carga sets virtuales ya exportados**, te deja
**mover la cámara** hasta el encuadre que quieras y **exporta un FOTOGRAMA FIJO** (el "frame") que va de **fondo al croma**
→ a **vMix** u otro sistema del control, o se **guarda en disco**. **Sin Unreal en vivo, sin tracking, sin genlock.**
De momento **solo imágenes fijas** (plano fijo); movimiento = más adelante.

## Enfoque técnico DECIDIDO (Alex eligió glTF)
- **NO se abre Unreal en runtime.** El set se **exporta una vez a glTF/GLB** (de Unreal, Blender o donde sea) y SetFrameR
  lo carga. Así vale para cualquier plataforma.
- **Iluminación con HDRI**: cargar el set **+ un HDRI como entorno (IBL)** → queda bien al instante sin iluminar a mano.
  (Truco clave para que no se vea plano.)
- **Única "calibración" que queda** = casar el encuadre virtual con la cámara real: **FOV + altura + ángulo** (estático,
  con sliders/presets). Presets de focal → reutilizar el **catálogo de ópticas de ClapperQR** ([[clapperqr-lens-catalog]]).

## MVP (empezar pequeño)
1. Cargar **glTF/GLB** + **HDRI** (IBL).
2. **Navegar** la cámara (orbit/fly), fijar **FOV** y **aspecto 16:9**.
3. **Exportar PNG** a resolución objetivo (1920×1080) → guardar en disco.
4. Enviar a **vMix** (de simple a fino):
   - a) **PNG a un archivo/carpeta fijo** que vMix tenga como input de imagen (recarga solo). ← MVP.
   - b) **NDI** (frame fijo como fuente NDI; encaja con el mundo NDI de la suite, [[ndi-licensing]]).
   - c) **API de vMix** (HTTP) para meter/reemplazar el input.
5. Stills only (nada de movimiento todavía).

## De dónde salen los sets (glTF)
- **Sketchfab** (descarga glTF/GLB directa; muchos gratis CC — ojo licencia), **Fab.com**/**Quixel Megascans** (Epic).
- **Poly Haven** = HDRIs **CC0** (para la iluminación) + algún modelo.
- **A medida:** montar en **Blender** (importar assets + iluminar + **hornear** + exportar glTF nativo — mejor que pelearse
  con UE para esto).
- **Unreal → glTF**: tiene el glTF Exporter de Epic, pero **hornear la luz** y materiales PBR; NO exporta Lumen/Nanite/
  materiales complejos.

## Stack (encaja con la familia)
- **PySide6 + QtWebEngine + three.js** (o Babylon) — visor web dentro de app de escritorio. Win+Mac.
  (Ojo empaquetado QtWebEngine: [[webengine-packaging]].) **Casa de Estilo** `shared/theme.py` ([[design-house-style]]).
- Nombres/empaquetado: [[apps-naming-canonical]]. Firma **ad-hoc** en Mac ([[apple-certificate-decidido]]). Distribuye launchR.
- UI en **inglés** ([[apps-ui-english]]).

## Caveats honestos
- **Fondo fijo = solo plano fijo.** Si la cámara real se mueve, no hay parallax y se nota. Perfecto para informativo/
  entrevista con cámara bloqueada; movimiento queda para una v2 (ahí sí haría falta tracking → otra liga).
- El export de UE pierde chicha visual → **hornear luz** o usar **HDRI** / panoramas pre-renderizados.

## Contexto / ecosistema
Nace del plató de Tartanga (grupo TARTANGA). Relacionado: [[control-realizacion-app]] (tvstudio = el control real donde
está vMix), [[keylab-chroma-pwa]] (croma docente), [[dmx-lighting-app-idea]]. Vía producción virtual "pobre" (croma, sin LED).

## Estado
**4-oct-2026: cambio de rumbo → PWA que exporta un *Virtual Set de vMix*** (fondo + UV maps de pantallas y
presentador + zooms). MVP hecho y probado; ver `CLAUDE.md`. Lo de abajo es el estado previo.

Solo carpeta + este brief. **No empezado.** Siguiente: spike del visor (three.js: cargar un glTF de Sketchfab + HDRI de
Poly Haven, orbitar, export PNG) dentro de un PySide6+QtWebEngine mínimo.
