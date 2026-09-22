// ==UserScript==
// @name         NOVABOT
// @namespace    https://github.com/victoritis/NOVABOT
// @version      1.0.0
// @description  Panel de control para Grepolis — interfaz propia, sin depender del cliente del juego.
// @author       victoritis
// @match        *://*.grepolis.com/*
// @resource     NOVABOT_CSS https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
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
  const VERSION = '1.0.0';
  const STORAGE_KEY = 'novabot_ui_state_v1';

  // Evita cargar el script dos veces si Tampermonkey lo reinyecta.
  if (UW.__NOVABOT_ACTIVE__) return;
  UW.__NOVABOT_ACTIVE__ = VERSION;

  const TABS = [
    { id: 'inicio',      label: 'Inicio',        icon: 'home',   disabled: false },
    { id: 'granjas',     label: 'Granjas',       icon: 'farm',   disabled: false },
    { id: 'construccion', label: 'Construcción', icon: 'build',  disabled: false },
    { id: 'reclutamiento', label: 'Reclutamiento', icon: 'shield', disabled: false },
    { id: 'comercio',    label: 'Comercio',       icon: 'trade',  disabled: false },
    { id: 'ataques',     label: 'Ataques',        icon: 'sword',  disabled: false }
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
      },
      ataques: {
        correctionMs: 0       // corrección automática del disparo (se ajusta sola con la llegada real)
      },
      reclutamiento: {
        enabled: true,
        fillPct: 95,          // tamaño del lote = % del almacén
        towns: {}             // townId -> { goals: [{id, target}] }
      },
      comercio: {
        enabled: true,        // general, no por ciudad
        forBuild: true,       // abastecer la construcción
        minShipment: 500,
        storageMarginPct: 5,  // hueco que se deja libre en el almacén destino
        keepMin: 0,           // mínimo que se deja siempre en la ciudad donante
        maxPerTick: 5,
        forRecruit: true,     // abastecer los lotes de reclutamiento
        agingWeight: 2,       // cuánto sube la prioridad por cada segundo esperando (anti-olvido de lejanas)
        secPerUnit: 0         // se calibra solo con los envíos reales
      }
    };
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        const def = defaultState();
        const out = { ...def, ...raw };
        for (const k of ['granjas', 'construccion', 'comercio', 'reclutamiento', 'ataques']) out[k] = { ...def[k], ...(raw[k] || {}) };
        return out;
      }
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
  // 1º intenta bajar novabot.css FRESCO de GitHub en cada carga (sin caché de
  // Tampermonkey); si falla, usa la copia de @resource. Así basta con subir el
  // CSS a GitHub para verlo, sin tocar la versión del script.
  const CSS_URL = 'https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css';
  // Un único <style id="novabot-css"> propio: cada carga reemplaza su contenido.
  function applyCss(css) {
    let st = document.getElementById('novabot-css');
    if (!st) {
      st = document.createElement('style');
      st.id = 'novabot-css';
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = css;
  }

  function loadStyles() {
    let ok = false;
    try {
      const css = typeof GM_getResourceText === 'function' ? GM_getResourceText('NOVABOT_CSS') : null;
      if (css) { applyCss(css); ok = true; }
    } catch (e) { console.warn('[NOVABOT] @resource CSS no disponible:', e); }

    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${CSS_URL}?t=${Date.now()}`,
        onload: (r) => {
          if (r.status === 200 && r.responseText) {
            applyCss(r.responseText);
            const v = document.querySelector('.nb-brand-version');
            if (v) v.textContent = `v${VERSION} · css ${cssVersion()}`;
          } else console.warn('[NOVABOT] No se pudo bajar novabot.css fresco:', r.status);
        },
        onerror: (e) => console.warn('[NOVABOT] Error bajando novabot.css:', e)
      });
      ok = true;
    }
    return ok;
  }

  const stylesLoaded = loadStyles();

  // Versión declarada dentro de novabot.css (--nb-css-version). Si no aparece,
  // el CSS cargado es anterior a este control (o no se cargó).
  function cssVersion() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--nb-css-version').trim().replace(/["']/g, '');
    return v || '¿antiguo?';
  }

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
    sword: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg>',
    farm: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M12 9c0-4 3-7 7-7 0 4-3 7-7 7Z"/><path d="M12 13c0-4-3-7-7-7 0 4 3 7 7 7Z"/></svg>'
  };

  /* ---------------------------------------------------------------------------------
     5) DOM — construcción del FAB y del panel
  --------------------------------------------------------------------------------- */
  let root, fab, panel, headerEl, tabsEl, bodyEl, footerCityEl, farmLogEl;

  // Interruptor reutilizable (sustituye a los checkbox nativos, que se ven mal
  // sobre el fondo oscuro).
  function switchEl(on, onToggle, small = true) {
    const sw = el('div', { class: `nb-switch${small ? ' nb-switch-sm' : ''}${on ? ' on' : ''}`, role: 'switch', tabindex: '0' });
    const flip = () => { const v = !sw.classList.contains('on'); sw.classList.toggle('on', v); onToggle(v); };
    sw.addEventListener('click', flip);
    sw.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    return sw;
  }
  function optionRow(label, hint, on, onToggle) {
    return el('div', { class: 'nb-row nb-option' }, [
      el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, label), hint ? el('span', { class: 'nb-option-hint' }, hint) : null]),
      switchEl(on, onToggle)
    ]);
  }

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
      renderInicioTab();
    } else if (state.activeTab === 'ataques') {
      renderAtaquesTab();
    } else if (state.activeTab === 'reclutamiento') {
      renderReclutamientoTab();
    } else if (state.activeTab === 'comercio') {
      renderComercioTab();
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

  // Resumen: una tarjeta por módulo con su estado, interruptor y dato clave.
  // Clic en la tarjeta = ir a la pestaña.
  function renderInicioTab() {
    const townId = +UW.Game?.townId;
    bodyEl.appendChild(el('div', { class: 'nb-card nb-hero' }, [
      el('div', { class: 'nb-hero-label' }, 'Ciudad actual'),
      el('div', { class: 'nb-hero-value', id: 'nb-current-town' }, '—')
    ]));
    footerCityEl = $('#nb-current-town', bodyEl);
    updateCityLabel();

    let metrics = {};
    try {
      const goalsBuild = allTownIds().reduce((n, id) => n + townBuildCfg(id).goals.length, 0);
      const goalsRec = allTownIds().filter((id) => townRecruitCfg(id).goals.length).length;
      const transit = transitRows().length;
      const needs = (() => { try { return planTrades().needs.length; } catch { return 0; } })();
      metrics = {
        granjas: el('span', { 'data-nb-countdown': '' }, '—'),
        construccion: `${goalsBuild} objetivos · ${buildQueueLimit()} huecos de cola`,
        reclutamiento: `${goalsRec} ciudades con tropas pedidas`,
        comercio: `${transit} en camino · ${needs} ciudades esperando`
      };
    } catch {}
    const mod = (tab, title, cfgObj, hint) => {
      const tile = el('div', { class: `nb-tile${cfgObj.enabled ? ' on' : ''}` }, [
        el('div', { class: 'nb-tile-head' }, [
          el('span', { class: 'nb-tile-title' }, title),
          switchEl(!!cfgObj.enabled, (v) => { cfgObj.enabled = v; saveState(); renderBody(); })
        ]),
        el('div', { class: 'nb-tile-metric' }, [metrics[tab] || '']),
        el('div', { class: 'nb-tile-hint' }, hint)
      ]);
      tile.addEventListener('click', (e) => {
        if (e.target.closest('.nb-switch')) return;
        state.activeTab = tab; saveState(); buildTabs(); renderBody();
      });
      return tile;
    };
    bodyEl.appendChild(el('div', { class: 'nb-tiles' }, [
      mod('granjas', 'Granjas', state.granjas, 'Recolecta todas las aldeas'),
      mod('construccion', 'Construcción', state.construccion, 'Sube edificios por objetivos'),
      mod('reclutamiento', 'Reclutamiento', state.reclutamiento, 'Lotes que llenan el almacén'),
      mod('comercio', 'Comercio', state.comercio, 'Reparte recursos entre ciudades'),
      (() => {
        const nx = nextPending();
        const n = atk.queue.filter((a) => a.status === 'pending').length;
        const tile = el('div', { class: `nb-tile${n ? ' on' : ''}` }, [
          el('div', { class: 'nb-tile-head' }, [el('span', { class: 'nb-tile-title' }, 'Ataques'), el('span', { class: 'nb-pill' + (n ? '' : ' nb-pill-off') }, `${n} programados`)]),
          el('div', { class: 'nb-tile-metric' }, nx ? [el('span', { 'data-atk-at': nx.executeAt }, ''), ` · ${nx.targetName}`] : ['—']),
          el('div', { class: 'nb-tile-hint' }, 'Ataques y apoyos al segundo')
        ]);
        tile.addEventListener('click', () => { state.activeTab = 'ataques'; saveState(); buildTabs(); renderBody(); });
        return tile;
      })()
    ]));
    updateCountdown();
  }

  function buildUI() {
    root = el('div', { id: 'novabot-root' });

    fab = el('div', { id: 'novabot-fab', class: 'nb-interactive', html: ICON.logo, title: 'Abrir NOVABOT (arrastra para moverlo)' });

    headerEl = el('div', { class: 'nb-header' }, [
      el('div', { class: 'nb-brand' }, [
        el('span', { html: ICON.logo }),
        el('div', { class: 'nb-brand-text' }, [
          el('span', { class: 'nb-brand-title' }, 'NOVABOT'),
          el('span', { class: 'nb-brand-version', title: 'Versión del script · versión del CSS cargado' }, `v${VERSION} · css ${cssVersion()}`)
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

  // Mantiene un elemento dentro de la ventana (si la ventana se hace más
  // pequeña, p. ej. al abrir un panel lateral, no se queda fuera de la vista).
  function fitInView(pos, node, fallbackW, fallbackH) {
    const w = Math.min(node.offsetWidth || fallbackW, window.innerWidth);
    const h = Math.min(node.offsetHeight || fallbackH, window.innerHeight);
    return {
      x: clamp(pos.x, 4, Math.max(4, window.innerWidth - w - 4)),
      y: clamp(pos.y, 4, Math.max(4, window.innerHeight - h - 4))
    };
  }

  function applyPanelPosition() {
    const defaultRight = 22, defaultBottom = 88;
    if (state.pos) {
      const p = fitInView(state.pos, panel, 360, 200);
      panel.style.left = `${p.x}px`;
      panel.style.top = `${p.y}px`;
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
      const p = fitInView(state.fabPos, fab, 54, 54);
      fab.style.left = `${p.x}px`;
      fab.style.top = `${p.y}px`;
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
      panel.style.width = `${Math.min(state.size.w, window.innerWidth - 8)}px`;
      panel.style.height = `${Math.min(state.size.h, window.innerHeight - 8)}px`;
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
    if ((state.activeTab === 'construccion' || state.activeTab === 'reclutamiento') && bodyEl) renderBody();
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

  // Texto de error legible a partir de lo que devuelva el juego (string, objeto
  // con error/message, o un json anidado).
  function gameErrorText(args) {
    const pick = (o, depth = 0) => {
      if (!o || depth > 4) return '';
      if (typeof o === 'string') return o.trim();
      if (typeof o !== 'object') return '';
      for (const k of ['error', 'message', 'msg', 'error_msg', 'description']) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      for (const k of ['json', 'responseJSON', 'data']) { const t = pick(o[k], depth + 1); if (t) return t; }
      if (typeof o.responseText === 'string') { try { return pick(JSON.parse(o.responseText), depth + 1); } catch {} }
      return '';
    };
    for (const a of args) { const t = pick(a); if (t && !/^(error|timeout|abort)$/i.test(t)) return t.replace(/<[^>]+>/g, ''); }
    return 'El juego rechazó la acción.';
  }

  function gpCall(method, controller, action, json, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const fn = UW.gpAjax?.[method];
      if (typeof fn !== 'function') { reject(new Error(`gpAjax.${method} no disponible.`)); return; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`Sin respuesta del juego (${controller}/${action}).`)); } }, timeoutMs);
      try {
        fn.call(UW.gpAjax, controller, action, json, false, {
          success: (...a) => { if (done) return; done = true; clearTimeout(timer); resolve(a[1] ?? a[0] ?? null); },
          error: (...a) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(gameErrorText(a))); }
        });
      } catch (e) { done = true; clearTimeout(timer); reject(e); }
    });
  }
  const gpGet = (controller, action, json) => gpCall('ajaxGet', controller, action, json);
  const gpPost = (controller, action, json) => gpCall('ajaxPost', controller, action, json);

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

  // Quita del bot los objetivos que ya se alcanzaron (nivel actual + lo que
  // hay en cola real del juego >= objetivo) — así, en cuanto se manda a
  // construir el último nivel que faltaba, la fila pasa a la cola del juego
  // y desaparece de "Objetivos del bot" sin esperar a que termine de subir.
  function pruneCompletedGoals(townId) {
    const bd = buildDataFor(townId);
    if (!bd) return;
    const cfg = townBuildCfg(townId);
    const before = cfg.goals.length;
    cfg.goals = cfg.goals.filter((g) => committedLevel(bd.building_data?.[g.id]) < g.target);
    if (cfg.goals.length !== before) saveState();
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
        buildLog(`${farmTownName(townId)}: ${buildingName(next.id)} → nivel ${next.level} (a la cola del juego).`, 'ok');
        await sleep(300); // pequeño margen para que el modelo Backbone se actualice antes de leerlo
        pruneCompletedGoals(townId);
        if (state.activeTab === 'construccion') renderBody();
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
    pruneCompletedGoals(townId); // por si se completó a mano o fuera del ciclo del bot
    const tcfg = townBuildCfg(townId);
    const bd = buildDataFor(townId);

    // Activar / desactivar
    const sw = el('div', { class: `nb-switch${cfg.enabled ? ' on' : ''}` });
    sw.addEventListener('click', () => {
      cfg.enabled = !cfg.enabled; saveState(); renderBody();
      buildLog(cfg.enabled ? 'Construcción activada.' : 'Construcción desactivada.');
    });

    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Construcción automática')]), sw]),
      optionRow('Orden estricto', 'Si el primero está bloqueado, no salta al siguiente', !!cfg.strictOrder, (v) => { cfg.strictOrder = v; saveState(); })
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
    // El nivel que deja cada orden se calcula acumulando sobre el nivel actual
    // del edificio, en el mismo orden en que el juego las va a completar.
    const orders = townBuildOrders(townId)
      .slice()
      .sort((a, b) => (+a.to_be_completed_at || 0) - (+b.to_be_completed_at || 0));
    const levelAcc = {};
    for (const o of orders) {
      const id = o.building_type;
      if (!(id in levelAcc)) levelAcc[id] = +bd?.building_data?.[id]?.level || 0;
      levelAcc[id] += o.tear_down ? -1 : 1;
      o.__resultLevel = levelAcc[id];
    }
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Cola del juego (${orders.length})`),
      orders.length
        ? el('div', { class: 'nb-queue' }, orders.map((o) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, [
              `${buildingName(o.building_type)}${o.tear_down ? ' (derribo)' : ''} `,
              el('b', { class: 'nb-queue-level' }, `→ ${o.__resultLevel}`)
            ]),
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

      // ---- Añadir edificios: fila por edificio, con su propio nivel objetivo ----
      const available = buildingIds().filter((id) => !tcfg.goals.some((g) => g.id === id));
      const addSearch = el('input', { class: 'nb-input', type: 'text', placeholder: 'Buscar edificio…' });
      const addList = el('div', { class: 'nb-add-list' });

      function renderAddRow(id) {
        const info = bd.building_data?.[id];
        const cur = committedLevel(info);
        const max = maxOf(id);
        const atMax = cur >= max || info?.has_max_level;
        const input = el('input', {
          class: 'nb-input nb-input-inline', type: 'number', min: String(cur + 1), max: String(max), value: String(Math.min(cur + 1, max))
        });
        const add = () => {
          if (atMax) return;
          const v = clamp(pos(input.value, cur + 1), cur + 1, max);
          setTarget(id, v);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        return el('div', { class: `nb-add-row${atMax ? ' nb-add-row-off' : ''}` }, [
          el('div', { class: 'nb-add-name' }, [buildingName(id), el('span', { class: 'nb-add-level' }, `nivel ${cur}`)]),
          atMax
            ? el('span', { class: 'nb-pill nb-pill-off' }, 'máximo')
            : el('div', { class: 'nb-stepper' }, [
                el('span', { class: 'nb-mini', title: '−1', onclick: () => { input.value = clamp(pos(input.value, cur + 1) - 1, cur + 1, max); } }, '−'),
                input,
                el('span', { class: 'nb-mini', title: '+1', onclick: () => { input.value = clamp(pos(input.value, cur + 1) + 1, cur + 1, max); } }, '+'),
                el('span', { class: 'nb-mini nb-mini-add', title: 'Añadir a objetivos', onclick: add }, '✓')
              ])
        ]);
      }

      function renderAddList(filter) {
        addList.innerHTML = '';
        const f = (filter || '').trim().toLowerCase();
        const ids = available.filter((id) => !f || buildingName(id).toLowerCase().includes(f));
        if (!ids.length) { addList.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin resultados.')); return; }
        for (const id of ids) addList.appendChild(renderAddRow(id));
      }
      addSearch.addEventListener('input', () => renderAddList(addSearch.value));
      renderAddList('');

      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, `Añadir edificio (${available.length} disponibles)`),
        available.length ? el('div', {}, [addSearch, addList]) : el('p', { class: 'nb-placeholder' }, 'Ya tienes objetivo en todos los edificios.')
      ]));
    }

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    buildLogEl = logBox;
    renderBuildLog();
  }

  /* ---------------------------------------------------------------------------------
     8c) COMERCIO — reparto automático de recursos entre tus ciudades
     -----------------------------------------------------------------------------
     Diseño genérico: cada módulo que necesita recursos registra un "proveedor de
     demandas" (tradeDemandProviders). El reparto no sabe de construcción,
     reclutamiento, etc.: solo ve { townId, wood, stone, iron, prio, label }.
     Así, cuando haya más módulos, basta con añadir su proveedor y todos comparten
     el mismo motor sin pisarse (las reservas de cada ciudad cuentan TODAS sus
     demandas, así una ciudad nunca dona lo que ella misma va a gastar).

     Petición (la misma que usa el juego desde la ventana de comercio):
       POST town_info?action=trade   json: { id:<ciudad destino>, wood, stone, iron, town_id:<origen> }
     Envíos en camino: MM.getCollections().Trade (origin/destination_town_id,
     wood/stone/iron, started_at, arrival_at) + registro propio hasta que aparecen.
  --------------------------------------------------------------------------------- */
  const RES = ['wood', 'stone', 'iron'];
  const tradeRuntime = { timer: null, running: false, log: [], ledger: [], pairCooldown: new Map(), waitingSince: new Map() };
  let tradeLogEl = null;
  const sumRes = (r) => RES.reduce((s, k) => s + (+r?.[k] || 0), 0);
  const fmtRes = (r) => RES.filter((k) => r[k] > 0).map((k) => `${Math.round(r[k])} ${({ wood: 'madera', stone: 'piedra', iron: 'plata' })[k]}`).join(', ');

  // ---- Proveedores de demandas (añadir aquí los de futuros módulos) ----
  // Cada proveedor devuelve una lista ORDENADA de encargos por ciudad:
  //   { townId, prio, label, wood, stone, iron }
  // El orden importa: se asume que la ciudad los irá gastando en ese orden en
  // cuanto pueda pagarlos (así se puede enviar más de lo que cabe en el almacén
  // si antes de que llegue lo último ya se habrá gastado lo primero).

  // Huecos de la cola de construcción: 7 con Administrador (premium "curator"), si no 2.
  function buildQueueLimit() {
    const c = +UW.Game?.premium_features?.curator || 0;
    return c * 1000 > Date.now() ? 7 : 2;
  }

  // Coste de un nivel concreto. El juego aplica un descuento fijo sobre la
  // fórmula base (medido: 0,85); se calcula con el nivel siguiente que el juego
  // sí da (resources_for) y se aplica igual a los niveles posteriores.
  function levelCost(id, level, info) {
    const b = UW.GameData?.buildings?.[id];
    if (!b?.resources) return null;
    const base = (L) => ({
      wood: b.resources.wood * Math.pow(L, b.wood_factor || 1),
      stone: b.resources.stone * Math.pow(L, b.stone_factor || 1),
      iron: b.resources.iron * Math.pow(L, b.iron_factor || 1)
    });
    const L0 = +info?.next_level || 0;
    const real = info?.resources_for;
    if (real && level === L0) return { wood: +real.wood || 0, stone: +real.stone || 0, iron: +real.iron || 0 };
    const f0 = L0 ? base(L0) : null;
    const fl = base(level);
    const out = {};
    for (const k of RES) {
      const ratio = real && f0 && f0[k] ? (+real[k] || 0) / f0[k] : 0.85;
      out[k] = Math.round(fl[k] * ratio);
    }
    return out;
  }

  const tradeDemandProviders = [
    // Construcción: todos los niveles que caben en los huecos libres de la cola
    // real (límite 7 contando lo que ya está en cola del juego), siguiendo el
    // orden de objetivos del bot.
    function buildDemands() {
      if (!state.comercio.forBuild) return [];
      const out = [];
      const limit = buildQueueLimit();
      for (const townId of allTownIds()) {
        const goals = townBuildCfg(townId).goals;
        if (!goals.length) continue;
        const bd = buildDataFor(townId);
        if (!bd) continue;
        let free = Math.max(0, limit - townBuildOrders(townId).length);
        if (!free) continue;
        const sim = {}; // nivel simulado por edificio conforme se "encargan" niveles
        for (const g of goals) {
          if (!free) break;
          const info = bd.building_data?.[g.id];
          if (!info || info.has_max_level) continue;
          // Bloqueos que el comercio no puede resolver: se salta ese edificio.
          const hard = info.group_locked || (Array.isArray(info.missing_dependencies) && info.missing_dependencies.length) || !info.enough_storage;
          if (hard) { if (state.construccion.strictOrder) break; continue; }
          let lvl = sim[g.id] ?? committedLevel(info);
          while (free && lvl < g.target) {
            lvl += 1;
            const cost = levelCost(g.id, lvl, info);
            if (!cost) break;
            out.push({ townId, prio: 1, label: `${buildingName(g.id)} ${lvl}`, ...cost });
            free -= 1;
          }
          sim[g.id] = lvl;
        }
      }
      return out;
    }
  ];

  function collectDemands() {
    const all = [];
    for (const p of tradeDemandProviders) { try { all.push(...p()); } catch (e) { console.warn('[NOVABOT][comercio] proveedor falló:', e); } }
    return all;
  }

  // ---- Distancias y tiempos de viaje ----
  function townXY(townId) {
    const d = farmTownData(townId);
    return { x: +d.island_x, y: +d.island_y };
  }
  function townDist(a, b) {
    const A = townXY(a), B = townXY(b);
    if (!Number.isFinite(A.x) || !Number.isFinite(B.x)) return 30;
    return Math.max(0.5, Math.hypot(A.x - B.x, A.y - B.y)); // misma isla = 0.5
  }
  // Segundos por unidad de distancia, calibrado con los envíos reales vistos.
  function secPerUnit() {
    return +state.comercio.secPerUnit > 0 ? +state.comercio.secPerUnit : 28; // 28 s/u medido en es147
  }
  function calibrateTravel() {
    const samples = [];
    for (const t of gameTrades()) {
      if (!t.started_at || !t.arrival_at) continue;
      const d = townDist(t.origin_town_id, t.destination_town_id);
      if (d < 1) continue;
      samples.push((t.arrival_at - t.started_at) / d);
    }
    if (!samples.length) return;
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)];
    if (med > 1 && Math.abs(med - (+state.comercio.secPerUnit || 0)) > 0.5) { state.comercio.secPerUnit = +med.toFixed(2); saveState(); }
  }
  const travelSec = (a, b) => Math.max(60, Math.round(townDist(a, b) * secPerUnit()));

  // ---- Envíos en camino ----
  function gameTrades() {
    try {
      const own = new Set(allTownIds());
      return [].concat(UW.MM.getCollections().Trade || []).flatMap((c) => c?.models || []).map((m) => m.attributes)
        .filter((t) => own.has(+t.destination_town_id) && +t.arrival_at * 1000 > Date.now() - 30000);
    } catch { return []; }
  }
  function transitRows() {
    const game = gameTrades().map((t) => ({ from: +t.origin_town_id, to: +t.destination_town_id,
      wood: +t.wood || 0, stone: +t.stone || 0, iron: +t.iron || 0, arrival: +t.arrival_at * 1000 }));
    const now = Date.now();
    tradeRuntime.ledger = tradeRuntime.ledger.filter((l) => l.expires > now);
    // Lo enviado por el bot cuenta hasta que el juego lo muestre en su colección.
    const extra = tradeRuntime.ledger.filter((l) => !game.some((g) => g.from === l.from && g.to === l.to && Math.abs(sumRes(g) - sumRes(l)) <= 50));
    return [...game, ...extra];
  }
  function incomingTo(townId, rows) {
    const out = { wood: 0, stone: 0, iron: 0 };
    for (const r of rows) if (r.to === +townId) for (const k of RES) out[k] += r[k];
    return out;
  }

  function tradeCapacityOf(townId) {
    try { return Math.max(0, +UW.ITowns.getTown(townId)?.getAvailableTradeCapacity?.() || 0); } catch { return 0; }
  }
  function productionOf(townId) {
    try { const p = UW.ITowns.getTown(townId)?.getProduction?.() || {}; return { wood: +p.wood || 0, stone: +p.stone || 0, iron: +p.iron || 0 }; }
    catch { return { wood: 0, stone: 0, iron: 0 }; }
  }

  // ---- Planificación ----
  /*
   Algoritmo (problema de transporte con plazos):
   1) Demandas: lista ordenada de encargos por ciudad (todos los que caben en la cola).
   2) Falta neta por ciudad = suma de sus encargos − recursos actuales − lo que ya viene de camino.
   3) Reparto tipo Vogel (VAM): en cada paso se atiende la ciudad con mayor
      "arrepentimiento" = cuánto empeora su tiempo si le quitan su mejor donante
      (tiempo 2º donante − tiempo 1º donante), sumado a lo que lleva esperando.
      Así las lejanas (que solo tienen donantes lejanos) no se quedan sin nada
      por culpa de que las cercanas siempre ganen: cuanto más esperan, más suben.
   4) Almacén: en vez de limitar a "lo que cabe ahora", se simula la línea de
      tiempo de la ciudad destino (producción + llegadas ordenadas por hora +
      gasto de sus encargos en orden en cuanto se pueden pagar) y se comprueba
      que en el momento de cada llegada no se supera el almacén. Así se puede
      enviar más de lo que cabe si antes se va a gastar, sin perder nada.
  */
  function simulateOk(s, items, arrivals, storageCap) {
    const lvl = { ...s.cur };
    const queue = items.map((i) => ({ wood: i.wood, stone: i.stone, iron: i.iron }));
    const consume = () => {
      while (queue.length && RES.every((k) => lvl[k] >= queue[0][k])) {
        const q = queue.shift();
        for (const k of RES) lvl[k] -= q[k];
      }
    };
    consume();
    let prevT = 0;
    for (const a of [...arrivals].sort((x, y) => x.t - y.t)) {
      const dt = Math.max(0, a.t - prevT) / 3600;
      for (const k of RES) lvl[k] = Math.min(s.storage, lvl[k] + s.prod[k] * dt);
      prevT = a.t;
      consume();
      for (const k of RES) {
        if (!a[k]) continue;
        lvl[k] += a[k];
        if (lvl[k] > storageCap + 1) return false; // se desperdiciaría al llegar
      }
      consume();
    }
    return true;
  }

  function planTrades() {
    const cfg = state.comercio;
    const towns = allTownIds();
    const transit = transitRows();
    const demands = collectDemands();
    const now = Date.now();
    const marginPct = clamp(+cfg.storageMarginPct || 0, 0, 50) / 100;
    const minShip = Math.max(1, +cfg.minShipment || 500);

    const itemsBy = {};
    for (const id of towns) itemsBy[id] = [];
    for (const d of demands) if (itemsBy[d.townId]) itemsBy[d.townId].push(d);

    const st = {};
    for (const id of towns) {
      const cur = townResources(id);
      const total = { wood: 0, stone: 0, iron: 0 };
      for (const d of itemsBy[id]) for (const k of RES) total[k] += d[k];
      st[id] = {
        cur, total, cap: tradeCapacityOf(id), storage: townStorage(id) || 0, prod: productionOf(id),
        incoming: incomingTo(id, transit),
        // Llegadas ya en camino (para la simulación del almacén).
        arrivals: transit.filter((r) => r.to === id).map((r) => ({ t: Math.max(0, (r.arrival - now) / 1000), wood: r.wood, stone: r.stone, iron: r.iron })),
        // Excedente: lo que sobra tras reservar TODOS sus propios encargos.
        surplus: Object.fromEntries(RES.map((k) => [k, Math.max(0, cur[k] - total[k] - (+cfg.keepMin || 0))]))
      };
    }

    const needs = [];
    for (const id of towns) {
      const s = st[id];
      if (!itemsBy[id].length) { tradeRuntime.waitingSince.delete(id); continue; }
      const miss = Object.fromEntries(RES.map((k) => [k, Math.max(0, s.total[k] - s.cur[k] - s.incoming[k])]));
      if (sumRes(miss) <= 0) { tradeRuntime.waitingSince.delete(id); continue; }
      if (!tradeRuntime.waitingSince.has(id)) tradeRuntime.waitingSince.set(id, now);
      needs.push({ townId: id, miss, label: itemsBy[id].map((i) => i.label).join(', '), items: itemsBy[id],
        waited: (now - tradeRuntime.waitingSince.get(id)) / 1000 });
    }

    const donorsFor = (n) => towns
      .filter((id) => id !== n.townId && st[id].cap > 0 && RES.some((k) => st[id].surplus[k] > 0 && n.miss[k] > 0))
      .filter((id) => (tradeRuntime.pairCooldown.get(`${id}>${n.townId}`) || 0) < now)
      .sort((a, b) => travelSec(a, n.townId) - travelSec(b, n.townId));

    const plan = [];
    const pending = needs.slice();
    const agingWeight = Math.max(0, +cfg.agingWeight || 2);
    while (pending.length) {
      // Recalcular prioridad (VAM + envejecimiento) tras cada asignación.
      let best = null, bestScore = -Infinity;
      for (const n of pending) {
        const ds = donorsFor(n);
        if (!ds.length) { n.score = -Infinity; continue; }
        const t1 = travelSec(ds[0], n.townId);
        const regret = ds.length > 1 ? travelSec(ds[1], n.townId) - t1 : 24 * 3600; // un solo donante posible = urgente
        n.score = regret + n.waited * agingWeight;
        if (n.score > bestScore) { bestScore = n.score; best = n; }
      }
      if (!best) break;
      pending.splice(pending.indexOf(best), 1);

      const r = st[best.townId];
      const storageCap = r.storage * (1 - marginPct);
      for (const donorId of donorsFor(best)) {
        if (sumRes(best.miss) <= 0) break;
        const d = st[donorId];
        const eta = travelSec(donorId, best.townId);
        const want = { wood: 0, stone: 0, iron: 0 };
        let left = d.cap;
        for (const k of [...RES].sort((a, b) => best.miss[b] - best.miss[a])) {
          const v = Math.floor(Math.min(left, d.surplus[k], best.miss[k]));
          if (v > 0) { want[k] = v; left -= v; }
        }
        if (sumRes(want) <= 0) continue;
        // Ajustar a lo que la simulación de almacén permite (por recurso).
        const test = (ship) => simulateOk(r, best.items, [...r.arrivals, { t: eta, ...ship }], storageCap);
        if (!test(want)) {
          for (const k of RES) {
            if (!want[k] || test(want)) continue;
            let lo = 0, hi = want[k];
            while (hi - lo > 50) { const mid = Math.floor((lo + hi) / 2); want[k] = mid; if (test(want)) lo = mid; else hi = mid; }
            want[k] = lo;
          }
        }
        const total = sumRes(want);
        const completes = RES.every((k) => want[k] >= best.miss[k]);
        if (total <= 0 || (total < minShip && !completes)) continue;
        plan.push({ from: donorId, to: best.townId, ship: want, eta, label: best.items[0]?.label || '' });
        d.cap -= total;
        for (const k of RES) { d.surplus[k] -= want[k]; best.miss[k] -= want[k]; r.incoming[k] += want[k]; }
        r.arrivals.push({ t: eta, ...want });
      }
    }
    return { plan, needs };
  }

  async function tradeTick() {
    if (!state.comercio.enabled) return;
    calibrateTravel();
    const { plan } = planTrades();
    const maxPerTick = Math.max(1, +state.comercio.maxPerTick || 5);
    for (const p of plan.slice(0, maxPerTick)) {
      if (!state.comercio.enabled) return;
      try {
        await gpPostAs(p.from, 'town_info', 'trade', { id: p.to, wood: p.ship.wood, stone: p.ship.stone, iron: p.ship.iron, nl_init: true });
        tradeRuntime.ledger.push({ from: p.from, to: p.to, ...p.ship, arrival: Date.now() + p.eta * 1000, expires: Date.now() + p.eta * 1000 + 120000 });
        tradeRuntime.pairCooldown.set(`${p.from}>${p.to}`, Date.now() + 20000);
        tradeLog(`${farmTownName(p.from)} → ${farmTownName(p.to)}: ${fmtRes(p.ship)} · ${Math.round(p.eta / 60)} min · para ${p.label}`, 'ok');
      } catch (e) {
        tradeRuntime.pairCooldown.set(`${p.from}>${p.to}`, Date.now() + 5 * 60000);
        tradeLog(`${farmTownName(p.from)} → ${farmTownName(p.to)}: ${e.message}`, 'error');
      }
      await sleep(700 + Math.random() * 900);
    }
    if (plan.length && state.activeTab === 'comercio') renderBody();
  }

  function startTradeEngine() {
    if (tradeRuntime.timer) return;
    tradeRuntime.timer = setInterval(() => {
      if (!state.comercio.enabled || tradeRuntime.running) return;
      tradeRuntime.running = true;
      tradeTick().catch((e) => tradeLog(`Error: ${e.message}`, 'error')).finally(() => { tradeRuntime.running = false; });
    }, 10000); // revisa cada 10 s si hay algo que enviar
  }

  function tradeLog(text, kind = 'info') {
    tradeRuntime.log.unshift({ at: Date.now(), text, kind });
    tradeRuntime.log = tradeRuntime.log.slice(0, 40);
    renderTradeLog();
  }
  function renderTradeLog() {
    if (!tradeLogEl) return;
    tradeLogEl.innerHTML = '';
    if (!tradeRuntime.log.length) { tradeLogEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin actividad todavía.')); return; }
    for (const e of tradeRuntime.log) tradeLogEl.appendChild(el('div', { class: `nb-log-item nb-log-${e.kind}` }, `${new Date(e.at).toLocaleTimeString('es-ES')} · ${e.text}`));
  }

  function renderComercioTab() {
    const cfg = state.comercio;
    const sw = el('div', { class: `nb-switch${cfg.enabled ? ' on' : ''}` });
    sw.addEventListener('click', () => { cfg.enabled = !cfg.enabled; saveState(); renderBody(); tradeLog(cfg.enabled ? 'Comercio activado.' : 'Comercio desactivado.'); });

    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Comercio automático')]), sw]),
      optionRow('Abastecer construcción', 'Envía lo que falta para los edificios en cola', !!cfg.forBuild, (v) => { cfg.forBuild = v; saveState(); renderBody(); }),
      optionRow('Abastecer reclutamiento', 'Envía lo que falta para completar los lotes de tropas', !!cfg.forRecruit, (v) => { cfg.forRecruit = v; saveState(); renderBody(); }),
      el('p', { class: 'nb-placeholder' }, 'Revisa cada 10 s. Abastece todos los encargos que caben en la cola de cada ciudad. Nunca dona lo que la donante va a gastar y nunca hace que se pierda recurso al llegar.')
    ]));

    const num = (key, label, step, min) => {
      const i = el('input', { class: 'nb-input', type: 'number', step: String(step), min: String(min), value: cfg[key] });
      i.addEventListener('change', () => { cfg[key] = Math.max(min, pos(i.value, cfg[key])); saveState(); });
      return el('label', { class: 'nb-field' }, [label, i]);
    };
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Ajustes'),
      el('div', { class: 'nb-field-row' }, [num('minShipment', 'Envío mínimo', 100, 1), num('storageMarginPct', 'Margen almacén %', 1, 0)]),
      el('div', { class: 'nb-field-row' }, [num('keepMin', 'Dejar siempre en donante', 100, 0), num('maxPerTick', 'Envíos por ciclo', 1, 1)]),
      el('div', { class: 'nb-field-row' }, [num('agingWeight', 'Peso de la espera (anti-olvido)', 1, 0)]),
      el('p', { class: 'nb-placeholder' }, `Velocidad de viaje calibrada: ${secPerUnit()} s por casilla.`)
    ]));

    // Necesidades actuales y plan
    let planInfo = { plan: [], needs: [] };
    try { planInfo = planTrades(); } catch {}
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Necesidades (${planInfo.needs.length})`),
      planInfo.needs.length
        ? el('div', { class: 'nb-queue' }, planInfo.needs.map((n) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, [`${farmTownName(n.townId)} `, el('b', { class: 'nb-queue-level' }, n.label)]),
            el('span', { class: 'nb-queue-time' }, fmtRes(n.miss) || 'cubierto')
          ])))
        : el('p', { class: 'nb-placeholder' }, 'Ninguna ciudad espera recursos.')
    ]));

    const rows = transitRows();
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `En camino (${rows.length})`),
      rows.length
        ? el('div', { class: 'nb-queue' }, rows.map((r) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, `${farmTownName(r.from)} → ${farmTownName(r.to)} · ${fmtRes(r)}`),
            el('span', { class: 'nb-queue-time', 'data-nb-until': Math.round(r.arrival / 1000) }, formatLeft(Math.round(r.arrival / 1000)))
          ])))
        : el('p', { class: 'nb-placeholder' }, 'Nada en camino.')
    ]));

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    tradeLogEl = logBox;
    renderTradeLog();
  }

  /* ---------------------------------------------------------------------------------
     8d) RECLUTAMIENTO (tierra y mar) — lotes que llenan el almacén
     -----------------------------------------------------------------------------
     Por ciudad: lista de tropas con un total objetivo. El bot calcula el LOTE
     más grande que cabe en el almacén (mezclando las tropas pedidas para
     aprovechar los 3 recursos a la vez), espera a tener ese lote (el recurso
     que más pide el lote llega a su tope) y entonces recluta todo de golpe.
     Mientras espera, el lote se publica como demanda al Comercio, que manda
     justo los recursos que faltan (en la proporción que pide la mezcla).

     Petición: POST building_barracks?action=build (tierra) / building_docks (mar)
               json: { unit_id, amount, town_id, nl_init:true }
  --------------------------------------------------------------------------------- */
  const recruitRuntime = { timer: null, running: false, log: [], cooldown: new Map() };
  let recruitLogEl = null;

  function townRecruitCfg(townId) {
    const all = state.reclutamiento.towns;
    if (!all[townId]) all[townId] = { goals: [] };
    return all[townId];
  }

  function unitName(id) { const u = UW.GameData?.units?.[id]; return u?.name_plural || u?.name || id; }

  // Coste por tropa: tabla base del juego (GameData.units[id].resources).
  // No se aplica el descuento de la Leva: en una orden real de 19. NOVA (con
  // Leva) el reembolso por unidad es justo el 50% del coste BASE, así que no está
  // claro que se aplique; usando la base el lote nunca se queda corto.
  function unitCost(townId, id) {
    const u = UW.GameData?.units?.[id];
    const r = u?.resources || {};
    const f = 1;
    return { wood: Math.ceil((+r.wood || 0) * f), stone: Math.ceil((+r.stone || 0) * f), iron: Math.ceil((+r.iron || 0) * f), pop: +u?.population || 1, favor: +u?.favor || 0 };
  }

  const isNavalUnit = (id) => !!UW.GameData?.units?.[id]?.is_naval;
  const isMythUnit = (id) => +UW.GameData?.units?.[id]?.favor > 0;

  function townGod(townId) {
    try { return UW.ITowns.getTown(townId)?.god?.() || null; } catch { return null; }
  }
  // Tope de favor por dios: el lote mítico se dimensiona con él (igual que el
  // almacén para los recursos) y se recluta cuando el favor llega.
  function godMaxFavor() {
    try { return +Object.values(UW.MM.getModels().PlayerGods || {})[0]?.attributes?.max_favor || 500; } catch { return 500; }
  }

  // Favor actual del dios (compartido entre todas las ciudades con ese dios).
  function godFavor(god) {
    if (!god) return 0;
    try {
      const m = Object.values(UW.MM.getModels().PlayerGods || {})[0];
      const a = m?.attributes || {};
      const o = a.production_overview?.[god];
      if (o) {
        const hours = Math.max(0, Date.now() / 1000 - (+a.last_updated_timestamp || Date.now() / 1000)) / 3600;
        return Math.min(+a.max_favor || Infinity, (+o.current || 0) + (+o.production || 0) * hours);
      }
      return +a[`${god}_favor`] || 0;
    } catch { return 0; }
  }

  // Tropas que la ciudad puede reclutar ya (investigación + edificios). Las míticas
  // solo si son del dios de la ciudad.
  function landUnitsFor(townId) {
    const units = UW.GameData?.units || {};
    let rs = null; try { rs = UW.ITowns.getTown(townId)?.getResearches?.(); } catch {}
    const bd = buildDataFor(townId);
    const out = [];
    for (const [id, u] of Object.entries(units)) {
      if (!u || typeof u !== 'object' || u.is_npc_unit_only || id === 'militia') continue;
      if (+u.favor > 0 && (!u.god_id || u.god_id !== townGod(townId))) continue;
      const needR = [].concat(u.research_dependencies || []);
      if (needR.some((r) => !rs?.get?.(r))) continue;
      const needB = u.building_dependencies || {};
      if (Object.entries(needB).some(([b, l]) => (+bd?.building_data?.[b]?.level || 0) < +l)) continue;
      out.push(id);
    }
    // Tierra, luego mar, luego míticas; alfabético dentro de cada grupo.
    const grp = (id) => (isMythUnit(id) ? 2 : isNavalUnit(id) ? 1 : 0);
    return out.sort((a, b) => (grp(a) - grp(b)) || unitName(a).localeCompare(unitName(b), 'es'));
  }

  function townUnitsHave(townId) {
    const out = {};
    try { Object.assign(out, UW.ITowns.getTown(townId)?.units?.() || {}); } catch {}
    return out;
  }
  function townUnitOrders(townId) {
    try { return (UW.ITowns.getTown(townId)?.getUnitOrdersCollection?.()?.models || []).map((m) => m.attributes); } catch { return []; }
  }
  function queuedUnits(townId) {
    const out = {};
    for (const o of townUnitOrders(townId)) out[o.unit_type] = (out[o.unit_type] || 0) + (+o.units_left || +o.count || 0);
    return out;
  }
  // Cuartel (tierra) y Puerto (mar) tienen colas separadas.
  function unitQueueFree(townId, kind = null) {
    const orders = townUnitOrders(townId);
    const free = (k) => Math.max(0, buildQueueLimit() - orders.filter((o) => (o.kind === 'naval') === (k === 'naval')).length);
    return kind ? free(kind) : free('ground') + free('naval');
  }
  function freePopulation(townId) {
    try { return Math.max(0, +UW.ITowns.getTown(townId)?.getAvailablePopulation?.() || 0); } catch { return 0; }
  }

  // Lote óptimo: maximiza la población reclutada sin pasar el presupuesto de
  // almacén (por recurso) ni la población libre ni lo que falta de cada tropa.
  // Empieza con la mezcla proporcional a lo que falta y rellena en greedy con la
  // tropa que mejor aprovecha el recurso que más sobra (así un lanzador, que tira
  // de madera, se combina con hoplitas, que tiran de piedra/plata).
  function recruitBatch(townId) {
    const cfg = townRecruitCfg(townId);
    const have = townUnitsHave(townId), queued = queuedUnits(townId);
    const rows = cfg.goals.map((g) => ({ id: g.id, rem: Math.max(0, g.target - (+have[g.id] || 0) - (+queued[g.id] || 0)), c: unitCost(townId, g.id) }))
      .filter((r) => r.rem > 0 && unitQueueFree(townId, isNavalUnit(r.id) ? 'naval' : 'ground') > 0);
    if (!rows.length) return null;
    const storage = townStorage(townId) || 0;
    const fill = clamp(+state.reclutamiento.fillPct || 95, 10, 100) / 100;
    const budget = { wood: storage * fill, stone: storage * fill, iron: storage * fill, pop: freePopulation(townId), favor: godMaxFavor() * fill };
    const KEYS = [...RES, 'pop', 'favor'];
    if (budget.pop <= 0) return { rows, units: {}, cost: { wood: 0, stone: 0, iron: 0 }, reason: 'sin población libre' };

    // Proporcional
    const sum = { wood: 0, stone: 0, iron: 0, pop: 0, favor: 0 };
    for (const r of rows) for (const k of KEYS) sum[k] += r.rem * r.c[k];
    let s = 1;
    for (const k of KEYS) if (sum[k] > 0) s = Math.min(s, budget[k] / sum[k]);
    const units = {};
    const used = { wood: 0, stone: 0, iron: 0, pop: 0, favor: 0 };
    for (const r of rows) {
      const n = Math.floor(r.rem * s);
      if (n > 0) { units[r.id] = n; for (const k of KEYS) used[k] += n * r.c[k]; }
    }
    // Relleno greedy (1 a 1) con la tropa que más usa lo que sobra.
    for (let guard = 0; guard < 5000; guard++) {
      const left = Object.fromEntries(KEYS.map((k) => [k, budget[k] - used[k]]));
      let best = null, bestScore = 0;
      for (const r of rows) {
        if ((units[r.id] || 0) >= r.rem) continue;
        if (KEYS.some((k) => r.c[k] > left[k])) continue;
        // Puntuación: población por unidad del recurso más escaso tras añadirla.
        const score = r.c.pop / Math.max(1e-9, Math.max(...RES.map((k) => r.c[k] / Math.max(1, left[k]))));
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (!best) break;
      units[best.id] = (units[best.id] || 0) + 1;
      for (const k of KEYS) used[k] += best.c[k];
    }
    const cost = { wood: used.wood, stone: used.stone, iron: used.iron };
    if (!Object.keys(units).length) return { rows, units, cost, reason: 'no cabe ni una tropa' };
    return { rows, units, cost, pop: used.pop, favor: used.favor };
  }

  // Demanda para el Comercio: el lote completo (prioridad por detrás de construir).
  tradeDemandProviders.push(function recruitDemands() {
    if (!state.reclutamiento.enabled || !state.comercio.forRecruit) return [];
    const out = [];
    for (const townId of allTownIds()) {
      if (!townRecruitCfg(townId).goals.length || !unitQueueFree(townId)) continue;
      const b = recruitBatch(townId);
      if (!b || !sumRes(b.cost)) continue;
      out.push({ townId, prio: 2, label: `lote ${Object.entries(b.units).map(([u, n]) => `${n} ${unitName(u)}`).join(' + ')}`, ...b.cost });
    }
    return out;
  });

  async function recruitTick() {
    if (!state.reclutamiento.enabled) return;
    for (const townId of allTownIds()) {
      if (!state.reclutamiento.enabled) return;
      if (!townRecruitCfg(townId).goals.length || !unitQueueFree(townId)) continue;
      if ((recruitRuntime.cooldown.get(townId) || 0) > Date.now()) continue;
      // Construir va primero: si hay un edificio listo para pagarse, no le quitamos recursos.
      if (state.construccion.enabled && nextBuildFor(townId).id) continue;
      const b = recruitBatch(townId);
      if (!b || b.reason) continue;
      const cur = townResources(townId);
      if (RES.some((k) => cur[k] < b.cost[k])) continue; // aún no está el lote completo
      if (b.favor && godFavor(townGod(townId)) < b.favor) continue;
      for (const [unitId, amount] of Object.entries(b.units)) {
        if (!(amount > 0)) continue;
        try {
          await gpPostAs(townId, isNavalUnit(unitId) ? 'building_docks' : 'building_barracks', 'build', { unit_id: unitId, amount, nl_init: true });
          recruitLog(`${farmTownName(townId)}: ${amount} ${unitName(unitId)} reclutados.`, 'ok');
        } catch (e) {
          recruitLog(`${farmTownName(townId)}: ${unitName(unitId)} — ${e.message}`, 'error');
          recruitRuntime.cooldown.set(townId, Date.now() + 5 * 60000);
          break;
        }
        await sleep(700 + Math.random() * 800);
      }
      if (state.activeTab === 'reclutamiento') renderBody();
    }
  }

  function startRecruitEngine() {
    if (recruitRuntime.timer) return;
    recruitRuntime.timer = setInterval(() => {
      if (!state.reclutamiento.enabled || recruitRuntime.running) return;
      recruitRuntime.running = true;
      recruitTick().catch((e) => recruitLog(`Error: ${e.message}`, 'error')).finally(() => { recruitRuntime.running = false; });
    }, 15000);
  }

  function recruitLog(text, kind = 'info') {
    recruitRuntime.log.unshift({ at: Date.now(), text, kind });
    recruitRuntime.log = recruitRuntime.log.slice(0, 30);
    renderRecruitLog();
  }
  function renderRecruitLog() {
    if (!recruitLogEl) return;
    recruitLogEl.innerHTML = '';
    if (!recruitRuntime.log.length) { recruitLogEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin actividad todavía.')); return; }
    for (const e of recruitRuntime.log) recruitLogEl.appendChild(el('div', { class: `nb-log-item nb-log-${e.kind}` }, `${new Date(e.at).toLocaleTimeString('es-ES')} · ${e.text}`));
  }

  function renderReclutamientoTab() {
    const cfg = state.reclutamiento;
    const townId = +UW.Game?.townId || allTownIds()[0];
    const tcfg = townRecruitCfg(townId);

    const sw = el('div', { class: `nb-switch${cfg.enabled ? ' on' : ''}` });
    sw.addEventListener('click', () => { cfg.enabled = !cfg.enabled; saveState(); renderBody(); recruitLog(cfg.enabled ? 'Reclutamiento activado.' : 'Reclutamiento desactivado.'); });

    const fillIn = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '10', max: '100', value: cfg.fillPct });
    fillIn.addEventListener('change', () => { cfg.fillPct = clamp(pos(fillIn.value, 95), 10, 100); saveState(); renderBody(); });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Reclutamiento automático')]), sw]),
      optionRow('Pedir recursos al Comercio', 'Los lotes se completan con envíos de otras ciudades', !!state.comercio.forRecruit, (v) => { state.comercio.forRecruit = v; saveState(); }),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Lote = % del almacén'), el('span', {}, [fillIn, ' %'])]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Ciudad actual'), el('span', { class: 'nb-row-value' }, farmTownName(townId))])
    ]));

    // Siguiente lote
    const b = recruitBatch(townId);
    const cur = townResources(townId);
    let lotBox;
    if (!b) lotBox = el('p', { class: 'nb-placeholder' }, tcfg.goals.length ? 'Objetivos cumplidos.' : 'Sin tropas pedidas.');
    else if (b.reason) lotBox = el('p', { class: 'nb-placeholder' }, b.reason);
    else {
      const bars = RES.filter((k) => b.cost[k] > 0).map((k) => {
        const pct = Math.min(100, Math.round(cur[k] / b.cost[k] * 100));
        return el('div', { class: 'nb-bar-row' }, [
          el('span', { class: 'nb-bar-label' }, ({ wood: 'Madera', stone: 'Piedra', iron: 'Plata' })[k]),
          el('div', { class: 'nb-bar' }, [el('div', { class: 'nb-bar-fill', style: `width:${pct}%` })]),
          el('span', { class: 'nb-bar-num' }, `${Math.floor(cur[k])}/${Math.ceil(b.cost[k])}`)
        ]);
      });
      lotBox = el('div', {}, [
        el('div', { class: 'nb-goal-name' }, Object.entries(b.units).map(([u, n]) => `${n} ${unitName(u)}`).join(' + ')),
        el('div', { class: 'nb-goal-sub' }, `${b.pop} de población${b.favor ? ` · ${Math.ceil(b.favor)} favor (${Math.floor(godFavor(townGod(townId)))} disponible)` : ''}`),
        ...bars
      ]);
    }
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Siguiente lote'), lotBox]));

    // Objetivos
    const have = townUnitsHave(townId), queued = queuedUnits(townId);
    const setTarget = (id, v) => {
      const i = tcfg.goals.findIndex((g) => g.id === id);
      v = Math.max(0, Math.round(v));
      if (!v) { if (i >= 0) tcfg.goals.splice(i, 1); }
      else if (i >= 0) tcfg.goals[i].target = v;
      else tcfg.goals.push({ id, target: v });
      saveState(); renderBody();
    };
    const goalsBox = el('div', { class: 'nb-goals' });
    for (const g of tcfg.goals) {
      const h = (+have[g.id] || 0) + (+queued[g.id] || 0);
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '0', value: g.target });
      input.addEventListener('change', () => setTarget(g.id, pos(input.value, g.target)));
      goalsBox.appendChild(el('div', { class: `nb-goal${h >= g.target ? ' nb-goal-done' : ''}` }, [
        el('div', { class: 'nb-goal-main' }, [
          el('div', { class: 'nb-goal-name' }, [unitName(g.id), isMythUnit(g.id) ? el('span', { class: 'nb-tag nb-tag-myth' }, 'mítica') : isNavalUnit(g.id) ? el('span', { class: 'nb-tag' }, 'naval') : null]),
          el('div', { class: 'nb-goal-sub' }, `tienes ${+have[g.id] || 0}${queued[g.id] ? ` + ${queued[g.id]} en cola` : ''} · faltan ${Math.max(0, g.target - h)}`)
        ]),
        el('div', { class: 'nb-stepper' }, [
          el('span', { class: 'nb-mini', onclick: () => setTarget(g.id, g.target - 50) }, '−50'),
          input,
          el('span', { class: 'nb-mini', onclick: () => setTarget(g.id, g.target + 50) }, '+50'),
          el('span', { class: 'nb-mini nb-mini-danger', title: 'Quitar', onclick: () => setTarget(g.id, 0) }, '✕')
        ])
      ]));
    }
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Tropas objetivo (${tcfg.goals.length})`),
      tcfg.goals.length ? goalsBox : el('p', { class: 'nb-placeholder' }, 'Añade tropas abajo.')
    ]));

    // Añadir tropa
    const avail = landUnitsFor(townId).filter((id) => !tcfg.goals.some((g) => g.id === id));
    const addList = el('div', { class: 'nb-add-list' });
    for (const id of avail) {
      const c = unitCost(townId, id);
      const h = (+have[id] || 0) + (+queued[id] || 0);
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '1', value: String(h + 100) });
      const add = () => setTarget(id, Math.max(h + 1, pos(input.value, h + 100)));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      addList.appendChild(el('div', { class: 'nb-add-row' }, [
        el('div', { class: 'nb-add-name' }, [
          el('span', {}, unitName(id)),
          isMythUnit(id) ? el('span', { class: 'nb-tag nb-tag-myth' }, 'mítica') : isNavalUnit(id) ? el('span', { class: 'nb-tag' }, 'naval') : null,
          el('span', { class: 'nb-add-level' }, `tienes ${h} · ${c.wood}/${c.stone}/${c.iron}${c.favor ? ` · ${c.favor} favor` : ''} · ${c.pop} pob`)
        ]),
        el('div', { class: 'nb-stepper' }, [input, el('span', { class: 'nb-mini nb-mini-add', title: 'Añadir (total objetivo)', onclick: add }, '✓')])
      ]));
    }
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Añadir tropa (número = total que quieres tener)'),
      avail.length ? addList : el('p', { class: 'nb-placeholder' }, 'No hay más tropas disponibles en esta ciudad.')
    ]));

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    recruitLogEl = logBox;
    renderRecruitLog();
  }

  /* ---------------------------------------------------------------------------------
     8e) ATAQUES — programador de ataques y apoyos (todo por API)
     -----------------------------------------------------------------------------
     Peticiones (las mismas que la ventana de ataque del juego):
       GET  town_info?action=attack      json: { id:<destino>, town_id:<origen> }
            → json: distance, units{id:{count,duration,population}}, heroes_durations,
              same_island, morale, has_player_protection, protection_ends,
              same_alliance, alliance_pact, night_starts_at_hour, night_duration,
              attack_types, attack_strategies, researches{berth}…
       POST town_info?action=send_units  json: { id, type, <unidad>:n…, heroes?,
              attacking_strategy?:[…], power_id?, town_id }
            (formato leído de WndHandlerAttack.sendUnits del propio juego: el héroe
            va en "heroes", no en hero_id/include_hero como hacía el script original).

     Tiempo de viaje: duración por tropa que devuelve el servidor (coincide al
     segundo con la ventana del juego). Reglas de Grepolis:
       · misma isla: manda la tropa más lenta;
       · otra isla: las tropas de tierra van en barco → mandan los barcos y las
         voladoras (que vuelan por su cuenta); hace falta capacidad de transporte.

     Reloj: cada respuesta del juego trae "_srvtime" (segundos del servidor). Con
     la hora local de envío y de recepción de cada petición se acota el desfase
     reloj local ↔ servidor por intersección de intervalos (tipo Marzullo), que
     converge a unas decenas de ms. Así se sabe EXACTAMENTE cuándo es cada segundo
     del servidor, en vez de leer la hora que se ve en pantalla (precisión 1 s).

     Envío: el servidor fija la llegada = segundo en que procesa la orden +
     duración. Para acertar el segundo, la orden se dispara para que llegue al
     servidor a mitad de ese segundo (+500 ms), descontando la latencia medida.
     Los temporizadores van en un Web Worker para que funcionen aunque la
     pestaña esté en segundo plano (Chrome frena los timers normales a 1/s).
     5 s antes se precarga la información (tropas disponibles) para que en el
     momento exacto solo haga falta el POST. Tras enviar se lee la llegada real
     que devuelve el juego y se corrige solo el desfase para los siguientes.
  --------------------------------------------------------------------------------- */
  const ATK_KEY = 'novabot_attacks_v2';
  const ATK_MISS_TOLERANCE_MS = 8000;   // si se pasó la hora más de esto (p. ej. PC dormido), NO se envía
  const ATK_PREFETCH_MS = 6000;         // precarga de tropas antes de salir
  const ATK_RECHECK_MS = 35000;         // recalcular duración (modo llegada) antes de salir
  const ATK_ARM_MS = 2500;              // armar el temporizador de precisión
  const ATK_INTO_SECOND_MS = 500;       // llegar al servidor a mitad del segundo objetivo

  const atk = {
    queue: [], world: [], worldById: new Map(), worldLoaded: false, worldLoading: false, worldTriedAt: 0,
    view: 'new', infoCache: new Map(), worker: null, timers: new Map(), log: [],
    form: {
      source: null, target: null, search: '', units: {}, hero: '', spell: '', type: 'attack', strategy: '',
      mode: 'arrival', time: '', onMissing: 'partial', keep: true, step: 1, info: null, infoError: '', infoLoading: false
    },
    recent: []
  };

  // ---------- reloj del servidor (precisión de ms) ----------
  const clock = { samples: [], lo: null, hi: null, rtt: [], hooked: false };

  function installClockSync() {
    if (clock.hooked) return;
    const $j = UW.jQuery;
    if (!$j) return;
    clock.hooked = true;
    $j(document).on('ajaxSend.novabot', (e, xhr) => { try { xhr.__nbSent = Date.now(); } catch {} });
    $j(document).on('ajaxComplete.novabot', (e, xhr) => {
      try {
        const tRecv = Date.now(), tSend = xhr.__nbSent;
        if (!tSend) return;
        clock.rtt.push(tRecv - tSend); if (clock.rtt.length > 20) clock.rtt.shift();
        const txt = String(xhr.responseText || '');
        const i = txt.lastIndexOf('"_srvtime"');
        if (i < 0) return;
        const m = /"_srvtime"\s*:\s*(\d{9,11})/.exec(txt.slice(i, i + 40));
        if (!m) return;
        addClockSample(+m[1] * 1000, tSend, tRecv);
      } catch {}
    });
  }

  // Muestra: el servidor procesó la petición entre tSend y tRecv (hora local) y
  // en ese momento su reloj estaba en [S, S+1000). ⇒ desfase ∈ [S−tRecv, S+1000−tSend].
  function addClockSample(S, tSend, tRecv) {
    clock.samples.push({ lo: S - tRecv, hi: S + 1000 - tSend, at: tRecv });
    const cutoff = Date.now() - 30 * 60000;
    clock.samples = clock.samples.filter((x) => x.at >= cutoff).slice(-300);
    // Intersección de las muestras más recientes que sean coherentes entre sí.
    let lo = -Infinity, hi = Infinity;
    for (let k = clock.samples.length - 1; k >= 0; k--) {
      const s = clock.samples[k];
      const nlo = Math.max(lo, s.lo), nhi = Math.min(hi, s.hi);
      if (nlo > nhi) break;                       // incoherente (salto de hora): se ignora lo más antiguo
      lo = nlo; hi = nhi;
    }
    clock.lo = lo; clock.hi = hi;
  }

  function clockOffset() {
    if (clock.lo !== null && Number.isFinite(clock.lo) && Number.isFinite(clock.hi)) return { off: (clock.lo + clock.hi) / 2, err: (clock.hi - clock.lo) / 2 };
    // Sin muestras aún: reloj del juego (precisión ±1 s).
    try { const s = +UW.Timestamp?.server?.(); if (s > 0) return { off: s * 1000 + 500 - Date.now(), err: 1000 }; } catch {}
    return { off: 0, err: 5000 };
  }
  const srvNow = () => Date.now() + clockOffset().off;
  const latencyOneWay = () => {
    if (!clock.rtt.length) return 60;
    const v = clock.rtt.slice().sort((a, b) => a - b);
    return Math.min(1500, v[Math.floor(v.length / 2)] / 2);
  };
  // Hora "de pared" del servidor (la que se ve en el juego).
  const srvGmt = () => { try { return (+UW.Timestamp?.serverGMTOffset || +UW.Game?.server_gmt_offset || 0) * 1000; } catch { return 0; } };
  const two = (n) => String(n).padStart(2, '0');
  const wall = (ms) => new Date(ms + srvGmt());
  const fmtClock = (ms, tenths = false) => {
    if (!Number.isFinite(ms)) return '--:--:--';
    const d = wall(ms);
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}${tenths ? `.${Math.floor(d.getUTCMilliseconds() / 100)}` : ''}`;
  };
  function dayWord(ms) {
    const a = wall(srvNow()), b = wall(ms);
    const days = Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86400000);
    return days === 0 ? 'hoy' : days === 1 ? 'mañana' : days === -1 ? 'ayer' : `${two(b.getUTCDate())}/${two(b.getUTCMonth() + 1)}`;
  }
  const fmtWhen = (ms) => (Number.isFinite(ms) ? `${dayWord(ms)} ${fmtClock(ms)}` : '--');
  const fmtDur = (ms) => { if (!Number.isFinite(ms)) return '--:--:--'; const n = Math.max(0, Math.round(ms / 1000)); return `${two(Math.floor(n / 3600))}:${two(Math.floor(n % 3600 / 60))}:${two(n % 60)}`; };
  function fmtCount(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 0) return 'ya';
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return fmtDur(ms);
  }

  // "22:36:14" (hora del juego) → próximo instante futuro (epoch ms). Admite "223614".
  function normTime(v) {
    const digits = String(v || '').replace(/\D/g, '');
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(String(v).trim())) return String(v).trim().padStart(8, '0');
    if (digits.length === 6) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4)}`;
    return String(v || '').trim();
  }
  function nextWallTime(hms, notBefore) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(hms);
    if (!m || +m[1] > 23 || +m[2] > 59 || +m[3] > 59) return null;
    const d = wall(notBefore);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +m[1], +m[2], +m[3]) - srvGmt();
    while (t <= notBefore) t += 86400000;
    return t;
  }

  // ---------- temporizador en Web Worker (no se frena en segundo plano) ----------
  function atkWorker() {
    if (atk.worker !== null) return atk.worker;
    try {
      const code = 'const t={};onmessage=(e)=>{const d=e.data;if(d.cmd==="at"){clearTimeout(t[d.id]);t[d.id]=setTimeout(()=>{delete t[d.id];postMessage(d.id)},Math.max(0,d.delay))}else if(d.cmd==="clear"){clearTimeout(t[d.id]);delete t[d.id]}else if(d.cmd==="every"){setInterval(()=>postMessage("__tick"),d.ms)}}';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      w.onmessage = (e) => {
        if (e.data === '__tick') { atkHeartbeat(); return; }
        const fn = atk.timers.get(e.data); atk.timers.delete(e.data); if (fn) fn();
      };
      atk.worker = w;
    } catch (e) { console.warn('[NOVABOT][ataques] Worker no disponible, uso temporizadores normales:', e); atk.worker = false; }
    return atk.worker;
  }
  function atkTimerAt(id, delay, fn) {
    atkTimerClear(id);
    const w = atkWorker();
    atk.timers.set(id, fn);
    if (w) w.postMessage({ cmd: 'at', id, delay });
    else setTimeout(() => { const f = atk.timers.get(id); atk.timers.delete(id); if (f) f(); }, Math.max(0, delay));
  }
  function atkTimerClear(id) {
    atk.timers.delete(id);
    if (atk.worker) atk.worker.postMessage({ cmd: 'clear', id });
  }

  // ---------- mundo: ciudades, jugadores, alianzas ----------
  async function atkLoadWorld() {
    if (atk.worldLoaded || atk.worldLoading || Date.now() - atk.worldTriedAt < 60000) return;
    atk.worldLoading = true; atk.worldTriedAt = Date.now();
    try {
      const get = (f) => fetch(`/data/${f}`, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''));
      const [towns, players, allis] = await Promise.all([get('towns.txt'), get('players.txt'), get('alliances.txt')]);
      const dec = (v) => { try { return decodeURIComponent(String(v || '').replace(/\+/g, ' ')); } catch { return String(v || ''); } };
      const al = new Map();
      for (const l of allis.split('\n')) { const p = l.split(','); if (+p[0]) al.set(+p[0], dec(p[1])); }
      const pl = new Map();
      for (const l of players.split('\n')) { const p = l.split(','); if (+p[0]) pl.set(+p[0], { name: dec(p[1]), ally: al.get(+p[2]) || '' }); }
      const own = new Set(allTownIds());
      const arr = [], map = new Map();
      for (const l of towns.split('\n')) {
        const p = l.split(','); const id = +p[0]; if (!id) continue;
        const who = pl.get(+p[1]);
        const t = { id, name: dec(p[2]), ix: +p[3], iy: +p[4], points: +p[6] || 0, player: +p[1] ? (who?.name || `Jugador #${p[1]}`) : 'Abandonada', ally: who?.ally || '', own: own.has(id) };
        arr.push(t); map.set(id, t);
      }
      atk.world = arr; atk.worldById = map; atk.worldLoaded = arr.length > 0;
    } catch (e) { console.warn('[NOVABOT][ataques] no se pudo cargar el mundo:', e); }
    atk.worldLoading = false;
    if (atk.worldLoaded && state.activeTab === 'ataques') renderBody();
  }
  const normTxt = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  // Acepta nombre, jugador, alianza, id, [town]123[/town] o el enlace #eyJ… del juego.
  function atkSearch(q) {
    const raw = String(q || '').trim();
    const bb = /\[town\](\d+)\[\/town\]/i.exec(raw) || /^(\d{1,7})$/.exec(raw);
    if (bb) { const t = atk.worldById.get(+bb[1]); return t ? [t] : []; }
    const link = /#([A-Za-z0-9+/=]{12,})/.exec(raw);
    if (link) { try { const o = JSON.parse(atob(link[1])); const t = atk.worldById.get(+o.id); if (t) return [t]; } catch {} }
    const n = normTxt(raw);
    if (n.length < 2) return [];
    return atk.world.filter((t) => normTxt(t.name).includes(n) || normTxt(t.player).includes(n) || (t.ally && normTxt(t.ally).includes(n)))
      .sort((a, b) => (normTxt(a.name).startsWith(n) ? 0 : 1) - (normTxt(b.name).startsWith(n) ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  // ---------- héroes, hechizos, tropas ----------
  function heroModels() { try { return [].concat(UW.MM.getCollections()?.PlayerHero || []).flatMap((c) => c?.models || []); } catch { return []; } }
  const mval = (m, k) => { try { const v = m?.get?.(k); if (v !== undefined) return v; } catch {} return m?.attributes?.[k]; };
  function heroIdOf(m) { try { const v = m?.getId?.(); if (v != null) return String(v); } catch {} const v = mval(m, 'hero_id') ?? mval(m, 'id'); return v == null ? '' : String(v); }
  function heroTownOf(m) {
    for (const fn of ['getHomeTownId', 'getOriginTownId', 'getTownId']) { try { const v = +m?.[fn]?.(); if (v > 0) return v; } catch {} }
    for (const k of ['home_town_id', 'origin_town_id', 'town_id']) { const v = +mval(m, k); if (v > 0) return v; }
    return null;
  }
  function heroesIn(townId) { return heroModels().map((m) => ({ id: heroIdOf(m), town: heroTownOf(m), level: +mval(m, 'level') || null })).filter((h) => h.id && h.town === +townId); }
  const heroName = (id) => UW.GameData?.heroes?.[id]?.name || String(id).replace(/_/g, ' ');
  function powerList() {
    const out = new Map();
    for (const src of [UW.GameData?.powers, UW.GameData?.god_powers].filter(Boolean)) {
      for (const [k, d] of Object.entries(src)) if (!out.has(k) && d && typeof d === 'object') out.set(k, { id: k, name: d.name || k, cost: +(d.favor || d.favor_cost) || 0 });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }
  const U = (id) => UW.GameData?.units?.[id] || {};
  const atkUnitName = (id) => U(id).name || id;
  const isFlying = (id) => !!U(id).flying;
  const isTransport = (id) => +U(id).capacity > 0;
  const isOffensive = (id) => { const u = U(id); return +u.attack > Math.max(+u.def_hack || 0, +u.def_pierce || 0, +u.def_distance || 0) && !isTransport(id) && id !== 'colonize_ship'; };

  // ---------- información del ataque (servidor) ----------
  async function attackInfo(sourceId, targetId, maxAgeMs = 20000) {
    const key = `${sourceId}>${targetId}`;
    const c = atk.infoCache.get(key);
    if (c && Date.now() - c.at < maxAgeMs) return c.info;
    const r = await gpGetAs(sourceId, 'town_info', 'attack', { id: +targetId, nl_init: true });
    let x = r?.json !== undefined ? r.json : r;
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch {} }
    if (!x || typeof x !== 'object' || !x.units) throw new Error(gameErrorText([r]) || 'El juego no devolvió datos del ataque.');
    atk.infoCache.set(key, { at: Date.now(), info: x });
    return x;
  }
  function gpGetAs(townId, controller, action, json) {
    const prev = UW.Game.townId;
    UW.Game.townId = +townId;
    try { return gpGet(controller, action, { ...json, town_id: +townId }); }
    finally { UW.Game.townId = prev; }
  }

  // Duración (ms) con las reglas de Grepolis. Devuelve también la tropa que marca el tiempo.
  function travelFromInfo(info, units, heroId) {
    const sel = Object.entries(units).filter(([, n]) => +n > 0).map(([k]) => k);
    if (!sel.length) return { error: 'Elige al menos una tropa.' };
    const dur = (k) => +info.units?.[k]?.duration || 0;
    const ground = sel.filter((k) => !U(k).is_naval && !isFlying(k));
    const naval = sel.filter((k) => U(k).is_naval);
    let counted;
    if (info.same_island) counted = sel;
    else {
      if (ground.length && !naval.length) return { error: 'Otra isla: las tropas de tierra necesitan barcos de transporte.' };
      counted = sel.filter((k) => U(k).is_naval || isFlying(k));
    }
    let slow = null, max = 0;
    for (const k of counted) if (dur(k) > max) { max = dur(k); slow = k; }
    if (heroId) { const h = +info.heroes_durations?.[heroId]?.duration || 0; if (h > max) { max = h; slow = 'hero'; } }
    if (!max) return { error: 'El juego no devolvió la duración de esas tropas.' };
    return { ms: max * 1000, slow };
  }

  function transportCheck(sourceId, info, units) {
    if (info.same_island) return null;
    const sel = Object.fromEntries(Object.entries(units).filter(([, n]) => +n > 0));
    let c = null;
    try { c = UW.GameDataUnits?.calculateCapacity?.(+sourceId, sel); } catch {}
    if (!c) {
      const berth = +info.researches?.berth || 0;
      c = { total_capacity: 0, needed_capacity: 0 };
      for (const [k, n] of Object.entries(sel)) {
        if (isFlying(k)) continue;
        if (U(k).is_naval) c.total_capacity += isTransport(k) ? (+U(k).capacity + berth) * n : 0;
        else c.needed_capacity += (+U(k).population || 1) * n;
      }
    }
    if (!c.needed_capacity) return null;
    return { need: c.needed_capacity, have: c.total_capacity, ok: c.total_capacity >= c.needed_capacity };
  }

  // Añade los barcos de transporte que falten (primero los lentos, que llevan más).
  function addNeededTransports(sourceId, info, units) {
    const t = transportCheck(sourceId, info, units);
    if (!t || t.ok) return units;
    const out = { ...units };
    const berth = +info.researches?.berth || 0;
    let missing = t.need - t.have;
    for (const k of ['big_transporter', 'small_transporter']) {
      if (missing <= 0) break;
      const cap = (+U(k).capacity || 0) + berth;
      const avail = (+info.units?.[k]?.count || 0) - (+out[k] || 0);
      if (cap <= 0 || avail <= 0) continue;
      const n = Math.min(avail, Math.ceil(missing / cap));
      out[k] = (+out[k] || 0) + n; missing -= n * cap;
    }
    return out;
  }

  // Avisos de Grepolis para un plan concreto.
  function atkWarnings(item, info, arrivalAt) {
    const w = [];
    const type = item.type;
    if (type !== 'support' && info.same_alliance) w.push({ lvl: 'danger', txt: 'El objetivo es de TU ALIANZA.' });
    else if (type !== 'support' && info.alliance_pact) w.push({ lvl: 'danger', txt: 'El objetivo es de una alianza con PACTO.' });
    if (type !== 'support' && info.has_player_protection && +info.protection_ends * 1000 > (arrivalAt || 0)) w.push({ lvl: 'danger', txt: `Objetivo con protección de principiante hasta ${fmtWhen(+info.protection_ends * 1000)}.` });
    const ns = +info.night_starts_at_hour, nd = +info.night_duration;
    if (nd > 0 && arrivalAt) {
      const h = wall(arrivalAt).getUTCHours();
      const inNight = ((h - ns + 24) % 24) < nd;
      if (inNight && type !== 'support') w.push({ lvl: 'warn', txt: `Llega en MODO NOCHE (${two(ns)}:00–${two((ns + nd) % 24)}:00): la defensa cuenta doble.` });
    }
    if (type !== 'support' && info.morale_activated && +info.morale < 100) w.push({ lvl: 'info', txt: `Moral ${Math.round(+info.morale)} %: tu ataque rinde a ese porcentaje.` });
    const tr = transportCheck(item.source, info, item.units);
    if (tr && !tr.ok) w.push({ lvl: 'danger', txt: `Faltan barcos: capacidad ${tr.have}/${tr.need}.`, fix: 'transport' });
    // Tropas ya comprometidas en otros ataques programados desde la misma ciudad.
    const committed = {};
    for (const a of atk.queue) {
      if (a.id === item.id || a.status !== 'pending' || a.source !== item.source) continue;
      if (a.executeAt > (item.executeAt || Infinity)) continue;
      for (const [k, n] of Object.entries(a.units)) committed[k] = (committed[k] || 0) + (+n || 0);
    }
    const short = Object.entries(item.units).filter(([k, n]) => +n > 0 && (+info.units?.[k]?.count || 0) - (committed[k] || 0) < +n);
    if (short.length) w.push({ lvl: 'warn', txt: `Tropas también usadas en otro ataque anterior: ${short.map(([k]) => atkUnitName(k)).join(', ')}.` });
    return w;
  }

  // ---------- cola ----------
  function atkLoad() { try { atk.queue = JSON.parse(localStorage.getItem(ATK_KEY) || '[]'); } catch { atk.queue = []; } }
  function atkSave() {
    try { localStorage.setItem(ATK_KEY, JSON.stringify(atk.queue.map(({ _pre, _armed, ...rest }) => rest))); } catch {}
  }
  const atkCorrection = () => clamp(+state.ataques?.correctionMs || 0, -1500, 1500);

  function buildPayload(a, info) {
    const p = { id: +a.target, type: a.type, nl_init: true };
    const used = {}, missing = [];
    let total = 0;
    for (const [k, v] of Object.entries(a.units)) {
      const req = Math.max(0, Math.floor(+v || 0)); if (!req) continue;
      const have = Math.max(0, Math.floor(+info?.units?.[k]?.count || 0));
      const n = Math.min(req, have);
      if (n > 0) { p[k] = n; used[k] = n; total += n; }
      if (n < req) missing.push(`${atkUnitName(k)} ${n}/${req}`);
    }
    if (!total) throw new Error('No queda ninguna de las tropas elegidas en la ciudad.');
    if (missing.length && a.onMissing === 'skip') throw new Error(`Faltan tropas (${missing.join(', ')}); configurado para no enviar.`);
    if (a.type === 'attack' && a.strategy) p.attacking_strategy = [a.strategy];
    if (a.spell) p.power_id = a.spell;
    if (a.hero && heroesIn(a.source).some((h) => h.id === String(a.hero))) p.heroes = a.hero;
    return { payload: p, used, missing };
  }

  // Llegada real que devuelve el juego (arrival_at en las notificaciones).
  function arrivalFromResponse(res, expectedMs) {
    let txt = ''; try { txt = JSON.stringify(res); } catch {}
    const vals = [...txt.matchAll(/arrival_at\\*"?\s*:\s*\\*"?(\d{10})/g)].map((m) => +m[1] * 1000);
    if (!vals.length) return null;
    vals.sort((a, b) => Math.abs(a - expectedMs) - Math.abs(b - expectedMs));
    return Math.abs(vals[0] - expectedMs) < 6 * 3600000 ? vals[0] : null;
  }

  async function atkFire(a) {
    if (a.status !== 'pending') return;
    a.status = 'sending'; atkRefreshQueue();
    try {
      let pre = a._pre;
      if (!pre || Date.now() - pre.at > 20000) {
        const info = await attackInfo(a.source, a.target, 0);
        pre = { at: Date.now(), ...buildPayload(a, info) };
      }
      const res = await gpPostAs(a.source, 'town_info', 'send_units', pre.payload);
      a.status = 'sent'; a.sentAt = srvNow();
      if (pre.missing.length) a.note = `Enviado con menos tropas: ${pre.missing.join(', ')}`;
      const expected = a.executeAt + a.duration;
      const real = arrivalFromResponse(res, expected);
      if (real) {
        a.realArrival = real;
        const errS = Math.round((real - expected) / 1000);
        a.arrivalErr = errS;
        // Auto-corrección: si llegó 1 s tarde/pronto, adelantar/retrasar los próximos.
        // (solo con el reloj bien sincronizado; si no, el error sería del reloj, no del disparo)
        if (errS !== 0 && Math.abs(errS) <= 2 && clockOffset().err < 250) {
          state.ataques.correctionMs = clamp(atkCorrection() + (errS > 0 ? 250 : -250), -1500, 1500);
          saveState();
        }
      }
      atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${a.type === 'support' ? 'apoyo' : 'ataque'} enviado${real ? ` · llega ${fmtClock(real)}${a.arrivalErr ? ` (${a.arrivalErr > 0 ? '+' : ''}${a.arrivalErr} s)` : ' ✓ exacto'}` : ''}.`, 'ok');
    } catch (e) {
      a.status = /configurado para no enviar/.test(e.message) ? 'skipped' : 'error';
      a.error = e.message;
      atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${e.message}`, 'error');
    }
    delete a._pre; delete a._armed;
    atkSave(); atkRefreshQueue();
  }

  async function atkRecheck(a) {
    try {
      const info = await attackInfo(a.source, a.target, 0);
      const t = travelFromInfo(info, a.units, a.hero);
      if (t.error) return;
      a.duration = t.ms;
      if (a.mode === 'arrival') {
        const exec = a.wantAt - t.ms;
        if (exec < srvNow() + 300) { a.executeAt = Math.ceil((srvNow() + 1500) / 1000) * 1000; a.note = 'La llegada pedida ya no era alcanzable: sale en cuanto se pueda.'; }
        else a.executeAt = exec;
      }
      a.arrivalAt = a.executeAt + a.duration;
      atkSave();
    } catch {}
  }

  // Latido (cada 200 ms, desde el Worker): recálculos, precarga, armado y perdidos.
  function atkHeartbeat() {
    const now = srvNow();
    for (const a of atk.queue) {
      if (a.status !== 'pending') continue;
      const left = a.executeAt - now;
      if (left < -ATK_MISS_TOLERANCE_MS) {
        a.status = 'missed'; a.error = `No se envió: la hora de salida pasó hace ${fmtDur(-left)} (¿página cerrada o PC en reposo?).`;
        atkLog(`${farmTownName(a.source)} → ${a.targetName}: perdido (no se envía tarde).`, 'error');
        atkSave(); atkRefreshQueue(); continue;
      }
      if (a.mode === 'arrival' && !a._rechecked && left < ATK_RECHECK_MS && left > ATK_PREFETCH_MS) {
        a._rechecked = true; atkRecheck(a);
      }
      if (!a._pre && !a._prefetching && left < ATK_PREFETCH_MS && left > 400) {
        a._prefetching = true;
        attackInfo(a.source, a.target, 0)
          .then((info) => { a._pre = { at: Date.now(), ...buildPayload(a, info) }; })
          .catch(() => {})
          .finally(() => { a._prefetching = false; });
      }
      if (!a._armed && left < ATK_ARM_MS) {
        a._armed = true;
        // Hora local a la que disparar para que llegue al servidor a mitad del segundo.
        const fireLocal = a.executeAt + ATK_INTO_SECOND_MS - clockOffset().off - latencyOneWay() - atkCorrection();
        atkTimerAt(a.id, fireLocal - Date.now(), () => atkFire(a));
      }
    }
  }

  function startAttackEngine() {
    if (atk.started) return;
    atk.started = true;
    if (!state.ataques) state.ataques = { correctionMs: 0 };
    atkLoad();
    for (const a of atk.queue) if (a.status === 'sending') { a.status = 'error'; a.error = 'La página se recargó mientras se enviaba: revisa en el juego si salió.'; }
    atkSave();
    installClockSync();
    const w = atkWorker();
    if (w) w.postMessage({ cmd: 'every', ms: 200 });
    else setInterval(atkHeartbeat, 200);
    setInterval(atkUpdateLive, 100);
  }

  function atkLog(text, kind = 'info') {
    atk.log.unshift({ at: Date.now(), text, kind });
    atk.log.length = Math.min(atk.log.length, 40);
    if (atkLogEl) paintLog(atkLogEl, atk.log);
  }
  function paintLog(box, list) {
    box.innerHTML = '';
    if (!list.length) { box.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin actividad todavía.')); return; }
    for (const e of list) box.appendChild(el('div', { class: `nb-log-item nb-log-${e.kind}` }, `${new Date(e.at).toLocaleTimeString('es-ES')} · ${e.text}`));
  }

  // ---------- UI ----------
  let atkQueueEl = null, atkPlanEl = null, atkLogEl = null;

  function nextPending() { return atk.queue.filter((a) => a.status === 'pending').sort((a, b) => a.executeAt - b.executeAt)[0] || null; }

  function atkUpdateLive() {
    if (state.activeTab !== 'ataques' && state.activeTab !== 'inicio') return;
    const now = srvNow();
    const c = $('#nb-atk-clock'); if (c) c.textContent = fmtClock(now, true);
    const p = $('#nb-atk-prec'); if (p) { const e = clockOffset().err; p.textContent = e >= 1000 ? 'sincronizando…' : `±${Math.round(e)} ms`; p.classList.toggle('nb-ok', e < 150); }
    for (const n of $$('[data-atk-at]')) n.textContent = fmtCount(+n.dataset.atkAt - now);
  }

  function atkRefreshQueue() {
    if (!atkQueueEl || state.activeTab !== 'ataques') return;
    atkQueueEl.innerHTML = '';
    const order = { sending: 0, pending: 1, error: 2, missed: 2, skipped: 3, sent: 4 };
    const list = atk.queue.slice().sort((a, b) => (order[a.status] - order[b.status]) || (a.status === 'sent' ? b.executeAt - a.executeAt : a.executeAt - b.executeAt));
    if (!list.length) { atkQueueEl.appendChild(el('p', { class: 'nb-placeholder' }, 'No hay nada programado.')); return; }
    const label = { pending: 'programado', sending: 'enviando…', sent: 'enviado', error: 'error', missed: 'perdido', skipped: 'no enviado' };
    for (const a of list) {
      const units = Object.entries(a.units).map(([k, n]) => `${n} ${atkUnitName(k)}`).join(' · ');
      const actions = [];
      if (a.status === 'pending') {
        actions.push(el('span', { class: 'nb-mini', title: 'Duplicar llegando 1 s después (tren)', onclick: () => atkDuplicate(a) }, '+1s'));
        actions.push(el('span', { class: 'nb-mini', title: 'Editar', onclick: () => atkEdit(a) }, '✎'));
        actions.push(el('span', { class: 'nb-mini nb-mini-danger', title: 'Cancelar', onclick: () => { atkTimerClear(a.id); atk.queue = atk.queue.filter((x) => x !== a); atkSave(); atkRefreshQueue(); } }, '✕'));
      } else {
        if (a.status === 'missed' || a.status === 'error') actions.push(el('span', { class: 'nb-mini', title: 'Volver a programar (editar)', onclick: () => atkEdit(a) }, '✎'));
        actions.push(el('span', { class: 'nb-mini', title: 'Quitar de la lista', onclick: () => { atk.queue = atk.queue.filter((x) => x !== a); atkSave(); atkRefreshQueue(); } }, '✕'));
      }
      atkQueueEl.appendChild(el('div', { class: `nb-atk-item nb-atk-${a.status}` }, [
        el('div', { class: 'nb-atk-top' }, [
          el('span', { class: `nb-tag nb-tag-${a.type === 'support' ? 'support' : 'attack'}` }, a.type === 'support' ? 'apoyo' : a.type === 'revolt' ? 'revuelta' : 'ataque'),
          el('span', { class: 'nb-atk-route' }, `${farmTownName(a.source)} → ${a.targetName}`),
          el('span', { class: `nb-tag nb-tag-${a.status}` }, label[a.status] || a.status)
        ]),
        el('div', { class: 'nb-atk-times' }, [
          el('div', {}, [el('span', {}, 'Sale'), el('b', {}, fmtWhen(a.executeAt))]),
          el('div', {}, [el('span', {}, 'Llega'), el('b', {}, fmtWhen(a.realArrival || a.arrivalAt))]),
          a.status === 'pending' || a.status === 'sending'
            ? el('div', { class: 'nb-atk-count' }, [el('span', {}, 'Falta'), el('b', { 'data-atk-at': a.executeAt }, fmtCount(a.executeAt - srvNow()))])
            : a.arrivalErr !== undefined && a.status === 'sent'
              ? el('div', {}, [el('span', {}, 'Precisión'), el('b', { class: a.arrivalErr ? 'nb-warn-txt' : 'nb-ok' }, a.arrivalErr ? `${a.arrivalErr > 0 ? '+' : ''}${a.arrivalErr} s` : 'exacta')])
              : null
        ]),
        el('div', { class: 'nb-goal-sub' }, `${units}${a.hero ? ` · héroe ${heroName(a.hero)}` : ''}${a.spell ? ' · hechizo' : ''}`),
        a.error ? el('div', { class: 'nb-goal-sub nb-err' }, a.error) : a.note ? el('div', { class: 'nb-goal-sub' }, a.note) : null,
        el('div', { class: 'nb-atk-actions' }, actions)
      ]));
    }
    atkUpdateLive();
  }

  function atkEdit(a) {
    const f = atk.form;
    Object.assign(f, {
      source: a.source, target: atk.worldById.get(a.target) || { id: a.target, name: a.targetName, player: '', ally: '', points: 0 },
      units: { ...a.units }, hero: a.hero || '', spell: a.spell || '', type: a.type, strategy: a.strategy || '',
      mode: a.mode, time: fmtClock(a.wantAt), onMissing: a.onMissing || 'partial', info: null
    });
    atkTimerClear(a.id);
    atk.queue = atk.queue.filter((x) => x !== a);
    atkSave();
    atk.view = 'new';
    renderBody();
    atkLoadInfo();
  }

  function atkDuplicate(a) {
    const b = { ...a, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, status: 'pending', note: '', error: '' };
    delete b._pre; delete b._armed; delete b._rechecked; delete b.realArrival; delete b.arrivalErr;
    b.wantAt = a.wantAt + 1000; b.executeAt = a.executeAt + 1000; b.arrivalAt = a.arrivalAt + 1000;
    atk.queue.push(b); atkSave(); atkRefreshQueue();
    atkLog(`Duplicado: ${b.targetName}, llega ${fmtClock(b.arrivalAt)}.`, 'info');
  }

  // Carga la info del servidor para el par origen→objetivo del formulario.
  async function atkLoadInfo() {
    const f = atk.form;
    if (!f.source || !f.target) { f.info = null; return; }
    const key = `${f.source}>${f.target.id}`;
    f.infoLoading = true; f.infoError = ''; f.infoKey = key;
    atkPaintPlan();
    try {
      const info = await attackInfo(f.source, f.target.id);
      if (f.infoKey !== key) return;
      f.info = info;
      if (!info.attack_strategies?.[f.strategy]) f.strategy = Object.keys(info.attack_strategies || {})[0] || '';
      if (f.type !== 'support' && !info.attack_types?.[f.type]) f.type = 'attack';
    } catch (e) { if (f.infoKey === key) { f.info = null; f.infoError = e.message; } }
    f.infoLoading = false;
    if (state.activeTab === 'ataques' && atk.view === 'new') renderBody();
  }

  function atkComputePlan() {
    const f = atk.form;
    if (!f.info) return null;
    const t = travelFromInfo(f.info, f.units, f.hero);
    if (t.error) return { error: t.error };
    const now = srvNow();
    const hms = normTime(f.time);
    let executeAt = null, arrivalAt = null, wantAt = null, note = '';
    if (/^\d{2}:\d{2}:\d{2}$/.test(hms)) {
      if (f.mode === 'arrival') {
        wantAt = nextWallTime(hms, now + t.ms + 1500);
        const today = nextWallTime(hms, now);
        if (today && wantAt !== today) note = `Hoy ya no llega a las ${hms} (lo antes posible: ${fmtWhen(now + t.ms)}): se programa para ${dayWord(wantAt)}.`;
        executeAt = wantAt - t.ms; arrivalAt = wantAt;
      } else {
        wantAt = nextWallTime(hms, now + 1500);
        executeAt = wantAt; arrivalAt = wantAt + t.ms;
      }
    }
    return { ms: t.ms, slow: t.slow, executeAt, arrivalAt, wantAt, note };
  }

  function atkPaintPlan() {
    if (!atkPlanEl) return;
    const f = atk.form;
    atkPlanEl.innerHTML = '';
    if (f.infoLoading) { atkPlanEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Consultando al juego…')); return; }
    if (f.infoError) { atkPlanEl.appendChild(el('p', { class: 'nb-placeholder nb-err' }, f.infoError)); return; }
    const plan = atkComputePlan();
    if (!plan) { atkPlanEl.appendChild(el('p', { class: 'nb-placeholder' }, 'Elige origen, objetivo y tropas.')); return; }
    if (plan.error) { atkPlanEl.appendChild(el('p', { class: 'nb-placeholder nb-err' }, plan.error)); return; }
    atkPlanEl.appendChild(el('div', { class: 'nb-stats' }, [
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Viaje'), el('b', {}, fmtDur(plan.ms)), el('small', {}, plan.slow === 'hero' ? 'marca el héroe' : plan.slow ? `marca: ${atkUnitName(plan.slow)}` : '')]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Salida'), el('b', {}, plan.executeAt ? fmtClock(plan.executeAt) : '—'), el('small', {}, plan.executeAt ? dayWord(plan.executeAt) : '')]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Llegada'), el('b', {}, plan.arrivalAt ? fmtClock(plan.arrivalAt) : '—'), el('small', {}, plan.arrivalAt ? dayWord(plan.arrivalAt) : '')])
    ]));
    if (plan.note) atkPlanEl.appendChild(el('div', { class: 'nb-alert nb-alert-warn' }, plan.note));
    const draft = { id: null, source: f.source, type: f.type, units: f.units, executeAt: plan.executeAt };
    for (const w of atkWarnings(draft, f.info, plan.arrivalAt)) {
      const box = el('div', { class: `nb-alert nb-alert-${w.lvl}` }, w.txt);
      if (w.fix === 'transport') box.appendChild(el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { f.units = addNeededTransports(f.source, f.info, f.units); renderBody(); } }, 'Añadir barcos'));
      atkPlanEl.appendChild(box);
    }
  }

  async function atkSubmit() {
    const f = atk.form;
    if (!f.target) throw new Error('Elige un objetivo.');
    if (f.target.id && allTownIds().includes(+f.target.id) && f.type !== 'support') throw new Error('Es una ciudad tuya: para mandar tropas usa "Apoyo".');
    const info = await attackInfo(f.source, f.target.id, 0);
    f.info = info;
    const plan = atkComputePlan();
    if (!plan || plan.error) throw new Error(plan?.error || 'Plan no válido.');
    if (!plan.executeAt) throw new Error('Pon una hora válida (HH:MM:SS).');
    const units = Object.fromEntries(Object.entries(f.units).filter(([, n]) => +n > 0).map(([k, n]) => [k, Math.floor(+n)]));
    for (const [k, n] of Object.entries(units)) if (n > (+info.units?.[k]?.count || 0)) throw new Error(`Solo hay ${+info.units?.[k]?.count || 0} ${atkUnitName(k)} en la ciudad.`);
    const item = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, source: +f.source, target: +f.target.id,
      targetName: f.target.name + (f.target.player ? ` (${f.target.player})` : ''), type: f.type, strategy: f.strategy,
      units, hero: f.hero, spell: f.spell, mode: f.mode, wantAt: plan.wantAt, duration: plan.ms,
      executeAt: plan.executeAt, arrivalAt: plan.arrivalAt, onMissing: f.onMissing, status: 'pending',
      note: plan.note || '', error: '', createdAt: Date.now()
    };
    const danger = atkWarnings(item, info, plan.arrivalAt).filter((w) => w.lvl === 'danger');
    if (danger.length && !confirm(`Atención:\n· ${danger.map((w) => w.txt).join('\n· ')}\n\n¿Programar igualmente?`)) return;
    atk.queue.push(item); atkSave();
    atk.recent = [f.target, ...atk.recent.filter((t) => t.id !== f.target.id)].slice(0, 6);
    atkLog(`Programado: ${farmTownName(item.source)} → ${item.targetName}, sale ${fmtWhen(item.executeAt)}, llega ${fmtWhen(item.arrivalAt)}.`, 'ok');
    // Tren: mantener objetivo y avanzar la hora para el siguiente.
    if (f.keep) { f.units = {}; if (/^\d{2}:\d{2}:\d{2}$/.test(normTime(f.time))) f.time = fmtClock(nextWallTime(normTime(f.time), srvNow()) + (+f.step || 1) * 1000); }
    else Object.assign(f, { target: null, units: {}, time: '', info: null, hero: '', spell: '' });
    renderBody();
  }

  function renderAtaquesTab() {
    atkLoadWorld();
    installClockSync();
    const f = atk.form;
    const towns = allTownIds().sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    if (!f.source || !towns.includes(+f.source)) f.source = +UW.Game?.townId || towns[0];

    // Cabecera: reloj + siguiente
    const nx = nextPending();
    bodyEl.appendChild(el('div', { class: 'nb-card nb-hero nb-hero-atk' }, [
      el('div', {}, [el('div', { class: 'nb-hero-label' }, 'Hora del servidor'), el('div', { class: 'nb-hero-value nb-mono', id: 'nb-atk-clock' }, '--:--:--'), el('div', { class: 'nb-hero-sub', id: 'nb-atk-prec' }, '')]),
      nx ? el('div', { class: 'nb-hero-next' }, [el('div', { class: 'nb-hero-label' }, 'Próxima salida'), el('div', { class: 'nb-hero-value nb-mono', 'data-atk-at': nx.executeAt }, ''), el('div', { class: 'nb-hero-sub' }, `${farmTownName(nx.source)} → ${nx.targetName}`)]) : null
    ]));

    const pendingN = atk.queue.filter((a) => a.status === 'pending').length;
    bodyEl.appendChild(el('div', { class: 'nb-seg nb-seg-main' }, [['new', 'Nuevo'], ['queue', `Programados (${pendingN})`]].map(([v, l]) =>
      el('span', { class: `nb-seg-btn${atk.view === v ? ' active' : ''}`, onclick: () => { atk.view = v; renderBody(); } }, l))));

    if (atk.view === 'queue') {
      atkQueueEl = el('div', { class: 'nb-atk-list' });
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-head' }, [
          el('div', { class: 'nb-card-title' }, 'Programados'),
          el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { atk.queue = atk.queue.filter((a) => a.status === 'pending' || a.status === 'sending'); atkSave(); atkRefreshQueue(); } }, 'Limpiar terminados')
        ]),
        atkQueueEl
      ]));
      atkRefreshQueue();
    } else {
      atkQueueEl = null;
      renderAtkForm(towns);
    }

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    atkLogEl = logBox; paintLog(logBox, atk.log);
    atkUpdateLive();
  }

  function renderAtkForm(towns) {
    const f = atk.form;
    const info = f.info && f.infoKey === `${f.source}>${f.target?.id}` ? f.info : null;
    if (f.target && !info && !f.infoLoading && !f.infoError) atkLoadInfo();

    // 1) Origen
    const srcSel = el('select', { class: 'nb-input' });
    for (const id of towns) { const o = el('option', { value: id }, farmTownName(id)); if (id === +f.source) o.selected = true; srcSel.appendChild(o); }
    srcSel.addEventListener('change', () => { f.source = +srcSel.value; f.units = {}; f.hero = ''; f.info = null; f.infoError = ''; renderBody(); });

    // 2) Objetivo
    let targetBox;
    if (f.target) {
      targetBox = el('div', { class: 'nb-selected' }, [
        el('div', { class: 'nb-selected-main' }, [
          el('b', {}, f.target.name),
          el('span', { class: 'nb-add-level' }, [f.target.player, f.target.ally ? ` · ${f.target.ally}` : '', f.target.points ? ` · ${f.target.points.toLocaleString('es-ES')} pts` : '', info ? (info.same_island ? ' · misma isla' : ' · otra isla') : ''].join(''))
        ]),
        el('span', { class: 'nb-mini', title: 'Cambiar objetivo', onclick: () => { f.target = null; f.info = null; f.infoError = ''; renderBody(); } }, '✕')
      ]);
    } else {
      const search = el('input', { class: 'nb-input', type: 'text', placeholder: atk.worldLoaded ? 'Nombre, jugador, alianza, id o [town]…[/town]' : 'Cargando ciudades del mundo…', value: f.search });
      if (!atk.worldLoaded) search.disabled = true;
      const sugg = el('div', { class: 'nb-add-list' });
      const pick = (t) => { f.target = t; f.search = ''; f.info = null; f.infoError = ''; renderBody(); };
      const paint = () => {
        sugg.innerHTML = '';
        const r = atkSearch(search.value);
        if (search.value.trim().length >= 2 && !r.length) sugg.appendChild(el('p', { class: 'nb-placeholder' }, 'Sin coincidencias.'));
        for (const t of r) sugg.appendChild(el('div', { class: 'nb-add-row nb-clickable', onclick: () => pick(t) }, [
          el('div', { class: 'nb-add-name' }, [el('span', {}, t.name), t.own ? el('span', { class: 'nb-tag nb-tag-support' }, 'tuya') : null,
            el('span', { class: 'nb-add-level' }, `${t.player}${t.ally ? ` · ${t.ally}` : ''} · ${t.points.toLocaleString('es-ES')} pts`)])
        ]));
      };
      search.addEventListener('input', () => { f.search = search.value; paint(); });
      search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = atkSearch(search.value); if (r[0]) pick(r[0]); } });
      paint();
      const recents = atk.recent.length ? el('div', { class: 'nb-chips' }, atk.recent.map((t) => el('span', { class: 'nb-chip', onclick: () => pick(t) }, t.name))) : null;
      targetBox = el('div', {}, [search, recents, sugg]);
    }

    // 3) Tipo / estrategia
    const types = Object.entries(info?.attack_types || { attack: 'Ataque' }).concat([['support', 'Apoyo']]);
    const typeSeg = el('div', { class: 'nb-seg' }, types.map(([k, l]) => el('span', { class: `nb-seg-btn${f.type === k ? ' active' : ''}`, onclick: () => { f.type = k; renderBody(); } }, l)));
    const strategies = Object.entries(info?.attack_strategies || {});
    let stratSel = null;
    if (strategies.length > 1 && f.type !== 'support') {
      stratSel = el('select', { class: 'nb-input' });
      for (const [k, l] of strategies) { const o = el('option', { value: k }, l); if (k === f.strategy) o.selected = true; stratSel.appendChild(o); }
      stratSel.addEventListener('change', () => { f.strategy = stratSel.value; });
    }

    // 4) Tropas (disponibles según el juego, con su duración)
    const counts = {};
    if (info) for (const [k, u] of Object.entries(info.units || {})) counts[k] = +u.count || 0;
    else Object.assign(counts, townUnitsHave(f.source));
    const rows = Object.entries(counts).filter(([k, n]) => n > 0 && k !== 'militia' && UW.GameData?.units?.[k])
      .sort(([a], [b]) => ((U(a).is_naval ? 1 : 0) - (U(b).is_naval ? 1 : 0)) || atkUnitName(a).localeCompare(atkUnitName(b), 'es'));
    const plan = info ? atkComputePlan() : null;
    const grid = el('div', { class: 'nb-units-grid' });
    for (const [k, n] of rows) {
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '0', max: String(n), placeholder: '0', value: f.units[k] || '' });
      input.addEventListener('input', () => { f.units[k] = clamp(pos(input.value, 0), 0, n); if (+input.value > n) input.value = n; atkPaintPlan(); markSlow(); });
      const d = +info?.units?.[k]?.duration;
      grid.appendChild(el('div', { class: `nb-unit-cell${plan?.slow === k ? ' nb-slow' : ''}`, 'data-unit': k, title: d ? `Viaje de ${atkUnitName(k)}: ${fmtDur(d * 1000)}` : atkUnitName(k) }, [
        el('div', { class: 'nb-unit-info' }, [el('span', { class: 'nb-unit-name' }, atkUnitName(k)), el('span', { class: 'nb-unit-sub' }, `${n}${d ? ` · ${fmtDur(d * 1000)}` : ''}`)]),
        el('span', { class: 'nb-mini', title: 'Todas', onclick: () => { input.value = n; f.units[k] = n; atkPaintPlan(); markSlow(); } }, 'máx'),
        input
      ]));
    }
    const setUnits = (pred) => { f.units = {}; for (const [k, n] of rows) if (pred(k)) f.units[k] = n; renderBody(); };
    function markSlow() {
      const p = atkComputePlan();
      for (const c of $$('.nb-unit-cell', grid)) c.classList.toggle('nb-slow', !!p && p.slow === c.dataset.unit);
    }

    // 5) Héroe / hechizo
    const heroSel = el('select', { class: 'nb-input' });
    heroSel.appendChild(el('option', { value: '' }, 'Sin héroe'));
    for (const h of heroesIn(f.source)) { const o = el('option', { value: h.id }, `${heroName(h.id)}${h.level ? ` · nv ${h.level}` : ''}`); if (h.id === f.hero) o.selected = true; heroSel.appendChild(o); }
    heroSel.addEventListener('change', () => { f.hero = heroSel.value; atkPaintPlan(); });
    const spellSel = el('select', { class: 'nb-input' });
    spellSel.appendChild(el('option', { value: '' }, 'Sin hechizo'));
    for (const p of powerList()) { const o = el('option', { value: p.id }, `${p.name}${p.cost ? ` · ${p.cost} favor` : ''}`); if (p.id === f.spell) o.selected = true; spellSel.appendChild(o); }
    spellSel.addEventListener('change', () => { f.spell = spellSel.value; });

    // 6) Hora
    const modeSeg = el('div', { class: 'nb-seg' }, [['arrival', 'Llegar a las'], ['departure', 'Salir a las']].map(([m, l]) =>
      el('span', { class: `nb-seg-btn${f.mode === m ? ' active' : ''}`, onclick: () => { f.mode = m; renderBody(); } }, l)));
    const timeIn = el('input', { class: 'nb-input nb-input-time', type: 'text', inputmode: 'numeric', placeholder: 'HH:MM:SS', value: f.time, maxlength: '8' });
    timeIn.addEventListener('input', () => { f.time = timeIn.value; atkPaintPlan(); });
    timeIn.addEventListener('blur', () => { const n = normTime(timeIn.value); if (n !== timeIn.value) { timeIn.value = n; f.time = n; atkPaintPlan(); } });
    const shift = (s) => {
      const base = /^\d{2}:\d{2}:\d{2}$/.test(normTime(f.time)) ? nextWallTime(normTime(f.time), srvNow() - 86400000 + 1) : srvNow();
      f.time = fmtClock(base + s * 1000); timeIn.value = f.time; atkPaintPlan();
    };
    const soonest = () => {
      const p = atkComputePlan();
      const base = srvNow() + 15000 + (f.mode === 'arrival' && p?.ms ? p.ms : 0);
      f.time = fmtClock(Math.ceil(base / 1000) * 1000); timeIn.value = f.time; atkPaintPlan();
    };
    const quick = el('div', { class: 'nb-quick' }, [
      el('span', { class: 'nb-mini', onclick: soonest, title: 'Lo antes posible (+15 s)' }, 'ya'),
      el('span', { class: 'nb-mini', onclick: () => shift(-1) }, '−1s'),
      el('span', { class: 'nb-mini', onclick: () => shift(1) }, '+1s'),
      el('span', { class: 'nb-mini', onclick: () => shift(10) }, '+10s'),
      el('span', { class: 'nb-mini', onclick: () => shift(60) }, '+1m'),
      el('span', { class: 'nb-mini', onclick: () => shift(600) }, '+10m')
    ]);

    atkPlanEl = el('div', { class: 'nb-plan' });

    const missSeg = el('div', { class: 'nb-seg nb-seg-sm' }, [['partial', 'Enviar lo que haya'], ['skip', 'No enviar']].map(([v, l]) =>
      el('span', { class: `nb-seg-btn${f.onMissing === v ? ' active' : ''}`, onclick: () => { f.onMissing = v; renderBody(); } }, l)));
    const stepIn = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '0', value: f.step });
    stepIn.addEventListener('change', () => { f.step = Math.max(0, pos(stepIn.value, 1)); });

    const addBtn = el('span', { class: 'nb-btn nb-btn-primary nb-btn-block' }, f.type === 'support' ? 'Programar apoyo' : 'Programar ataque');
    addBtn.addEventListener('click', async () => {
      addBtn.textContent = 'Comprobando con el juego…';
      try { await atkSubmit(); } catch (e) { atkLog(e.message, 'error'); addBtn.textContent = f.type === 'support' ? 'Programar apoyo' : 'Programar ataque'; atkPaintPlan(); }
    });

    const section = (n, title, children) => el('div', { class: 'nb-step' }, [el('div', { class: 'nb-step-head' }, [el('span', { class: 'nb-step-n' }, String(n)), el('span', {}, title)]), ...[].concat(children)]);
    bodyEl.appendChild(el('div', { class: 'nb-card nb-form' }, [
      section(1, 'Origen', srcSel),
      section(2, 'Objetivo', targetBox),
      section(3, 'Tipo', [typeSeg, stratSel]),
      section(4, 'Tropas', rows.length ? [
        el('div', { class: 'nb-quick' }, [
          el('span', { class: 'nb-mini', onclick: () => setUnits(() => true) }, 'Todas'),
          el('span', { class: 'nb-mini', onclick: () => setUnits(isOffensive) }, 'Ofensivas'),
          el('span', { class: 'nb-mini', onclick: () => setUnits((k) => !U(k).is_naval) }, 'Solo tierra'),
          el('span', { class: 'nb-mini', onclick: () => setUnits(() => false) }, 'Ninguna')
        ]),
        grid,
        el('div', { class: 'nb-field-row nb-mt' }, [el('label', { class: 'nb-field' }, ['Héroe', heroSel]), el('label', { class: 'nb-field' }, ['Hechizo', spellSel])])
      ] : el('p', { class: 'nb-placeholder' }, 'No hay tropas en esta ciudad.')),
      section(5, 'Hora del servidor', [modeSeg, el('div', { class: 'nb-time-row' }, [timeIn, quick])]),
      atkPlanEl,
      el('div', { class: 'nb-options' }, [
        el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Si faltan tropas al salir'), missSeg]),
        optionRow('Modo tren', 'Tras programar, mantiene objetivo y adelanta la hora', f.keep, (v) => { f.keep = v; renderBody(); }),
        f.keep ? el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Segundos entre ataques del tren'), stepIn]) : null
      ]),
      addBtn
    ]));
    atkPaintPlan();
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

  // Registro de depuración: guarda en localStorage las últimas peticiones POST
  // que hace el juego (controller, action, datos). Sobrevive a recargas y sirve
  // para ver el formato exacto de una acción hecha a mano. Solo lectura local.
  const DEBUG_KEY = 'novabot_debug_posts';
  function installPostRecorder() {
    const obj = UW.gpAjax;
    if (!obj || typeof obj.ajaxPost !== 'function' || obj.ajaxPost.__nbRec) return;
    const orig = obj.ajaxPost;
    const wrapped = function (controller, action, data) {
      try {
        const list = JSON.parse(localStorage.getItem(DEBUG_KEY) || '[]');
        list.push({ at: new Date().toLocaleString('es-ES'), controller, action, town: UW.Game?.townId, data: JSON.stringify(data).slice(0, 500) });
        localStorage.setItem(DEBUG_KEY, JSON.stringify(list.slice(-40)));
      } catch {}
      return orig.apply(this, arguments);
    };
    try { Object.assign(wrapped, orig); } catch {}
    wrapped.__nbRec = true;
    obj.ajaxPost = wrapped;
  }

  async function init() {
    await waitFor(() => !!document.body);
    buildUI();
    window.addEventListener('resize', () => { applyPanelSize(); applyPanelPosition(); applyFabPosition(); });
    startFarmEngine();
    startBuildEngine();
    startTradeEngine();
    startRecruitEngine();
    startAttackEngine();

    // En cuanto el cliente del juego termine de cargar, refresca el nombre de ciudad.
    waitFor(() => !!(UW.Game && UW.ITowns)).then(() => {
      installPostRecorder();
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