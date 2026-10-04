/*  report_widget.js — botón "Reportar / Sugerir" para las PWA de CinemaFilmak.
 *
 *  Un solo <script> lo instala. Envía al MISMO endpoint que las apps de escritorio
 *  (report.cinemafilmak.com) -> Telegram. Sin dependencias, sin build.
 *
 *  Uso mínimo (auto-inyecta un botón flotante abajo-derecha):
 *      <script src="report.js" data-app="DMXSimulatoR"></script>
 *
 *  Opciones (atributos del <script>):
 *      data-app="Nombre"        (requerido) nombre que sale en Telegram
 *      data-auto-button="0"     no inyectar botón; abrir con CFReport.open('problem'|'suggestion')
 *      data-label="Ayuda"       texto del botón flotante (defecto: "Reportar")
 *
 *  API: window.CFReport.open(kind)   kind = 'problem' | 'suggestion' (defecto 'problem')
 *
 *  Fuente canónica: missioncontrol/shared/report_widget.js (copiar a cada PWA; no editar la copia).
 */
(function () {
  "use strict";
  var ENDPOINT = "https://report.cinemafilmak.com/report";
  var s = document.currentScript || (function () {
    var all = document.getElementsByTagName("script");
    return all[all.length - 1];
  })();
  var APP   = (s && s.getAttribute("data-app")) || document.title || "PWA";
  var AUTO  = !s || s.getAttribute("data-auto-button") !== "0";
  var LABEL = (s && s.getAttribute("data-label")) || "Reportar";

  var CSS = "" +
    ".cfr-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "background:rgba(255,90,77,.12);color:#ff5a4d;border:1px solid rgba(255,90,77,.5);border-radius:20px;padding:9px 15px;cursor:pointer;" +
      "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}" +
    ".cfr-btn:hover{background:rgba(255,90,77,.22)}" +
    ".cfr-ov{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:18px}" +
    ".cfr-card{width:100%;max-width:440px;background:#1c1a16;color:#ece7de;border:1px solid #2b2822;border-radius:16px;padding:20px;" +
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)}" +
    ".cfr-card h3{margin:0 0 4px;font-size:18px}.cfr-card h3 b{color:#ff5a4d;font-weight:800}" +
    ".cfr-sub{color:#9b958a;font-size:13px;margin:0 0 16px}" +
    ".cfr-seg{display:flex;gap:8px;margin:0 0 14px}" +
    ".cfr-seg button{flex:1;padding:9px;border-radius:10px;border:1px solid #3a362f;background:transparent;color:#ece7de;font:600 13px sans-serif;cursor:pointer}" +
    ".cfr-seg button.on{background:rgba(255,90,77,.12);color:#ff5a4d;border-color:rgba(255,90,77,.5)}" +
    ".cfr-ta{width:100%;min-height:110px;resize:vertical;background:#100f0d;color:#ece7de;border:1px solid #3a362f;border-radius:10px;padding:11px;" +
      "font:14px/1.5 sans-serif;box-sizing:border-box}" +
    ".cfr-row{display:flex;gap:10px;margin-top:16px}" +
    ".cfr-row button{flex:1;padding:11px;border-radius:10px;border:1px solid #3a362f;background:transparent;color:#ece7de;font:600 14px sans-serif;cursor:pointer}" +
    ".cfr-row .send{background:rgba(255,90,77,.12);color:#ff5a4d;border-color:rgba(255,90,77,.5)}" +
    ".cfr-row .send:disabled{opacity:.5;cursor:default}" +
    ".cfr-msg{margin:12px 0 0;font-size:13px;color:#9b958a;text-align:center}";

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function injectCSS() {
    if (document.getElementById("cfr-css")) return;
    var st = el("style"); st.id = "cfr-css"; st.textContent = CSS; document.head.appendChild(st);
  }

  function open(kind) {
    injectCSS();
    kind = kind === "suggestion" ? "suggestion" : "problem";
    var ov = el("div", "cfr-ov");
    var card = el("div", "cfr-card");
    var h = el("h3"); h.innerHTML = "Enviar a " + APP.replace(/(.)$/, "<b>$1</b>");
    var sub = el("p", "cfr-sub", "Nos llega directamente. Cuéntanos qué pasa o qué mejorarías.");
    // segmento problema / sugerencia
    var seg = el("div", "cfr-seg");
    var bProb = el("button", kind === "problem" ? "on" : "", "🐞 Problema");
    var bSug  = el("button", kind === "suggestion" ? "on" : "", "💡 Sugerencia");
    seg.appendChild(bProb); seg.appendChild(bSug);
    var ta = el("textarea", "cfr-ta"); ta.placeholder = "Escribe aquí…";
    var row = el("div", "cfr-row");
    var bCancel = el("button", "", "Cancelar");
    var bSend = el("button", "send", "Enviar");
    row.appendChild(bCancel); row.appendChild(bSend);
    var msg = el("p", "cfr-msg");
    card.appendChild(h); card.appendChild(sub); card.appendChild(seg); card.appendChild(ta); card.appendChild(row); card.appendChild(msg);
    ov.appendChild(card); document.body.appendChild(ov);
    ta.focus();

    bProb.onclick = function () { kind = "problem"; bProb.className = "on"; bSug.className = ""; };
    bSug.onclick  = function () { kind = "suggestion"; bSug.className = "on"; bProb.className = ""; };
    function close() { ov.remove(); }
    bCancel.onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };

    bSend.onclick = function () {
      var note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      bSend.disabled = true; msg.textContent = "Enviando…";
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: APP, version: "web", kind: kind,
          os: (navigator.userAgent || "").slice(0, 120),
          note: note
        })
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        msg.textContent = "¡Gracias! Enviado ✓";
        setTimeout(close, 1100);
      }).catch(function () {
        bSend.disabled = false;
        msg.textContent = "No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.";
      });
    };
  }

  window.CFReport = { open: open };

  if (AUTO) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", addButton);
    } else { addButton(); }
  }
  function addButton() {
    injectCSS();
    var b = el("button", "cfr-btn", LABEL);
    b.title = "Reportar un problema o sugerir una mejora";
    b.onclick = function () { open("problem"); };
    document.body.appendChild(b);
  }
})();
