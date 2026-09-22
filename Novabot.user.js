// ==UserScript==
// @name         NOVABOT
// @namespace    https://github.com/victoritis/NOVABOT
// @version      0.1.1
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
  const VERSION = '0.1.1';
  const STORAGE_KEY = 'novabot_ui_state_v1';

  // Evita cargar el script dos veces si Tampermonkey lo reinyecta.
  if (UW.__NOVABOT_ACTIVE__) return;
  UW.__NOVABOT_ACTIVE__ = VERSION;

  const TABS = [
    { id: 'inicio',      label: 'Inicio',        icon: 'home',   disabled: false },
    { id: 'construccion', label: 'Construcción', icon: 'build',  disabled: true },
    { id: 'reclutamiento', label: 'Reclutamiento', icon: 'shield', disabled: true },
    { id: 'comercio',    label: 'Comercio',       icon: 'trade',  disabled: true },
    { id: 'ajustes',     label: 'Ajustes',        icon: 'gear',   disabled: true }
  ];

  /* ---------------------------------------------------------------------------------
     2) UTILIDADES
  --------------------------------------------------------------------------------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
      minimized: false,
      activeTab: 'inicio',
      pos: null,        // {x, y} esquina superior-izquierda del panel; null = posición por defecto
      masterEnabled: false
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
    close: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg>'
  };

  /* ---------------------------------------------------------------------------------
     5) DOM — construcción del FAB y del panel
  --------------------------------------------------------------------------------- */
  let root, fab, panel, headerEl, masterSwitch, tabsEl, bodyEl, footerCityEl;

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
          el('span', { class: 'nb-row-label' }, 'Módulos activos'),
          el('span', { class: 'nb-pill' }, '0 / 4')
        ])
      ]));
      footerCityEl = $('#nb-current-town', bodyEl);

      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Próximos pasos'),
        el('p', { class: 'nb-placeholder' },
          'Este es el panel base de NOVABOT. Las pestañas de Construcción, Reclutamiento y Comercio se irán activando a medida que se implementen.')
      ]));

      updateCityLabel();
    } else {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('p', { class: 'nb-placeholder' }, 'Este módulo todavía no está disponible.')
      ]));
    }
  }

  function buildUI() {
    root = el('div', { id: 'novabot-root' });

    fab = el('div', { id: 'novabot-fab', class: 'nb-interactive', html: ICON.logo, title: 'Abrir NOVABOT' });
    fab.addEventListener('click', () => setOpen(true));

    masterSwitch = el('div', { class: `nb-switch${state.masterEnabled ? ' on' : ''}` });
    masterSwitch.addEventListener('click', () => {
      state.masterEnabled = !state.masterEnabled;
      masterSwitch.classList.toggle('on', state.masterEnabled);
      saveState();
    });

    headerEl = el('div', { class: 'nb-header' }, [
      el('div', { class: 'nb-brand' }, [
        el('span', { html: ICON.logo }),
        el('div', { class: 'nb-brand-text' }, [
          el('span', { class: 'nb-brand-title' }, 'NOVABOT'),
          el('span', { class: 'nb-brand-version' }, `v${VERSION}`)
        ])
      ]),
      el('div', { class: 'nb-header-actions' }, [
        el('div', { class: 'nb-icon-btn', html: ICON.minus, title: 'Minimizar', onclick: (e) => { e.stopPropagation(); toggleMinimized(); } }),
        el('div', { class: 'nb-icon-btn', html: ICON.close, title: 'Cerrar', onclick: (e) => { e.stopPropagation(); setOpen(false); } })
      ])
    ]);

    tabsEl = el('div', { class: 'nb-tabs' });
    bodyEl = el('div', { class: 'nb-body' });

    const footer = el('div', { class: 'nb-footer' }, [
      el('span', {}, ['Estado: ', el('b', {}, state.masterEnabled ? 'activado' : 'en pausa')]),
      el('span', {}, `es147`)
    ]);

    const masterRow = el('div', { class: 'nb-master' }, [
      el('div', { class: 'nb-master-label' }, [document.createTextNode('NOVABOT '), el('b', {}, state.masterEnabled ? 'activado' : 'pausado')]),
      masterSwitch
    ]);

    panel = el('div', { id: 'novabot-panel', class: 'nb-interactive' }, [headerEl, masterRow, tabsEl, bodyEl, footer]);

    root.appendChild(fab);
    root.appendChild(panel);
    document.body.appendChild(root);

    buildTabs();
    renderBody();
    applyPanelPosition();
    applyOpenState();
    makeDraggable(headerEl, panel);
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

  function toggleMinimized() {
    state.minimized = !state.minimized;
    panel.classList.toggle('nb-minimized', state.minimized);
    saveState();
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

  function makeDraggable(handle, target) {
    let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.nb-icon-btn')) return;
      dragging = true;
      const rect = target.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      originX = rect.left; originY = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const maxX = window.innerWidth - target.offsetWidth - 4;
      const maxY = window.innerHeight - 40;
      const x = clamp(originX + dx, 4, Math.max(4, maxX));
      const y = clamp(originY + dy, 4, Math.max(4, maxY));
      target.style.left = `${x}px`;
      target.style.top = `${y}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = target.getBoundingClientRect();
      state.pos = { x: Math.round(rect.left), y: Math.round(rect.top) };
      saveState();
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
     8) INIT
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

    // En cuanto el cliente del juego termine de cargar, refresca el nombre de ciudad.
    waitFor(() => !!(UW.Game && UW.ITowns)).then(() => {
      updateCityLabel();
      setInterval(updateCityLabel, 4000);
    });
  }

  init();
})();