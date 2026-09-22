// ==UserScript==
// @name         NOVABOT
// @namespace    https://github.com/victoritis/NOVABOT
// @version      0.2.1
// @description  Panel de control para Grepolis — interfaz propia, sin depender del cliente del juego.
// @author       victoritis
// @match        *://*.grepolis.com/*
// @resource     NOVABOT_CSS https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/victoritis/NOVABOT/main/NOVABOT.user.js
// @downloadURL  https://raw.githubusercontent.com/victoritis/NOVABOT/main/NOVABOT.user.js
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
  const VERSION = '0.2.1';
  const STORAGE_KEY = 'novabot_ui_state_v1';

  // Evita cargar el script dos veces si Tampermonkey lo reinyecta.
  if (UW.__NOVABOT_ACTIVE__) return;
  UW.__NOVABOT_ACTIVE__ = VERSION;

  const TABS = [
    { id: 'inicio',      label: 'Inicio',        icon: 'home',   disabled: false },
    { id: 'granjas',     label: 'Granjas',       icon: 'farm',   disabled: false },
    { id: 'construccion', label: 'Construcción', icon: 'build',  disabled: true },
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
        ])
      ]));
      footerCityEl = $('#nb-current-town', bodyEl);

      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Próximos pasos'),
        el('p', { class: 'nb-placeholder' },
          'Este es el panel base de NOVABOT. Las pestañas de Construcción, Reclutamiento y Comercio se irán activando a medida que se implementen.')
      ]));

      updateCityLabel();
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

     Los 4 tiempos dependen de si la ciudad tiene investigada la Lealtad de los
     aldeanos (visto en las clases CSS del propio juego: fto_600/2400/10800/28800
     sin investigar, fto_300/1200/5400/14400 investigada — cada tiempo con Lealtad
     es la mitad del correspondiente sin ella). "tier" (0-3) es la posición dentro
     del set que le toque a cada ciudad, así el mismo ajuste vale tenga o no la
     investigación: 0 = la más rápida, 3 = la más lenta.

     OJO: los nombres de campo de la respuesta de get_farm_towns_for_town son mi
     mejor estimación a partir del HTML — no los verifiqué contra el JSON real para
     no gastar recolecciones de prueba. Actívalo y mira la consola: si algo no
     encaja, un console.warn dirá qué campo revisar.
  --------------------------------------------------------------------------------- */
  const FARM_TIME_SETS = {
    default: [600, 2400, 10800, 28800],   // 10m · 40m · 3h · 8h  (sin Lealtad)
    loyalty: [300, 1200, 5400, 14400]     // 5m  · 20m · 1h30 · 4h (con Lealtad)
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

  function farmTownData(townId) {
    const t = UW.ITowns?.getTown?.(townId);
    try { return t?.toJSON?.() || t?.attributes || {}; } catch { return {}; }
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
    const loyalty = !!(d.booty_researched || d.diplomacy_researched || d.loyalty_researched);
    return loyalty ? FARM_TIME_SETS.loyalty : FARM_TIME_SETS.default;
  }

  async function fetchFarmTownIds(townId) {
    const d = farmTownData(townId);
    const payload = {
      town_id: townId,
      current_town_id: townId,
      island_x: d.island_x, island_y: d.island_y,
      booty_researched: d.booty_researched ?? 0,
      trade_office: d.trade_office ?? 0,
      diplomacy_researched: d.diplomacy_researched ?? '',
      nl_init: true
    };
    const res = await gpGet('farm_town_overviews', 'get_farm_towns_for_town', payload);
    const list = res?.farm_towns || res?.villages || res?.data?.farm_towns || (Array.isArray(res) ? res : []);
    if (!Array.isArray(list)) {
      farmLog(`${farmTownName(townId)}: respuesta con formato inesperado — mira la consola.`, 'error');
      console.warn('[NOVABOT][granjas] get_farm_towns_for_town devolvió algo que no reconozco:', res);
      return [];
    }
    return list.map((v) => v.id ?? v.farm_town_id ?? v.town_id).filter(Boolean);
  }

  async function collectTown(townId) {
    const seconds = townFarmTimeSet(townId)[clamp(state.granjas.tier, 0, 3)];
    const ids = await fetchFarmTownIds(townId);
    if (!ids.length) { farmLog(`${farmTownName(townId)}: sin aldeas que recolectar por ahora.`, 'muted'); return seconds; }
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

  async function farmTick() {
    if (!state.granjas.enabled) return;
    for (const townId of allTownIds()) {
      if (!state.granjas.enabled) break; // se pudo desactivar a media vuelta
      const now = Date.now();
      const nextAt = farmRuntime.nextTownAt.get(townId) || 0;
      if (now < nextAt) continue;

      if (isTownStorageAtThreshold(townId)) {
        farmLog(`${farmTownName(townId)}: almacén lleno, se salta esta vuelta.`, 'muted');
        farmRuntime.nextTownAt.set(townId, now + 5 * 60000);
        continue;
      }

      try {
        const seconds = await collectTown(townId);
        farmRuntime.nextTownAt.set(townId, Date.now() + seconds * 1000);
      } catch (e) {
        farmLog(`${farmTownName(townId)}: error — ${e.message}`, 'error');
        farmRuntime.nextTownAt.set(townId, Date.now() + 60000);
      }

      const { minDelayMs, maxDelayMs } = state.granjas;
      const lo = Math.min(minDelayMs, maxDelayMs), hi = Math.max(minDelayMs, maxDelayMs);
      await sleep(lo + Math.random() * Math.max(0, hi - lo));
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
    });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, [el('b', {}, 'Recolección automática')]),
        enableSwitch
      ]),
      el('p', { class: 'nb-placeholder' }, 'Se activa o desactiva para todas tus ciudades a la vez.')
    ]));

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
      el('div', { class: 'nb-card-title' }, 'Retraso aleatorio entre ciudades (segundos)'),
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

    // En cuanto el cliente del juego termine de cargar, refresca el nombre de ciudad.
    waitFor(() => !!(UW.Game && UW.ITowns)).then(() => {
      updateCityLabel();
      // El juego dispara este evento (vía jQuery) al cambiar de ciudad — así el
      // nombre se actualiza al instante en vez de esperar al sondeo de abajo.
      try {
        const $j = UW.jQuery || UW.$;
        const evt = UW.GameEvents?.town?.town_switch;
        if ($j && evt) $j(document).on(evt, updateCityLabel);
      } catch (e) { console.warn('[NOVABOT] No se pudo enganchar al evento de cambio de ciudad:', e); }
      setInterval(updateCityLabel, 1000); // red de seguridad por si el evento no llega
    });
  }

  init();
})();