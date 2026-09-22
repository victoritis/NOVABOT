// ==UserScript==
// @name         NOVABOT
// @namespace    https://github.com/victoritis/NOVABOT
// @version      0.4.2
// @description  Panel de control para Grepolis — interfaz propia, sin depender del cliente del juego.
// @author       victoritis
// @match        *://*.grepolis.com/*
// @resource     NOVABOT_CSS https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/* =====================================================================================
   NOVABOT — loader.
   -------------------------------------------------------------------------------------
   Dos archivos en el repo:
     - NOVABOT.user.js   este fichero (lo instala Tampermonkey)
     - novabot.css       estilos, cargados en runtime vía @resource + GM_getResourceText

   IMPORTANTE — caché de @resource:
   Tampermonkey descarga novabot.css una vez y lo cachea. Solo vuelve a comprobar si
   hay una versión nueva cuando el propio @version de este .user.js cambia (o al pulsar
   "Buscar actualizaciones de userscripts" en Tampermonkey). Así que cada vez que
   toquemos SOLO el CSS, hay que subir igualmente este archivo con el @version
   incrementado para que a ti te llegue el CSS nuevo al actualizar.

   Con @updateURL/@downloadURL apuntando al raw de GitHub, Tampermonkey puede avisarte
   de actualizaciones automáticamente una vez lo instales desde esa URL (o lo edites
   para que apunten a la tuya si cambias de rama/repo).

   Organización interna (para cuando quieras seguir separando):
     1) CONFIG        constantes, claves de almacenamiento
     2) UTILIDADES     helpers puros, sin tocar el DOM
     3) ESTADO         lectura/escritura en localStorage
     4) ESTILOS        carga del CSS remoto (novabot.css) vía GM_getResourceText
     5) DOM            construcción del botón flotante + panel
     6) INTERACCIÓN    arrastrar panel, pestañas, minimizar/cerrar
     7) INTEGRACIÓN    lectura ligera del cliente de Grepolis (nombre de ciudad, etc.)
     8) INIT           arranque y montaje en la página
   ===================================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------------
     1) CONFIG
  --------------------------------------------------------------------------------- */
  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const VERSION = '0.4.2';
  const STORAGE_KEY = 'novabot_ui_state_v1';

  // Evita cargar el script dos veces si Tampermonkey lo reinyecta.
  if (UW.__NOVABOT_ACTIVE__) return;
  UW.__NOVABOT_ACTIVE__ = VERSION;

  const TABS = [
    { id: 'inicio',      label: 'Inicio',        icon: 'home',   disabled: false },
    { id: 'granjas',     label: 'Granjas',       icon: 'farm',   disabled: false },
    { id: 'construccion', label: 'Construcción', icon: 'build',  disabled: false },
    { id: 'reclutamiento', label: 'Reclutamiento', icon: 'shield', disabled: true },
    { id: 'comercio',    label: 'Comercio',       icon: 'trade',  disabled: true },
    { id: 'ajustes',     label: 'Ajustes',        icon: 'gear',   disabled: true }
  ];

  /* ---------------------------------------------------------------------------------
     2) UTILIDADES
  --------------------------------------------------------------------------------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pos = (v, d = 0) => { const n = Math.round(+v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /* ---------------------------------------------------------------------------------
     3) ESTADO (posición del panel, pestaña activa, abierto/cerrado...)
  --------------------------------------------------------------------------------- */
  function defaultState() {
    return {
      open: false,
      activeTab: 'inicio',
      pos: null,        // {x, y} panel: esquina superior-izquierda; null = posición por defecto
      fabPos: null,      // {x, y} botón flotante; null = posición por defecto
      size: null,        // {w, h} tamaño del panel; null = tamaño por defecto (CSS)
      granjas: {
        enabled: false,   // aplica a TODAS las ciudades por igual
        tier: 1,          // 0..3 → posición dentro de los 4 tiempos de esa ciudad (0=más rápido)
        minDelayMs: 30000,
        maxDelayMs: 90000,
        stopMode: 'preset',  // 'preset' | 'manual'
        stopPreset: 90,      // 80 | 90 | 100
        stopManual: 90
      },
      construccion: {
        enabled: false,
        strictOrder: false,   // true = no salta a otro edificio si el primero está bloqueado
        towns: {}             // townId -> { goals: [{id, target}] } (orden = prioridad)
      }
    };
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') return { ...defaultState(), ...raw };
    } catch {}
    return defaultState();
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  let state = loadState();

  /* ---------------------------------------------------------------------------------
     4) ESTILOS — carga novabot.css declarado en @resource y lo inyecta.
     Si por lo que sea el recurso no está disponible (repo aún no subido, red bloqueada,
     nombre de rama distinto a "main"...), avisamos por consola en vez de romper el
     resto del script.
  --------------------------------------------------------------------------------- */
  function loadStyles() {
    try {
      const css = typeof GM_getResourceText === 'function' ? GM_getResourceText('NOVABOT_CSS') : null;
      if (css) { GM_addStyle(css); return true; }
      console.warn('[NOVABOT] GM_getResourceText no devolvió CSS (revisa @resource / la rama del repo).');
    } catch (e) {
      console.warn('[NOVABOT] No se pudo cargar novabot.css:', e);
    }
    return false;
  }

  const stylesLoaded = loadStyles();

  /* ---------------------------------------------------------------------------------
     5) DOM — iconos (SVG inline, sin depender de ningún recurso externo)
  --------------------------------------------------------------------------------- */
  const ICON = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v2h18V7L12 2Z"/><path d="M5 10v9M9 10v9M15 10v9M19 10v9"/><path d="M3 21h18"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    build: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l4 4-9 9H5v-4l9-9Z"/><path d="M13 7l4 4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 7.9 8 9 4.6-1.1 8-4 8-9V6l-8-3Z"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10 3 6l4-4"/><path d="M3 6h13a4 4 0 0 1 4 4v1"/><path d="m17 14 4 4-4 4"/><path d="M21 18H8a4 4 0 0 1-4-4v-1"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg>',
    resize: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><line x1="21" y1="9" x2="9" y2="21"/><line x1="21" y1="15" x2="15" y2="21"/></svg>',
    farm: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M12 9c0-4 3-7 7-7 0 4-3 7-7 7Z"/><path d="M12 13c0-4-3-7-7-7 0 4 3 7 7 7Z"/></svg>'
  };

  /* ---------------------------------------------------------------------------------
     5) DOM — construcción del FAB y del panel
  --------------------------------------------------------------------------------- */
  let root, fab, panel, headerEl, tabsEl, bodyEl, footerCityEl, farmLogEl;

  function buildTabs() {
    tabsEl.innerHTML = '';
    for (const tab of TABS) {
      const isActive = state.activeTab === tab.id;
      const node = el('div', {
        class: `nb-tab${isActive ? ' nb-active' : ''}${tab.disabled ? ' nb-disabled' : ''}`,
        html: `${ICON[tab.icon] || ''}<span>${esc(tab.label)}</span>`,
        title: tab.disabled ? `${tab.label} (próximamente)` : tab.label,
        onclick: () => {
          if (tab.disabled) return;
          state.activeTab = tab.id;
          saveState();
          buildTabs();
          renderBody();
        }
      });
      tabsEl.appendChild(node);
    }
  }

  function renderBody() {
    bodyEl.innerHTML = '';

    if (!stylesLoaded) {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Aviso'),
        el('p', { class: 'nb-placeholder' },
          'No se pudo cargar novabot.css desde GitHub (revisa la consola). El panel funciona pero sin estilos.')
      ]));
    }

    if (state.activeTab === 'inicio') {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Estado'),
        el('div', { class: 'nb-row' }, [
          el('span', { class: 'nb-row-label' }, 'Ciudad actual'),
          el('span', { class: 'nb-row-value', id: 'nb-current-town' }, '—')
        ]),
        el('div', { class: 'nb-row' }, [
          el('span', { class: 'nb-row-label' }, 'Granjas'),
          el('span', { class: `nb-pill${state.granjas.enabled ? '' : ' nb-pill-off'}` }, state.granjas.enabled ? 'Activado' : 'Desactivado')
        ]),
        el('div', { class: 'nb-row' }, [
          el('span', { class: 'nb-row-label' }, 'Próxima recolección'),
          el('span', { class: 'nb-row-value', 'data-nb-countdown': '' }, '—')
        ])
      ]));
      updateCountdown();
      footerCityEl = $('#nb-current-town', bodyEl);

      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Próximos pasos'),
        el('p', { class: 'nb-placeholder' },
          'Este es el panel base de NOVABOT. Las pestañas de Construcción, Reclutamiento y Comercio se irán activando a medida que se implementen.')
      ]));

      updateCityLabel();
    } else if (state.activeTab === 'construccion') {
      renderConstruccionTab();
    } else if (state.activeTab === 'granjas') {
      renderGranjasTab();
    } else {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('p', { class: 'nb-placeholder' }, 'Este módulo todavía no está disponible.')
      ]));
    }
  }

  function buildUI() {
    root = el('div', { id: 'novabot-root' });

    fab = el('div', { id: 'novabot-fab', class: 'nb-interactive', html: ICON.logo, title: 'Abrir NOVABOT (arrastra para moverlo)' });

    headerEl = el('div', { class: 'nb-header' }, [
      el('div', { class: 'nb-brand' }, [
        el('span', { html: ICON.logo }),
        el('div', { class: 'nb-brand-text' }, [
          el('span', { class: 'nb-brand-title' }, 'NOVABOT'),
          el('span', { class: 'nb-brand-version' }, `v${VERSION}`)
        ])
      ]),
      el('div', { class: 'nb-header-actions' }, [
        el('div', { class: 'nb-icon-btn', html: ICON.minus, title: 'Minimizar', onclick: (e) => { e.stopPropagation(); setOpen(false); } }),
        el('div', { class: 'nb-icon-btn', html: ICON.close, title: 'Cerrar', onclick: (e) => { e.stopPropagation(); setOpen(false); } })
      ])
    ]);

    tabsEl = el('div', { class: 'nb-tabs' });
    bodyEl = el('div', { class: 'nb-body' });

    const footer = el('div', { class: 'nb-footer' }, [
      el('span', {}, [el('b', {}, 'NOVABOT'), ' activo']),
      el('span', {}, `es147`)
    ]);

    const resizeHandle = el('div', { class: 'nb-resize', html: ICON.resize, title: 'Arrastra para redimensionar' });

    panel = el('div', { id: 'novabot-panel', class: 'nb-interactive' }, [headerEl, tabsEl, bodyEl, footer, resizeHandle]);

    root.appendChild(fab);
    root.appendChild(panel);
    document.body.appendChild(root);

    buildTabs();
    renderBody();
    applyPanelPosition();
    applyPanelSize();
    applyFabPosition();
    applyOpenState();

    makeDraggable(headerEl, panel, {
      onDragEnd: (pos) => { state.pos = pos; saveState(); }
    });
    makeDraggable(fab, fab, {
      onDragEnd: (pos) => { state.fabPos = pos; saveState(); },
      onClick: () => setOpen(true)
    });
    makeResizable(resizeHandle, panel, {
      onResize: (size) => { state.size = size; saveState(); }
    });
  }

  /* ---------------------------------------------------------------------------------
     6) INTERACCIÓN — abrir/cerrar, minimizar, arrastrar
  --------------------------------------------------------------------------------- */
  function setOpen(open) {
    state.open = open;
    saveState();
    applyOpenState();
  }

  function applyOpenState() {
    if (state.open) {
      panel.classList.remove('nb-hidden');
      requestAnimationFrame(() => panel.classList.add('nb-visible'));
      fab.classList.add('nb-hidden');
    } else {
      panel.classList.remove('nb-visible');
      panel.classList.add('nb-hidden');
      fab.classList.remove('nb-hidden');
    }
  }

  function applyPanelPosition() {
    const defaultRight = 22, defaultBottom = 88;
    if (state.pos) {
      panel.style.left = `${state.pos.x}px`;
      panel.style.top = `${state.pos.y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    } else {
      panel.style.right = `${defaultRight}px`;
      panel.style.bottom = `${defaultBottom}px`;
      panel.style.left = 'auto';
      panel.style.top = 'auto';
    }
  }

  function applyFabPosition() {
    const defaultRight = 22, defaultBottom = 22;
    if (state.fabPos) {
      fab.style.left = `${state.fabPos.x}px`;
      fab.style.top = `${state.fabPos.y}px`;
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    } else {
      fab.style.right = `${defaultRight}px`;
      fab.style.bottom = `${defaultBottom}px`;
      fab.style.left = 'auto';
      fab.style.top = 'auto';
    }
  }

  function applyPanelSize() {
    if (state.size) {
      panel.style.width = `${state.size.w}px`;
      panel.style.height = `${state.size.h}px`;
      panel.style.maxHeight = 'none';
    }
  }

  /**
   * Redimensiona `target` arrastrando desde `handle` (esquina inferior-derecha).
   * Crece hacia abajo/derecha sin mover la esquina superior-izquierda, y respeta
   * los límites de la ventana. `onResize` recibe el tamaño final para persistirlo.
   */
  function makeResizable(handle, target, { minWidth = 300, minHeight = 220, onResize } = {}) {
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0, left = 0, top = 0;

    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      const rect = target.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      left = rect.left; top = rect.top;
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const maxW = window.innerWidth - left - 8;
      const maxH = window.innerHeight - top - 8;
      const w = clamp(startW + dx, minWidth, Math.max(minWidth, maxW));
      const h = clamp(startH + dy, minHeight, Math.max(minHeight, maxH));
      target.style.width = `${w}px`;
      target.style.height = `${h}px`;
      target.style.maxHeight = 'none';
    });

    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      const rect = target.getBoundingClientRect();
      onResize?.({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
  }

  /**
   * Arrastre genérico para `target` agarrando por `handle` (pueden ser el mismo
   * elemento, como en el FAB). Distingue clic de arrastre con un pequeño umbral:
   * si el puntero no se mueve más de THRESHOLD px, se considera un clic y se
   * llama a onClick; si se mueve más, es un arrastre y se llama a onDragEnd con
   * la posición final para persistirla.
   */
  function makeDraggable(handle, target, { onDragEnd, onClick, boundsPadding = 4 } = {}) {
    let dragging = false, dragged = false, startX = 0, startY = 0, originX = 0, originY = 0;
    const THRESHOLD = 4;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.nb-icon-btn')) return;
      dragging = true;
      dragged = false;
      const rect = target.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      originX = rect.left; originY = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragged && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) dragged = true;
      if (!dragged) return;
      const maxX = window.innerWidth - target.offsetWidth - boundsPadding;
      const maxY = window.innerHeight - target.offsetHeight - boundsPadding;
      const x = clamp(originX + dx, boundsPadding, Math.max(boundsPadding, maxX));
      const y = clamp(originY + dy, boundsPadding, Math.max(boundsPadding, maxY));
      target.style.left = `${x}px`;
      target.style.top = `${y}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (dragged) {
        const rect = target.getBoundingClientRect();
        onDragEnd?.({ x: Math.round(rect.left), y: Math.round(rect.top) });
      } else {
        onClick?.();
      }
    });
  }

  /* ---------------------------------------------------------------------------------
     7) INTEGRACIÓN LIGERA — nombre de la ciudad activa, si el cliente ya cargó
  --------------------------------------------------------------------------------- */
  function currentTownName() {
    try {
      const id = UW.Game?.townId;
      const town = id && UW.ITowns?.getTown ? UW.ITowns.getTown(id) : null;
      return town?.name || UW.Game?.town_name || null;
    } catch { return null; }
  }

  // Al cambiar de ciudad, la pestaña Construcción se redibuja con la nueva.
  let lastTownId = null;
  function onTownMaybeChanged() {
    const id = +UW.Game?.townId || null;
    if (id === lastTownId) return;
    lastTownId = id;
    if (state.activeTab === 'construccion' && bodyEl) renderBody();
  }

  function updateCityLabel() {
    if (!footerCityEl) return;
    const name = currentTownName();
    footerCityEl.textContent = name || 'esperando al juego…';
  }

  /* ---------------------------------------------------------------------------------
     8) GRANJAS — recolección automática de aldeas (farm towns)
     -----------------------------------------------------------------------------
     Comprobado el 22/09/2026 leyendo el panel nativo "Aldeas" del propio juego
     (Network tab + atributos data-* del DOM, sin más que lecturas):

       GET  /game/farm_town_overviews?action=get_farm_towns_for_town
            json: { town_id, current_town_id, island_x, island_y,
                     booty_researched, trade_office, diplomacy_researched, nl_init:true }
            → aldeas de esa ciudad y su estado.

       POST /game/farm_town_overviews?action=claim_loads
            json: { farm_town_ids:[...], time_option:<segundos>, claim_factor:"normal",
                     current_town_id, town_id, nl_init:true }
            → recolecta de golpe las aldeas indicadas, con el tiempo elegido.

     Confirmado el 22/09/2026 contra el dump real de GameData del propio juego
     (GameData.farm_town_time_values y farm_town.claim_resource_cooldowns_normal/
     _booty): SIN investigar Lealtad de los aldeanos los 4 tiempos son
     [300,1200,5400,14400] (5m·20m·1h30·4h, el set "normal", más rápido), y CON
     Lealtad investigada son [600,2400,10800,28800] (10m·40m·3h·8h, el set
     "booty" — investigarla da +115% de recursos pero DOBLA los tiempos de
     espera). "tier" (0-3) es la posición dentro del set que le toque a cada
     ciudad, así el mismo ajuste vale tenga o no la investigación: 0 = la más
     rápida, 3 = la más lenta. Las etiquetas de los botones se quedan fijas en
     "10 min/40 min/3 horas/8 horas" (los valores del set con Lealtad, que es
     el habitual en ciudades desarrolladas); si la ciudad no la tiene investigada
     se usa automáticamente el equivalente rápido sin tocar la etiqueta.

     Enumeración de aldeas: la respuesta de get_farm_towns_for_town no trae
     farm_town_list de forma fiable (comprobado en pruebas), así que la fuente
     principal es leer del DOM los tiles del mapa que el propio juego ya
     renderiza — [id^="farm_town_"] con data-id y data-town_id — sin necesidad
     de pedir nada al servidor ni pulsar nada. Como respaldo, si el DOM no tiene
     nada útil, se intenta igualmente el endpoint AJAX por si el formato cambia.
  --------------------------------------------------------------------------------- */
  const FARM_TIME_SETS = {
    normal: [300, 1200, 5400, 14400],     // 5m  · 20m · 1h30 · 4h (sin Lealtad)
    booty:  [600, 2400, 10800, 28800]     // 10m · 40m · 3h · 8h  (con Lealtad, +115% recursos)
  };

  const farmRuntime = {
    timer: null,
    running: false,
    nextTownAt: new Map(),  // townId -> epoch ms en que se puede volver a intentar
    log: []                 // {at, text, kind}
  };

  function gpGet(controller, action, json) {
    return new Promise((resolve, reject) => {
      const fn = UW.gpAjax?.ajaxGet;
      if (typeof fn !== 'function') { reject(new Error('gpAjax.ajaxGet no disponible.')); return; }
      try {
        fn.call(UW.gpAjax, controller, action, json, false, {
          success: (...a) => resolve(a[1] ?? a[0] ?? null),
          error: (...a) => reject(new Error(a.find((x) => typeof x === 'string' && x.trim()) || 'Error del juego.'))
        });
      } catch (e) { reject(e); }
    });
  }

  function gpPost(controller, action, json) {
    return new Promise((resolve, reject) => {
      const fn = UW.gpAjax?.ajaxPost;
      if (typeof fn !== 'function') { reject(new Error('gpAjax.ajaxPost no disponible.')); return; }
      try {
        fn.call(UW.gpAjax, controller, action, json, false, {
          success: (...a) => resolve(a[1] ?? a[0] ?? null),
          error: (...a) => reject(new Error(a.find((x) => typeof x === 'string' && x.trim()) || 'Error del juego.'))
        });
      } catch (e) { reject(e); }
    });
  }

  function allTownIds() {
    try { return Object.values(UW.ITowns?.towns || {}).map((t) => +t.id).filter(Boolean); }
    catch { return []; }
  }

  function farmTownName(id) {
    try { return UW.ITowns?.getTown?.(id)?.name || `Ciudad ${id}`; } catch { return `Ciudad ${id}`; }
  }

  // town.toJSON()/attributes vienen VACÍOS para ciudades que no son la activa
  // (comprobado en vivo, 22/09/2026) — hay que usar los getters propios del
  // modelo, que sí funcionan para cualquier ciudad cargada en ITowns.
  function farmTownData(townId) {
    const t = UW.ITowns?.getTown?.(townId);
    if (!t) return {};
    let booty = false;
    try { booty = !!t.getResearches?.()?.get?.('booty'); } catch {}
    let x, y;
    try { x = t.getIslandCoordinateX?.(); y = t.getIslandCoordinateY?.(); } catch {}
    return { island_x: x, island_y: y, booty_researched: booty ? 1 : 0 };
  }

  function townResources(townId) {
    const t = UW.ITowns?.getTown?.(townId);
    let r = {};
    try { r = t?.getCurrentResources?.() || t?.resources?.() || {}; } catch {}
    return { wood: +r.wood || 0, stone: +r.stone || 0, iron: +r.iron || 0 };
  }

  function townStorage(townId) {
    const t = UW.ITowns?.getTown?.(townId);
    const tries = [() => t?.getStorage?.(), () => t?.getStorageCapacity?.(), () => t?.getCurrentResources?.()?.storage];
    for (const f of tries) {
      try { const v = f(); if (Number.isFinite(+v) && +v > 0) return +v; } catch {}
    }
    return null;
  }

  // true si madera, piedra Y plata han llegado todas al % configurado (si a alguna
  // le falta, se sigue recolectando esa ciudad con normalidad).
  function isTownStorageAtThreshold(townId) {
    const cfg = state.granjas;
    const pct = clamp(cfg.stopMode === 'manual' ? pos(cfg.stopManual, 90) : cfg.stopPreset, 1, 100);
    const cap = townStorage(townId);
    if (!cap) return false; // si no sabemos el almacén, no bloqueamos por seguridad
    const limit = cap * (pct / 100);
    const res = townResources(townId);
    return res.wood >= limit && res.stone >= limit && res.iron >= limit;
  }

  function townFarmTimeSet(townId) {
    const d = farmTownData(townId);
    const booty = !!d.booty_researched;
    return booty ? FARM_TIME_SETS.booty : FARM_TIME_SETS.normal;
  }

  /* -----------------------------------------------------------------------
     Enumeración de aldeas — confirmado leyendo el DOM real del panel nativo
     "Aldeas" (22/09/2026): cada fila es <li class="... farm_town_el_<id> ...">
     dentro de #farm_town_list, una por aldea PENDIENTE de recolectar (cuando
     no queda ninguna, el html trae "farm_list_empty" / el mensaje "Todas las
     granjas disponibles seleccionadas").

     get_farm_towns_from_multiple_towns (json: town_ids:[todas], town_id:<ancla>)
     devuelve el mismo tipo de "html", pero solo para la ciudad ancla — no hay
     forma confirmada de separar por ciudad ahí dentro. Así que por fiabilidad
     se pide get_farm_towns_for_town CIUDAD A CIUDAD (una llamada por ciudad,
     con el propio townId como current_town_id) y se parsea su html con el
     mismo patrón farm_town_el_<id>. Se cachea por ciudad FARM_VILLAGES_TTL_MS
     para no repetirlo en cada vuelta del bucle.
  ----------------------------------------------------------------------- */
  const FARM_VILLAGES_TTL_MS = 0; // sin caché: cada ciclo pide el estado real
  farmRuntime.villagesByTown = new Map();   // townId -> number[]
  farmRuntime.villagesFetchedAt = new Map(); // townId -> epoch ms

  // Parsea el html del panel de Aldeas y saca los ids de aldea pendientes
  // (clase farm_town_el_<id> en cada <li> de #farm_town_list).
  function parseFarmHtml(html) {
    if (!html || typeof html !== 'string') return [];
    if (html.includes('farm_list_empty')) return []; // nada pendiente ahora mismo
    return [...html.matchAll(/farm_town_el_(\d+)/g)].map((m) => +m[1]);
  }

  async function fetchFarmTownIds(townId) {
    const last = farmRuntime.villagesFetchedAt.get(townId) || 0;
    if (Date.now() - last < FARM_VILLAGES_TTL_MS) return farmRuntime.villagesByTown.get(townId) || [];

    const d = farmTownData(townId);
    const res = await gpGet('farm_town_overviews', 'get_farm_towns_for_town', {
      town_id: townId,
      current_town_id: townId,
      island_x: d.island_x, island_y: d.island_y,
      booty_researched: d.booty_researched ?? 0,
      trade_office: d.trade_office ?? 0,
      diplomacy_researched: d.diplomacy_researched ?? '',
      nl_init: true
    });
    const ids = parseFarmHtml(res?.html);
    farmRuntime.villagesByTown.set(townId, ids);
    farmRuntime.villagesFetchedAt.set(townId, Date.now());
    return ids;
  }

  async function collectTown(townId) {
    const seconds = townFarmTimeSet(townId)[clamp(state.granjas.tier, 0, 3)];
    const ids = await fetchFarmTownIds(townId);
    // Nada listo (en espera): reintenta en 2 min en vez de esperar el ciclo entero.
    if (!ids.length) { farmLog(`${farmTownName(townId)}: sin aldeas listas.`, 'muted'); return 0; }
    await gpPost('farm_town_overviews', 'claim_loads', {
      farm_town_ids: ids,
      time_option: seconds,
      claim_factor: 'normal',
      current_town_id: townId,
      town_id: townId,
      nl_init: true
    });
    farmLog(`${farmTownName(townId)}: recolectadas ${ids.length} aldeas (${Math.round(seconds / 60)} min).`, 'ok');
    return seconds;
  }

  // Las aldeas son de la ISLA, no de la ciudad: si tienes varias ciudades en la
  // misma isla, solo una puede recoger por ciclo (la otra da "Error del juego").
  // Agrupamos por isla y en cada una recoge la ciudad con el almacén más vacío.
  function townFill(townId) {
    const cap = townStorage(townId);
    if (!cap) return 0;
    const r = townResources(townId);
    return Math.max(r.wood, r.stone, r.iron) / cap;
  }

  function townsByIsland() {
    const groups = new Map();
    for (const id of allTownIds()) {
      const d = farmTownData(id);
      const key = `${d.island_x}_${d.island_y}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    return groups;
  }

  // Un ciclo = recoger TODAS las islas seguidas (sin esperas largas). El retraso
  // aleatorio configurado se suma al tiempo de recolección para fijar cuándo
  // empieza el siguiente ciclo: próximo = ahora + tiempo elegido + aleatorio.
  farmRuntime.nextCycleAt = 0;

  function randomDelayMs() {
    const { minDelayMs, maxDelayMs } = state.granjas;
    const lo = Math.min(minDelayMs, maxDelayMs), hi = Math.max(minDelayMs, maxDelayMs);
    return lo + Math.random() * Math.max(0, hi - lo);
  }

  // Islas que fallaron (aldeas aún en espera por una recogida anterior): se
  // reintentan solas cada 1 min hasta que entren, sin esperar al ciclo completo.
  farmRuntime.retryIslands = new Set();
  farmRuntime.retryAt = 0;

  async function collectIsland(towns) {
    const candidates = towns.filter((id) => !isTownStorageAtThreshold(id))
      .sort((a, b) => townFill(a) - townFill(b));
    if (!candidates.length) {
      farmLog(`${towns.map(farmTownName).join(', ')}: almacén lleno, se salta.`, 'muted');
      return null; // lleno: no se reintenta hasta el próximo ciclo
    }
    return collectTown(candidates[0]);
  }

  /* Recogida de TODAS las ciudades en una sola petición — capturada del propio
     juego al pulsar "Seleccionar todas" + "Recoger" (22/09/2026):
       POST farm_town_overviews?action=claim_loads_multiple
       json: { towns:[ids], time_option_base:<s sin Lealtad>, time_option_booty:<s con Lealtad>,
               claim_factor:"normal", town_id, nl_init:true }
     Se manda una ciudad por isla (la de almacén más vacío) y se excluyen las
     que ya llegaron al % de almacén configurado. */
  function pickTownsForClaim() {
    const towns = [], full = [];
    for (const [, group] of townsByIsland()) {
      const ok = group.filter((id) => !isTownStorageAtThreshold(id))
        .sort((a, b) => townFill(a) - townFill(b));
      if (ok.length) towns.push(ok[0]); else full.push(...group);
    }
    return { towns, full };
  }

  async function farmTick() {
    if (!state.granjas.enabled || Date.now() < farmRuntime.nextCycleAt) return;
    const tier = clamp(state.granjas.tier, 0, 3);
    const base = FARM_TIME_SETS.normal[tier], booty = FARM_TIME_SETS.booty[tier];
    const { towns, full } = pickTownsForClaim();
    if (full.length) farmLog(`Almacén lleno, se saltan: ${full.map(farmTownName).join(', ')}.`, 'muted');
    if (!towns.length) {
      farmRuntime.nextCycleAt = Date.now() + 5 * 60000;
      farmLog('Todas las ciudades con almacén lleno. Reviso en 5 min.', 'muted');
      return;
    }
    try {
      await gpPost('farm_town_overviews', 'claim_loads_multiple', {
        towns,
        time_option_base: base,
        time_option_booty: booty,
        claim_factor: 'normal',
        town_id: UW.Game?.townId || towns[0],
        nl_init: true
      });
      const anyBooty = towns.some((id) => farmTownData(id).booty_researched);
      const seconds = anyBooty ? booty : base;
      farmRuntime.nextCycleAt = Date.now() + seconds * 1000 + randomDelayMs();
      farmLog(`Recogidas ${towns.length} ciudades de una vez (${Math.round(seconds / 60)} min). Próximo a las ${new Date(farmRuntime.nextCycleAt).toLocaleTimeString('es-ES')}.`, 'ok');
    } catch (e) {
      farmRuntime.nextCycleAt = Date.now() + 60000;
      farmLog(`No se pudo recoger (${e.message}). Reintento en 1 min.`, 'error');
    }
  }

  function startFarmEngine() {
    if (farmRuntime.timer) return;
    // Revisa cada 5s qué ciudades ya cumplieron su espera; el retraso aleatorio
    // configurable se aplica DENTRO de farmTick, entre ciudad y ciudad.
    farmRuntime.timer = setInterval(() => {
      if (!state.granjas.enabled || farmRuntime.running) return;
      farmRuntime.running = true;
      farmTick()
        .catch((e) => farmLog(`Error en el ciclo: ${e.message}`, 'error'))
        .finally(() => { farmRuntime.running = false; });
    }, 5000);
    setInterval(updateCountdown, 1000);
  }

  // Cuenta atrás hasta el próximo ciclo (en la pestaña Granjas y en Inicio).
  function updateCountdown() {
    let text;
    if (!state.granjas.enabled) text = 'desactivado';
    else if (farmRuntime.running) text = 'recolectando…';
    else {
      const ms = (farmRuntime.nextCycleAt || 0) - Date.now();
      if (ms <= 0) text = 'ahora';
      else {
        const s = Math.ceil(ms / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        text = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
      }
    }
    for (const n of $$('[data-nb-countdown]')) n.textContent = text;
    for (const n of $$('[data-nb-until]')) n.textContent = formatLeft(+n.dataset.nbUntil);
  }

  function farmLog(text, kind = 'info') {
    farmRuntime.log.unshift({ at: Date.now(), text, kind });
    farmRuntime.log = farmRuntime.log.slice(0, 30);
    renderFarmLog();
  }

  function renderFarmLog() {
    if (!farmLogEl) return;
    farmLogEl.innerHTML = '';
    if (!farmRuntime.log.length) {
      farmLogEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin actividad todavía.'));
      return;
    }
    for (const entry of farmRuntime.log) {
      const time = new Date(entry.at).toLocaleTimeString('es-ES');
      farmLogEl.appendChild(el('div', { class: `nb-log-item nb-log-${entry.kind}` }, `${time} · ${entry.text}`));
    }
  }

  function renderGranjasTab() {
    const cfg = state.granjas;

    const enableSwitch = el('div', { class: `nb-switch${cfg.enabled ? ' on' : ''}` });
    enableSwitch.addEventListener('click', () => {
      cfg.enabled = !cfg.enabled;
      enableSwitch.classList.toggle('on', cfg.enabled);
      saveState();
      renderBody();
      farmLog(cfg.enabled ? 'Módulo activado — se aplica a todas las ciudades.' : 'Módulo desactivado.', 'info');
      if (cfg.enabled && !farmRuntime.running) {
        farmRuntime.running = true;
        farmTick().catch((e) => farmLog(`Error en el ciclo: ${e.message}`, 'error')).finally(() => { farmRuntime.running = false; });
      }
    });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, [el('b', {}, 'Recolección automática')]),
        enableSwitch
      ]),
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, 'Próxima recolección'),
        el('span', { class: 'nb-row-value', 'data-nb-countdown': '' }, '—')
      ]),
      el('p', { class: 'nb-placeholder' }, 'Se activa o desactiva para todas tus ciudades a la vez.')
    ]));
    updateCountdown();

    const tierRow = el('div', { class: 'nb-btn-group' });
    ['10 min', '40 min', '3 horas', '8 horas'].forEach((label, i) => {
      tierRow.appendChild(el('div', {
        class: `nb-btn${cfg.tier === i ? ' active' : ''}`,
        onclick: () => { cfg.tier = i; saveState(); renderBody(); }
      }, label));
    });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Tiempo de recolección'),
      tierRow,
      el('p', { class: 'nb-placeholder' }, 'Si la ciudad no tiene investigada la Lealtad de los aldeanos, se usa automáticamente el equivalente: 5 min, 20 min, 1h30 u 4 horas.')
    ]));

    const minInput = el('input', { class: 'nb-input', type: 'number', min: '0', step: '5', value: Math.round(cfg.minDelayMs / 1000) });
    minInput.addEventListener('change', () => { cfg.minDelayMs = pos(minInput.value, 30) * 1000; saveState(); });
    const maxInput = el('input', { class: 'nb-input', type: 'number', min: '0', step: '5', value: Math.round(cfg.maxDelayMs / 1000) });
    maxInput.addEventListener('change', () => { cfg.maxDelayMs = pos(maxInput.value, 90) * 1000; saveState(); });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Retraso aleatorio extra entre ciclos (segundos)'),
      el('div', { class: 'nb-field-row' }, [
        el('label', { class: 'nb-field' }, ['Mínimo', minInput]),
        el('label', { class: 'nb-field' }, ['Máximo', maxInput])
      ])
    ]));

    const stopRow = el('div', { class: 'nb-btn-group' });
    [80, 90, 100].forEach((p) => {
      stopRow.appendChild(el('div', {
        class: `nb-btn${cfg.stopMode === 'preset' && cfg.stopPreset === p ? ' active' : ''}`,
        onclick: () => { cfg.stopMode = 'preset'; cfg.stopPreset = p; saveState(); renderBody(); }
      }, `${p}%`));
    });
    const manualInput = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '1', max: '100', value: cfg.stopManual });
    manualInput.addEventListener('change', () => {
      cfg.stopMode = 'manual';
      cfg.stopManual = clamp(pos(manualInput.value, 90), 1, 100);
      saveState();
      renderBody();
    });
    stopRow.appendChild(el('div', { class: `nb-btn nb-btn-manual${cfg.stopMode === 'manual' ? ' active' : ''}` }, [manualInput, '%']));

    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'No recolectar si el almacén llega a'),
      stopRow,
      el('p', { class: 'nb-placeholder' }, 'Se comprueba madera, piedra y plata; si a alguna le falta para llegar, se sigue recolectando igual.')
    ]));

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Actividad'),
      logBox
    ]));
    farmLogEl = logBox;
    renderFarmLog();
  }

  /* ---------------------------------------------------------------------------------
     8b) CONSTRUCCIÓN — objetivos por ciudad, todo por petición (sin cambiar de ciudad)
     -----------------------------------------------------------------------------
     Capturado del propio juego al construir a mano (22/09/2026):
       POST frontend_bridge?action=execute
       json: { model_url:"BuildingOrder", action_name:"buildUp", captcha:null,
               arguments:{ building_id:"barracks" }, town_id, nl_init:true }
     Datos de cada ciudad (niveles, costes, población, requisitos, cola llena):
       MM.getCollections().BuildingBuildData → building_data[id] (existe para las 21).
     gpAjax pone en la URL town_id=Game.townId; para que URL y json apunten a la
     MISMA ciudad, gpPostAs() cambia Game.townId solo durante la llamada
     (síncrona) y lo restaura al momento. No se cambia de ciudad en pantalla.
  --------------------------------------------------------------------------------- */
  const buildRuntime = { timer: null, running: false, log: [], cooldown: new Map() };
  let buildLogEl = null;

  function gpPostAs(townId, controller, action, json) {
    const prev = UW.Game.townId;
    UW.Game.townId = +townId;
    try { return gpPost(controller, action, { ...json, town_id: +townId }); }
    finally { UW.Game.townId = prev; }
  }

  function buildingName(id) {
    const d = UW.GameData?.buildings?.[id];
    return d?.name || id;
  }

  function buildingIds() {
    return Object.keys(UW.GameData?.buildings || {}).filter((id) => id !== 'id')
      .sort((a, b) => buildingName(a).localeCompare(buildingName(b), 'es'));
  }

  function buildDataFor(townId) {
    try {
      const cols = UW.MM.getCollections().BuildingBuildData;
      for (const c of [].concat(cols || [])) {
        for (const m of c?.models || []) if (+m.get('town_id') === +townId) return m.attributes;
      }
    } catch {}
    return null;
  }

  // Nivel "comprometido" = actual + lo que ya está en cola.
  function committedLevel(info) {
    if (!info) return 0;
    return Math.max(+info.level || 0, (+info.next_level || 1) - 1);
  }

  function townBuildCfg(townId) {
    const all = state.construccion.towns;
    if (!all[townId]) all[townId] = { goals: [] };
    return all[townId];
  }

  // Motivo por el que no se puede subir ahora (null = se puede).
  function buildBlockReason(townId, info) {
    if (!info) return 'sin datos';
    if (info.has_max_level) return 'nivel máximo';
    if (info.group_locked) return 'bloqueado';
    if (Array.isArray(info.missing_dependencies) && info.missing_dependencies.length) return 'faltan requisitos';
    if (!info.enough_storage) return 'almacén pequeño';
    if ((+info.population_free || 0) < (+info.population_for || 0)) return 'falta población';
    const cost = info.resources_for || {};
    const r = townResources(townId);
    if (r.wood < (+cost.wood || 0) || r.stone < (+cost.stone || 0) || r.iron < (+cost.iron || 0)) return 'faltan recursos';
    return null;
  }

  function townBuildOrders(townId) {
    try {
      const q = UW.ITowns.getTown(townId)?.buildingOrders?.();
      return (q?.models || []).map((m) => m.attributes);
    } catch { return []; }
  }

  function formatLeft(ts) {
    const s = Math.max(0, Math.round((+ts || 0) - Date.now() / 1000));
    if (!ts) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
  }

  function nextBuildFor(townId) {
    const bd = buildDataFor(townId);
    if (!bd) return { reason: 'sin datos' };
    if (bd.is_building_order_queue_full) return { reason: 'cola llena' };
    for (const g of townBuildCfg(townId).goals) {
      const info = bd.building_data?.[g.id];
      if (!info || committedLevel(info) >= g.target) continue;
      if ((buildRuntime.cooldown.get(`${townId}:${g.id}`) || 0) > Date.now()) continue;
      const reason = buildBlockReason(townId, info);
      if (!reason) return { id: g.id, level: committedLevel(info) + 1 };
      if (state.construccion.strictOrder) return { reason: `${buildingName(g.id)}: ${reason}` };
    }
    return { reason: 'nada pendiente' };
  }

  async function buildTick() {
    if (!state.construccion.enabled) return;
    for (const townId of allTownIds()) {
      if (!state.construccion.enabled) return;
      const next = nextBuildFor(townId);
      if (!next.id) continue;
      try {
        await gpPostAs(townId, 'frontend_bridge', 'execute', {
          model_url: 'BuildingOrder', action_name: 'buildUp', captcha: null,
          arguments: { building_id: next.id }, nl_init: true
        });
        buildLog(`${farmTownName(townId)}: ${buildingName(next.id)} → nivel ${next.level}.`, 'ok');
      } catch (e) {
        buildLog(`${farmTownName(townId)}: ${buildingName(next.id)} — ${e.message}`, 'error');
        buildRuntime.cooldown.set(`${townId}:${next.id}`, Date.now() + 5 * 60000);
      }
      await sleep(800 + Math.random() * 1200);
    }
  }

  function startBuildEngine() {
    if (buildRuntime.timer) return;
    buildRuntime.timer = setInterval(() => {
      if (!state.construccion.enabled || buildRuntime.running) return;
      buildRuntime.running = true;
      buildTick().catch((e) => buildLog(`Error: ${e.message}`, 'error'))
        .finally(() => { buildRuntime.running = false; });
    }, 15000);
  }

  function buildLog(text, kind = 'info') {
    buildRuntime.log.unshift({ at: Date.now(), text, kind });
    buildRuntime.log = buildRuntime.log.slice(0, 30);
    renderBuildLog();
  }

  function renderBuildLog() {
    if (!buildLogEl) return;
    buildLogEl.innerHTML = '';
    if (!buildRuntime.log.length) {
      buildLogEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin actividad todavía.'));
      return;
    }
    for (const e of buildRuntime.log) {
      buildLogEl.appendChild(el('div', { class: `nb-log-item nb-log-${e.kind}` }, `${new Date(e.at).toLocaleTimeString('es-ES')} · ${e.text}`));
    }
  }

  function renderConstruccionTab() {
    const cfg = state.construccion;
    const towns = allTownIds().sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    // Siempre la ciudad en la que estás ahora mismo (como en Inicio).
    const townId = +UW.Game?.townId || towns[0];
    const tcfg = townBuildCfg(townId);
    const bd = buildDataFor(townId);

    // Activar / desactivar
    const sw = el('div', { class: `nb-switch${cfg.enabled ? ' on' : ''}` });
    sw.addEventListener('click', () => {
      cfg.enabled = !cfg.enabled; saveState(); renderBody();
      buildLog(cfg.enabled ? 'Construcción activada.' : 'Construcción desactivada.');
    });
    const strict = el('input', { type: 'checkbox' });
    strict.checked = !!cfg.strictOrder;
    strict.addEventListener('change', () => { cfg.strictOrder = strict.checked; saveState(); });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Construcción automática')]), sw]),
      el('label', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Respetar orden estricto (no saltar al siguiente)'), strict])
    ]));

    const copyBtn = el('div', { class: 'nb-btn', title: 'Copia estos objetivos al resto de ciudades' }, 'Copiar a todas');
    copyBtn.addEventListener('click', () => {
      if (!confirm(`¿Copiar los objetivos de ${farmTownName(townId)} a TODAS las ciudades?`)) return;
      for (const id of towns) if (id !== townId) cfg.towns[id] = { goals: tcfg.goals.map((g) => ({ ...g })) };
      saveState(); buildLog(`Objetivos de ${farmTownName(townId)} copiados a todas.`, 'ok');
    });
    const next = nextBuildFor(townId);
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, 'Ciudad actual'),
        el('span', { class: 'nb-row-value' }, farmTownName(townId))
      ]),
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, 'Siguiente'),
        el('span', { class: 'nb-row-value' }, next.id ? `${buildingName(next.id)} → ${next.level}` : next.reason)
      ]),
      el('div', { class: 'nb-btn-group' }, [copyBtn])
    ]));

    // ---- Cola real del juego (solo lectura) ----
    const orders = townBuildOrders(townId);
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Cola del juego (${orders.length})`),
      orders.length
        ? el('div', { class: 'nb-queue' }, orders.map((o) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, `${buildingName(o.building_type)}${o.tear_down ? ' (derribo)' : ''}`),
            el('span', { class: 'nb-queue-time', 'data-nb-until': o.to_be_completed_at || '' }, formatLeft(o.to_be_completed_at))
          ])))
        : el('p', { class: 'nb-placeholder' }, 'Nada en construcción.')
    ]));

    if (!bd) {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('p', { class: 'nb-placeholder' }, 'Sin datos de edificios para esta ciudad todavía.')]));
    } else {
      const maxOf = (id) => +UW.GameData?.buildings?.[id]?.max_level || 99;
      const setTarget = (id, v) => {
        const i = tcfg.goals.findIndex((g) => g.id === id);
        const cur = committedLevel(bd.building_data?.[id]);
        v = clamp(v, 0, maxOf(id));
        if (v <= cur) { if (i >= 0) tcfg.goals.splice(i, 1); }       // objetivo alcanzado/menor → se quita
        else if (i >= 0) tcfg.goals[i].target = v;
        else tcfg.goals.push({ id, target: v });
        saveState(); renderBody();
      };
      const move = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= tcfg.goals.length) return;
        [tcfg.goals[i], tcfg.goals[j]] = [tcfg.goals[j], tcfg.goals[i]];
        saveState(); renderBody();
      };

      // ---- Objetivos del bot (orden = prioridad) ----
      const goalsBox = el('div', { class: 'nb-goals' });
      tcfg.goals.forEach((g, i) => {
        const info = bd.building_data?.[g.id];
        const cur = committedLevel(info);
        const done = cur >= g.target;
        const reason = done ? null : buildBlockReason(townId, info);
        const isNext = next.id === g.id;
        goalsBox.appendChild(el('div', { class: `nb-goal${isNext ? ' nb-goal-next' : ''}${done ? ' nb-goal-done' : ''}` }, [
          el('span', { class: 'nb-goal-idx' }, String(i + 1)),
          el('div', { class: 'nb-goal-main' }, [
            el('div', { class: 'nb-goal-name' }, buildingName(g.id)),
            el('div', { class: 'nb-goal-sub' }, done ? 'completado' : isNext ? 'siguiente' : (reason || 'en espera'))
          ]),
          el('div', { class: 'nb-stepper' }, [
            el('span', { class: 'nb-goal-cur' }, `${cur} →`),
            el('span', { class: 'nb-mini', title: '−1', onclick: () => setTarget(g.id, g.target - 1) }, '−'),
            el('span', { class: 'nb-goal-target' }, String(g.target)),
            el('span', { class: 'nb-mini', title: '+1', onclick: () => setTarget(g.id, g.target + 1) }, '+')
          ]),
          el('div', { class: 'nb-goal-actions' }, [
            el('span', { class: `nb-mini${i === 0 ? ' nb-mini-off' : ''}`, title: 'Subir prioridad', onclick: () => move(i, -1) }, '▲'),
            el('span', { class: `nb-mini${i === tcfg.goals.length - 1 ? ' nb-mini-off' : ''}`, title: 'Bajar prioridad', onclick: () => move(i, 1) }, '▼'),
            el('span', { class: 'nb-mini nb-mini-danger', title: 'Quitar del bot', onclick: () => { tcfg.goals.splice(i, 1); saveState(); renderBody(); } }, '✕')
          ])
        ]));
      });
      const clearBtn = tcfg.goals.length
        ? el('span', { class: 'nb-btn', onclick: () => { if (confirm('¿Quitar todos los objetivos de esta ciudad?')) { tcfg.goals = []; saveState(); renderBody(); } } }, 'Vaciar')
        : null;
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-head' }, [el('div', { class: 'nb-card-title' }, `Objetivos del bot (${tcfg.goals.length})`), clearBtn]),
        tcfg.goals.length ? goalsBox : el('p', { class: 'nb-placeholder' }, 'Sin objetivos. Añade edificios abajo.')
      ]));

      // ---- Añadir edificios (clic = objetivo nivel actual + 1) ----
      const chips = el('div', { class: 'nb-chips' });
      for (const id of buildingIds()) {
        if (tcfg.goals.some((g) => g.id === id)) continue;
        const info = bd.building_data?.[id];
        const cur = committedLevel(info);
        const atMax = cur >= maxOf(id) || info?.has_max_level;
        chips.appendChild(el('span', {
          class: `nb-chip${atMax ? ' nb-chip-off' : ''}`,
          title: atMax ? 'Nivel máximo' : `Añadir: ${buildingName(id)} → ${cur + 1}`,
          onclick: () => { if (!atMax) setTarget(id, cur + 1); }
        }, [buildingName(id), el('b', {}, String(cur))]));
      }
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Añadir edificio (clic = +1 nivel)'),
        chips
      ]));
    }

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    buildLogEl = logBox;
    renderBuildLog();
  }

  /* ---------------------------------------------------------------------------------
     9) INIT
  --------------------------------------------------------------------------------- */
  function waitFor(cond, timeoutMs = 20000, stepMs = 200) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (cond() || Date.now() - t0 > timeoutMs) return resolve();
        setTimeout(tick, stepMs);
      };
      tick();
    });
  }

  async function init() {
    await waitFor(() => !!document.body);
    buildUI();
    startFarmEngine();
    startBuildEngine();

    // En cuanto el cliente del juego termine de cargar, refresca el nombre de ciudad.
    waitFor(() => !!(UW.Game && UW.ITowns)).then(() => {
      updateCityLabel();
      // El juego dispara este evento (vía jQuery) al cambiar de ciudad — así el
      // nombre se actualiza al instante en vez de esperar al sondeo de abajo.
      try {
        const $j = UW.jQuery || UW.$;
        const evt = UW.GameEvents?.town?.town_switch;
        if ($j && evt) $j(document).on(evt, () => { updateCityLabel(); onTownMaybeChanged(); });
      } catch (e) { console.warn('[NOVABOT] No se pudo enganchar al evento de cambio de ciudad:', e); }
      setInterval(() => { updateCityLabel(); onTownMaybeChanged(); }, 1000); // red de seguridad por si el evento no llega
    });
  }

  init();
})();