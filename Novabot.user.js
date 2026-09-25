// ==UserScript==
// @name         NOVABOT
// @namespace    https://github.com/victoritis/NOVABOT
// @version      1.13.1
// @description  Panel de control para Grepolis — interfaz propia, sin depender del cliente del juego.
// @author       victoritis
// @match        *://*.grepolis.com/*
// @resource     NOVABOT_CSS https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      gist.githubusercontent.com
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
  const VERSION = '1.13.1';
  const STORAGE_KEY = 'novabot_ui_state_v1';
  // Cuenta (mundo + jugador): TODO lo guardado va por cuenta, para que en el mismo PC
  // otra cuenta no vea ni pise la configuración (ni la nube) de la tuya.
  let ACCOUNT = '';
  const acctKey = (k) => (ACCOUNT ? `${k}__${ACCOUNT}` : k);

  // Evita cargar el script dos veces si Tampermonkey lo reinyecta.
  if (UW.__NOVABOT_ACTIVE__) return;
  UW.__NOVABOT_ACTIVE__ = VERSION;

  const TABS = [
    { id: 'inicio',      label: 'Inicio',        icon: 'home',   disabled: false },
    { id: 'resumen',     label: 'Vista general', icon: 'grid',   disabled: false },
    { id: 'granjas',     label: 'Granjas',       icon: 'farm',   disabled: false },
    { id: 'construccion', label: 'Construcción', icon: 'build',  disabled: false },
    { id: 'investigacion', label: 'Investigación', icon: 'flask', disabled: false },
    { id: 'reclutamiento', label: 'Reclutamiento', icon: 'shield', disabled: false },
    { id: 'comercio',    label: 'Comercio',       icon: 'trade',  disabled: false },
    { id: 'festivales',  label: 'Festivales',     icon: 'star',   disabled: false },
    { id: 'cueva',       label: 'Cueva',          icon: 'cave',   disabled: false },
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
    for (const c of [].concat(children).flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  // Lleva a una tarjeta de otra pestaña y la resalta unos segundos (para ver qué
  // opción está relacionada con cuál).
  function gotoCard(tab, key) {
    state.activeTab = tab; saveState();
    try { buildTabs(); } catch {}
    renderBody();
    setTimeout(() => {
      const card = bodyEl?.querySelector(`[data-nb-card="${key}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('nb-flash'); void card.offsetWidth; card.classList.add('nb-flash');
      setTimeout(() => card.classList.remove('nb-flash'), 3200);
    }, 60);
  }

  /* ---------------------------------------------------------------------------------
     3) ESTADO (posición del panel, pestaña activa, abierto/cerrado...)
  --------------------------------------------------------------------------------- */
  function defaultState() {
    return {
      open: false,
      tourSeen: false,      // ya se ofreció el tour guiado (botón "?")
      newsSeen: '',         // última versión cuyas novedades ya se enseñaron
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
        interleave: true,     // valor por defecto para las ciudades que aún no lo han elegido (ver townInterleave)
        towns: {}             // townId -> { goals: [{id, target}], lastId, interleave } (orden = prioridad; un edificio puede repetirse)
      },
      festivales: {
        enabled: true,
        event: false          // "Festival evento": solo durante el evento; apaga los normales
      },
      investigacion: {
        enabled: true,
        towns: {}             // townId -> { queue: ['archer', …], enabled? } (orden = orden de investigación)
      },
      prioridad: {
        mode: 'equilibrado',   // equilibrado | orden | paralelo
        order: ['construccion', 'investigacion', 'reclutamiento', 'festivales'],
        include: { construccion: true, investigacion: true, reclutamiento: true, festivales: true },
        levels: { construccion: 1, investigacion: 1, reclutamiento: 1, festivales: 1, cueva: 4 } // "por niveles"
      },
      ataques: {
        correctionMs: 0       // corrección automática del disparo (se ajusta sola con la llegada real)
      },
      reclutamiento: {
        enabled: true,
        fillPct: 95,          // tamaño del lote = % del almacén
        lotsAhead: 2,         // lotes que se piden al comercio por adelantado
        towns: {}             // townId -> { goals: [{id, target}] }
      },
      cueva: {
        enabled: false,       // meter plata en las cuevas
        keepPct: 25,          // plata que se deja SIEMPRE en el imperio (% de la suma de almacenes)
        cap: 0,               // tope de plata por cueva (0 = sin tope)
        minDeposit: 500       // no mover menos de esto de una vez
      },
      aldeas: {
        enabled: false,       // intercambio de recursos con las aldeas de la isla
        gainRatio: 1.2,       // cambios para equilibrar: solo con la tasa así de alta
        minRatio: 0.85,       // cambios de rescate (el recurso se iba a perder): tasa mínima
        excessPct: 70,        // con Cueva: se cambia por plata lo que pase de este % del almacén
        feed: true,           // traer de otras ciudades lo que piden las aldeas con buena tasa
        bulk: true,           // cambiar con pérdida cuando sobra muchísimo de un recurso
        bulkPct: 85,          // "sobra mucho": la ciudad pasa de este % del almacén…
        bulkRatio: 0.6        // …y se acepta hasta esta tasa
      },
      equilibrio: {
        enabled: true,        // mover recursos entre ciudades con los comerciantes libres
        balance: true,        // además de evitar pérdidas, igualar ciudades
        tolPct: 20,           // tolerancia por arriba sobre la media del imperio (% del almacén)
        tolDownPct: 13,       // tolerancia por abajo: recibe la que está por debajo de la media − esto
        maxCapPct: 60,        // % de comerciantes que puede usar sin encargos pendientes ni a punto
        busyCapPct: 20,       // % de comerciantes con encargos pendientes o a punto (el resto, libre)
        horizonMin: 30,       // encargos "a punto": los que empiezan dentro de estos minutos
        maxTravelMin: 45,     // viaje máximo (evitar pérdida: el doble)
        minMove: 1000,        // envío mínimo al igualar
        maxMoves: 4           // envíos por vuelta
      },
      comercio: {
        enabled: true,        // general, no por ciudad
        forBuild: true,       // abastecer la construcción
        minShipment: 500,
        storageMarginPct: 5,  // hueco que se deja libre en el almacén destino
        keepMin: 0,           // mínimo que se deja siempre en la ciudad donante
        maxPerTick: 5,
        forRecruit: true,     // abastecer los lotes de reclutamiento
        forFestival: true,    // abastecer festivales (Academia 30+)
        forResearch: true,    // abastecer investigaciones
        agingWeight: 2,       // cuánto sube la prioridad por cada segundo esperando (anti-olvido de lejanas)
        secPerUnit: 0         // se calibra solo con los envíos reales
      }
    };
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(acctKey(STORAGE_KEY)) || 'null');
      if (raw && typeof raw === 'object') {
        const def = defaultState();
        const out = { ...def, ...raw };
        for (const k of ['granjas', 'aldeas', 'equilibrio', 'cueva', 'construccion', 'comercio', 'reclutamiento', 'ataques', 'festivales', 'prioridad', 'investigacion']) out[k] = { ...def[k], ...(raw[k] || {}) };
        // Prioridad guardada con el formato antiguo (preset): que prioMode() la convierta.
        if (raw.prioridad && !raw.prioridad.mode) delete out.prioridad.mode;
        return out;
      }
    } catch {}
    return defaultState();
  }

  function saveState() {
    try { localStorage.setItem(acctKey(STORAGE_KEY), JSON.stringify(state)); } catch {}
    try { cloudMarkDirty(); } catch {}
  }

  let state = loadState();
  // v1.6.1: panel más grande por defecto → se olvida una vez el tamaño guardado.
  if (state.layoutV !== 2) { state.size = null; state.pos = null; state.layoutV = 2; }
  // Se llama al arrancar, en cuanto se conoce la cuenta: carga SU configuración.
  // La de versiones anteriores (una sola para todo el PC) se la queda la primera
  // cuenta que arranque con esta versión.
  function bindAccount() {
    const w = UW.Game?.world_id, pid = UW.Game?.player_id;
    if (!w || !pid) return false;
    ACCOUNT = `${w}_${pid}`;
    try {
      if (!localStorage.getItem('novabot_legacy_owner')) {
        localStorage.setItem('novabot_legacy_owner', ACCOUNT);
        for (const k of [STORAGE_KEY, 'novabot_attacks_v2']) {
          const old = localStorage.getItem(k);
          if (old !== null && localStorage.getItem(acctKey(k)) === null) localStorage.setItem(acctKey(k), old);
        }
      }
    } catch {}
    state = loadState();
    if (state.layoutV !== 2) { state.size = null; state.pos = null; state.layoutV = 2; }
    // v1.9.4: el % de "sobra" del intercambio con aldeas pasa de 80 a 70 (una vez).
    // El festival evento está oculto: quien lo tenía puesto vuelve a los festivales normales.
    if (!FEST_EVENT_ON && state.festivales?.event) { state.festivales.event = false; state.festivales.enabled = true; saveState(); }
    if (!state.aldeas.v70) { if (+state.aldeas.excessPct === 80) state.aldeas.excessPct = 70; state.aldeas.v70 = true; saveState(); }
    return true;
  }

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
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    build: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l4 4-9 9H5v-4l9-9Z"/><path d="M13 7l4 4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 7.9 8 9 4.6-1.1 8-4 8-9V6l-8-3Z"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10 3 6l4-4"/><path d="M3 6h13a4 4 0 0 1 4 4v1"/><path d="m17 14 4 4-4 4"/><path d="M21 18H8a4 4 0 0 1-4-4v-1"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 4.1"/><path d="M12 17.6h.01"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg>',
    resize: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><line x1="21" y1="9" x2="9" y2="21"/><line x1="21" y1="15" x2="15" y2="21"/></svg>',
    flask: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/></svg>',
    cave: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20c0-6 3.5-12 9-12s9 6 9 12"/><path d="M8 20c0-3 1.8-6 4-6s4 3 4 6"/><path d="M2 20h20"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>',
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
  // Iconos del propio juego: sus clases CSS (sprites) ya están cargadas en la
  // página, así que basta con ponerlas (p. ej. "unit_icon40x40 big_transporter").
  const unitIcon = (id, size = 40) => el('span', { class: `nb-icon nb-icon-${size} unit_icon${size}x${size} ${id}` });
  // small: el sprite de 40 px reducido dentro de una caja de 22 px (no depende de "zoom").
  const buildingIcon = (id, small = false) => small
    ? el('span', { class: 'nb-icon-sm' }, [el('span', { class: `building_icon40x40 ${id}` })])
    : el('span', { class: `nb-icon nb-icon-40 building_icon40x40 ${id}` });
  // Aldea de recolección (icono de misión del juego: requiere el contenedor .quest_type).
  const villageIcon = () => el('span', { class: 'nb-icon-sm nb-icon-sm-44 quest_type' }, [el('span', { class: 'loot_village_icon' })]);
  const resIcon = (k) => el('span', { class: `nb-res-icon resources_small ${k}`, title: ({ wood: 'Madera', stone: 'Piedra', iron: 'Plata', favor: 'Favor', population: 'Población' })[k] || k });
  const heroIcon = (type) => el('span', { class: `nb-icon nb-icon-25 hero_icon hero25x25 ${type}` });
  // Recursos con sus iconos del juego: [icono 1200] [icono 300]…
  const fmtResEl = (r) => el('span', { class: 'nb-res-list' }, RES.filter((k) => (+r?.[k] || 0) > 0)
    .map((k) => el('span', { class: 'nb-res' }, [resIcon(k), String(Math.round(r[k]))])));
  // Icono de cada módulo (edificio del juego que lo representa).
  const MODULE_ICON = { granjas: 'farm', construccion: 'main', investigacion: 'academy', reclutamiento: 'barracks', comercio: 'market', festivales: 'place', cueva: 'hide', ataques: 'wall', inicio: 'main', prioridad: 'storage' };
  // Títulos de tarjeta: icono pequeño del edificio correspondiente (adorno).
  const TITLE_ICON = [
    [/prioridad/i, 'storage'], [/en camino|necesidades/i, 'market'], [/lote|tropa/i, 'barracks'],
    [/aptas|festival/i, 'place'], [/cola del juego|edificio|objetivos del bot/i, 'main'],
    [/recolec|aldea|almacén llega/i, 'farm'], [/programados|nuevo|objetivo|origen/i, 'wall']
  ];
  function decorateTitles(root) {
    for (const t of root.querySelectorAll('.nb-card-title')) {
      if (t.querySelector('.nb-icon, .nb-icon-sm')) continue;
      const txt = t.textContent || '';
      // Sin icono: Construcción (ya lleva uno por edificio) y "Actividad".
      if (state.activeTab === 'construccion' || state.activeTab === 'investigacion' || /actividad|aviso|siguiente lote/i.test(txt)) continue; // (el lote puede ser de Cuartel o de Puerto)
      if (state.activeTab === 'granjas') { t.prepend(villageIcon()); continue; }
      const hit = TITLE_ICON.find(([re]) => re.test(txt));
      const id = hit ? hit[1] : MODULE_ICON[state.activeTab];
      if (id) t.prepend(buildingIcon(id, true));
    }
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
        'data-tab': tab.id,
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

  // Repintado automático (desde los motores): no mientras escribes en el panel,
  // para no borrar lo que estás tecleando.
  function renderIfIdle(tab) {
    if (!bodyEl || (tab && state.activeTab !== tab)) return;
    if (document.activeElement?.closest?.('#novabot-panel input, #novabot-panel select, #novabot-panel textarea')) return;
    renderBody();
  }

  // Con el tour abierto el panel no se repinta solo (el recuadro perdería su elemento).
  function renderBody() {
    if (tour.active && !tour.rendering) { tour.dirty = true; return; }
    renderBodyNow();
  }
  function renderBodyNow() {
    bodyEl.innerHTML = '';
    queueMicrotask(() => { try { decorateTitles(bodyEl); } catch {} });

    if (!stylesLoaded) {
      bodyEl.appendChild(el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Aviso'),
        el('p', { class: 'nb-placeholder' },
          'No se pudo cargar novabot.css desde GitHub (revisa la consola). El panel funciona pero sin estilos.')
      ]));
    }

    if (state.activeTab === 'inicio') {
      renderInicioTab();
    } else if (state.activeTab === 'resumen') {
      renderResumenTab();
    } else if (state.activeTab === 'festivales') {
      renderFestivalesTab();
    } else if (state.activeTab === 'cueva') {
      renderCuevaTab();
    } else if (state.activeTab === 'investigacion') {
      renderInvestigacionTab();
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
  /* Vista general · Reclutamiento del bot: por ciudad, qué tropas se piden, cuánto
     falta, el lote siguiente (y si está listo), colas y hechizos. Solo lectura. */
  function renderResumenRecruit() {
    if (overviewReady()) for (const id of allTownIds()) pruneRecruitGoals(id);
    const towns = allTownIds().filter((id) => townRecruitCfg(id).goals.length)
      .sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    const limit = buildQueueLimit();
    let pendingUnits = 0, readyLots = 0, waiting = 0;
    const cards = towns.map((id) => {
      const cfg = townRecruitCfg(id);
      const have = townUnitsHave(id), queued = queuedUnits(id);
      let b = null; try { b = recruitBatch(id); } catch {}
      const cur = townResources(id);
      // Estado de la ciudad
      const now = Date.now();
      let st, cls;
      if (!recruitOnFor(id)) { st = 'Desactivado'; cls = 'off'; }
      else if (cfg.hold) { st = 'En espera (sin hora)'; cls = 'wait'; }
      else if (+cfg.startAt > now) { st = ['Empieza en ', el('b', { 'data-nb-until': Math.round(cfg.startAt / 1000) }, formatLeft(Math.round(cfg.startAt / 1000)))]; cls = 'wait'; }
      else if (recruitRuntime.wait.get(id)) { st = recruitRuntime.wait.get(id); cls = 'wait'; }
      else if (!b) { st = 'Objetivos cumplidos'; cls = 'done'; }
      else if (b.queueFull) { st = 'Cola llena'; cls = 'wait'; }
      else if (b.reason) { st = b.reason; cls = 'wait'; }
      else if (RES.every((k) => cur[k] >= b.cost[k])) { st = 'Lote listo para reclutar'; cls = 'ok'; readyLots++; }
      else { st = 'Reuniendo recursos'; cls = 'run'; }
      if (cls === 'wait') waiting++;
      // Tropas pedidas
      const rows = cfg.goals.map((g) => {
        const h = +have[g.id] || 0, q = +queued[g.id] || 0, rem = Math.max(0, g.target - h - q);
        pendingUnits += rem;
        const pct = g.target ? Math.min(100, Math.round((h + q) / g.target * 100)) : 100;
        const pctHave = g.target ? Math.min(100, Math.round(h / g.target * 100)) : 100;
        return el('div', { class: 'nb-rc-unit' }, [
          unitIcon(g.id, 25),
          el('div', { class: 'nb-rc-unit-main' }, [
            el('div', { class: 'nb-rc-unit-top' }, [el('b', {}, unitName(g.id)), el('span', {}, `${h}${q ? ` + ${q} en cola` : ''} / ${g.target}`)]),
            el('div', { class: 'nb-bar nb-rc-bar' }, [el('div', { class: 'nb-bar-fill nb-rc-q', style: `width:${pct}%` }), el('div', { class: 'nb-bar-fill', style: `width:${pctHave}%` })]),
            el('div', { class: 'nb-rc-unit-sub' }, rem ? `faltan ${rem}${unitResearched(id, g.id) ? '' : ' · esperando investigación'}` : 'completo')
          ])
        ]);
      });
      // Siguiente lote
      let lot = null;
      if (b && !b.reason && sumRes(b.cost)) {
        const pctOf = (k) => b.cost[k] ? Math.min(100, Math.floor(cur[k] / b.cost[k] * 100)) : 100;
        const tot = Math.min(...RES.filter((k) => b.cost[k] > 0).map(pctOf));
        lot = el('div', { class: 'nb-rc-lot' }, [
          el('div', { class: 'nb-rc-lot-head' }, [el('span', {}, 'Siguiente lote'), el('b', {}, Object.entries(b.units).map(([u, n]) => `${n} ${unitName(u)}`).join(' + ')), el('span', { class: 'nb-rc-pct' }, `${tot} %`)]),
          el('div', { class: 'nb-res-list' }, RES.filter((k) => b.cost[k] > 0).map((k) => el('span', { class: `nb-res${cur[k] >= b.cost[k] ? ' nb-ok' : ''}` }, [resIcon(k), `${Math.floor(cur[k])}/${Math.ceil(b.cost[k])}`])))
        ]);
      }
      // Colas y hechizos
      const orders = townUnitOrders(id);
      const qInfo = (naval) => { const n = orders.filter((o) => (o.kind === 'naval') === naval).length; return el('span', { class: 'nb-rc-q-item' }, [buildingIcon(naval ? 'docks' : 'barracks', true), `${n}/${limit}`]); };
      const spells = Object.entries(cfg.spells || {}).map(([sid, mode]) => {
        const on = spellEnd(id, sid) > now;
        return el('span', { class: `nb-rc-spell${on ? ' on' : ''}`, title: `${UW.GameData?.powers?.[sid]?.name || sid} · ${mode === 'required' ? 'obligatorio' : 'opcional'} · ${on ? 'activo' : 'inactivo'}` }, [el('span', { class: `nb-icon nb-icon-25 power_icon30x30 ${sid}` })]);
      });
      return el('div', { class: `nb-rc-card nb-rc-${cls}${+UW.Game?.townId === id ? ' nb-rc-current' : ''}` }, [
        el('div', { class: 'nb-rc-head' }, [
          el('b', { class: 'nb-rc-town' }, farmTownName(id)),
          el('span', { class: `nb-rc-state nb-rc-state-${cls}` }, st)
        ]),
        el('div', { class: 'nb-rc-units' }, rows),
        lot,
        el('div', { class: 'nb-rc-foot' }, [qInfo(false), qInfo(true), spells.length ? el('span', { class: 'nb-rc-spells' }, spells) : null])
      ]);
    });
    bodyEl.appendChild(el('div', { class: 'nb-stats nb-rc-stats' }, [
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Ciudades reclutando'), el('b', {}, String(towns.length))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Tropas por reclutar'), el('b', {}, pendingUnits.toLocaleString('es-ES'))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Lotes listos'), el('b', {}, String(readyLots))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'En espera'), el('b', {}, String(waiting))])
    ]));
    bodyEl.appendChild(towns.length ? el('div', { class: 'nb-rc-grid' }, cards)
      : el('div', { class: 'nb-card' }, [el('p', { class: 'nb-placeholder' }, 'Ninguna ciudad tiene tropas pedidas en el bot.')]));
    updateCountdown();
  }

  /* Vista general · Construcción del bot: por ciudad, qué edificios se piden, a qué
     nivel van (barra), el siguiente nivel con sus recursos y la cola. Solo lectura.
     "Lo que toca" se calcula como el motor: primer paso de cada edificio (cabezas),
     y de ellas la que se construiría ahora; si ninguna, la que está reuniendo
     recursos; si tampoco, la primera (bloqueada). Con orden estricto, siempre la primera. */
  function buildOverviewOf(townId) {
    const bd = buildDataFor(townId);
    const limit = buildQueueLimit();
    const orders = townBuildOrders(townId);
    const full = !!bd?.is_building_order_queue_full || orders.length >= limit;
    const heads = [], seen = new Set();
    if (bd) for (const s of buildPlan(townId)) {
      if (seen.has(s.id)) continue;
      const info = bd.building_data?.[s.id];
      if (s.level !== queuedLevel(townId, s.id, info) + (s.down ? -1 : 1)) { seen.add(s.id); continue; }
      seen.add(s.id);
      heads.push({ ...s, info, reason: s.down ? null : buildBlockReason(townId, info) });
    }
    const gathering = (h) => /faltan recursos|reservado/.test(h.reason || '');
    const focus = !heads.length ? null : state.construccion.strictOrder ? heads[0]
      : heads.find((h) => !h.reason) || heads.find(gathering) || heads[0];
    return { bd, orders, limit, full, heads, focus, gathering };
  }

  function renderResumenBuild() {
    for (const id of allTownIds()) pruneCompletedGoals(id);
    const towns = allTownIds().filter((id) => townBuildCfg(id).goals.length)
      .sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    let pendingLv = 0, ready = 0, waiting = 0;
    const cards = towns.map((id) => {
      const cfg = townBuildCfg(id);
      const o = buildOverviewOf(id);
      const f = o.focus;
      let st, cls;
      if (!buildEnabledFor(id)) { st = 'Desactivado'; cls = 'off'; }
      else if (!o.bd) { st = 'Sin datos de edificios'; cls = 'wait'; }
      else if (!f) { st = 'Objetivos cumplidos'; cls = 'done'; }
      else if (o.full) { st = 'Cola llena'; cls = 'wait'; }
      else if (!f.reason) { st = f.down ? 'Derribo listo' : 'Listo para construir'; cls = 'ok'; ready++; }
      else if (o.gathering(f)) { st = /reservado/.test(f.reason) ? f.reason[0].toUpperCase() + f.reason.slice(1) : 'Reuniendo recursos'; cls = 'run'; }
      else { st = `${buildingName(f.id)}: ${f.reason}`; cls = 'wait'; }
      if (cls === 'wait') waiting++;
      // Objetivos (en orden de prioridad)
      const rows = cfg.goals.map((g, gi) => {
        const info = o.bd?.building_data?.[g.id];
        const real = realBuildingLevel(id, g.id), q = queuedLevel(id, g.id, info);
        // Si el edificio ya salió antes en la lista, este objetivo empieza donde acaba aquel.
        const prev = cfg.goals.slice(0, gi).filter((x) => x.id === g.id).pop();
        const from = !prev ? q : g.demolish ? Math.min(q, prev.target) : Math.max(q, prev.target);
        const rem = Math.max(0, g.demolish ? from - g.target : g.target - from);
        pendingLv += rem;
        const head = o.heads.find((h) => h.id === g.id && h.gi === gi);
        const sub = !rem ? 'completo'
          : `${g.demolish ? 'derribar' : 'faltan'} ${rem} nivel${rem > 1 ? 'es' : ''}${f && head === f && !f.reason ? ' · siguiente' : head?.reason ? ` · ${head.reason}` : head ? '' : ' · tras el objetivo anterior'}`;
        const pct = g.target ? Math.min(100, Math.round(q / g.target * 100)) : 100;
        const pctHave = g.target ? Math.min(100, Math.round(real / g.target * 100)) : 100;
        return el('div', { class: 'nb-rc-unit' }, [
          buildingIcon(g.id, true),
          el('div', { class: 'nb-rc-unit-main' }, [
            el('div', { class: 'nb-rc-unit-top' }, [el('b', {}, [buildingName(g.id), g.demolish ? ' (derribo)' : '']), el('span', {}, `${real}${q !== real ? ` (${q} con cola)` : ''} → ${g.target}`)]),
            g.demolish ? null : el('div', { class: 'nb-bar nb-rc-bar' }, [el('div', { class: 'nb-bar-fill nb-rc-q', style: `width:${pct}%` }), el('div', { class: 'nb-bar-fill', style: `width:${pctHave}%` })]),
            el('div', { class: 'nb-rc-unit-sub' }, sub)
          ])
        ]);
      });
      // Siguiente nivel y sus recursos
      let lot = null;
      if (f && buildEnabledFor(id)) {
        const cost = f.down ? {} : (f.info?.resources_for || {});
        const cur = townResources(id);
        const need = RES.filter((k) => (+cost[k] || 0) > 0);
        const tot = need.length ? Math.min(...need.map((k) => Math.min(100, Math.floor(cur[k] / +cost[k] * 100)))) : 100;
        lot = el('div', { class: 'nb-rc-lot' }, [
          el('div', { class: 'nb-rc-lot-head' }, [el('span', {}, 'Siguiente'), el('b', {}, `${buildingName(f.id)} → ${f.level}${f.down ? ' (derribo)' : ''}`), need.length ? el('span', { class: 'nb-rc-pct' }, `${tot} %`) : null]),
          need.length ? el('div', { class: 'nb-res-list' }, need.map((k) => el('span', { class: `nb-res${cur[k] >= +cost[k] ? ' nb-ok' : ''}` }, [resIcon(k), `${Math.floor(cur[k])}/${Math.ceil(+cost[k])}`]))) : null
        ]);
      }
      // Cola del juego + modo
      const bo = o.orders.slice().sort((a, b) => (+a.to_be_completed_at || 0) - (+b.to_be_completed_at || 0));
      const qItem = el('span', { class: 'nb-rc-q-item' }, [buildingIcon('main', true), `${bo.length}/${o.limit}`,
        bo[0] ? [' · ', buildingName(bo[0].building_type), ' ', el('b', { 'data-nb-until': Math.round(+bo[0].to_be_completed_at) }, formatLeft(+bo[0].to_be_completed_at))] : ' libre']);
      const mode = el('span', { class: 'nb-rc-spells' }, [townInterleave(id) ? 'intercala' : 'en orden', state.construccion.strictOrder ? ' · estricto' : '']);
      return el('div', { class: `nb-rc-card nb-rc-${cls}${+UW.Game?.townId === id ? ' nb-rc-current' : ''}` }, [
        el('div', { class: 'nb-rc-head' }, [el('b', { class: 'nb-rc-town' }, farmTownName(id)), el('span', { class: `nb-rc-state nb-rc-state-${cls}` }, st)]),
        el('div', { class: 'nb-rc-units' }, rows),
        lot,
        el('div', { class: 'nb-rc-foot' }, [qItem, mode])
      ]);
    });
    bodyEl.appendChild(el('div', { class: 'nb-stats nb-rc-stats' }, [
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Ciudades construyendo'), el('b', {}, String(towns.length))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Niveles por hacer'), el('b', {}, pendingLv.toLocaleString('es-ES'))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Listas para construir'), el('b', {}, String(ready))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'En espera'), el('b', {}, String(waiting))])
    ]));
    bodyEl.appendChild(towns.length ? el('div', { class: 'nb-rc-grid' }, cards)
      : el('div', { class: 'nb-card' }, [el('p', { class: 'nb-placeholder' }, 'Ninguna ciudad tiene edificios pedidos en el bot.')]));
    updateCountdown();
  }

  /* Vista general · Investigación del bot: por ciudad, la cola del bot con el estado
     de cada investigación, la siguiente con sus recursos, la cola de la Academia y
     los puntos. Solo lectura. */
  function renderResumenResearch() {
    if (Date.now() - researchRuntime.ordersAt > 30000 && !researchRuntime.busy) refreshResearchOrders().then(() => renderIfIdle('resumen'));
    for (const id of allTownIds()) pruneResearchQueue(id);
    const towns = allTownIds().filter((id) => townResearchCfg(id).queue.length)
      .sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    const limit = buildQueueLimit();
    const iconSm = (r) => { let c = r; try { c = UW.GameDataResearches?.getResearchCssClass?.(r) || r; } catch {} return el('span', { class: 'nb-icon-sm' }, [el('span', { class: `research_icon research40x40 ${c}` })]); };
    let pending = 0, ready = 0, waiting = 0;
    const cards = towns.map((id) => {
      const plan = researchPlan(id);
      const next = nextResearchFor(id);
      pending += plan.length;
      let st, cls;
      if (!researchEnabledFor(id)) { st = 'Desactivado'; cls = 'off'; }
      else if (!plan.length) { st = 'Cola completada'; cls = 'done'; }
      else if (next.r) { st = 'Lista para investigar'; cls = 'ok'; ready++; }
      else if (/faltan recursos/.test(next.reason)) { st = 'Reuniendo recursos'; cls = 'run'; }
      else if (/reservado/.test(next.reason)) { st = next.reason; cls = 'run'; }
      else { st = next.reason; cls = 'wait'; }
      if (cls === 'wait') waiting++;
      // La que toca: la que se lanzaría, o la primera sin bloqueo (esperando recursos).
      const focus = plan.find((x) => x.r === next.r) || plan.find((x) => !x.block);
      const rows = plan.map((x) => el('div', { class: 'nb-rc-unit' }, [
        iconSm(x.r),
        el('div', { class: 'nb-rc-unit-main' }, [
          el('div', { class: 'nb-rc-unit-top' }, [el('b', {}, researchName(x.r)), el('span', {}, `${x.points} pts`)]),
          el('div', { class: 'nb-rc-unit-sub' }, x === focus ? (next.r === x.r ? 'siguiente' : 'esperando recursos') : x.block || 'en espera de recursos')
        ])
      ]));
      let lot = null;
      if (focus && researchEnabledFor(id)) {
        const cur = townResources(id), cost = focus.cost;
        const need = RES.filter((k) => cost[k] > 0);
        const tot = need.length ? Math.min(...need.map((k) => Math.min(100, Math.floor(cur[k] / cost[k] * 100)))) : 100;
        lot = el('div', { class: 'nb-rc-lot' }, [
          el('div', { class: 'nb-rc-lot-head' }, [el('span', {}, 'Siguiente'), el('b', {}, researchName(focus.r)), el('span', { class: 'nb-rc-pct' }, `${tot} %`)]),
          el('div', { class: 'nb-res-list' }, need.map((k) => el('span', { class: `nb-res${cur[k] >= cost[k] ? ' nb-ok' : ''}` }, [resIcon(k), `${Math.floor(cur[k])}/${Math.ceil(cost[k])}`])))
        ]);
      }
      const orders = researchOrdersOf(id);
      const pts = researchPoints(id);
      const qItem = el('span', { class: 'nb-rc-q-item' }, [buildingIcon('academy', true), `${orders.length}/${limit}`,
        orders[0] ? [' · ', researchName(orders[0].research_type), ' ', el('b', { 'data-nb-until': Math.round(+orders[0].to_be_completed_at) }, formatLeft(+orders[0].to_be_completed_at))] : ' libre']);
      return el('div', { class: `nb-rc-card nb-rc-${cls}${+UW.Game?.townId === id ? ' nb-rc-current' : ''}` }, [
        el('div', { class: 'nb-rc-head' }, [el('b', { class: 'nb-rc-town' }, farmTownName(id)), el('span', { class: `nb-rc-state nb-rc-state-${cls}` }, st)]),
        el('div', { class: 'nb-rc-units' }, rows),
        lot,
        el('div', { class: 'nb-rc-foot' }, [qItem, el('span', { class: 'nb-rc-spells', title: 'Puntos de investigación: libres · usados/total' }, `${pts.free} pts libres · ${pts.used}/${pts.total}`)])
      ]);
    });
    bodyEl.appendChild(el('div', { class: 'nb-stats nb-rc-stats' }, [
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Ciudades investigando'), el('b', {}, String(towns.length))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Investigaciones en cola'), el('b', {}, String(pending))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'Listas para investigar'), el('b', {}, String(ready))]),
      el('div', { class: 'nb-stat' }, [el('span', {}, 'En espera'), el('b', {}, String(waiting))])
    ]));
    bodyEl.appendChild(towns.length ? el('div', { class: 'nb-rc-grid' }, cards)
      : el('div', { class: 'nb-card' }, [el('p', { class: 'nb-placeholder' }, 'Ninguna ciudad tiene investigaciones en la cola del bot.')]));
    updateCountdown();
  }

  /* Vista general: una fila por ciudad con lo que está en curso (solo lectura). */
  function renderResumenTab() {
    const VIEWS = [['ciudades', 'Ciudades'], ['construccion', 'Construcción'], ['investigacion', 'Investigación'], ['reclutamiento', 'Reclutamiento']];
    const view = VIEWS.some(([v]) => v === state.resumenView) ? state.resumenView : 'ciudades';
    bodyEl.appendChild(el('div', { class: 'nb-seg nb-seg-main nb-seg-wrap' }, VIEWS.map(([v, l]) =>
      el('span', { class: `nb-seg-btn${view === v ? ' active' : ''}`, title: v === 'ciudades' ? 'Una fila por ciudad' : `${l} del bot, ciudad a ciudad`, onclick: () => { state.resumenView = v; saveState(); renderBody(); } }, l))));
    if (view === 'reclutamiento') { renderResumenRecruit(); return; }
    if (view === 'construccion') { renderResumenBuild(); return; }
    if (view === 'investigacion') { renderResumenResearch(); return; }
    const now = Date.now();
    const transit = (() => { try { return transitRows(); } catch { return []; } })();
    const cd = (ms) => el('b', { class: 'nb-ov-time', 'data-nb-until': Math.round(ms / 1000) }, formatLeft(Math.round(ms / 1000)));
    const dim = (t) => el('span', { class: 'nb-ov-dim' }, t);
    const towns = allTownIds().sort((a, b) => farmTownName(a).localeCompare(farmTownName(b), 'es'));
    const limit = buildQueueLimit();
    const rows = towns.map((id) => {
      // Construcción: cola del juego (lo primero que termina) + objetivos del bot
      const bo = townBuildOrders(id).slice().sort((a, b) => (+a.to_be_completed_at || 0) - (+b.to_be_completed_at || 0));
      const goals = townBuildCfg(id).goals.length;
      const build = el('div', { class: 'nb-ov-cell' }, [
        el('div', {}, [el('span', { class: 'nb-ov-count' }, `${bo.length}/${limit}`), bo[0] ? [' ', buildingName(bo[0].building_type), ' ', cd(+bo[0].to_be_completed_at * 1000)] : dim(' sin cola')]),
        goals ? dim(`${goals} objetivo(s) en el bot${buildEnabledFor(id) ? '' : ' · desactivado'}`) : null
      ]);
      // Reclutamiento: Cuartel y Puerto
      const uo = (() => { try { return townUnitOrders(id); } catch { return []; } })();
      const kindCell = (naval) => {
        const list = uo.filter((o) => (o.kind === 'naval') === naval).sort((a, b) => +a.to_be_completed_at - +b.to_be_completed_at);
        const last = list[list.length - 1];
        return el('div', {}, [buildingIcon(naval ? 'docks' : 'barracks', true), el('span', { class: 'nb-ov-count' }, `${list.length}/${limit}`),
          last ? [' hasta ', cd(+last.to_be_completed_at * 1000)] : dim(' libre')]);
      };
      const rc = townRecruitCfg(id);
      const recState = !rc.goals.length ? null : !recruitOnFor(id) ? 'bot: desactivado' : rc.hold ? 'bot: en espera' : +rc.startAt > now ? 'bot: programado' : 'bot: activo';
      const recruit = el('div', { class: 'nb-ov-cell' }, [kindCell(false), kindCell(true), recState ? dim(recState) : null]);
      // Festival
      const fEnd = festivalEnd(id);
      const fest = el('div', { class: 'nb-ov-cell' }, [fEnd ? el('div', {}, ['En curso ', cd(fEnd)]) : canFestival(id) ? dim('apta, sin festival') : dim('—')]);
      // Comercio: lo que llega
      const inc = transit.filter((r) => r.to === id);
      const nextInc = inc.slice().sort((a, b) => a.arrival - b.arrival)[0];
      const trade = el('div', { class: 'nb-ov-cell' }, [inc.length ? el('div', {}, [el('span', { class: 'nb-ov-count' }, String(inc.length)), ' en camino · 1º ', cd(nextInc.arrival)]) : dim('—')]);
      // Ataques del bot que salen de esta ciudad
      const atks = atk.queue.filter((a) => +a.source === id && a.status === 'pending').sort((a, b) => a.executeAt - b.executeAt);
      const attacks = el('div', { class: 'nb-ov-cell' }, [atks.length ? el('div', {}, [el('span', { class: 'nb-ov-count' }, String(atks.length)), ' · sale ', el('b', { 'data-atk-at': atks[0].executeAt }, fmtCount(atks[0].executeAt - srvNow()))]) : dim('—')]);
      const cur = +UW.Game?.townId === id;
      return el('tr', { class: cur ? 'nb-ov-current' : '' }, [
        el('td', { class: 'nb-ov-town' }, farmTownName(id)),
        el('td', {}, build), el('td', {}, recruit), el('td', {}, fest), el('td', {}, trade), el('td', {}, attacks)
      ]);
    });
    const head = el('tr', {}, ['Ciudad', 'Construcción', 'Reclutamiento', 'Festival', 'Llega (comercio)', 'Ataques del bot'].map((h) => el('th', {}, h)));
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Vista general · ${towns.length} ciudades`),
      el('div', { class: 'nb-ov-wrap' }, [el('table', { class: 'nb-ov' }, [el('thead', {}, [head]), el('tbody', {}, rows)])]),
      el('p', { class: 'nb-placeholder nb-mt' }, 'Solo lectura. Se actualiza al abrir la pestaña; las cuentas atrás van solas.')
    ]));
    updateCountdown();
  }

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
        construccion: (() => { const exc = state.construccion.enabled ? 0 : allTownIds().filter(buildEnabledFor).length; return `${goalsBuild} objetivos · ${buildQueueLimit()} huecos de cola${exc ? ` · activa en ${exc} ciudad(es) por excepción` : ''}`; })(),
        reclutamiento: (() => { const sch = allTownIds().filter((id) => recruitOnFor(id) && recruitWaiting(id)).length; return `${goalsRec} ciudades con tropas pedidas${sch ? ` · ${sch} programada(s)` : ''}`; })(),
        comercio: `${transit} en camino · ${needs} ciudades esperando${state.equilibrio?.enabled ? ' · equilibrio' : ''}`,
        festivales: (() => { const apt = allTownIds().filter(canFestival); const on = apt.filter((id) => festivalEnd(id)).length; return `${on}/${apt.length} con festival`; })()
      };
    } catch {}
    const mod = (tab, title, cfgObj, hint) => {
      const tile = el('div', { class: `nb-tile${cfgObj.enabled ? ' on' : ''}` }, [
        el('div', { class: 'nb-tile-head' }, [
          el('span', { class: 'nb-tile-title' }, [buildingIcon(MODULE_ICON[tab], true), title]),
          switchEl(!!cfgObj.enabled, (v) => { if (tab === 'construccion' || tab === 'reclutamiento') setModuleGlobal(tab, v); else { cfgObj.enabled = v; saveState(); } renderBody(); })
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
    bodyEl.appendChild(renderPriorityCard());
    bodyEl.appendChild(renderCloudCard());
    bodyEl.appendChild(el('div', { class: 'nb-tiles' }, [
      mod('granjas', 'Granjas', state.granjas, 'Recolecta todas las aldeas'),
      mod('construccion', 'Construcción', state.construccion, 'Sube edificios por objetivos'),
      mod('reclutamiento', 'Reclutamiento', state.reclutamiento, 'Lotes que llenan el almacén'),
      mod('comercio', 'Comercio', state.comercio, 'Reparte recursos entre ciudades'),
      mod('festivales', 'Festivales', state.festivales, FEST_EVENT_ON && state.festivales.event ? 'Festival evento activo (normales apagados)' : 'Academia 30+, sin festival en curso'),
      (() => {
        const nx = nextPending();
        const n = atk.queue.filter((a) => a.status === 'pending').length;
        const tile = el('div', { class: `nb-tile${n ? ' on' : ''}` }, [
          el('div', { class: 'nb-tile-head' }, [el('span', { class: 'nb-tile-title' }, [buildingIcon('wall', true), 'Ataques']), el('span', { class: 'nb-pill' + (n ? '' : ' nb-pill-off') }, `${n} programados`)]),
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
        el('div', { class: 'nb-icon-btn nb-help-btn', html: ICON.help, title: 'Tour guiado: te enseña todo el bot paso a paso', onclick: (e) => { e.stopPropagation(); tourMenu(false); } }),
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
    // Primera vez que se abre: ofrecer el tour guiado.
    if (open && !tour.active && !tour.menu) setTimeout(tourAutoOffer, 450);
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
      // Sin posición guardada: centrado en la pantalla.
      const sz = state.size || defaultPanelSize();
      panel.style.left = `${Math.max(4, Math.round((window.innerWidth - Math.min(sz.w, window.innerWidth - 8)) / 2))}px`;
      panel.style.top = `${Math.max(4, Math.round((window.innerHeight - Math.min(sz.h, window.innerHeight - 8)) / 2))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
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

  // Tamaño por defecto: ancho para 3 columnas de fichas (≈ 960 px) y 85 % del alto.
  const defaultPanelSize = () => ({ w: Math.min(960, window.innerWidth - 40), h: Math.min(Math.round(window.innerHeight * 0.85), 920) });
  function applyPanelSize() {
    const sz = state.size || defaultPanelSize();
    panel.style.width = `${Math.min(sz.w, window.innerWidth - 8)}px`;
    panel.style.height = `${Math.min(sz.h, window.innerHeight - 8)}px`;
    panel.style.maxHeight = 'none';
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
  // Firma de edificios + cola del juego de la ciudad abierta: si cambia (has construido
  // o derribado a mano), la pestaña Construcción se repinta con los datos reales.
  let lastBuildSig = '';
  function buildSignature(townId) {
    try {
      const t = UW.ITowns.getTown(townId);
      return JSON.stringify(t.getBuildings().attributes) + '|' + t.buildingOrders().models.map((m) => `${m.attributes.id}:${m.attributes.building_type}:${m.attributes.tear_down ? 1 : 0}`).join(',');
    } catch { return ''; }
  }
  function checkBuildChanges() {
    if (state.activeTab !== 'construccion' || !bodyEl) return;
    const sig = buildSignature(+UW.Game?.townId);
    if (sig && lastBuildSig && sig !== lastBuildSig) renderIfIdle('construccion');
    lastBuildSig = sig;
  }
  let lastTownId = null;
  function onTownMaybeChanged() {
    const id = +UW.Game?.townId || null;
    if (id === lastTownId) return;
    lastTownId = id;
    // Ataques: el origen sigue a la ciudad que tienes abierta (salvo si estás editando uno).
    if (id && !atk.form.replaceId && +atk.form.source !== id) Object.assign(atk.form, { source: id, units: {}, hero: '', spell: '', info: null, infoError: '' });
    // Todas las pestañas siguen a la ciudad activa (las que muestran "esta ciudad" y las
    // que la resaltan). Si estás escribiendo en el panel, se repinta en cuanto termines.
    townRenderPending = true;
    flushTownRender();
  }
  let townRenderPending = false;
  function flushTownRender() {
    if (!townRenderPending || !bodyEl) return;
    if (document.activeElement?.closest?.('#novabot-panel input, #novabot-panel select, #novabot-panel textarea')) return;
    townRenderPending = false;
    renderBody();
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

  /* Botín por recolección — el juego calcula claim_resource_values = [t1..t4] (lo que
     da la aldea de CADA recurso con cada tiempo) solo para las aldeas de la isla de la
     ciudad abierta (comprobado 24/09/2026: nivel 6 con Lealtad = [228,496,1068,2100] a
     velocidad 4; las demás islas vienen a 0). Se apunta por nivel y Lealtad (por
     cuenta) y se usa para estimar cuánto recibirá cada ciudad en la próxima recolección. */
  const BOOTY_FACTOR = 2.15; // Lealtad de los aldeanos: +115 %
  const lootRuntime = { table: null, learnedAt: 0 };
  function lootTable() {
    if (!lootRuntime.table) {
      try { lootRuntime.table = JSON.parse(localStorage.getItem(acctKey('novabot_loot_v1')) || '{}') || {}; } catch { lootRuntime.table = {}; }
    }
    return lootRuntime.table;
  }
  function learnLootValues() {
    if (Date.now() - lootRuntime.learnedAt < 20000) return;
    lootRuntime.learnedAt = Date.now();
    const tid = +UW.Game?.townId;
    if (!tid) return;
    const booty = farmTownData(tid).booty_researched ? 1 : 0;
    const tab = lootTable();
    let changed = false;
    for (const rel of exCollection('FarmTownPlayerRelation')) {
      const v = rel.claim_resource_values, lvl = +rel.expansion_stage || 0;
      if (!v || typeof v !== 'object' || !lvl) continue;
      const arr = [0, 1, 2, 3].map((i) => +v[i] || 0);
      if (!arr[0]) continue;
      const key = `${booty}_${lvl}`;
      if (JSON.stringify(tab[key]) !== JSON.stringify(arr)) { tab[key] = arr; changed = true; }
    }
    if (changed) { try { localStorage.setItem(acctKey('novabot_loot_v1'), JSON.stringify(tab)); } catch {} }
  }
  function lootValue(level, booty, tier) {
    if (!level) return 0;
    const tab = lootTable(), b = booty ? 1 : 0;
    const direct = tab[`${b}_${level}`]?.[tier];
    if (direct) return direct;
    const other = tab[`${1 - b}_${level}`]?.[tier];
    if (other) return Math.round(b ? other * BOOTY_FACTOR : other / BOOTY_FACTOR);
    // Otro nivel conocido: se escala con el máximo diario de cada nivel.
    const perDay = UW.GameData?.farm_town?.max_resources_per_day || {};
    for (const [key, arr] of Object.entries(tab)) {
      const [kb, kl] = key.split('_').map(Number);
      if (!arr?.[tier] || !perDay[kl] || !perDay[level]) continue;
      let v = arr[tier] * perDay[level] / perDay[kl];
      if (kb !== b) v = b ? v * BOOTY_FACTOR : v / BOOTY_FACTOR;
      return Math.round(v);
    }
    return 0;
  }
  // Botín (de CADA recurso) que recibe una ciudad si es la que recolecta su isla.
  function islandLoot(townId) {
    if (!state.granjas.enabled) return 0;
    try { learnLootValues(); } catch {}
    const d = farmTownData(townId);
    const booty = !!d.booty_researched, tier = clamp(state.granjas.tier, 0, 3);
    const farms = new Map(exCollection('FarmTown').map((f) => [+f.id, f]));
    let sum = 0;
    for (const rel of exCollection('FarmTownPlayerRelation')) {
      if (+rel.relation_status !== 1) continue;
      const f = farms.get(+rel.farm_town_id);
      if (!f || +f.island_x !== +d.island_x || +f.island_y !== +d.island_y) continue;
      sum += lootValue(+rel.expansion_stage || 0, booty, tier);
    }
    return sum;
  }
  // Lo que se perdería (suma de los 3 recursos) si esta ciudad recolecta ahora.
  function claimWaste(townId) {
    const cap = townStorage(townId);
    if (!cap) return 0;
    const loot = islandLoot(townId), r = townResources(townId);
    return ['wood', 'stone', 'iron'].reduce((s, k) => s + Math.max(0, r[k] + loot - cap), 0);
  }

  /* Recogida de TODAS las ciudades en una sola petición — capturada del propio
     juego al pulsar "Seleccionar todas" + "Recoger" (22/09/2026):
       POST farm_town_overviews?action=claim_loads_multiple
       json: { towns:[ids], time_option_base:<s sin Lealtad>, time_option_booty:<s con Lealtad>,
               claim_factor:"normal", town_id, nl_init:true }
     Se manda una ciudad por isla: la que MENOS pierde con el botín (recurso a
     recurso), y a igualdad la de almacén más vacío. Se excluyen las que ya llegaron
     al % de almacén configurado. */
  function pickTownsForClaim() {
    const towns = [], full = [];
    for (const [, group] of townsByIsland()) {
      const ok = group.filter((id) => !isTownStorageAtThreshold(id))
        .map((id) => ({ id, waste: claimWaste(id), fill: townFill(id) }))
        .sort((a, b) => (a.waste - b.waste) || (a.fill - b.fill));
      if (ok.length) towns.push(ok[0].id); else full.push(...group);
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
      farmRuntime.lastClaim = { at: Date.now(), booty: anyBooty, delay: randomDelayMs() };
      farmRuntime.nextCycleAt = Date.now() + seconds * 1000 + farmRuntime.lastClaim.delay;
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
    let expired = false;
    for (const n of $$('[data-nb-until]')) {
      n.textContent = formatLeft(+n.dataset.nbUntil);
      if (+n.dataset.nbUntil * 1000 <= Date.now()) expired = true;
    }
    // Algo terminó (envío llegado, edificio acabado, festival terminado): repintar
    // para que desaparezca en vez de quedarse en 0 (el juego tarda un momento en
    // actualizar sus datos, por eso se reintenta cada 2 s mientras siga en 0).
    if (expired && ['comercio', 'construccion', 'festivales', 'reclutamiento', 'investigacion', 'resumen'].includes(state.activeTab) && Date.now() - (updateCountdown.lastRepaint || 0) > 2000
        && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#novabot-panel input, #novabot-panel select'))) {
      updateCountdown.lastRepaint = Date.now();
      renderBody();
    }
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
        onclick: () => {
          cfg.tier = i; saveState();
          // Si ya se recogió, el próximo ciclo pasa a contar con el tiempo NUEVO desde
          // la última recogida (no se queda con el que había antes).
          const lc = farmRuntime.lastClaim;
          if (lc && farmRuntime.nextCycleAt > Date.now()) {
            const secs = (lc.booty ? FARM_TIME_SETS.booty : FARM_TIME_SETS.normal)[clamp(i, 0, 3)];
            farmRuntime.nextCycleAt = lc.at + secs * 1000 + lc.delay;
            farmLog(`Tiempo cambiado: próximo ciclo a las ${new Date(Math.max(Date.now(), farmRuntime.nextCycleAt)).toLocaleTimeString('es-ES')}.`, 'info');
          }
          renderBody(); updateCountdown();
        }
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

    bodyEl.appendChild(renderExchangeCard());

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Actividad'),
      logBox
    ]));
    farmLogEl = logBox;
    renderFarmLog();
  }

  /* ---------------------------------------------------------------------------------
     8a-bis) INTERCAMBIO CON ALDEAS — cambia recursos con las aldeas de la isla para
     equilibrar la ciudad (dar lo que sobra, recibir lo que falta) y para no perder
     lo que no cabe en el almacén.
     -----------------------------------------------------------------------------
     Leído del código del juego (23/09/2026):
       FarmTownPlayerRelation.trade(amount) →
       POST frontend_bridge?action=execute
         { model_url:'FarmTownPlayerRelation/<relId>', action_name:'trade', captcha:null,
           arguments:{ farm_town_id, amount } }
       Doy <amount> de resource_demand y recibo round(amount × tasa) de resource_offer.
       Límites (isTradeAllowed del propio juego): 100 ≤ amount ≤ 3000, ≤ comerciantes
       libres de la ciudad y ≤ lo que tenga del recurso.
     Tasa (24/09/2026, applyTradeRatioBonus del juego):
       tasa = min(trade_ratio + recuperado, 1,25) + 0,1 si LA CIUDAD que cambia tiene
       Oficina comercial (Game.constants.farm_towns.trade_ratio_bonus).
       Recuperado = 0,02 × velocidad por hora desde ratio_updated_at.
       Tras cambiar baja 0,03 por cada 100 entregados (wiki del juego): cambiar 3000
       la deja 0,9 más baja.
     Por qué solo con tasa alta: la tasa se recupera a ritmo fijo y se para al llegar
     al máximo. Cambiar la misma cantidad con tasa 0,85 o con 1,25 "gasta" lo mismo
     de recuperación, pero con 1,25 recibes un 47 % más. Así que los cambios normales
     (equilibrar) se hacen solo con la tasa alta; con tasa baja solo si el recurso se
     va a perder de todas formas (almacén lleno y sin sitio en otras ciudades).
     Tres tipos de cambio (por orden de preferencia):
       · alimentar: el comercio trajo ese recurso de otra ciudad para esta aldea.
       · rescate:   el recurso rebosará en la próxima recolección.
       · equilibrar: la ciudad (y el imperio) tiene más del que doy que del que recibo.
     Nunca da lo que la ciudad reserva para sus encargos ni hace rebosar lo que recibe.
  --------------------------------------------------------------------------------- */
  const exRuntime = {
    timer: null, running: false, pending: [], cooldown: new Map(), capGuess: new Map(), last: null,
    ratioOverride: new Map(),  // relId -> { base, at } tasa tras un cambio propio, hasta que el juego la actualice
    feeds: []                  // { townId, relId, give, get, amount, arrival, expires } envíos para alimentar una aldea
  };
  const EX_DROP_PER_UNIT = 0.0003; // la tasa baja 0,03 por cada 100 entregados
  const EX_MIN_GAIN = 300;         // no hacer cambios de equilibrio más pequeños que esto

  function exCollection(name) {
    try { return [].concat(UW.MM.getCollections()?.[name] || []).flatMap((c) => c?.models || []).map((m) => m.attributes); } catch { return []; }
  }
  function hasTradeOffice(townId) {
    try { return (+UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes?.trade_office || 0) >= 1; } catch { return false; }
  }
  // Hora del servidor en segundos (Timestamp del juego; si no, la del PC).
  const serverNow = () => { try { const t = +UW.Timestamp?.now?.(); if (t > 1e9) return t; } catch {} return Date.now() / 1000; };
  // Tasa base (sin bonus) ahora mismo: lo guardado + lo recuperado, hasta 1,25.
  function exBaseRatio(rel, nowS = serverNow()) {
    const def = +UW.Game?.constants?.farm_towns?.trade_ratio_default || 1.25;
    let base = +rel.trade_ratio || 0, upd = +rel.ratio_updated_at || 0;
    // Tras un cambio propio el juego tarda en mandar la tasa nueva: mientras la aldea
    // siga con los datos de antes, se usa la estimada.
    const ov = exRuntime.ratioOverride.get(+rel.id);
    if (ov) {
      if (upd === ov.prevUpd && (+rel.trade_ratio || 0) === ov.prevTr) { base = ov.base; upd = ov.at; }
      else exRuntime.ratioOverride.delete(+rel.id);
    }
    const speed = +UW.Game?.game_speed || 1;
    const rec = upd ? Math.max(0, nowS - upd) / 3600 * 0.02 * speed : 0;
    return Math.min(def, base + rec);
  }
  // Tasa real para UNA ciudad (el bonus de la Oficina comercial es de la ciudad que cambia).
  function exRatioFor(rel, townId) {
    const bonus = hasTradeOffice(townId) ? (+UW.Game?.constants?.farm_towns?.trade_ratio_bonus || 0.1) : 0;
    return Math.round((exBaseRatio(rel) + bonus) * 100) / 100;
  }
  // Máximo por intercambio: 3000 (límite del juego). Si el juego rechaza, se reduce
  // solo para esa aldea.
  const EX_MAX = 3000;
  function exMaxAmount(rel) {
    let m = EX_MAX;
    if (+rel.max_trade_capacity > 0) m = Math.min(m, +rel.max_trade_capacity);
    if (exRuntime.capGuess.has(+rel.id)) m = Math.min(m, exRuntime.capGuess.get(+rel.id));
    return m;
  }
  // Aldeas propias con las que se puede cambiar, agrupadas por isla ("x_y").
  function exVillagesByIsland() {
    const farms = new Map(exCollection('FarmTown').map((f) => [+f.id, f]));
    const out = new Map();
    for (const rel of exCollection('FarmTownPlayerRelation')) {
      if (+rel.relation_status !== 1) continue;
      const f = farms.get(+rel.farm_town_id);
      if (!f || !RES.includes(f.resource_demand) || !RES.includes(f.resource_offer) || f.resource_demand === f.resource_offer) continue;
      const key = `${+f.island_x}_${+f.island_y}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ rel, farm: f, give: f.resource_demand, get: f.resource_offer });
    }
    return out;
  }
  function exVillagesFor(townId) {
    const xy = townXY(townId);
    return (exVillagesByIsland().get(`${xy.x}_${xy.y}`) || []).map((v) => ({ ...v, ratio: exRatioFor(v.rel, townId) }));
  }
  function exPendingTo(townId) {
    const now = Date.now();
    exRuntime.pending = exRuntime.pending.filter((p) => p.arrival > now);
    const out = { wood: 0, stone: 0, iron: 0 };
    for (const p of exRuntime.pending) if (p.townId === +townId) out[p.res] += p.amount;
    return out;
  }

  // Estado del imperio (lo usa también la Cueva: globalMiss.iron).
  function exContext() {
    const towns = allTownIds();
    let demands = [];
    try { demands = collectDemands(); } catch {}
    let transit = [];
    try { transit = transitRows(); } catch {}
    const ctx = {};
    const globalMiss = { wood: 0, stone: 0, iron: 0 };
    for (const id of towns) {
      const total = { wood: 0, stone: 0, iron: 0 }, reserve = { wood: 0, stone: 0, iron: 0 };
      for (const d of demands) if (+d.townId === id) for (const k of RES) (d.reserveOnly ? reserve : total)[k] += +d[k] || 0;
      const cur = townResources(id), inc = incomingTo(id, transit), pend = exPendingTo(id);
      const miss = Object.fromEntries(RES.map((k) => [k, Math.max(0, total[k] - cur[k] - inc[k] - pend[k])]));
      for (const k of RES) globalMiss[k] += miss[k];
      ctx[id] = { cur, total, reserve, inc, pend, miss, storage: townStorage(id) || 0 };
    }
    return { towns, ctx, globalMiss };
  }

  // Envío de alimentación que ya llegó (o está a punto) para esta aldea y ciudad.
  function exFeedFor(relId, townId, now = Date.now()) {
    return exRuntime.feeds.find((f) => f.relId === +relId && f.townId === +townId && f.arrival <= now + 5000 && f.expires > now) || null;
  }

  // Mejor cambio posible de UNA aldea en UNA ciudad (o null). M = resourceModel().
  // Devuelve { amount, receive, mode, score }.
  function exCandidate(M, townId, v, ratio, cfg = state.aldeas, now = Date.now()) {
    const t = M.T[townId];
    if (!t || !t.storage) return null;
    const X = v.give, Y = v.get, S = t.storage;
    const cave = caveOn();
    // Con la Cueva activa: solo se cambia POR plata (la Cueva la guarda) y nunca se da plata.
    if (cave && (Y !== 'iron' || X === 'iron')) return null;
    const cap = t.capLeft ?? t.cap;
    if (cap < 100) return null;
    const avail = Math.max(0, Math.floor(t.cur[X] - t.keep[X]));
    if (avail < 100) return null;
    // Sitio para lo que recibo: hasta la línea de seguridad (con Cueva, la plata hasta el 95 %).
    const roomY = cave ? S * 0.95 - t.lvl.iron : t.safe[Y] - t.lvl[Y];
    if (roomY / ratio < 100) return null;
    const gainR = clamp(+cfg.gainRatio || 1.2, 0.5, 1.5);
    const minR = clamp(+cfg.minRatio || 0.85, 0.3, 1.5);
    let amount = 0, mode = null, rank = 0, pref = 0;
    // Lo traído para esta aldea: se cambia en cuanto haya llegado (casi todo).
    const feed = exFeedFor(v.rel.id, townId, now);
    if (feed && avail >= feed.amount * 0.8 && ratio + 1e-9 >= Math.min(gainR, minR)) {
      mode = 'alimentar'; rank = 3; amount = Math.min(feed.amount, avail);
    } else if (t.over[X] > 0 && ratio + 1e-9 >= minR) {
      // Rescate con pérdida (tasa < 1) solo si no hay otra salida: el equilibrio entre
      // ciudades está apagado, no queda sitio en otras ciudades o la recolección es ya.
      const eqOn = !!(state.equilibrio?.enabled && state.comercio?.enabled);
      const imminent = M.dt !== null && M.dt < 3 / 60;
      if (ratio >= 1 || !eqOn || imminent || (M.roomAll[X] || 0) < t.over[X]) {
        // Con pérdida, solo lo que de verdad rebosaría; con ganancia, hasta la línea de seguridad.
        mode = 'rescate'; rank = 2; amount = Math.min(avail, ratio >= 1 ? Math.max(t.over[X], t.lvl[X] - t.safe[X]) : t.over[X]);
        pref = 1 - t.lvl[Y] / S; // mejor recibir lo que menos tiene
      }
    }
    if (!mode && ratio + 1e-9 >= gainR) {
      // Lo que otras ciudades esperan de X se lo manda antes el comercio.
      const others = Math.max(0, (M.globalMiss[X] || 0) - t.miss[X]);
      if (cave) {
        // Con Cueva: se cambia por plata lo que pase del % elegido del almacén.
        const line = S * clamp(+cfg.excessPct || 70, 10, 100) / 100;
        if (t.lvl[X] > line) { mode = 'equilibrar'; rank = 1; pref = (t.lvl[X] - line) / S; amount = Math.min(t.lvl[X] - line, avail - others); }
      } else {
        // Equilibrar: cuánto más tengo de X que de Y, en la ciudad y en todo el imperio.
        const d = (t.lvl[X] - t.lvl[Y]) / S + (M.F[X] - M.F[Y]);
        if (d > 0.04) { mode = 'equilibrar'; rank = 1; pref = d; amount = Math.min(d * S / (1 + ratio), avail - others); }
      }
      // Con ciudades esperando recursos, los cambios normales no gastan los comerciantes
      // que el comercio puede necesitar (misma parte que el equilibrio).
      if (mode && M.busy) {
        const busyPct = clamp(+state.equilibrio?.busyCapPct || 20, 0, 100) / 100;
        amount = Math.min(amount, cap - t.maxCap * (1 - busyPct));
      }
    }
    // Exceso: si la ciudad va muy llena de X y en todo el imperio sobra X mucho más que Y,
    // se cambia aunque la tasa sea baja (por defecto desde 0,6): mejor plata que almacenes
    // llenos de madera o piedra sin usar.
    if (!mode && cfg.bulk !== false) {
      const bulkLine = S * clamp(+cfg.bulkPct || 85, 50, 100) / 100;
      const bulkR = clamp(+cfg.bulkRatio || 0.6, 0.3, 1.5);
      const gap = M.F[X] - M.F[Y];
      if (t.lvl[X] > bulkLine && ratio + 1e-9 >= bulkR && gap >= 0.15 && (t.lvl[X] - t.lvl[Y]) / S >= 0.15) {
        const others = Math.max(0, (M.globalMiss[X] || 0) - t.miss[X]);
        mode = 'exceso'; rank = 0.5; pref = gap;
        amount = Math.min(t.lvl[X] - bulkLine * 0.95, (t.lvl[X] - t.lvl[Y]) / (1 + ratio), avail - others);
        if (M.busy) amount = Math.min(amount, cap - t.maxCap * (1 - clamp(+state.equilibrio?.busyCapPct || 20, 0, 100) / 100));
      }
    }
    if (!mode) return null;
    amount = Math.floor(Math.min(amount, cap, exMaxAmount(v.rel), roomY / ratio));
    if (amount < (mode === 'equilibrar' || mode === 'exceso' ? EX_MIN_GAIN : 100)) return null;
    return { amount, receive: Math.round(amount * ratio), mode, score: rank * 1e9 + pref * 1e6 + ratio * 1e4 + amount / 1000 };
  }

  // Plan de intercambios de TODAS las islas (máx. `limit`). Cada aldea se usa una vez
  // por vuelta y la hace la ciudad de la isla donde más ayuda (y con mejor tasa: la
  // Oficina comercial da +0,1).
  function exPlanAll(M, cfg = state.aldeas, limit = 3) {
    const now = Date.now();
    const byIsland = new Map();
    for (const id of M.towns) {
      const t = M.T[id];
      if (!t) continue;
      t.capLeft = t.cap;
      if (!byIsland.has(t.island)) byIsland.set(t.island, []);
      byIsland.get(t.island).push(id);
    }
    const villages = [];
    for (const [key, list] of exVillagesByIsland()) {
      if (!byIsland.has(key)) continue;
      for (const v of list) {
        if ((exRuntime.cooldown.get(+v.rel.id) || 0) > now) continue;
        // Aldea esperando lo que le trae el comercio: no se usa para otra cosa mientras.
        if (exRuntime.feeds.some((f) => f.relId === +v.rel.id && f.arrival > now + 5000 && f.expires > now)) continue;
        villages.push({ ...v, towns: byIsland.get(key) });
      }
    }
    const plan = [];
    const used = new Set();
    while (plan.length < limit) {
      let best = null;
      for (const v of villages) {
        if (used.has(v.rel.id)) continue;
        for (const tid of v.towns) {
          const ratio = exRatioFor(v.rel, tid);
          const c = exCandidate(M, tid, v, ratio, cfg, now);
          if (c && (!best || c.score > best.score)) best = { ...c, townId: tid, rel: v.rel, farm: v.farm, give: v.give, get: v.get, ratio };
        }
      }
      if (!best) break;
      used.add(best.rel.id);
      plan.push(best);
      const t = M.T[best.townId];
      t.cur[best.give] -= best.amount; t.lvl[best.give] -= best.amount;
      t.lvl[best.get] += best.receive; t.capLeft -= best.amount;
      t.over[best.give] = Math.max(0, t.over[best.give] - best.amount);
    }
    return plan;
  }

  async function exchangeTick() {
    const cfg = state.aldeas;
    if (!cfg.enabled) return;
    const now = Date.now();
    exRuntime.feeds = exRuntime.feeds.filter((f) => f.expires > now);
    const M = resourceModel();
    try { M.busy = tradeBusy(planTrades().needs); } catch {}
    const plan = exPlanAll(M, cfg, 3);
    for (const t of plan) {
      if (!state.aldeas.enabled) return;
      const baseBefore = exBaseRatio(t.rel);
      try {
        await gpPostAs(t.townId, 'frontend_bridge', 'execute', {
          model_url: `FarmTownPlayerRelation/${t.rel.id}`, action_name: 'trade', captcha: null,
          arguments: { farm_town_id: +t.farm.id, amount: t.amount }, nl_init: true
        });
        const dur = Math.max(30, +t.rel.trade_duration || 150);
        exRuntime.pending.push({ townId: t.townId, res: t.get, amount: t.receive, arrival: Date.now() + dur * 1000 + 15000 });
        exRuntime.cooldown.set(+t.rel.id, Date.now() + 3 * 60000);
        exRuntime.ratioOverride.set(+t.rel.id, { base: Math.max(0, baseBefore - t.amount * EX_DROP_PER_UNIT), at: serverNow(), prevUpd: +t.rel.ratio_updated_at || 0, prevTr: +t.rel.trade_ratio || 0 });
        if (t.mode === 'alimentar') exRuntime.feeds = exRuntime.feeds.filter((f) => !(f.relId === +t.rel.id && f.townId === t.townId));
        farmLog(`${farmTownName(t.townId)} (${t.mode}): ${t.amount} ${RES_ES[t.give]} → ${t.receive} ${RES_ES[t.get]} con ${t.farm.name} (tasa ${t.ratio.toFixed(2)}).`, 'ok');
      } catch (e) {
        exRuntime.cooldown.set(+t.rel.id, Date.now() + 5 * 60000);
        exRuntime.capGuess.set(+t.rel.id, Math.max(500, Math.floor(t.amount / 2)));
        farmLog(`${farmTownName(t.townId)}: intercambio con ${t.farm.name} rechazado (${e.message}).`, 'error');
      }
      await sleep(600 + Math.random() * 700);
    }
    exRuntime.last = Date.now();
    if (plan.length) renderIfIdle('granjas');
  }
  const RES_ES = { wood: 'madera', stone: 'piedra', iron: 'plata' };

  /* ---------------------------------------------------------------------------------
     8a-ter) CUEVA — meter plata en las cuevas
     -----------------------------------------------------------------------------
     Leído del juego (vista general de cuevas, 24/09/2026):
       · Estado: GET town_overviews?action=hides_overview → html con, por ciudad,
         id="ov_town_<id>" data-iron-stored="<guardada>" y "(guardada/máximo)"
         (máximo "∞" con Cueva 10; si no, 1000 por nivel).
       · Guardar: POST town_overviews?action=store_iron
         { town_id, active_town_id, iron_to_keep:0, iron_to_store } → { iron, iron_stored }
     Cuánto se mete: por TOTAL del imperio. Se deja siempre un % de la suma de almacenes
     en plata (para lo que venga); lo que pasa de ahí se puede meter, aunque sea todo
     en una sola ciudad, sin tocar lo que necesita esa ciudad (según la Prioridad).
  --------------------------------------------------------------------------------- */
  const caveRuntime = { timer: null, running: false, log: [], info: new Map(), infoAt: 0, plan: null, planAt: 0, planning: false, cooldown: new Map() };
  let caveLogEl = null;
  const caveOn = () => !!state.cueva?.enabled;
  const hideLevel = (townId) => { try { return +UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes?.hide || 0; } catch { return 0; } };
  // Capacidad y lo guardado: el nivel manda (Cueva 10 = sin límite; si no, 1000/nivel).
  function caveInfo(townId) {
    const lvl = hideLevel(townId);
    const i = caveRuntime.info.get(+townId);
    const max = lvl >= 10 ? Infinity : lvl * 1000;
    return { lvl, max, stored: i ? i.stored : null };
  }
  async function refreshCaveInfo() {
    const d = await gpGet('town_overviews', 'hides_overview', { nl_init: true });
    const html = String(d?.html || '');
    const map = new Map();
    for (const m of html.matchAll(/id="ov_town_(\d+)"[^>]*?data-iron-stored="(\d+)"/g)) map.set(+m[1], { stored: +m[2] });
    // (por si el orden de atributos cambia)
    for (const m of html.matchAll(/data-iron-stored="(\d+)"[^>]*?id="ov_town_(\d+)"/g)) if (!map.has(+m[2])) map.set(+m[2], { stored: +m[1] });
    if (map.size) { caveRuntime.info = map; caveRuntime.infoAt = Date.now(); caveRuntime.planAt = 0; }
    return map.size;
  }

  // Plan de TODAS las ciudades (cacheado unos segundos: la Prioridad lo consulta mucho).
  function cavePlanAll() {
    if (caveRuntime.plan && Date.now() - caveRuntime.planAt < 4000) return caveRuntime.plan;
    if (caveRuntime.planning) return caveRuntime.plan || { by: new Map(), budget: 0, keep: 0, total: 0 };
    caveRuntime.planning = true;
    try {
      const cfg = state.cueva;
      const by = new Map();
      const towns = allTownIds();
      let total = 0, storTotal = 0;
      const rows = [];
      for (const id of towns) {
        const cur = townResources(id).iron, stor = townStorage(id) || 0;
        total += cur; storTotal += stor;
        const ci = caveInfo(id);
        let room = ci.lvl ? (ci.max === Infinity ? Infinity : (ci.stored === null ? 0 : Math.max(0, ci.max - ci.stored))) : 0;
        if (+cfg.cap > 0) room = ci.stored === null ? 0 : Math.min(room, Math.max(0, +cfg.cap - ci.stored));
        // Lo que esta ciudad necesita de plata según la Prioridad (módulos por encima de la Cueva).
        let need = 0;
        try { need = reserveAbove(id, 'cueva').iron || 0; } catch {}
        rows.push({ id, cur, room, avail: Math.max(0, Math.floor(cur - need)) });
      }
      const keep = Math.round(storTotal * clamp(+cfg.keepPct || 0, 0, 100) / 100);
      // Lo que otras ciudades esperan de plata (se lo mandará el comercio) tampoco se toca.
      let missIron = 0;
      try { missIron = exContext().globalMiss.iron || 0; } catch {}
      let budget = Math.max(0, Math.floor(total - keep - missIron));
      const budget0 = budget;
      // Primero las ciudades con más plata libre (así se vacía donde más sobra).
      rows.sort((a, b) => b.avail - a.avail);
      for (const r of rows) {
        const a = Math.floor(Math.min(r.avail, r.room, budget));
        if (a > 0) { by.set(r.id, a); budget -= a; }
      }
      caveRuntime.plan = { by, keep, total, rows, missIron, budget: budget0 };
      caveRuntime.planAt = Date.now();
      return caveRuntime.plan;
    } finally { caveRuntime.planning = false; }
  }
  function cavePlanFor(townId) {
    if (!caveOn()) return 0;
    const a = cavePlanAll().by.get(+townId) || 0;
    return a >= Math.max(1, +state.cueva.minDeposit || 0) ? a : 0;
  }

  async function caveTick() {
    if (!caveOn()) return;
    if (Date.now() - caveRuntime.infoAt > 10 * 60000) { try { await refreshCaveInfo(); } catch (e) { caveLog(`No se pudo leer las cuevas: ${e.message}`, 'error'); return; } }
    caveRuntime.planAt = 0;
    const plan = cavePlanAll();
    let done = 0;
    for (const [townId] of [...plan.by.entries()].sort((a, b) => b[1] - a[1])) {
      if (!caveOn() || done >= 5) break;
      if ((caveRuntime.cooldown.get(townId) || 0) > Date.now()) continue;
      const amount = cavePlanFor(townId);
      if (!amount) continue;
      // Justo antes: plata real de ahora (puede haberse gastado mientras tanto).
      const cur = townResources(townId).iron;
      let need = 0; try { need = reserveAbove(townId, 'cueva').iron || 0; } catch {}
      const a = Math.floor(Math.min(amount, cur - need));
      if (a < Math.max(1, +state.cueva.minDeposit || 0)) continue;
      try {
        const r = await gpPost('town_overviews', 'store_iron', { town_id: +townId, active_town_id: +UW.Game?.townId || +townId, iron_to_keep: 0, iron_to_store: a });
        const prev = caveRuntime.info.get(+townId)?.stored || 0;
        caveRuntime.info.set(+townId, { stored: Number.isFinite(+r?.iron_stored) && +r.iron_stored >= prev ? +r.iron_stored : prev + a });
        caveRuntime.planAt = 0;
        done += 1;
        caveLog(`${farmTownName(townId)}: ${a.toLocaleString('es-ES')} de plata a la cueva.`, 'ok');
      } catch (e) {
        caveRuntime.cooldown.set(townId, Date.now() + 10 * 60000);
        caveLog(`${farmTownName(townId)}: ${e.message}`, 'error');
      }
      await sleep(700 + Math.random() * 700);
    }
    if (done) setTimeout(() => refreshCaveInfo().catch(() => {}), 4000);
    renderIfIdle('cueva');
  }
  function startCaveEngine() {
    if (caveRuntime.timer) return;
    caveRuntime.timer = setInterval(() => {
      if (!caveOn() || caveRuntime.running) return;
      caveRuntime.running = true;
      caveTick().catch((e) => caveLog(`Error: ${e.message}`, 'error')).finally(() => { caveRuntime.running = false; });
    }, 120000);
  }
  function caveLog(text, kind = 'info') {
    caveRuntime.log.unshift({ at: Date.now(), text, kind });
    caveRuntime.log = caveRuntime.log.slice(0, 30);
    if (caveLogEl) paintLog(caveLogEl, caveRuntime.log);
  }
  function renderCuevaTab() {
    const cfg = state.cueva;
    const fmt = (n) => (n === Infinity ? '∞' : Math.round(n).toLocaleString('es-ES'));
    const runNow = () => { if (caveRuntime.running) return; caveRuntime.running = true; caveTick().catch((e) => caveLog(`Error: ${e.message}`, 'error')).finally(() => { caveRuntime.running = false; }); };
    const num = (key, min, max, step, def) => {
      const i = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: String(min), max: String(max), step: String(step), value: cfg[key] });
      i.addEventListener('change', () => { cfg[key] = clamp(pos(i.value, def), min, max); saveState(); caveRuntime.planAt = 0; renderBody(); });
      return i;
    };
    bodyEl.appendChild(el('div', { class: 'nb-card', 'data-nb-card': 'cueva' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Meter plata en las cuevas')]),
        switchEl(!!cfg.enabled, (v) => { cfg.enabled = v; saveState(); caveRuntime.planAt = 0; caveLog(v ? 'Cueva activada.' : 'Cueva desactivada.'); renderBody(); if (v) { caveRuntime.infoAt = 0; runNow(); } }, false)]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Plata que se deja siempre en el imperio (% de la suma de almacenes)'), el('span', {}, [num('keepPct', 0, 100, 5, 25), ' %'])]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Tope por cueva (0 = sin tope)'), num('cap', 0, 100000000, 1000, 0)]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Mínimo por ingreso'), num('minDeposit', 100, 100000, 100, 500)]),
      el('p', { class: 'nb-placeholder' }, 'Cada 2 min. Se mira la plata de TODAS las ciudades: siempre queda ese % para lo que venga, y lo que sobra se mete (aunque sea todo en una ciudad), sin tocar lo que esa ciudad necesita según la Prioridad de recursos. Cueva 10 = sin límite; si no, 1000 por nivel.')
    ]));
    // Relación con el Intercambio con aldeas (Granjas)
    const exOn = !!state.aldeas?.enabled;
    bodyEl.appendChild(el('div', { class: `nb-alert ${cfg.enabled && exOn ? 'nb-alert-info' : 'nb-alert-warn'}` }, [
      el('span', {}, cfg.enabled
        ? (exOn ? [el('b', {}, 'Intercambio con aldeas: activo · solo por plata. '), `Lo que sobre de madera o piedra (más del ${state.aldeas.excessPct}% del almacén) se cambia por plata con tasa ≥ ${state.aldeas.gainRatio ?? 1.2} (o ≥ ${state.aldeas.minRatio} si rebosaría), y la Cueva la guarda.`]
                : [el('b', {}, 'Intercambio con aldeas: desactivado. '), 'Actívalo en Granjas para cambiar lo que sobre de madera o piedra por plata y meterla en las cuevas.'])
        : [el('b', {}, 'Con la Cueva activa, '), 'el Intercambio con aldeas (Granjas) solo cambia por plata.']),
      el('span', { class: 'nb-btn nb-btn-sm', onclick: () => gotoCard('granjas', 'aldeas') }, 'Ir al intercambio con aldeas')
    ]));

    // Estado
    const plan = cfg.enabled ? (caveRuntime.planAt = 0, cavePlanAll()) : null;
    const list = el('div', { class: 'nb-goals' });
    const towns = allTownIds().map((id) => ({ id, name: farmTownName(id), ci: caveInfo(id), iron: townResources(id).iron })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    for (const t of towns) {
      const next = plan ? cavePlanFor(t.id) : 0;
      const stored = t.ci.stored;
      const full = t.ci.max !== Infinity && stored !== null && stored >= t.ci.max;
      const capped = +cfg.cap > 0 && stored !== null && stored >= +cfg.cap;
      const sub = !t.ci.lvl ? 'Sin cueva'
        : stored === null ? 'Leyendo cueva…'
        : full ? 'Cueva llena (sube su nivel para meter más)'
        : capped ? 'Tope alcanzado'
        : next ? el('span', {}, ['Siguiente: ', el('b', {}, fmt(next)), ' de plata'])
        : 'Nada que meter ahora';
      const pct = t.ci.max === Infinity ? null : Math.min(100, Math.round((stored || 0) / Math.max(1, t.ci.max) * 100));
      list.appendChild(el('div', { class: `nb-goal${next ? ' nb-goal-next' : ''}` }, [
        buildingIcon('hide', true),
        el('div', { class: 'nb-goal-main' }, [el('div', { class: 'nb-goal-name' }, `${t.name} · Cueva ${t.ci.lvl}`), el('div', { class: 'nb-goal-sub' }, [sub])]),
        el('span', { class: 'nb-pill' }, `${stored === null ? '—' : fmt(stored)} / ${fmt(t.ci.max)}`),
        pct === null ? null : el('div', { class: 'nb-bar nb-bar-mini' }, [el('div', { class: 'nb-bar-fill', style: `width:${pct}%` })])
      ]));
    }
    const totalStored = towns.reduce((s, t) => s + (t.ci.stored || 0), 0);
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Cuevas'),
      plan ? el('div', { class: 'nb-alert nb-alert-info' }, [
        'Plata en ciudades: ', el('b', {}, fmt(plan.total)), ' · se deja: ', el('b', {}, fmt(plan.keep)),
        ' · se puede meter: ', el('b', {}, fmt(plan.budget)), ' · ya guardada: ', el('b', {}, fmt(totalStored))
      ]) : null,
      el('div', { class: 'nb-row nb-mt' }, [el('span', { class: 'nb-row-label' }, caveRuntime.infoAt ? `Datos de las cuevas: ${new Date(caveRuntime.infoAt).toLocaleTimeString('es-ES')}` : 'Datos de las cuevas: sin leer'),
        el('span', { class: 'nb-btn nb-btn-sm', onclick: () => refreshCaveInfo().then(() => renderIfIdle('cueva')).catch((e) => caveLog(e.message, 'error')) }, 'Actualizar')]),
      el('div', { class: 'nb-mt' }, [list])
    ]));
    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    caveLogEl = logBox; paintLog(logBox, caveRuntime.log);
    if (!caveRuntime.infoAt && !caveRuntime.infoLoading) { caveRuntime.infoLoading = true; refreshCaveInfo().then(() => renderIfIdle('cueva')).catch(() => {}).finally(() => { caveRuntime.infoLoading = false; }); }
  }

  function startExchangeEngine() {
    if (exRuntime.timer) return;
    exRuntime.timer = setInterval(() => {
      if (!state.aldeas.enabled || exRuntime.running) return;
      exRuntime.running = true;
      exchangeTick().catch((e) => farmLog(`Intercambio: ${e.message}`, 'error')).finally(() => { exRuntime.running = false; });
    }, 60000);
  }

  function renderExchangeCard() {
    const cfg = state.aldeas;
    const numIn = (key, min, max, step, def, isFloat = true) => {
      const i = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: String(min), max: String(max), step: String(step), value: cfg[key] ?? def });
      i.addEventListener('change', () => { cfg[key] = clamp(isFloat ? (+i.value || def) : pos(i.value, def), min, max); saveState(); renderBody(); });
      return i;
    };
    const runNow = () => { if (exRuntime.running) return; exRuntime.running = true; exchangeTick().catch((e) => farmLog(`Intercambio: ${e.message}`, 'error')).finally(() => { exRuntime.running = false; }); };
    // Vista previa: aldeas de la ciudad abierta (con SU tasa) y próximos cambios de todo el imperio.
    let preview = null;
    const tid = +UW.Game?.townId;
    try {
      const vs = tid ? exVillagesFor(tid) : [];
      const gainR = +cfg.gainRatio || 1.2;
      const plan = cfg.enabled ? exPlanAll(resourceModel(), cfg, 6) : [];
      const now = Date.now();
      const feeds = exRuntime.feeds.filter((f) => f.expires > now);
      preview = el('div', { class: 'nb-mt' }, [
        vs.length ? el('div', { class: 'nb-card-title' }, `Aldeas de ${farmTownName(tid)}${hasTradeOffice(tid) ? ' (Oficina comercial +0,1)' : ''}`) : null,
        vs.length ? el('div', { class: 'nb-ex-list' }, vs.map((v) => el('div', { class: `nb-ex-item${v.ratio + 1e-9 >= gainR ? '' : ' nb-ex-off'}` }, [
          el('span', { class: 'nb-ex-name' }, v.farm.name),
          el('span', { class: 'nb-ex-trade' }, [resIcon(v.give), '→', resIcon(v.get)]),
          el('b', {}, v.ratio.toFixed(2))
        ]))) : el('p', { class: 'nb-placeholder' }, 'La ciudad abierta no tiene aldeas propias en su isla.'),
        el('div', { class: 'nb-card-title nb-mt' }, `Próximos cambios (${plan.length})`),
        plan.length
          ? el('div', { class: 'nb-queue' }, plan.map((t) => el('div', { class: 'nb-queue-item' }, [
              el('span', {}, [el('span', { class: 'nb-pill' }, t.mode), ` ${farmTownName(t.townId)}: ${t.amount} `, resIcon(t.give), ` → ${t.receive} `, resIcon(t.get), ` · ${t.farm.name}`]),
              el('span', { class: 'nb-queue-time' }, t.ratio.toFixed(2))
            ])))
          : el('p', { class: 'nb-placeholder' }, cfg.enabled ? `Nada ahora: ninguna aldea con tasa ≥ ${gainR} tiene algo que equilibrar, y nada rebosa.` : 'Desactivado.'),
        feeds.length ? el('div', { class: 'nb-card-title nb-mt' }, `Esperando envío para cambiar (${feeds.length})`) : null,
        feeds.length ? el('div', { class: 'nb-queue' }, feeds.map((f) => el('div', { class: 'nb-queue-item' }, [
          el('span', {}, [`${farmTownName(f.townId)}: ${f.amount} `, resIcon(f.give), ' → ', resIcon(f.get)]),
          el('span', { class: 'nb-queue-time', 'data-nb-until': Math.round(f.arrival / 1000) }, formatLeft(Math.round(f.arrival / 1000)))
        ]))) : null
      ]);
    } catch (e) { console.warn('[NOVABOT][aldeas]', e); }
    return el('div', { class: `nb-card${caveOn() ? ' nb-card-accent' : ''}`, 'data-nb-card': 'aldeas' }, [
      el('div', { class: 'nb-row' }, [
        el('span', { class: 'nb-row-label' }, [el('b', {}, 'Intercambio con aldeas'), caveOn() ? el('span', { class: 'nb-pill nb-ml' }, 'solo plata') : null]),
        switchEl(!!cfg.enabled, (v) => { cfg.enabled = v; saveState(); farmLog(v ? 'Intercambio con aldeas activado.' : 'Intercambio con aldeas desactivado.', 'info'); renderBody(); if (v) runNow(); }, false)
      ]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Tasa para equilibrar (≥)'), numIn('gainRatio', 0.8, 1.35, 0.05, 1.2)]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Tasa si se va a perder (≥)'), numIn('minRatio', 0.5, 1.35, 0.05, 0.85)]),
      caveOn() ? el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Con Cueva: cambiar por plata lo que pase de (% del almacén)'), el('span', {}, [numIn('excessPct', 10, 100, 5, 70, false), ' %'])]) : null,
      optionRow('Cambiar con pérdida si sobra mucho', 'Si una ciudad pasa del % de abajo en un recurso y en todo el imperio sobra ese recurso mucho más que otro (p. ej. madera 80 % y plata 45 %), lo cambia por el que falta aunque la tasa sea baja', cfg.bulk !== false, (v) => { cfg.bulk = v; saveState(); renderBody(); }),
      cfg.bulk !== false ? el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Sobra mucho a partir de (% del almacén) · tasa mínima'), el('span', {}, [numIn('bulkPct', 50, 100, 5, 85, false), ' % · ', numIn('bulkRatio', 0.3, 1.35, 0.05, 0.6)])]) : null,
      optionRow('Traer de otras ciudades', 'Si una aldea con buena tasa pide un recurso que su isla no tiene, el comercio lo trae de donde sobra y aquí se cambia al llegar (necesita Comercio y Equilibrio)', cfg.feed !== false, (v) => { cfg.feed = v; saveState(); renderBody(); }),
      el('p', { class: 'nb-placeholder' }, 'Cada minuto, en todas las islas: con tasa alta da lo que más sobra (en la ciudad y en el imperio) por lo que menos hay. Con tasa baja solo si ese recurso rebosaría en la próxima recolección y no cabe en otra ciudad. La tasa se recupera sola y a ritmo fijo, así que cambiar solo con tasa alta da bastante más por lo mismo. Nunca da lo reservado para encargos ni hace rebosar lo que recibe.'),
      caveOn() ? el('div', { class: 'nb-alert nb-alert-info nb-mt' }, [
        el('span', {}, [el('b', {}, 'Cueva activa: '), 'solo se cambia POR PLATA (para meterla en las cuevas). El resto de aldeas no se usan mientras la Cueva esté activa.']),
        el('span', { class: 'nb-btn nb-btn-sm', onclick: () => gotoCard('cueva', 'cueva') }, 'Ver Cueva')
      ]) : null,
      preview
    ]);
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

  // Activación por ciudad: cada ciudad puede tener una excepción (on/off) al
  // interruptor general. Cambiar el general quita todas las excepciones.
  const buildEnabledFor = (townId) => { const v = state.construccion.towns[townId]?.enabled; return typeof v === 'boolean' ? v : !!state.construccion.enabled; };
  const anyBuildEnabled = () => allTownIds().some(buildEnabledFor);
  function setModuleGlobal(key, v) {
    state[key].enabled = v;
    // (el inicio programado / la espera de cada ciudad se mantiene: si no, al tocar
    // el general esas ciudades empezarían a pedir recursos antes de su hora)
    for (const t of Object.values(state[key].towns || {})) delete t.enabled;
    saveState();
  }

  function townBuildCfg(townId) {
    const all = state.construccion.towns;
    if (!all[townId]) all[townId] = { goals: [] };
    return all[townId];
  }

  // Intercalar es POR CIUDAD. Las que aún no lo han tocado heredan el valor que
  // tenía la antigua opción general (así nadie pierde lo que ya tenía puesto).
  function townInterleave(townId) {
    const v = state.construccion.towns[townId]?.interleave;
    return typeof v === 'boolean' ? v : !!state.construccion.interleave;
  }

  // Bloqueos que NO se arreglan mandando recursos (null = ninguno).
  // OJO: info.population_free NO es la población libre de la ciudad (es la que
  // se liberaría al derribar un nivel). La libre real es getAvailablePopulation().
  function buildHardBlock(info, townId) {
    if (!info) return 'sin datos';
    if (info.has_max_level) return 'nivel máximo';
    if (info.group_locked) return 'bloqueado';
    if (Array.isArray(info.missing_dependencies) && info.missing_dependencies.length) return 'faltan requisitos';
    if (!info.enough_storage) return 'almacén pequeño';
    let free = NaN;
    try { free = +UW.ITowns.getTown(townId)?.getAvailablePopulation?.(); } catch {}
    if (Number.isFinite(free) && free < (+info.population_for || 0)) return 'falta población';
    return null;
  }
  // Motivo por el que no se puede subir ahora (null = se puede).
  function buildBlockReason(townId, info) {
    const hard = buildHardBlock(info, townId);
    if (hard) return hard;
    const cost = info.resources_for || {};
    const r = townResources(townId);
    if (r.wood < (+cost.wood || 0) || r.stone < (+cost.stone || 0) || r.iron < (+cost.iron || 0)) return 'faltan recursos';
    const fr = reserveAbove(townId, 'construccion');
    if (r.wood - fr.wood < (+cost.wood || 0) || r.stone - fr.stone < (+cost.stone || 0) || r.iron - fr.iron < (+cost.iron || 0)) return `reservado para ${reserveOwner(townId, 'construccion') || 'otro módulo'}`;
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

  // Nivel del edificio contando la cola del juego (subidas +1, derribos −1).
  // Sin derribos en cola vale committedLevel; con derribos se calcula desde el nivel real.
  function queuedLevel(townId, id, info) {
    const orders = townBuildOrders(townId).filter((o) => o.building_type === id);
    if (!orders.some((o) => o.tear_down)) return committedLevel(info);
    let real = NaN;
    try { real = +UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes?.[id]; } catch {}
    if (!Number.isFinite(real)) return committedLevel(info);
    return real + orders.reduce((n, o) => n + (o.tear_down ? -1 : 1), 0);
  }

  /* Plan de construcción = lista ordenada de NIVELES sueltos { id, level, gi, down }.
     · Un objetivo con demolish:true DERRIBA hasta ese nivel (un nivel cada vez).
     · Normal: objetivo a objetivo, en el orden en que los añadiste. Un edificio puede
       estar varias veces (p. ej. Senado 20, Muralla 11, Senado 22) para intercalar a mano.
     · Intercalar: un nivel de cada edificio por turnos, empezando por el siguiente al
       último que se construyó (tcfg.lastId), así el turno va rotando de verdad. */
  function buildPlan(townId) {
    const bd = buildDataFor(townId);
    if (!bd) return [];
    const tcfg = townBuildCfg(townId);
    const maxOf = (id) => +UW.GameData?.buildings?.[id]?.max_level || 99;
    // Pasos de cada edificio, en el orden de sus objetivos (subir y/o derribar).
    const seq = new Map(), sim = {};
    tcfg.goals.forEach((g, gi) => {
      const info = bd.building_data?.[g.id];
      if (!info) return;
      if (!seq.has(g.id)) seq.set(g.id, []);
      let lvl = sim[g.id] ?? queuedLevel(townId, g.id, info);
      if (g.demolish) { while (lvl > Math.max(0, g.target)) { lvl -= 1; seq.get(g.id).push({ id: g.id, level: lvl, gi, down: true }); } }
      else { while (lvl < Math.min(g.target, maxOf(g.id))) { lvl += 1; seq.get(g.id).push({ id: g.id, level: lvl, gi }); } }
      sim[g.id] = lvl;
    });
    if (!townInterleave(townId)) {
      // Normal: objetivo a objetivo, en el orden de la lista.
      return [...seq.values()].flat().sort((a, b) => a.gi - b.gi || 0);
    }
    // Intercalado: un paso de cada edificio por turnos, empezando tras el último hecho.
    const ids = [...seq.keys()];
    const k = ids.indexOf(tcfg.lastId);
    const order = k >= 0 ? [...ids.slice(k + 1), ...ids.slice(0, k + 1)] : ids;
    const out = [], pos = Object.fromEntries(order.map((id) => [id, 0]));
    for (let more = true; more;) {
      more = false;
      for (const id of order) { const st = seq.get(id)[pos[id]]; if (st) { out.push(st); pos[id] += 1; more = true; } }
    }
    return out;
  }

  function nextBuildFor(townId) {
    const bd = buildDataFor(townId);
    if (!bd) return { reason: 'sin datos' };
    if (bd.is_building_order_queue_full || townBuildOrders(townId).length >= buildQueueLimit()) return { reason: 'cola llena' };
    const skip = new Set(); // edificio bloqueado → sus pasos siguientes tampoco
    for (const s of buildPlan(townId)) {
      if (skip.has(s.id)) continue;
      const info = bd.building_data?.[s.id];
      const cur = queuedLevel(townId, s.id, info);
      if (s.level !== cur + (s.down ? -1 : 1)) { skip.add(s.id); continue; }
      if ((buildRuntime.cooldown.get(`${townId}:${s.id}`) || 0) > Date.now()) { skip.add(s.id); continue; }
      // Derribar no cuesta recursos: solo hace falta hueco en la cola y nivel > 0.
      const reason = s.down ? (cur <= 0 ? 'ya está a 0' : null) : buildBlockReason(townId, info);
      if (!reason) return { id: s.id, level: s.level, gi: s.gi, down: !!s.down };
      if (state.construccion.strictOrder) return { reason: `${buildingName(s.id)}: ${reason}`, blockedGi: s.gi };
      skip.add(s.id);
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
    cfg.goals = cfg.goals.filter((g) => {
      const lvl = queuedLevel(townId, g.id, bd.building_data?.[g.id]);
      return g.demolish ? lvl > g.target : lvl < g.target;
    });
    if (cfg.goals.length !== before) saveState();
  }

  async function buildTick() {
    if (!anyBuildEnabled()) return;
    for (const townId of allTownIds()) {
      if (!buildEnabledFor(townId)) continue;
      const next = nextBuildFor(townId);
      if (!next.id) continue;
      try {
        // Misma petición que el juego: BuildingOrder.buildUp / BuildingOrder.tearDown
        // (leído en game.min.js: execute("tearDown", {building_id, town_id})).
        await gpPostAs(townId, 'frontend_bridge', 'execute', {
          model_url: 'BuildingOrder', action_name: next.down ? 'tearDown' : 'buildUp', captcha: null,
          arguments: { building_id: next.id }, nl_init: true
        });
        townBuildCfg(townId).lastId = next.id; saveState(); // para el turno del intercalado
        // Unos segundos sin volver a tocar ese edificio: da tiempo a que el juego
        // actualice su cola y no se encargue dos veces el mismo nivel.
        buildRuntime.cooldown.set(`${townId}:${next.id}`, Date.now() + 20000);
        buildLog(`${farmTownName(townId)}: ${buildingName(next.id)} → ${next.down ? 'derribo a' : 'nivel'} ${next.level} (a la cola del juego).`, 'ok');
        await sleep(300); // pequeño margen para que el modelo Backbone se actualice antes de leerlo
        pruneCompletedGoals(townId);
        renderIfIdle('construccion');
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
      if (!anyBuildEnabled() || buildRuntime.running) return;
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

    // Activar / desactivar: general (todas) + excepción para esta ciudad
    const sw = switchEl(!!cfg.enabled, (v) => { setModuleGlobal('construccion', v); renderBody(); buildLog(v ? 'Construcción activada en todas las ciudades.' : 'Construcción desactivada en todas las ciudades.'); }, false);
    const isExc = typeof tcfg.enabled === 'boolean' && tcfg.enabled !== !!cfg.enabled;
    const townSw = switchEl(buildEnabledFor(townId), (v) => {
      if (v === !!cfg.enabled) delete tcfg.enabled; else tcfg.enabled = v; // igual que el general = sin excepción
      saveState(); renderBody();
      buildLog(`${farmTownName(townId)}: construcción ${v ? 'activada' : 'desactivada'} solo en esta ciudad.`);
    });
    const excCount = allTownIds().filter((id) => typeof state.construccion.towns[id]?.enabled === 'boolean').length;

    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('div', { class: 'nb-option-text' }, [el('b', {}, 'Construcción automática'), el('span', { class: 'nb-option-hint' }, `Todas las ciudades${excCount ? ` · ${excCount} excepción(es)` : ''}`)]), sw]),
      el('div', { class: 'nb-row nb-option' }, [el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, `Solo ${farmTownName(townId)}`),
        el('span', { class: `nb-option-hint${isExc ? ' nb-warn-txt' : ''}` }, isExc ? `Excepción: ${tcfg.enabled ? 'activada' : 'desactivada'} aunque el general esté ${cfg.enabled ? 'activado' : 'desactivado'}` : 'Sigue al general')]), townSw]),
      optionRow('Intercalar edificios', `Solo en ${farmTownName(townId)} · un nivel de cada uno por turnos, en el orden en que los añades`, townInterleave(townId), (v) => {
        tcfg.interleave = v; saveState(); renderBody();
        buildLog(`${farmTownName(townId)}: intercalar ${v ? 'activado' : 'desactivado'}.`);
      }),
      optionRow('Orden estricto', 'Si el primero está bloqueado, no salta al siguiente', !!cfg.strictOrder, (v) => { cfg.strictOrder = v; saveState(); })
    ]));
    const prioWarn = anyBuildEnabled() ? prioExcludedAlert('construccion') : null;
    if (prioWarn) bodyEl.appendChild(prioWarn);

    const copyBtn = el('div', { class: 'nb-btn', title: 'Copia estos objetivos al resto de ciudades' }, 'Copiar a todas');
    copyBtn.addEventListener('click', () => {
      if (!confirm(`¿Copiar los objetivos de ${farmTownName(townId)} (y su «Intercalar») a TODAS las ciudades?`)) return;
      for (const id of towns) if (id !== townId) cfg.towns[id] = { ...(cfg.towns[id] || {}), goals: tcfg.goals.map((g) => ({ ...g })), interleave: townInterleave(townId) };
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
        el('span', { class: 'nb-row-value' }, !buildEnabledFor(townId) ? 'desactivada en esta ciudad'
          : next.id ? `${buildingName(next.id)} → ${next.level}`
          : next.reason + (/faltan recursos/.test(next.reason) && !prioIncluded('construccion') ? ' (el comercio no le manda: prioridad)' : ''))
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
      // building_data.level YA incluye lo que está en cola: se parte del nivel real.
      if (!(id in levelAcc)) { let real = null; try { real = +UW.ITowns.getTown(townId).getBuildings().attributes[id]; } catch {} levelAcc[id] = Number.isFinite(real) ? real : Math.max(0, (+bd?.building_data?.[id]?.level || 0) - orders.filter((x) => x.building_type === id && !x.tear_down).length); }
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
      // Nivel desde el que parte el objetivo i: el actual (con cola) o el objetivo
      // anterior del mismo edificio (un edificio puede estar varias veces).
      const lvlOf = (id) => queuedLevel(townId, id, bd.building_data?.[id]);
      const fromOf = (i, list = tcfg.goals) => {
        const id = list[i].id;
        let f = lvlOf(id);
        for (let j = 0; j < i; j++) if (list[j].id === id) f = list[j].target;
        return f;
      };
      const lastLevelOf = (id) => { let f = lvlOf(id); for (const g of tcfg.goals) if (g.id === id) f = g.target; return f; };
      const setTarget = (i, v) => {
        const g = tcfg.goals[i];
        v = clamp(v, 0, maxOf(g.id));
        const from = fromOf(i);
        if (g.demolish ? v >= from : v <= from) tcfg.goals.splice(i, 1); // ya no cambia nada → se quita
        else g.target = v;
        saveState(); renderBody();
      };
      const addGoal = (id, v) => {
        const from = lastLevelOf(id);
        v = clamp(v, 0, maxOf(id));
        if (v === from) return;
        if (v < from && !confirm(`¿Derribar ${buildingName(id)} de ${from} a ${v}? (${from - v} nivel${from - v > 1 ? 'es' : ''})`)) return;
        tcfg.goals.push(v < from ? { id, target: v, demolish: true } : { id, target: v });
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
        const cur = fromOf(i), now = lvlOf(g.id);
        const done = g.demolish ? now <= g.target : now >= g.target;
        const waitingPrev = !done && now !== cur; // espera al objetivo anterior del mismo edificio
        const reason = done ? null : waitingPrev ? `tras llegar a ${cur}` : g.demolish ? 'derribo pendiente' : buildBlockReason(townId, info);
        const isNext = next.id === g.id && next.gi === i;
        goalsBox.appendChild(el('div', { class: `nb-goal${isNext ? ' nb-goal-next' : ''}${done ? ' nb-goal-done' : ''}` }, [
          el('span', { class: 'nb-goal-idx' }, String(i + 1)),
          buildingIcon(g.id),
          el('div', { class: 'nb-goal-main' }, [
            el('div', { class: 'nb-goal-name' }, [buildingName(g.id), g.demolish ? el('span', { class: 'nb-tag nb-tag-demolish' }, 'derribar') : null]),
            el('div', { class: 'nb-goal-sub' }, done ? 'completado' : isNext ? (g.demolish ? 'siguiente (derribo)' : 'siguiente') : (reason || 'en espera'))
          ]),
          el('div', { class: 'nb-stepper' }, [
            el('span', { class: 'nb-goal-cur' }, `${cur} →`),
            el('span', { class: 'nb-mini', title: '−1', onclick: () => setTarget(i, g.target - 1) }, '−'),
            el('span', { class: 'nb-goal-target' }, String(g.target)),
            el('span', { class: 'nb-mini', title: '+1', onclick: () => setTarget(i, g.target + 1) }, '+')
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
      // Se puede añadir un edificio aunque ya esté en la lista: el nuevo objetivo
      // parte de donde acaba el anterior (así se intercala a mano: Senado 20,
      // Muralla 11, Senado 22…). Se añade SIEMPRE al final.
      const available = buildingIds();
      const addSearch = el('input', { class: 'nb-input', type: 'text', placeholder: 'Buscar edificio…' });
      const addList = el('div', { class: 'nb-add-list' });

      // Cada ficha muestra el nivel que tendrá el edificio (real + cola del juego +
      // objetivos del bot). Súbelo para construir (verde) o bájalo para derribar (rojo).
      function renderAddRow(id) {
        const cur = lastLevelOf(id);
        const max = maxOf(id);
        const input = el('input', { class: 'nb-input nb-input-inline nb-lvl-input', type: 'number', min: '0', max: String(max), value: String(cur) });
        const addBtn = el('span', { class: 'nb-mini nb-mini-add' }, '✓');
        const val = () => clamp(pos(input.value, cur), 0, max);
        const paint = () => {
          const v = val();
          input.classList.toggle('nb-lvl-up', v > cur);
          input.classList.toggle('nb-lvl-down', v < cur);
          addBtn.classList.toggle('nb-mini-danger', v < cur);
          addBtn.classList.toggle('nb-mini-off', v === cur);
          addBtn.title = v > cur ? `Subir hasta ${v}` : v < cur ? `Derribar hasta ${v}` : 'Sube (+) para construir o baja (−) para derribar';
        };
        const add = () => { const v = val(); if (v === cur) { input.focus(); return; } addGoal(id, v); };
        addBtn.addEventListener('click', add);
        input.addEventListener('input', paint);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        paint();
        const inList = tcfg.goals.some((g) => g.id === id);
        return el('div', { class: 'nb-add-row' }, [
          buildingIcon(id),
          el('div', { class: 'nb-add-name' }, [buildingName(id), el('span', { class: 'nb-add-level' }, `nivel ${lvlOf(id)}${inList ? ` · en la lista hasta ${cur}` : ''}${cur >= max ? ' · máximo' : ''}`)]),
          el('div', { class: 'nb-stepper' }, [
            el('span', { class: 'nb-mini', title: '−1 (por debajo del actual = derribar)', onclick: () => { input.value = clamp(val() - 1, 0, max); paint(); } }, '−'),
            input,
            el('span', { class: 'nb-mini', title: '+1 (por encima del actual = construir)', onclick: () => { input.value = clamp(val() + 1, 0, max); paint(); } }, '+'),
            addBtn
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
        el('div', { class: 'nb-card-title' }, 'Añadir edificio · se pone al final · más = construir (verde), menos = derribar (rojo)'),
        el('div', {}, [addSearch, addList])
      ]));
    }

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    buildLogEl = logBox;
    renderBuildLog();
  }

  /* ---------------------------------------------------------------------------------
     8a) PRIORIDAD DE RECURSOS (común a todos los módulos que gastan)
     -----------------------------------------------------------------------------
     Tres modos:
       · Equilibrado (el de siempre): Construcción → Investigación → Reclutamiento →
         Festivales. Todos piden a la vez; en cada ciudad un módulo solo gasta lo que
         no necesita el SIGUIENTE gasto de los de arriba.
       · Personalizado · por orden: tú eliges el orden y qué entra. En cada ciudad
         solo recibe recursos UN módulo: el primero de la lista que puede hacer algo
         ahora. Si su cola está llena (o no tiene nada que hacer) pasa al siguiente, y
         en cuanto vuelve a tener hueco recupera el turno → sin cuellos de botella.
       · Personalizado · en paralelo: los módulos elegidos reciben recursos a la vez
         (varias acciones a la vez) y ninguno reserva nada para otro.
     Los módulos NO incluidos siguen funcionando, pero solo con lo que sobre y sin
     pedir nada al comercio.
  --------------------------------------------------------------------------------- */
  const PRIO_MODULES = { construccion: 'Construcción', investigacion: 'Investigación', reclutamiento: 'Reclutamiento', festivales: 'Festivales', cueva: 'Cueva' };
  const PRIO_DEFAULT_ORDER = ['construccion', 'investigacion', 'reclutamiento', 'festivales', 'cueva'];
  const PRIO_MODES = {
    equilibrado: { label: 'Equilibrado', hint: 'El de siempre. Todos reciben a la vez; en cada ciudad gasta primero Construcción, luego Investigación, Reclutamiento y Festivales.' },
    orden: { label: 'Personalizado · por orden', hint: 'Uno cada vez, en tu orden. El comercio abastece primero al 1º en todas las ciudades; si en ninguna puede producir más (colas llenas o nada pendiente) pasa al siguiente, y cuando vuelve a tener hueco recupera el turno.' },
    paralelo: { label: 'Personalizado · por niveles', hint: 'Pon a cada uno un nivel. Los del mismo nivel reciben recursos a la vez (en paralelo). El comercio abastece primero TODO lo del nivel 1 en todas las ciudades; solo cuando ninguna ciudad puede producir más en ese nivel (colas llenas o nada pendiente) pasa al nivel 2, y así sucesivamente.' }
  };
  // Presets antiguos → modos nuevos (una sola vez).
  const PRIO_OLD = {
    reclutamiento: { order: ['reclutamiento', 'construccion', 'investigacion', 'festivales'], inc: ['reclutamiento'] },
    recl_constr: { order: ['reclutamiento', 'construccion', 'investigacion', 'festivales'], inc: ['reclutamiento', 'construccion', 'investigacion'] },
    construccion: { order: ['construccion', 'investigacion', 'reclutamiento', 'festivales'], inc: ['construccion', 'investigacion'] },
    festivales: { order: ['festivales', 'construccion', 'investigacion', 'reclutamiento'], inc: ['festivales'] }
  };
  function prioMode() {
    const p = state.prioridad || (state.prioridad = {});
    if (!PRIO_MODES[p.mode]) {
      const old = PRIO_OLD[p.preset];
      if (old) { p.mode = 'orden'; p.order = old.order.slice(); p.include = Object.fromEntries(Object.keys(PRIO_MODULES).map((m) => [m, old.inc.includes(m)])); }
      else if (p.preset === 'custom') p.mode = 'orden';
      else p.mode = 'equilibrado';
      saveState();
    }
    return p.mode;
  }
  function priorityConfig() {
    const p = state.prioridad || {};
    const mode = prioMode();
    const order = (mode === 'equilibrado' ? PRIO_DEFAULT_ORDER : (p.order || PRIO_DEFAULT_ORDER)).filter((m) => PRIO_MODULES[m]);
    for (const m of Object.keys(PRIO_MODULES)) if (!order.includes(m)) order.push(m);
    const inc = new Set(mode === 'equilibrado' ? Object.keys(PRIO_MODULES) : Object.keys(PRIO_MODULES).filter((m) => p.include?.[m] !== false));
    // Incluidos primero (en su orden), luego el resto.
    const ranked = [...order.filter((m) => inc.has(m)), ...order.filter((m) => !inc.has(m))];
    return { mode, ranked, inc };
  }
  // En paralelo todos los incluidos tienen la misma prioridad.
  // Nivel de cada módulo: "por orden" = su puesto (1, 2, 3…); "por niveles" = el que
  // elijas (mismo nivel = en paralelo). Menor número = más prioridad.
  function prioLevel(mod, cfg = priorityConfig()) {
    if (!cfg.inc.has(mod)) return 99;
    if (cfg.mode === 'paralelo') return clamp(+state.prioridad?.levels?.[mod] || (mod === 'cueva' ? 4 : 1), 1, 4);
    return cfg.ranked.indexOf(mod) + 1;
  }
  const prioRank = (mod) => { const c = priorityConfig(); return c.mode === 'equilibrado' ? c.ranked.indexOf(mod) : prioLevel(mod, c); };
  const prioIncluded = (mod) => priorityConfig().inc.has(mod);

  // Lo que cada módulo necesita YA en una ciudad (su siguiente gasto).
  function moduleClaim(townId, mod) {
    const zero = { wood: 0, stone: 0, iron: 0 };
    try {
      if (mod === 'construccion') {
        if (!buildEnabledFor(townId)) return zero;
        const bd = buildDataFor(townId);
        if (!bd || bd.is_building_order_queue_full || townBuildOrders(townId).length >= buildQueueLimit()) return zero; // cola llena
        // El mismo edificio que construiría nextBuildFor (sin mirar los recursos).
        const skip = new Set();
        for (const s of buildPlan(townId)) {
          if (skip.has(s.id)) continue;
          const info = bd.building_data?.[s.id];
          if (s.down) continue; // derribar no reserva recursos
          if (!info || s.level !== queuedLevel(townId, s.id, info) + 1) { skip.add(s.id); continue; }
          if ((buildRuntime.cooldown.get(`${townId}:${s.id}`) || 0) > Date.now()) { skip.add(s.id); continue; }
          if (buildHardBlock(info, townId)) { if (state.construccion.strictOrder) return zero; skip.add(s.id); continue; }
          const c = info.resources_for || {};
          return { wood: +c.wood || 0, stone: +c.stone || 0, iron: +c.iron || 0 };
        }
        return zero;
      }
      if (mod === 'reclutamiento') {
        if (!recruitEnabledFor(townId) || !townRecruitCfg(townId).goals.length) return zero;
        const b = recruitBatch(townId);
        return b && !b.reason ? { ...b.cost } : zero;
      }
      if (mod === 'festivales') return festivalPending(townId) ? { ...festCost() } : zero;
      if (mod === 'cueva') { const a = cavePlanFor(townId); return a > 0 ? { wood: 0, stone: 0, iron: a } : zero; }
      if (mod === 'investigacion') { const n = researchPlan(townId).find((x) => !x.block); return n ? { ...n.cost } : zero; }
    } catch {}
    return zero;
  }

  // Todo lo que un módulo pide ahora en la ciudad (no solo el siguiente gasto),
  // con tope del almacén: es lo que reserva el que tiene el turno en "por orden".
  function moduleFullDemand(townId, mod) {
    const out = { wood: 0, stone: 0, iron: 0 };
    try {
      if (mod === 'construccion') { for (const d of buildDemandItems(townId)) for (const k of RES) out[k] += d[k]; }
      else if (mod === 'investigacion') { for (const x of researchPlan(townId)) if (!x.block) for (const k of RES) out[k] += x.cost[k]; }
      else { const c = moduleClaim(townId, mod); for (const k of RES) out[k] += c[k]; }
    } catch {}
    const cap = townStorage(townId) || Infinity;
    for (const k of RES) out[k] = Math.min(out[k], cap);
    return out;
  }
  // "Por orden" / "por niveles": el NIVEL que tiene el turno en esa ciudad = el de menor
  // número con algún módulo (incluido) que puede hacer algo ahora (cola con hueco y
  // algo pendiente). below: mirar solo niveles por encima (número menor) de ese.
  // forTrade: la Cueva no pide nada al comercio, así que no cuenta para el turno global
  // del comercio (si no, con la Cueva arriba el comercio se pararía).
  function activeLevel(townId, below = Infinity, forTrade = false) {
    const cfg = priorityConfig();
    let best = null;
    for (const m of cfg.ranked) {
      if (!cfg.inc.has(m) || (forTrade && m === 'cueva')) continue;
      const L = prioLevel(m, cfg);
      if (L >= below || (best !== null && L >= best)) continue;
      if (sumRes(moduleClaim(townId, m)) > 0) best = L;
    }
    return best;
  }
  // Módulos con el turno (los del nivel activo que tienen algo que hacer).
  function activeModules(townId, below = Infinity) {
    const L = activeLevel(townId, below);
    if (L === null) return [];
    const cfg = priorityConfig();
    return cfg.ranked.filter((m) => cfg.inc.has(m) && prioLevel(m, cfg) === L && sumRes(moduleClaim(townId, m)) > 0);
  }
  const activeModule = (townId) => activeModules(townId)[0] || null;

  // Reserva que un módulo debe respetar en una ciudad (lo que no puede gastar).
  function reserveAbove(townId, mod) {
    const { mode, ranked, inc } = priorityConfig();
    const out = { wood: 0, stone: 0, iron: 0 };
    if (mode !== 'equilibrado' && inc.has(mod)) {
      // Los de un nivel superior con el turno reservan TODO lo suyo; los del mismo nivel
      // no se reservan nada entre sí (van en paralelo).
      for (const m of activeModules(townId, prioLevel(mod))) { const d = moduleFullDemand(townId, m); for (const k of RES) out[k] += d[k]; }
      const cap = townStorage(townId) || Infinity;
      for (const k of RES) out[k] = Math.min(out[k], cap);
      return out;
    }
    const my = ranked.indexOf(mod);
    for (let i = 0; i < ranked.length; i++) {
      const m = ranked[i];
      if (m === mod || !inc.has(m)) continue;
      if (inc.has(mod) && i > my) continue;       // solo los de arriba
      const c = moduleClaim(townId, m);
      for (const k of RES) out[k] += c[k];
    }
    return out;
  }
  function reserveOwner(townId, mod) {
    const { mode, ranked, inc } = priorityConfig();
    if (mode !== 'equilibrado' && inc.has(mod)) return activeModules(townId, prioLevel(mod)).map((m) => PRIO_MODULES[m].toLowerCase()).join(' y ');
    const my = ranked.indexOf(mod);
    const names = ranked.filter((m, i) => m !== mod && inc.has(m) && (!inc.has(mod) || i < my) && sumRes(moduleClaim(townId, m)) > 0);
    return names.map((m) => PRIO_MODULES[m].toLowerCase()).join(' y ');
  }

  // Aviso para las pestañas de módulo: si la prioridad actual deja fuera este
  // módulo, el comercio NO le manda recursos (solo gasta lo que ya tenga la ciudad).
  function prioExcludedAlert(mod) {
    if (prioIncluded(mod)) return null;
    const p = state.prioridad;
    const include = () => { const { ranked } = priorityConfig(); p.order = ranked.slice(); p.include = { ...(p.include || {}), [mod]: true }; saveState(); renderBody(); };
    return el('div', { class: 'nb-alert nb-alert-warn' }, [
      el('span', {}, `Prioridad «${PRIO_MODES[prioMode()].label}»: ${PRIO_MODULES[mod].toLowerCase()} no está incluida; no recibe recursos del comercio y solo usa lo que ya tenga cada ciudad.`),
      el('span', { class: 'nb-btn nb-btn-sm', onclick: include }, 'Incluir')
    ]);
  }

  function renderPriorityCard() {
    const p = state.prioridad;
    const cfg = priorityConfig();
    const modes = el('div', { class: 'nb-seg nb-seg-wrap' }, Object.entries(PRIO_MODES).map(([k, v]) =>
      el('span', { class: `nb-seg-btn${cfg.mode === k ? ' active' : ''}`, onclick: () => {
        if (k !== 'equilibrado' && cfg.mode === 'equilibrado') { p.order = cfg.ranked.slice(); p.include = Object.fromEntries(Object.keys(PRIO_MODULES).map((m) => [m, true])); }
        p.mode = k; saveState(); renderBody();
      } }, v.label)));
    const custom = cfg.mode !== 'equilibrado';
    const list = el('div', { class: 'nb-goals' });
    const shown = cfg.mode === 'paralelo' ? cfg.ranked.slice().sort((a, b) => prioLevel(a, cfg) - prioLevel(b, cfg)) : cfg.ranked;
    shown.forEach((m, i) => {
      const included = cfg.inc.has(m);
      const move = (dir) => {
        const o = cfg.ranked.slice(); const j = i + dir;
        if (j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j], o[i]]; p.order = o; saveState(); renderBody();
      };
      const lvl = prioLevel(m, cfg);
      const mates = cfg.ranked.filter((x) => x !== m && cfg.inc.has(x) && prioLevel(x, cfg) === lvl).map((x) => PRIO_MODULES[x]);
      const sub = !included ? 'No incluido: solo usa lo que sobre · no pide recursos'
        : cfg.mode === 'paralelo' ? (mates.length ? `Nivel ${lvl}: a la vez que ${mates.join(' y ')}` : `Nivel ${lvl}: solo`)
        : cfg.mode === 'orden' ? (i === 0 ? 'Tiene el turno mientras tenga hueco en su cola' : 'Recibe cuando los de arriba tienen la cola llena o nada que hacer')
        : (i === 0 ? 'Primero en recibir y en gastar' : 'Recibe y gasta después de los de arriba');
      list.appendChild(el('div', { class: `nb-goal${included ? '' : ' nb-goal-done'}` }, [
        el('span', { class: 'nb-goal-idx' }, included ? String(cfg.mode === 'paralelo' ? lvl : i + 1) : '–'),
        el('div', { class: 'nb-goal-main' }, [el('div', { class: 'nb-goal-name' }, PRIO_MODULES[m]), el('div', { class: 'nb-goal-sub' }, sub)]),
        custom ? el('div', { class: 'nb-goal-actions' }, [
          cfg.mode === 'orden' ? el('span', { class: `nb-mini${i === 0 ? ' nb-mini-off' : ''}`, onclick: () => move(-1) }, '▲') : null,
          cfg.mode === 'orden' ? el('span', { class: `nb-mini${i === cfg.ranked.length - 1 ? ' nb-mini-off' : ''}`, onclick: () => move(1) }, '▼') : null,
          cfg.mode === 'paralelo' && included ? el('div', { class: 'nb-seg nb-seg-sm nb-lvl-seg' }, [1, 2, 3, 4].map((L) =>
            el('span', { class: `nb-seg-btn${lvl === L ? ' active' : ''}`, title: `Nivel ${L}`, onclick: () => { p.levels = { ...(p.levels || {}), [m]: L }; saveState(); renderBody(); } }, `N${L}`))) : null,
          switchEl(included, (v) => { p.include = { ...(p.include || {}), [m]: v }; saveState(); renderBody(); })
        ]) : null
      ]));
    });
    // Qué módulo(s) tienen ahora el turno en la ciudad abierta.
    let now = null;
    if (custom) {
      const tid = +UW.Game?.townId;
      const a = tid ? activeModules(tid) : [];
      now = el('div', { class: 'nb-alert nb-alert-info nb-mt' }, `Ahora en ${farmTownName(tid)}: ${a.length ? `tiene${a.length > 1 ? 'n' : ''} el turno ${a.map((x) => PRIO_MODULES[x]).join(' y ')}` : 'ningún módulo tiene nada que hacer'}.`);
    }
    return el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Prioridad de recursos'),
      modes,
      el('p', { class: 'nb-placeholder nb-mt' }, PRIO_MODES[cfg.mode].hint),
      el('div', { class: 'nb-mt' }, [list]),
      now
    ]);
  }


  /* ---------------------------------------------------------------------------------
     8b-bis) VISTAS GENERALES — estado completo de TODAS las ciudades
     -----------------------------------------------------------------------------
     El cliente del juego solo tiene cargados los envíos y las colas de tropas de las
     ciudades que has abierto en esta sesión. Al arrancar el bot ya habrá envíos en
     camino y tropas haciéndose en otras ciudades, así que se leen las vistas
     generales (solo lectura, lo mismo que abrir esas ventanas):
       GET town_overviews?action=trade_overview    → movements[{id,from,to,res,arrival}]
       GET town_overviews?action=recruit_overview  → towns[{id, orders{barracks,docks},
                                                       units[{id,count,total,research_factor}],
                                                       free_population, storage_volume…}]
     Se refrescan al arrancar, cada 60 s y tras cada acción propia. Comercio y
     Reclutamiento no actúan hasta tener la primera lectura.
  --------------------------------------------------------------------------------- */
  const overview = { at: 0, tradesAt: 0, recruitAt: 0, trades: [], recruit: new Map(), busy: false, timer: null, retry: null, failLogged: false };

  function linkTownId(html) {
    const m = /#([A-Za-z0-9+/=]{8,})/.exec(String(html || ''));
    if (!m) return 0;
    try { return +JSON.parse(atob(m[1])).id || 0; } catch { return 0; }
  }

  async function refreshOverviews() {
    if (overview.busy) return;
    overview.busy = true;
    try {
      const [tr, rc] = await Promise.all([
        gpGet('town_overviews', 'trade_overview', { nl_init: true }).catch(() => null),
        gpGet('town_overviews', 'recruit_overview', { nl_init: true }).catch(() => null)
      ]);
      // Cada vista cuenta por separado: el comercio no puede fiarse de "ya leído"
      // si la de envíos falló aunque la de reclutamiento saliera bien.
      if (tr && typeof tr === 'object' && (Array.isArray(tr.movements) || 'mov_tmpl' in tr)) {
        overview.trades = (tr.movements || []).map((m) => ({
          id: +m.id, from: linkTownId(m.from?.link), to: linkTownId(m.to?.link),
          wood: +m.res?.wood || 0, stone: +m.res?.stone || 0, iron: +m.res?.iron || 0, arrival: +m.arrival * 1000
        })).filter((m) => m.to);
        overview.tradesAt = Date.now();
      }
      const towns = rc?.data?.towns;
      if (Array.isArray(towns)) {
        const map = new Map();
        for (const t of towns) {
          const orders = [
            ...(t.orders?.barracks || []).map((o) => ({ kind: 'ground', ...o })),
            ...(t.orders?.docks || []).map((o) => ({ kind: 'naval', ...o }))
          ];
          const units = {};
          for (const u of t.units || []) units[u.id] = { count: +u.count || 0, total: +u.total || 0, rf: +u.research_factor || 1 };
          map.set(+t.id, { orders, units, freePop: +t.free_population, storage: +t.storage_volume || 0 });
        }
        overview.recruit = map;
        overview.recruitAt = Date.now();
      }
      overview.at = Math.min(overview.tradesAt, overview.recruitAt);
      const failed = [overview.tradesAt ? null : 'envíos', overview.recruitAt ? null : 'reclutamiento'].filter(Boolean);
      if (failed.length) {
        // Aún sin primera lectura completa: reintentar pronto (no esperar 60 s).
        clearTimeout(overview.retry);
        overview.retry = setTimeout(refreshOverviews, 10000);
        if (!overview.failLogged) { overview.failLogged = true; console.warn(`[NOVABOT] No se pudo leer la vista de ${failed.join(' y ')}; reintentando cada 10 s.`); }
      }
    } finally { overview.busy = false; }
    // Repintar las pestañas que dependen de estos datos (salvo si estás escribiendo).
    const typing = document.activeElement?.closest?.('#novabot-panel input, #novabot-panel select');
    if (!typing && bodyEl && ['inicio', 'comercio', 'reclutamiento'].includes(state.activeTab)) renderBody();
  }
  const overviewReady = () => overview.at > 0;

  function startOverviewSync() {
    if (overview.timer) return;
    refreshOverviews();
    overview.timer = setInterval(refreshOverviews, 60000);
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
  const tradeRuntime = { timer: null, running: false, log: [], ledger: [], pairCooldown: new Map(), waitingSince: new Map(), capSeen: new Map(), lastSendAt: 0 };
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
      for (const townId of allTownIds()) out.push(...buildDemandItems(townId));
      return out;
    }
  ];
  // Niveles que caben en los huecos libres de la cola de construcción de UNA ciudad.
  function buildDemandItems(tid) {
      const out = [];
      const limit = buildQueueLimit();
      for (const townId of [+tid]) {
        if (!buildEnabledFor(townId)) continue;
        const goals = townBuildCfg(townId).goals;
        if (!goals.length) continue;
        const bd = buildDataFor(townId);
        if (!bd || bd.is_building_order_queue_full) continue;
        let free = Math.max(0, limit - townBuildOrders(townId).length);
        if (!free) continue;
        // Mismo orden que construirá (buildPlan). Bloqueos que el comercio no puede
        // resolver (requisitos, almacén, población): se salta ese edificio; si no, sus
        // recursos llegarían y no se gastarían.
        const skip = new Set();
        for (const s of buildPlan(townId)) {
          if (!free) break;
          if (skip.has(s.id)) continue;
          const info = bd.building_data?.[s.id];
          if (s.down) { free -= 1; continue; } // derribar ocupa hueco pero no cuesta recursos
          if (buildHardBlock(info, townId)) { if (state.construccion.strictOrder) break; skip.add(s.id); continue; }
          const cost = levelCost(s.id, s.level, info);
          if (!cost) { skip.add(s.id); continue; }
          out.push({ townId, module: 'construccion', label: `${buildingName(s.id)} ${s.level}`, ...cost });
          free -= 1;
        }
      }
      return out;
  }

  function collectDemands() {
    const all = [];
    for (const p of tradeDemandProviders) { try { all.push(...p()); } catch (e) { console.warn('[NOVABOT][comercio] proveedor falló:', e); } }
    // Prioridad común (8a): los módulos no incluidos no piden ni reservan; el
    // resto recibe su rango como prioridad.
    const cfg = priorityConfig();
    let list = all.filter((d) => !d.module || cfg.inc.has(d.module));
    if (cfg.mode !== 'equilibrado') {
      // Por orden / por niveles: en cada ciudad solo piden (y reservan) los módulos del
      // nivel que tiene el turno (varios a la vez si comparten nivel).
      // El turno es GLOBAL: mientras en CUALQUIER ciudad un módulo de nivel superior
      // pueda producir (cola con hueco y algo pendiente), el comercio solo abastece ese
      // nivel. Se pasa al siguiente cuando ninguna ciudad tiene nada que hacer en él
      // (colas llenas o todo pedido).
      let level = null;
      for (const t of allTownIds()) { const L = activeLevel(t, Infinity, true); if (L !== null && (level === null || L < level)) level = L; }
      list = list.filter((d) => !d.module || prioLevel(d.module, cfg) === level);
    }
    return list.map((d) => ({ ...d, prio: d.module ? prioRank(d.module) : (d.prio ?? 9) }));
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
    const own = new Set(allTownIds());
    for (const t of gameTrades()) {
      if (!t.started || !t.arrival || !own.has(t.from)) continue; // envíos de otros jugadores: distancia desconocida
      const d = townDist(t.from, t.to);
      if (d < 1) continue;
      samples.push((t.arrival - t.started) / 1000 / d);
    }
    if (!samples.length) return;
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)];
    if (med > 1 && Math.abs(med - (+state.comercio.secPerUnit || 0)) > 0.5) { state.comercio.secPerUnit = +med.toFixed(2); saveState(); }
  }
  const travelSec = (a, b) => Math.max(60, Math.round(townDist(a, b) * secPerUnit()));

  // ---- Envíos en camino ----
  function gameTrades() {
    const own = new Set(allTownIds());
    const byId = new Map();
    try {
      const models = [...Object.values(UW.MM.getModels().Trade || {}), ...[].concat(UW.MM.getCollections().Trade || []).flatMap((c) => c?.models || [])];
      for (const m of models) {
        const t = m?.attributes; if (!t) continue;
        byId.set(+t.id, { id: +t.id, from: +t.origin_town_id, to: +t.destination_town_id, wood: +t.wood || 0, stone: +t.stone || 0, iron: +t.iron || 0, arrival: +t.arrival_at * 1000, started: +t.started_at * 1000 });
      }
    } catch {}
    for (const t of overview.trades) if (!byId.has(t.id)) byId.set(t.id, t);
    const now = Date.now();
    return [...byId.values()].filter((t) => own.has(t.to) && t.arrival > now);
  }
  function transitRows() {
    const game = gameTrades();
    const now = Date.now();
    // Lo ya llegado está en el almacén: dejarlo en "en camino" lo contaría dos veces.
    tradeRuntime.ledger = tradeRuntime.ledger.filter((l) => l.arrival > now && l.expires > now);
    // Lo enviado por el bot cuenta hasta que el juego lo muestre en su lista. Cada
    // envío del juego tapa como mucho UN registro del bot (el de llegada más
    // parecida): así dos envíos iguales seguidos no se confunden en uno.
    const used = new Set();
    const extra = tradeRuntime.ledger.filter((l) => {
      let best = null, bestD = Infinity;
      for (const g of game) {
        if (used.has(g) || g.from !== l.from || g.to !== l.to || Math.abs(sumRes(g) - sumRes(l)) > 50) continue;
        const d = Math.abs((g.arrival || 0) - l.arrival);
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best) { used.add(best); return false; }
      return true;
    });
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
  // Devuelve cuánto de cada recurso se perdería (por encima de storageCap) al ir
  // llegando los envíos.
  // Simulación de la línea de tiempo de la ciudad destino (segundos desde ahora):
  // producción + llegadas ordenadas + gasto de sus encargos EN ORDEN. Un encargo no se
  // gasta en el mismo instante en que se puede pagar: el bot tarda un ciclo en
  // reclutar/construir, así que se cuenta SPEND_LAG s de margen. Así un envío puede
  // llegar justo después de que se gaste el lote anterior (aunque hoy "no quepa"),
  // pero nunca antes: lo que llegaría con el almacén lleno se recorta.
  const SPEND_LAG = 45;
  function simulateWaste(s, items, arrivals, storageCap) {
    const lvl = { ...s.cur };
    const waste = { wood: 0, stone: 0, iron: 0 };
    const queue = items.map((i) => ({ wood: i.wood, stone: i.stone, iron: i.iron }));
    let readyAt = null; // cuándo se pudo pagar el primer encargo de la cola
    const affordable = () => queue.length && RES.every((k) => lvl[k] >= queue[0][k]);
    const step = (t) => {
      for (;;) {
        if (readyAt === null) { if (affordable()) readyAt = t; else return; }
        if (readyAt + SPEND_LAG > t) return;
        const q = queue.shift(); const at = readyAt + SPEND_LAG;
        for (const k of RES) lvl[k] -= q[k];
        readyAt = null;
        if (affordable()) readyAt = at; // el siguiente ya se podía pagar al gastar éste
      }
    };
    step(0);
    let prevT = 0;
    for (const a of [...arrivals].sort((x, y) => x.t - y.t)) {
      const dt = Math.max(0, a.t - prevT) / 3600;
      for (const k of RES) lvl[k] = Math.min(s.storage, lvl[k] + s.prod[k] * dt);
      prevT = a.t;
      step(a.t);
      for (const k of RES) {
        if (!a[k]) continue;
        lvl[k] += a[k];
        if (lvl[k] > storageCap) { waste[k] += lvl[k] - storageCap; lvl[k] = Math.min(lvl[k], s.storage); }
      }
      step(a.t);
    }
    return waste;
  }
  // Un envío nuevo vale si NO aumenta lo que se pierde de ningún recurso. (Si un
  // envío que ya viene de camino va a rebosar, eso no bloquea los demás recursos.)
  function simulateOk(s, items, arrivals, storageCap, base = null) {
    const b = base || simulateWaste(s, items, arrivals.slice(0, -1), storageCap); // (el nuevo va el último)
    const w = simulateWaste(s, items, arrivals, storageCap);
    return RES.every((k) => w[k] <= b[k] + 1);
  }

  // "Muralla 14, Muralla 15, Muralla 16" → "Muralla 14–16" (y máx. 3 grupos + "…").
  function compactLabels(labels) {
    // Agrupa por edificio (en el orden en que aparece): "Senado 6–9, Muralla 4–5".
    const groups = [], by = new Map();
    for (const l of labels) {
      const m = /^(.*\D)\s(\d+)$/.exec(l);
      if (!m) { groups.push({ text: l }); continue; }
      let g = by.get(m[1]);
      if (!g) { g = { base: m[1], from: +m[2], to: +m[2] }; by.set(m[1], g); groups.push(g); }
      g.from = Math.min(g.from, +m[2]); g.to = Math.max(g.to, +m[2]);
    }
    const txt = groups.map((g) => g.text || `${g.base} ${g.from}${g.to > g.from ? `–${g.to}` : ''}`);
    return txt.length > 3 ? `${txt.slice(0, 3).join(', ')} y ${txt.length - 3} más` : txt.join(', ');
  }

  function planTrades() {
    const cfg = state.comercio;
    const towns = allTownIds();
    const transit = transitRows();
    const demands = collectDemands();
    const now = Date.now();
    const marginPct = clamp(+cfg.storageMarginPct || 0, 0, 50) / 100;
    const minShip = Math.max(1, +cfg.minShipment || 500);

    const itemsBy = {}, reserveBy = {};
    for (const id of towns) { itemsBy[id] = []; reserveBy[id] = { wood: 0, stone: 0, iron: 0 }; }
    for (const d of demands) {
      if (!itemsBy[d.townId]) continue;
      if (d.reserveOnly) { for (const k of RES) reserveBy[d.townId][k] += d[k]; continue; } // no se pide, solo no se regala
      itemsBy[d.townId].push(d);
    }
    // Orden de gasto dentro de cada ciudad = prioridad del módulo (estable).
    for (const id of towns) itemsBy[id] = itemsBy[id].map((d, i) => ({ d, i })).sort((a, b) => (a.d.prio - b.d.prio) || (a.i - b.i)).map((x) => x.d);

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
        // Excedente: lo que sobra tras reservar TODOS sus propios encargos y lo que
        // sus próximos lotes van a gastar (reclutamiento pendiente).
        surplus: Object.fromEntries(RES.map((k) => [k, Math.max(0, cur[k] - Math.max(total[k], reserveBy[id][k]) - (+cfg.keepMin || 0))]))
      };
    }

    const needs = [];
    for (const id of towns) {
      const s = st[id];
      if (!itemsBy[id].length) { tradeRuntime.waitingSince.delete(id); continue; }
      const miss = Object.fromEntries(RES.map((k) => [k, Math.max(0, s.total[k] - s.cur[k] - s.incoming[k])]));
      if (sumRes(miss) <= 0) { tradeRuntime.waitingSince.delete(id); continue; }
      if (!tradeRuntime.waitingSince.has(id)) tradeRuntime.waitingSince.set(id, now);
      // Primer encargo (en orden de prioridad) que aún no está cubierto: su módulo
      // decide el turno de la ciudad y lo que le falta hasta él se envía primero.
      const have = Object.fromEntries(RES.map((k) => [k, s.cur[k] + s.incoming[k]]));
      const cum = { wood: 0, stone: 0, iron: 0 };
      let top = null;
      for (const it of itemsBy[id]) {
        for (const k of RES) cum[k] += it[k];
        if (RES.some((k) => cum[k] > have[k])) { top = it; break; }
      }
      const topMiss = Object.fromEntries(RES.map((k) => [k, top ? Math.max(0, cum[k] - have[k]) : 0]));
      needs.push({ townId: id, miss, missInit: { ...miss }, topMiss, topPrio: top ? top.prio : 99, topLabel: top?.label || '',
        label: compactLabels(itemsBy[id].map((i) => i.label)), items: itemsBy[id],
        waited: (now - tradeRuntime.waitingSince.get(id)) / 1000 });
    }

    // Una ciudad que está esperando recursos NO dona (aunque le sobre de otro tipo):
    // así no manda lo suyo a otra para luego pedirlo de vuelta.
    // Una ciudad que espera recursos solo puede dar los que ella NO necesita
    // (nunca lo que le falta: así no manda lo suyo para luego pedirlo de vuelta).
    const needy = new Map(needs.map((n) => [n.townId, n.missInit]));
    const canGive = (id, k) => !needy.has(id) || (needy.get(id)[k] || 0) <= 0;
    const donorsFor = (n) => towns
      .filter((id) => id !== n.townId && st[id].cap > 0 && RES.some((k) => canGive(id, k) && st[id].surplus[k] > 0 && n.miss[k] > 0))
      .filter((id) => (tradeRuntime.pairCooldown.get(`${id}>${n.townId}`) || 0) < now)
      .sort((a, b) => donorCost(a, n) - donorCost(b, n));
    // Coste de usar un donante = tiempo de viaje, rebajado hasta a la mitad si el
    // donante está a punto de llenar el almacén con lo que se necesita (ese
    // recurso se perdería si no se mueve).
    function donorCost(id, n) {
      const d = st[id];
      let over = 0;
      for (const k of RES) if (n.miss[k] > 0 && d.storage) over = Math.max(over, clamp((d.cur[k] / d.storage - 0.85) / 0.15, 0, 1));
      return travelSec(id, n.townId) * (1 - 0.5 * over);
    }

    const plan = [];
    const pending = needs.slice();
    const agingWeight = Number.isFinite(+cfg.agingWeight) ? Math.max(0, +cfg.agingWeight) : 2;
    while (pending.length) {
      // Turno: primero el módulo con más prioridad (ver 8a); a igualdad, VAM +
      // envejecimiento (recalculado tras cada asignación).
      let best = null, bestScore = -Infinity, bestPrio = Infinity;
      for (const n of pending) {
        const ds = donorsFor(n);
        if (!ds.length) { n.score = -Infinity; continue; }
        const t1 = travelSec(ds[0], n.townId);
        const regret = ds.length > 1 ? travelSec(ds[1], n.townId) - t1 : 24 * 3600; // un solo donante posible = urgente
        n.score = regret + n.waited * agingWeight;
        if (n.topPrio < bestPrio || (n.topPrio === bestPrio && n.score > bestScore)) { bestPrio = n.topPrio; bestScore = n.score; best = n; }
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
        // Lo que la ciudad producirá por sí misma mientras viaja el envío no hace
        // falta mandarlo (evita enviar de más a ciudades que producen mucho).
        const prodT = (k) => r.prod[k] * eta / 3600;
        const need = Object.fromEntries(RES.map((k) => [k, Math.max(0, best.miss[k] - prodT(k))]));
        // 1º lo que falta para el encargo más prioritario; 2º el resto (si hay capacidad).
        const needTop = Object.fromEntries(RES.map((k) => [k, Math.min(need[k], Math.max(0, best.topMiss[k] - prodT(k)))]));
        for (const pass of [needTop, need]) {
          for (const k of [...RES].sort((a, b) => pass[b] - pass[a])) {
            if (!canGive(donorId, k)) continue;
            const v = Math.floor(Math.min(left, d.surplus[k] - want[k], pass[k] - want[k]));
            if (v > 0) { want[k] += v; left -= v; }
          }
        }
        if (sumRes(want) <= 0) continue;
        // Ajustar a lo que la simulación de almacén permite. Primero el tope de cada
        // recurso por separado (que uno rebose no deja a cero los otros), luego la mezcla.
        const base = simulateWaste(r, best.items, r.arrivals, storageCap);
        const test = (ship) => simulateOk(r, best.items, [...r.arrivals, { t: eta, ...ship }], storageCap, base);
        if (!test(want)) {
          const zero = { wood: 0, stone: 0, iron: 0 };
          for (const k of RES) {
            if (!want[k] || test({ ...zero, [k]: want[k] })) continue;
            let lo = 0, hi = want[k];
            while (hi - lo > 50) { const mid = Math.floor((lo + hi) / 2); if (test({ ...zero, [k]: mid })) lo = mid; else hi = mid; }
            want[k] = lo;
          }
          for (const k of RES) {
            if (!want[k] || test(want)) continue;
            let lo = 0, hi = want[k];
            while (hi - lo > 50) { const mid = Math.floor((lo + hi) / 2); want[k] = mid; if (test(want)) lo = mid; else hi = mid; }
            want[k] = lo;
          }
        }
        const total = sumRes(want);
        const completes = RES.every((k) => want[k] >= need[k]);
        if (total <= 0 || (total < minShip && !completes)) continue;
        plan.push({ from: donorId, to: best.townId, ship: want, eta, label: best.topLabel || best.items[0]?.label || '' });
        d.cap -= total;
        for (const k of RES) { d.surplus[k] -= want[k]; best.miss[k] -= want[k]; best.topMiss[k] = Math.max(0, best.topMiss[k] - want[k]); r.incoming[k] += want[k]; }
        r.arrivals.push({ t: eta, ...want });
      }
    }
    return { plan, needs };
  }

  /* ---------------------------------------------------------------------------------
     8c-bis) EQUILIBRIO ENTRE CIUDADES — que no se pierda nada al recolectar y que
     cada ciudad tenga de todo.
     -----------------------------------------------------------------------------
     Usa los comerciantes que el comercio deja libres (solo en vueltas en que el
     comercio no tiene nada que enviar para encargos). Tres pases, por orden:
       1) Evitar pérdida: la ciudad que recolecta su isla recibe el botín de CADA
          recurso (lo que dan sus aldeas con el tiempo elegido). Si con eso + lo que
          produce hasta entonces + lo que le llega pasaría del almacén, lo que sobra
          (hasta su "línea de seguridad", que deja sitio para 2 recolecciones) se
          manda a las ciudades con sitio, primero a las que menos tienen de ese recurso.
       2) Alimentar aldeas: si una aldea con tasa alta pide un recurso que su isla no
          tiene y al imperio le sobra ese recurso más que el que da la aldea, se trae
          de la ciudad más cercana a la que le sobra; al llegar, el Intercambio con
          aldeas lo cambia (ver 8a-bis).
       3) Igualar: por recurso, la "cuota justa" de cada ciudad es el llenado medio del
          imperio × su almacén. Las que pasan de la cuota + tolerancia mandan a las que
          están por debajo de la cuota − tolerancia, hasta la mitad de la tolerancia
          (así no se mueve lo mismo de un lado a otro).
     Nunca se da lo que la ciudad reserva para sus encargos (ni un recurso que ella
     misma está esperando) y nunca se manda por encima de la línea de seguridad del
     destino.
  --------------------------------------------------------------------------------- */
  const balRuntime = { nextAt: 0 };
  const KIND_LABEL = { urgente: 'Evitar pérdida', adelantar: 'Adelantar encargo', aldea: 'Para cambiar en aldea', equilibrio: 'Equilibrio' };
  const KIND_RANK = { urgente: 0, adelantar: 1, aldea: 2, equilibrio: 3 };

  // Comerciantes totales: Mercado × 500 (× 1,5 con Oficina comercial) — comprobado en
  // las 22 ciudades el 24/09/2026. Por si acaso, nunca menos de lo visto libre.
  function maxTradeCapOf(townId) {
    let m = 0;
    try {
      const b = UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes || {};
      m = (+b.market || 0) * 500 * (hasTradeOffice(townId) ? 1.5 : 1);
    } catch {}
    const seen = Math.max(tradeRuntime.capSeen.get(+townId) || 0, tradeCapacityOf(townId));
    tradeRuntime.capSeen.set(+townId, seen);
    return Math.max(m, seen);
  }
  function islandKey(townId) { const xy = townXY(townId); return `${xy.x}_${xy.y}`; }
  function nextClaimHours() {
    if (!state.granjas.enabled) return null;
    return Math.max(0, (farmRuntime.nextCycleAt || 0) - Date.now()) / 3.6e6;
  }

  // Foto de TODAS las ciudades para decidir qué mover y qué cambiar. Nueva en cada
  // llamada: los planificadores la van modificando al asignar.
  function resourceModel() {
    const towns = allTownIds();
    const zero = () => ({ wood: 0, stone: 0, iron: 0 });
    let demands = []; try { demands = collectDemands(); } catch {}
    let transit = []; try { transit = transitRows(); } catch {}
    let claimers = new Set(); try { if (state.granjas.enabled) claimers = new Set(pickTownsForClaim().towns); } catch {}
    const dt = nextClaimHours();
    const marginPct = clamp(+state.comercio.storageMarginPct || 0, 0, 50) / 100;
    const keepMin = +state.comercio.keepMin || 0;
    const T = {}, sumLvl = zero(), globalMiss = zero(), roomAll = zero();
    let sumS = 0;
    for (const id of towns) {
      const storage = townStorage(id) || 0;
      if (!storage) continue;
      const cur = townResources(id), inc = incomingTo(id, transit), pend = exPendingTo(id), prod = productionOf(id);
      const total = zero(), reserve = zero();
      for (const d of demands) if (+d.townId === id) for (const k of RES) (d.reserveOnly ? reserve : total)[k] += +d[k] || 0;
      const loot = claimers.has(id) ? islandLoot(id) : 0;
      const top = storage * (1 - marginPct);
      // Lo recibido de aldeas ya sale en los envíos del juego (origen vacío): no contarlo dos veces.
      const vinc = zero();
      for (const r of transit) if (r.to === id && !r.from) for (const k of RES) vinc[k] += r[k];
      const lvl = {}, miss = {}, keep = {}, safe = {}, over = {};
      for (const k of RES) {
        pend[k] = Math.max(0, pend[k] - vinc[k]);
        lvl[k] = cur[k] + inc[k] + pend[k];
        miss[k] = Math.max(0, total[k] - lvl[k]);
        keep[k] = Math.max(total[k], reserve[k]) + keepMin;
        // Línea de seguridad: deja sitio para 2 recolecciones y media hora de producción.
        safe[k] = Math.max(storage * 0.5, top - 2 * loot - prod[k] * 0.5);
        // Lo que rebosaría en la próxima recolección si no se hace nada.
        over[k] = Math.max(0, lvl[k] + prod[k] * (dt ?? 0.25) + loot - top);
        sumLvl[k] += lvl[k]; globalMiss[k] += miss[k];
      }
      sumS += storage;
      T[id] = { id, storage, cur, inc, pend, prod, lvl, total, reserve, miss, keep, loot, safe, over, top,
        cap: tradeCapacityOf(id), maxCap: maxTradeCapOf(id), island: islandKey(id), claimer: claimers.has(id) };
    }
    // Sitio libre (hasta la línea de seguridad) en las ciudades que no rebosan.
    for (const t of Object.values(T)) for (const k of RES) if (!t.over[k]) roomAll[k] += Math.max(0, t.safe[k] - t.lvl[k]);
    // Llenado medio del imperio por recurso: la cuota justa de una ciudad es F × su almacén.
    const F = Object.fromEntries(RES.map((k) => [k, sumS ? sumLvl[k] / sumS : 0]));
    return { towns: Object.keys(T).map(Number), T, F, globalMiss, roomAll, dt, claimers, at: Date.now() };
  }

  // Aldeas con tasa alta que piden un recurso que su isla no tiene para dar. Solo si al
  // imperio le sobra más ese recurso que el que da la aldea (con Cueva: solo por plata).
  function exFeedWants(M, cfg = state.aldeas) {
    if (!cfg.enabled || !cfg.feed) return [];
    const gainR = clamp(+cfg.gainRatio || 1.2, 0.5, 1.5);
    const cave = caveOn();
    const now = Date.now();
    const byIsland = new Map();
    for (const id of M.towns) { const k = M.T[id].island; if (!byIsland.has(k)) byIsland.set(k, []); byIsland.get(k).push(id); }
    const out = [];
    for (const [key, list] of exVillagesByIsland()) {
      const towns = byIsland.get(key);
      if (!towns) continue;
      for (const v of list) {
        if ((exRuntime.cooldown.get(+v.rel.id) || 0) > now) continue;
        if (exRuntime.feeds.some((f) => f.relId === +v.rel.id)) continue;
        const X = v.give, Y = v.get;
        if (cave ? (Y !== 'iron' || X === 'iron') : (M.F[X] - M.F[Y] < 0.05)) continue;
        // Si una ciudad de la isla ya puede hacer el cambio ella sola, no hace falta traer nada.
        if (towns.some((tid) => exCandidate(M, tid, v, exRatioFor(v.rel, tid), cfg, now))) continue;
        let best = null;
        for (const tid of towns) {
          const t = M.T[tid], r = exRatioFor(v.rel, tid);
          if (r + 1e-9 < gainR) continue;
          const roomY = cave ? t.storage * 0.95 - t.lvl.iron : t.safe[Y] - t.lvl[Y];
          const roomX = t.safe[X] - t.lvl[X];
          const amount = Math.floor(Math.min(exMaxAmount(v.rel), roomY / r, roomX, t.maxCap));
          if (amount < 500) continue;
          if (!best || r > best.ratio || (r === best.ratio && amount > best.amount)) best = { townId: tid, rel: v.rel, farm: v.farm, give: X, get: Y, ratio: r, amount };
        }
        if (best) out.push(best);
      }
    }
    return out.sort((a, b) => (b.ratio - a.ratio) || (b.amount - a.amount));
  }

  // Movimientos de equilibrio (agrupados por pareja origen → destino).
  // idle = el comercio no tiene encargos que enviar ahora (entonces también iguala).
  /* Modo del equilibrio — los encargos van SIEMPRE primero:
       · 'encargos': alguna ciudad espera recursos ya. Solo se evita perder recursos, sin
         tocar ningún recurso que alguien esté esperando.
       · 'pronto':   nadie espera ahora, pero algún encargo empieza dentro del horizonte
         (hueco en la cola de construcción, lote de tropas, inicio programado,
         festival que termina). Se evita perder y se ADELANTA a esas ciudades lo que les
         va a faltar, sacándolo de donde sobra.
       · 'libre':    nada pendiente ni a punto: también se iguala y se alimentan aldeas.
     En 'encargos' y 'pronto' cada ciudad deja libre el (100 − X) % de sus comerciantes
     (por defecto el 80 %) y no se hacen viajes de más del máximo. */
  function upcomingDemands(horizonMs = Math.max(1, +state.equilibrio.horizonMin || 30) * 60000) {
    const now = Date.now(), until = now + horizonMs;
    const out = new Map(); // townId -> { wood, stone, iron, labels[], at }
    const addTo = (id, cost, label, at) => {
      if (!cost || !sumRes(cost)) return;
      let o = out.get(id);
      if (!o) { o = { wood: 0, stone: 0, iron: 0, labels: [], at: Infinity }; out.set(id, o); }
      for (const k of RES) o[k] += +cost[k] || 0;
      o.labels.push(label); o.at = Math.min(o.at, at);
    };
    const inc = (m) => { try { return prioIncluded(m); } catch { return true; } };
    for (const id of allTownIds()) {
      // Construcción con la cola llena: el siguiente nivel cuando termine la primera orden.
      try {
        if (state.comercio.forBuild && inc('construccion') && buildEnabledFor(id) && townBuildCfg(id).goals.length) {
          const orders = townBuildOrders(id);
          if (orders.length >= buildQueueLimit()) {
            const freeAt = Math.min(...orders.map((o) => +o.to_be_completed_at * 1000 || Infinity));
            if (freeAt <= until) {
              const bd = buildDataFor(id), skip = new Set();
              for (const s of buildPlan(id)) {
                if (s.down || skip.has(s.id)) continue;
                const info = bd?.building_data?.[s.id];
                if (buildHardBlock(info, id)) { skip.add(s.id); continue; }
                addTo(id, levelCost(s.id, s.level, info), `${buildingName(s.id)} ${s.level}`, freeAt);
                break;
              }
            }
          }
        }
      } catch {}
      // Reclutamiento: inicio programado dentro del horizonte, o cola llena que se libera.
      try {
        if (state.comercio.forRecruit && inc('reclutamiento') && recruitOnFor(id) && townRecruitCfg(id).goals.length) {
          const t = state.reclutamiento.towns[id] || {};
          const start = +t.startAt || 0;
          if (!t.hold && start > now && start <= until) {
            const b = recruitBatch(id, start);
            if (b && !b.reason) addTo(id, b.cost, 'tropas (inicio programado)', start);
          } else if (recruitEnabledFor(id)) {
            const b = recruitBatch(id);
            if (b?.queueFull && b.nextFree && b.nextFree <= until) {
              const nb = recruitBatch(id, b.nextFree);
              if (nb && !nb.reason) addTo(id, nb.cost, 'siguiente lote de tropas', b.nextFree);
            }
          }
        }
      } catch {}
      // Festival que termina dentro del horizonte (se empieza otro en cuanto acabe).
      try {
        if (state.comercio.forFestival !== false && inc('festivales') && festCfg() && canFestival(id)) {
          const end = festivalEnd(id);
          if (end > now && end <= until) addTo(id, festCost(), 'festival', end);
        }
      } catch {}
    }
    return out;
  }

  // ¿Hay encargos esperando recursos de verdad? (lo que falta y no cubre la propia
  // producción en unos minutos; "falta 18" se produce solo en segundos).
  function tradeBusy(needs) {
    return (needs || []).some((n) => RES.some((k) => (n.missInit[k] || 0) - (productionOf(n.townId)[k] || 0) * 0.1 > 0));
  }
  // Contexto del equilibrio: modo + lo que les va a faltar a las ciudades con encargos a punto.
  function balanceContext(needs) {
    let up = new Map();
    try { up = upcomingDemands(); } catch (e) { console.warn('[NOVABOT][equilibrio] próximos encargos:', e); }
    const mode = tradeBusy(needs) ? 'encargos' : up.size ? 'pronto' : 'libre';
    return { mode, up };
  }
  const MODE_TEXT = {
    encargos: 'Hay ciudades esperando recursos: el comercio va primero. Se evita perder y se iguala con poca parte de los comerciantes, sin tocar lo que alguien espera.',
    pronto: 'Hay encargos a punto de empezar: se evita perder recursos, se adelanta a esas ciudades lo que les va a faltar y se igualan ciudades, con poca parte de los comerciantes.',
    libre: 'Nada pendiente ni a punto: se evita perder, se igualan ciudades y se alimentan aldeas con más comerciantes.'
  };

  // Movimientos de equilibrio (agrupados por pareja origen → destino).
  function planBalance(M, ctx = { mode: 'libre', up: new Map() }) {
    const cfg = state.equilibrio;
    const now = Date.now();
    const free = ctx.mode === 'libre';
    const resList = caveOn() ? ['wood', 'stone'] : RES; // con Cueva la plata la gestiona la Cueva
    const tol = clamp(+cfg.tolPct || 20, 5, 60) / 100;
    const maxTravel = Math.max(1, +cfg.maxTravelMin || 45) * 60;
    // Parte de los comerciantes que puede usar cada ciudad (lo demás queda libre para encargos).
    const capPct = clamp(free ? (+cfg.maxCapPct || 60) : (+cfg.busyCapPct || 20), 0, 100) / 100;
    const ids = M.towns;
    const moves = new Map();
    const capLeft = {};
    for (const id of ids) { const t = M.T[id]; capLeft[id] = Math.max(0, Math.min(t.cap, t.cap - t.maxCap * (1 - capPct))); }
    // Lo que alguna ciudad espera ahora no lo mueve el equilibrio (lo reparte el comercio).
    const waited = (k) => ctx.mode === 'encargos' && (M.globalMiss[k] || 0) > 0;
    const giveable = (d, k) => (M.T[d].miss[k] > 0 ? 0 : Math.max(0, Math.floor(M.T[d].cur[k] - M.T[d].keep[k] - (ctx.up.get(d)?.[k] || 0))));
    const onCooldown = (a, b) => (tradeRuntime.pairCooldown.get(`${a}>${b}`) || 0) > now;
    const fill = (id, k) => M.T[id].lvl[k] / M.T[id].storage;
    const room = (r, k, eta) => { const t = M.T[r]; return t.over[k] > 0 ? 0 : Math.floor(t.safe[k] - t.lvl[k] - t.prod[k] * eta / 3600); };
    // Lo que le faltará a una ciudad para sus encargos a punto (más los de ahora).
    const lack = (r, k) => { const u = ctx.up.get(r); return u ? Math.max(0, Math.ceil((u[k] || 0) + M.T[r].total[k] - M.T[r].lvl[k])) : 0; };
    // Destinos: primero los que van a necesitar ese recurso, luego los que menos tienen;
    // cada 12 min de viaje cuenta como un 10 % más lleno.
    const score = (d, r, k) => fill(r, k) + travelSec(d, r) / 7200 - (lack(r, k) > 0 ? 1 : 0);
    const receivers = (d, k, maxT, cond) => ids
      .filter((r) => r !== d && !onCooldown(d, r) && travelSec(d, r) <= maxT && cond(r))
      .sort((a, b) => score(d, a, k) - score(d, b, k));
    function add(d, r, k, x, kind, feed = null) {
      const key = `${d}>${r}`;
      let m = moves.get(key);
      if (!m) { m = { from: d, to: r, ship: { wood: 0, stone: 0, iron: 0 }, kinds: new Set(), eta: travelSec(d, r), feeds: [] }; moves.set(key, m); }
      m.ship[k] += x; m.kinds.add(kind);
      if (feed) m.feeds.push(feed);
      const D = M.T[d], R = M.T[r];
      D.cur[k] -= x; D.lvl[k] -= x; D.over[k] = Math.max(0, D.over[k] - x);
      R.lvl[k] += x; R.inc[k] += x;
      capLeft[d] = Math.max(0, capLeft[d] - x);
    }

    // 1) Evitar pérdida en la próxima recolección.
    const urgent = [];
    for (const d of ids) for (const k of resList) if (M.T[d].over[k] > 0 && !waited(k)) urgent.push({ d, k, over: M.T[d].over[k] });
    urgent.sort((a, b) => b.over - a.over);
    for (const u of urgent) {
      const D = M.T[u.d];
      let want = Math.min(giveable(u.d, u.k), Math.ceil(Math.max(D.over[u.k], D.lvl[u.k] - D.safe[u.k])));
      if (want < 100) continue;
      for (const r of receivers(u.d, u.k, free ? maxTravel * 2 : maxTravel, (r) => room(r, u.k, travelSec(u.d, r)) >= 100)) {
        if (want < 100 || capLeft[u.d] < 100) break;
        const x = Math.floor(Math.min(want, room(r, u.k, travelSec(u.d, r)), capLeft[u.d]));
        if (x < 100) continue;
        add(u.d, r, u.k, x, 'urgente');
        want -= x;
      }
    }

    // 2) Adelantar a las ciudades con encargos a punto lo que les va a faltar, desde
    //    las que tienen de sobra (por encima de la media del imperio + media tolerancia).
    if (ctx.mode === 'pronto') {
      const wants = [];
      for (const [r, u] of ctx.up) for (const k of resList) { const l = lack(r, k); if (l >= 100) wants.push({ r, k, l, at: u.at }); }
      wants.sort((a, b) => a.at - b.at || b.l - a.l);
      for (const w of wants) {
        let need = Math.min(lack(w.r, w.k), room(w.r, w.k, 0));
        const donors = ids
          .filter((d) => d !== w.r && !onCooldown(d, w.r) && travelSec(d, w.r) <= maxTravel && !ctx.up.has(d))
          .map((d) => ({ d, x: Math.floor(Math.min(giveable(d, w.k), M.T[d].lvl[w.k] - (M.F[w.k] + tol / 2) * M.T[d].storage)) }))
          .filter((o) => o.x >= 100)
          .sort((a, b) => travelSec(a.d, w.r) - travelSec(b.d, w.r));
        for (const o of donors) {
          if (need < 100) break;
          const x = Math.floor(Math.min(need, o.x, capLeft[o.d], room(w.r, w.k, travelSec(o.d, w.r))));
          if (x < 100) continue;
          add(o.d, w.r, w.k, x, 'adelantar');
          need -= x;
        }
      }
    }

    // 3) Alimentar aldeas con tasa alta (solo en modo libre).
    if (free && state.aldeas.enabled && state.aldeas.feed) {
      for (const w of exFeedWants(M)) {
        const X = w.give, e = w.townId;
        const donor = ids
          .filter((d) => d !== e && !onCooldown(d, e) && travelSec(d, e) <= maxTravel)
          .map((d) => ({ d, x: Math.floor(Math.min(giveable(d, X), M.T[d].lvl[X] - M.F[X] * M.T[d].storage, capLeft[d])) }))
          .filter((o) => o.x >= Math.max(500, w.amount * 0.5))
          .sort((a, b) => travelSec(a.d, e) - travelSec(b.d, e))[0];
        if (!donor) continue;
        // Revalidar con lo ya asignado en esta vuelta (sitio para X al llegar y para Y al cambiar).
        const E = M.T[e], Y = w.get;
        const roomY = (caveOn() ? E.storage * 0.95 - E.lvl[Y] : E.safe[Y] - E.lvl[Y]) / w.ratio;
        const x = Math.floor(Math.min(w.amount, donor.x, room(e, X, travelSec(donor.d, e)), roomY));
        if (x < 500) continue;
        add(donor.d, e, X, x, 'aldea', { rel: w.rel, farm: w.farm, give: X, get: Y, amount: x, ratio: w.ratio });
        // Al llegar se cambia: en el modelo, X se convierte en Y.
        E.lvl[X] -= x; E.lvl[Y] += Math.round(x * w.ratio);
      }
    }

    // 4) Igualar. En cualquier modo (con encargos, solo con la parte pequeña de
    //    comerciantes y sin tocar lo que alguien espera).
    // La tolerancia se adapta a lo lleno que está el imperio: por arriba no pasa de la
    // mitad de lo que queda hasta el 100 % (con todo al 78 % y tolerancia 20, las que
    // pasan del 89 % dan a las que están por debajo del 65 %, con la tolerancia por abajo en 13).
    const tolUpOf = (k) => Math.min(tol, Math.max(0.03, (1 - M.F[k]) / 2));
    if (cfg.balance !== false) {
      const donors = [];
      for (const d of ids) for (const k of resList) {
        if (waited(k)) continue;
        const t = M.T[d];
        const ex = t.lvl[k] - (M.F[k] + tolUpOf(k)) * t.storage;
        if (ex > 0) donors.push({ d, k, ex });
      }
      donors.sort((a, b) => b.ex - a.ex);
      for (const u of donors) {
        const D = M.T[u.d];
        let want = Math.min(giveable(u.d, u.k), Math.floor(D.lvl[u.k] - (M.F[u.k] + tolUpOf(u.k) / 2) * D.storage));
        if (want < 100) continue;
        // Por abajo la tolerancia no pasa de la mitad de la media (si no, con un recurso
        // escaso en todo el imperio ninguna ciudad quedaría "por debajo").
        const tolDown = Math.min(clamp(+(cfg.tolDownPct ?? 13), 2, 60) / 100, M.F[u.k] / 2);
        const below = (r) => M.T[r].lvl[u.k] < (M.F[u.k] - tolDown) * M.T[r].storage;
        for (const r of receivers(u.d, u.k, maxTravel, below)) {
          if (want < 100 || capLeft[u.d] < 100) break;
          const R = M.T[r];
          const take = Math.min((M.F[u.k] - tolDown / 2) * R.storage - R.lvl[u.k], room(r, u.k, travelSec(u.d, r)));
          const x = Math.floor(Math.min(want, take, capLeft[u.d]));
          if (x < 100) continue;
          add(u.d, r, u.k, x, 'equilibrio');
          want -= x;
        }
      }
    }

    const minMove = Math.max(100, +cfg.minMove || 1000);
    const out = [];
    for (const m of moves.values()) {
      const total = sumRes(m.ship);
      const kinds = [...m.kinds].sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);
      const min = kinds[0] === 'urgente' ? 300 : kinds[0] === 'equilibrio' ? minMove : 500;
      if (total < min) continue;
      out.push({ ...m, kind: kinds[0], kinds, total });
    }
    return out.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (b.total - a.total));
  }

  async function balanceTick(needs = []) {
    const cfg = state.equilibrio;
    const ctx = balanceContext(needs);
    balRuntime.mode = ctx.mode;
    const moves = planBalance(resourceModel(), ctx);
    const max = Math.max(1, +cfg.maxMoves || 4);
    let sent = 0;
    for (const m of moves) {
      if (sent >= max || !state.equilibrio.enabled || !state.comercio.enabled) break;
      const label = KIND_LABEL[m.kind];
      try {
        await gpPostAs(m.from, 'town_info', 'trade', { id: m.to, wood: m.ship.wood, stone: m.ship.stone, iron: m.ship.iron, nl_init: true });
        const arrival = Date.now() + m.eta * 1000;
        tradeRuntime.ledger.push({ from: m.from, to: m.to, ...m.ship, arrival, expires: arrival + 120000 });
        tradeRuntime.pairCooldown.set(`${m.from}>${m.to}`, Date.now() + 60000);
        tradeRuntime.lastSendAt = Date.now();
        for (const f of m.feeds) {
          exRuntime.feeds.push({ townId: m.to, relId: +f.rel.id, give: f.give, get: f.get, amount: f.amount, arrival: arrival + 10000, expires: arrival + 20 * 60000 });
        }
        const extra = m.feeds.length ? ` · para ${m.feeds.map((f) => `${f.farm.name} (${RES_ES[f.give]} → ${RES_ES[f.get]} a ${f.ratio.toFixed(2)})`).join(', ')}` : '';
        const why = m.kind === 'adelantar' ? ` · para ${ctx.up.get(m.to)?.labels.join(', ') || 'su próximo encargo'}` : '';
        tradeLog(`${label} · ${farmTownName(m.from)} → ${farmTownName(m.to)}: ${fmtRes(m.ship)} · ${Math.max(1, Math.round(m.eta / 60))} min${extra}${why}`, 'ok');
        sent += 1;
      } catch (e) {
        tradeRuntime.pairCooldown.set(`${m.from}>${m.to}`, Date.now() + 5 * 60000);
        tradeLog(`${label} · ${farmTownName(m.from)} → ${farmTownName(m.to)}: ${e.message}`, 'error');
      }
      await sleep(700 + Math.random() * 900);
    }
    if (sent) { setTimeout(refreshOverviews, 3000); renderIfIdle('comercio'); }
  }

  function renderBalanceCard() {
    const cfg = state.equilibrio;
    const num = (key, label, step, min, max) => {
      const i = el('input', { class: 'nb-input', type: 'number', step: String(step), min: String(min), max: String(max), value: cfg[key] });
      i.addEventListener('change', () => { cfg[key] = clamp(pos(i.value, cfg[key]), min, max); saveState(); renderIfIdle('comercio'); });
      return el('label', { class: 'nb-field' }, [label, i]);
    };
    const pct = (v) => `${Math.round(v * 100)}%`;
    let M = null, risk = [], moves = [], ctx = { mode: 'libre', up: new Map() };
    try {
      M = resourceModel();
      risk = M.towns.map((id) => ({ id, over: { ...M.T[id].over } })).filter((r) => sumRes(r.over) >= 1);
      let needs = []; try { needs = planTrades().needs; } catch {}
      ctx = balanceContext(needs);
      moves = planBalance(M, ctx);
    } catch (e) { console.warn('[NOVABOT][equilibrio]', e); }
    const riskEl = risk.length
      ? el('div', { class: 'nb-alert nb-alert-warn nb-mt' }, [el('span', {}, [el('b', {}, 'Rebosaría en la próxima recolección: '),
          ...risk.flatMap((r, i) => [i ? ' · ' : '', `${farmTownName(r.id)} `, fmtResEl(r.over)])])])
      : el('div', { class: 'nb-alert nb-alert-info nb-mt' }, 'Ninguna ciudad rebosa en la próxima recolección.');
    const upList = [...ctx.up.entries()].sort((a, b) => a[1].at - b[1].at);
    const upEl = upList.length
      ? el('div', { class: 'nb-queue' }, upList.slice(0, 8).map(([id, u]) => el('div', { class: 'nb-queue-item' }, [
          el('span', {}, [`${farmTownName(id)}: ${u.labels.join(', ')} `, fmtResEl(u)]),
          el('span', { class: 'nb-queue-time', 'data-nb-until': Math.round(Math.max(u.at, Date.now()) / 1000) }, formatLeft(Math.round(Math.max(u.at, Date.now()) / 1000)))
        ])))
      : null;
    const movesEl = moves.length
      ? el('div', { class: 'nb-queue' }, moves.slice(0, 10).map((m) => el('div', { class: 'nb-queue-item' }, [
          el('span', {}, [el('span', { class: 'nb-pill' }, KIND_LABEL[m.kind]), ` ${farmTownName(m.from)} → ${farmTownName(m.to)} `, fmtResEl(m.ship)]),
          el('span', { class: 'nb-queue-time' }, `${Math.max(1, Math.round(m.eta / 60))} min`)
        ])))
      : el('p', { class: 'nb-placeholder' }, 'Nada que mover ahora.');
    return el('div', { class: 'nb-card', 'data-nb-card': 'equilibrio' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Equilibrio entre ciudades'), el('span', { class: 'nb-pill nb-ml' }, ctx.mode === 'encargos' ? 'encargos en curso' : ctx.mode === 'pronto' ? 'encargos a punto' : 'libre')]),
        switchEl(!!cfg.enabled, (v) => { cfg.enabled = v; saveState(); tradeLog(v ? 'Equilibrio activado.' : 'Equilibrio desactivado.'); renderBody(); }, false)]),
      optionRow('Igualar ciudades', 'Si una ciudad tiene mucho de un recurso y otra poco, lo reparte (con encargos, solo con la parte pequeña de comerciantes)', cfg.balance !== false, (v) => { cfg.balance = v; saveState(); renderBody(); }),
      el('div', { class: 'nb-field-row' }, [num('busyCapPct', 'Comerciantes con encargos (%)', 5, 0, 100), num('maxCapPct', 'Comerciantes sin encargos (%)', 10, 10, 100)]),
      el('div', { class: 'nb-field-row' }, [num('horizonMin', 'Encargos «a punto»: en (min)', 5, 5, 240), num('tolPct', 'Tolerancia por arriba (%)', 5, 5, 60)]),
      el('div', { class: 'nb-field-row' }, [num('maxTravelMin', 'Viaje máximo (min)', 5, 1, 600), num('minMove', 'Envío mínimo al igualar', 100, 100, 100000)]),
      el('div', { class: 'nb-field-row' }, [num('tolDownPct', 'Tolerancia por abajo (%)', 1, 2, 60), num('maxMoves', 'Envíos por vuelta', 1, 1, 20)]),
      el('p', { class: 'nb-placeholder' }, 'Solo actúa en las vueltas en que el comercio no tiene nada que enviar para encargos. Antes de cada recolección calcula el botín de cada ciudad y lo que no cabría lo manda a ciudades con sitio (primero a las que lo van a necesitar). Con encargos a punto, les adelanta lo que les faltará. Sin nada pendiente, iguala ciudades y trae recursos a las aldeas con buena tasa. Nunca toca lo reservado para encargos.'),
      el('div', { class: 'nb-alert nb-alert-info nb-mt' }, MODE_TEXT[ctx.mode]),
      M ? el('p', { class: 'nb-placeholder' }, `Imperio: madera ${pct(M.F.wood)} · piedra ${pct(M.F.stone)} · plata ${pct(M.F.iron)} del almacén${M.dt !== null ? ` · próxima recolección en ${Math.max(0, Math.round(M.dt * 60))} min` : ''}.`) : null,
      riskEl,
      upEl ? el('div', { class: 'nb-card-title nb-mt' }, `Encargos a punto (${upList.length})`) : null,
      upEl,
      el('div', { class: 'nb-card-title nb-mt' }, `Ahora movería (${moves.length})`),
      movesEl
    ]);
  }

  async function tradeTick() {
    if (!state.comercio.enabled) return;
    if (!overviewReady()) return; // sin conocer TODOS los envíos en camino se enviaría de más
    calibrateTravel();
    const { plan, needs } = planTrades();
    const maxPerTick = Math.max(1, +state.comercio.maxPerTick || 5);
    for (const p of plan.slice(0, maxPerTick)) {
      if (!state.comercio.enabled) return;
      try {
        await gpPostAs(p.from, 'town_info', 'trade', { id: p.to, wood: p.ship.wood, stone: p.ship.stone, iron: p.ship.iron, nl_init: true });
        tradeRuntime.ledger.push({ from: p.from, to: p.to, ...p.ship, arrival: Date.now() + p.eta * 1000, expires: Date.now() + p.eta * 1000 + 120000 });
        tradeRuntime.pairCooldown.set(`${p.from}>${p.to}`, Date.now() + 20000);
        tradeRuntime.lastSendAt = Date.now();
        tradeLog(`${farmTownName(p.from)} → ${farmTownName(p.to)}: ${fmtRes(p.ship)} · ${Math.round(p.eta / 60)} min · para ${p.label}`, 'ok');
        setTimeout(refreshOverviews, 3000);
      } catch (e) {
        tradeRuntime.pairCooldown.set(`${p.from}>${p.to}`, Date.now() + 5 * 60000);
        tradeLog(`${farmTownName(p.from)} → ${farmTownName(p.to)}: ${e.message}`, 'error');
        // Si fue un corte/tiempo agotado el envío pudo salir igual: releer lo que va de camino.
        setTimeout(refreshOverviews, 3000);
      }
      await sleep(700 + Math.random() * 900);
    }
    if (plan.length) renderIfIdle('comercio');
    // Equilibrio (8c-bis): solo en vueltas en que no hubo nada que enviar para encargos
    // y con los datos ya al día tras el último envío (cada 30 s como mucho).
    if (!plan.length && state.equilibrio?.enabled && Date.now() >= balRuntime.nextAt && Date.now() - (tradeRuntime.lastSendAt || 0) > 15000) {
      balRuntime.nextAt = Date.now() + 30000;
      await balanceTick(needs);
    }
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
      optionRow('Abastecer investigación', 'Solo cuando la ciudad tiene puntos de investigación para esa investigación', cfg.forResearch !== false, (v) => { cfg.forResearch = v; saveState(); renderBody(); }),
      optionRow('Abastecer festivales', 'Envía justo lo que falta para el festival (Academia 30+)', cfg.forFestival !== false, (v) => { cfg.forFestival = v; saveState(); renderBody(); }),
      el('p', { class: 'nb-placeholder' }, 'Aquí se elige a qué módulos manda recursos el comercio (es el único sitio). Revisa cada 10 s. Abastece todos los encargos que caben en la cola de cada ciudad. Nunca dona lo que la donante va a gastar y nunca hace que se pierda recurso al llegar.')
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
    bodyEl.appendChild(renderBalanceCard());

    if (!overviewReady()) bodyEl.appendChild(el('div', { class: 'nb-alert nb-alert-info' }, 'Leyendo los envíos en camino de todas las ciudades… el comercio empieza en cuanto termine.'));
    bodyEl.appendChild(renderPriorityCard());
    // Necesidades actuales y plan
    let planInfo = { plan: [], needs: [] };
    try { planInfo = planTrades(); } catch {}
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Necesidades (${planInfo.needs.length})`),
      planInfo.needs.length
        ? el('div', { class: 'nb-queue' }, planInfo.needs.map((n) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, [`${farmTownName(n.townId)} `, el('b', { class: 'nb-queue-level' }, n.label)]),
            el('span', { class: 'nb-queue-time' }, ['falta ', fmtResEl(n.missInit)])
          ])))
        : el('p', { class: 'nb-placeholder' }, 'Ninguna ciudad espera recursos.')
    ]));

    const rows = transitRows();
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `En camino (${rows.length})`),
      rows.length
        ? el('div', { class: 'nb-queue' }, rows.map((r) => el('div', { class: 'nb-queue-item' }, [
            el('span', {}, [`${r.from ? farmTownName(r.from) : 'Aldea'} → ${farmTownName(r.to)} `, fmtResEl(r)]),
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
     (una sola tropa, lo máximo que cabe en el almacén), espera a tenerlo y lo
     recluta de golpe. Mientras espera, el lote se publica como demanda al
     Comercio, que manda justo los recursos que faltan.

     Petición: POST building_barracks?action=build (tierra) / building_docks (mar)
               json: { unit_id, amount, town_id, nl_init:true }
  --------------------------------------------------------------------------------- */
  const recruitRuntime = { timer: null, running: false, log: [], cooldown: new Map(), wait: new Map() };
  let recruitLogEl = null;

  const recruitOnFor = (townId) => { const v = state.reclutamiento.towns[townId]?.enabled; return typeof v === 'boolean' ? v : !!state.reclutamiento.enabled; };
  // En espera: "Empezar más tarde" activado (aún sin hora) o con la hora sin llegar.
  // Mientras tanto la ciudad no pide ni reserva nada (y puede donar).
  const recruitWaiting = (townId) => { const t = state.reclutamiento.towns[townId]; return !!t && (!!t.hold || (+t.startAt || 0) > Date.now()); };
  const recruitEnabledFor = (townId) => recruitOnFor(townId) && !recruitWaiting(townId);
  const anyRecruitOn = () => allTownIds().some(recruitOnFor);

  function townRecruitCfg(townId) {
    const all = state.reclutamiento.towns;
    if (!all[townId]) all[townId] = { goals: [] };
    return all[townId];
  }

  function unitName(id) { const u = UW.GameData?.units?.[id]; return u?.name_plural || u?.name || id; }

  /* Coste REAL por ciudad y tropa: el que muestra la ventana del Cuartel / Puerto
     (UnitOrder.init del propio juego), que ya incluye TODO: investigaciones (Leva…),
     héroes asignados a la ciudad (p. ej. Aristóteles abarata las naves ligeras) y
     cualquier otra bonificación. Se lee por API (GET building_barracks|docks?index,
     lo mismo que abrir la ventana) y se refresca cada 5 min, y al llegar un héroe. */
  const realCosts = new Map(); // townId -> { at, units: { id: {wood,stone,iron,favor,pop} } }
  function parseUnitOrderInit(html) {
    const i = html.indexOf('UnitOrder.init('); if (i < 0) return null;
    const j = html.indexOf('{', i); if (j < 0) return null;
    let depth = 0, inStr = false, escp = false;
    for (let k = j; k < html.length; k++) {
      const c = html[k];
      if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(j, k + 1)); } catch { return null; } } }
    }
    return null;
  }
  async function refreshRealCosts(townId) {
    const units = {};
    for (const ctrl of ['building_barracks', 'building_docks']) {
      try {
        const d = await gpGetAs(townId, ctrl, 'index', { nl_init: true });
        const u = parseUnitOrderInit(String(d?.html || ''));
        if (u) for (const [id, v] of Object.entries(u)) {
          const r = v?.resources || {};
          units[id] = { wood: +r.wood || 0, stone: +r.stone || 0, iron: +r.iron || 0, favor: +v.favor || 0, pop: +v.population || 0 };
        }
      } catch {}
    }
    if (Object.keys(units).length) realCosts.set(+townId, { at: Date.now(), units, heroes: heroesPresentKey(townId) });
  }
  // Héroes que están YA en la ciudad (llegados). Al llegar el juego pone
  // town_arrival_at a null, así que se compara la lista, no la hora.
  function heroesPresentKey(townId) {
    try {
      return [].concat(UW.MM.getCollections().PlayerHero || []).flatMap((c) => c?.models || []).map((m) => m.attributes)
        .filter((h) => +h.home_town_id === +townId && !(+h.town_arrival_at * 1000 > Date.now())).map((h) => `${h.type}:${h.level}`).sort().join(',');
    } catch { return ''; }
  }
  function realCostsStale(townId) {
    const c = realCosts.get(+townId);
    if (!c) return true;
    if (Date.now() - c.at > 5 * 60000) return true;
    return c.heroes !== heroesPresentKey(townId); // llegó, se fue o subió de nivel un héroe
  }

  /* Héroes que abaratan tropas. El % sale de los datos del propio juego:
     GameData.heroes[tipo].description_args["1"] = { value, level_mod } → % = value + level_mod × nivel
     (Aristóteles nivel 11: 0,20 + 0,02 × 11 = 42 %). Tropas afectadas: tabla conocida
     y, si no está, se deducen del texto del héroe ("costes … de las <tropa>"). */
  // Comprobado con Daidalos (nv 8) en 02. NOVA: birreme base 800 → 800 × 0,90 (investigación)
  // × 0,82 (héroe: 10 % + 1 % × 8) = 590,4, justo lo que cobra el juego. Los descuentos se MULTIPLICAN.
  const HERO_UNIT_DISCOUNT = {
    aristotle: ['attack_ship'],   // naves ligeras
    daidalos: ['bireme'],
    eurybia: ['trireme'],
    odysseus: ['sword'],
    cheiron: ['hoplite'],
    argus: 'naval',               // todas las unidades navales
    anysia: 'myth_favor'          // solo el FAVOR de las unidades míticas
  };
  function heroCostBonuses(townId) {
    const out = [];
    try {
      const models = [].concat(UW.MM.getCollections().PlayerHero || []).flatMap((c) => c?.models || []).map((m) => m.attributes);
      for (const h of models) {
        if (+h.home_town_id !== +townId || (h.assignment_type && h.assignment_type !== 'town')) continue;
        const gd = UW.GameData?.heroes?.[h.type];
        const arg = gd?.description_args?.['1'];
        const desc = String(gd?.description || '').toLowerCase();
        if (!arg || !/cost/.test(desc)) continue;
        let units = HERO_UNIT_DISCOUNT[h.type];
        let favorOnly = false;
        if (units === 'naval') units = Object.entries(UW.GameData?.units || {}).filter(([, u]) => u?.is_naval).map(([id]) => id);
        else if (units === 'myth_favor') { units = Object.entries(UW.GameData?.units || {}).filter(([, u]) => +u?.favor > 0).map(([id]) => id); favorOnly = true; }
        if (!units) {
          units = Object.entries(UW.GameData?.units || {}).filter(([, u]) => [u.name, u.name_plural].filter(Boolean).some((n) => desc.includes(String(n).toLowerCase()))).map(([id]) => id);
        }
        if (!units.length) continue;
        const pct = clamp((+arg.value || 0) + (+arg.level_mod || 0) * (+h.level || 0), 0, 0.9);
        out.push({ type: h.type, name: gd?.name || h.type, units, pct, favorOnly, arrival: +h.town_arrival_at * 1000 || 0 });
      }
    } catch {}
    return out;
  }

  // Coste por tropa: el real del juego (investigaciones + héroes ya en la ciudad);
  // si aún no se ha leído, la tabla base × factor de investigación de la vista general.
  // atMs: momento en que se va a reclutar. Si para entonces habrá llegado un héroe
  // que abarata esa tropa (y ahora aún no está), se aplica su descuento por adelantado.
  function unitCost(townId, id, atMs = null) {
    const base = unitCostNow(townId, id);
    if (!atMs) return base;
    let f = 1, ff = 1;
    for (const h of heroCostBonuses(townId)) {
      if (!h.units.includes(id) || !(h.arrival > Date.now() && h.arrival <= atMs)) continue;
      if (h.favorOnly) ff *= 1 - h.pct; else f *= 1 - h.pct;   // se multiplican (como hace el juego)
    }
    if (f === 1 && ff === 1) return base;
    return { ...base, wood: Math.ceil(base.wood * f), stone: Math.ceil(base.stone * f), iron: Math.ceil(base.iron * f), favor: Math.ceil((base.favor || 0) * ff) };
  }
  function unitCostNow(townId, id) {
    const real = realCosts.get(+townId)?.units?.[id];
    if (real && (real.wood || real.stone || real.iron)) return { wood: real.wood, stone: real.stone, iron: real.iron, pop: real.pop || +UW.GameData?.units?.[id]?.population || 1, favor: real.favor };
    const u = UW.GameData?.units?.[id];
    const r = u?.resources || {};
    // Factor real del juego (p. ej. 0,9 con la Leva), leído de la vista de reclutamiento.
    // Comprobado: 82 caballeros = 17 712 madera = 82 × 240 × 0,9.
    const f = overview.recruit.get(+townId)?.units?.[id]?.rf || 1;
    return { wood: Math.ceil((+r.wood || 0) * f), stone: Math.ceil((+r.stone || 0) * f), iron: Math.ceil((+r.iron || 0) * f), pop: +u?.population || 1, favor: +u?.favor || 0 };
  }

  const isNavalUnit = (id) => !!UW.GameData?.units?.[id]?.is_naval;
  const isMythUnit = (id) => +UW.GameData?.units?.[id]?.favor > 0;
  const unitTag = (id) => isMythUnit(id) ? el('span', { class: 'nb-tag nb-tag-myth' }, 'mítica')
    : isNavalUnit(id) ? el('span', { class: 'nb-tag nb-tag-naval' }, 'naval')
    : el('span', { class: 'nb-tag nb-tag-land' }, 'terrestre');

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
      // Tropas sin investigar: se pueden pedir si su investigación está en la cola del
      // juego o en la del bot (se reclutan en cuanto quede investigada).
      const needR = [].concat(u.research_dependencies || []);
      if (needR.some((r) => !rs?.get?.(r) && !researchPending(townId, r))) continue;
      const needB = u.building_dependencies || {};
      if (Object.entries(needB).some(([b, l]) => (+bd?.building_data?.[b]?.level || 0) < +l)) continue;
      out.push(id);
    }
    // Tierra, luego mar, luego míticas; alfabético dentro de cada grupo.
    const grp = (id) => (isMythUnit(id) ? 2 : isNavalUnit(id) ? 1 : 0);
    return out.sort((a, b) => (grp(a) - grp(b)) || unitName(a).localeCompare(unitName(b), 'es'));
  }

  // Tropas propias de la ciudad: en casa + fuera (atacando / apoyando). Las que
  // están fuera también cuentan para el objetivo (si no, se volverían a reclutar).
  // Comprobado: vista de reclutamiento total = count (en casa) + fuera.
  function townUnitsHave(townId) {
    const out = {};
    try {
      const t = UW.ITowns.getTown(townId);
      const home = t?.units?.() || {}, outer = t?.unitsOuter?.() || {};
      for (const id of new Set([...Object.keys(home), ...Object.keys(outer)])) out[id] = (+home[id] || 0) + (+outer[id] || 0);
    } catch {}
    const ov = overview.recruit.get(+townId)?.units;
    if (ov) for (const [id, u] of Object.entries(ov)) out[id] = Math.max(+out[id] || 0, u.total || u.count);
    return out;
  }
  function townUnitOrders(townId) {
    const byId = new Map();
    try { for (const m of UW.ITowns.getTown(townId)?.getUnitOrdersCollection?.()?.models || []) byId.set(+m.attributes.id, m.attributes); } catch {}
    for (const o of overview.recruit.get(+townId)?.orders || []) if (!byId.has(+o.id)) byId.set(+o.id, o);
    const now = Date.now() / 1000;
    return [...byId.values()].filter((o) => !o.to_be_completed_at || +o.to_be_completed_at > now);
  }
  function queuedUnits(townId) {
    const out = {};
    for (const o of townUnitOrders(townId)) out[o.unit_type] = (out[o.unit_type] || 0) + (+o.units_left || +o.count || 0);
    return out;
  }
  // Cuartel (tierra) y Puerto (mar) tienen colas separadas.
  // Huecos libres (ahora, o en el instante atMs contando las órdenes que habrán
  // terminado para entonces).
  function unitQueueFree(townId, kind = null, atMs = null) {
    const orders = townUnitOrders(townId).filter((o) => !atMs || +o.to_be_completed_at * 1000 > atMs);
    const free = (k) => Math.max(0, buildQueueLimit() - orders.filter((o) => (o.kind === 'naval') === (k === 'naval')).length);
    return kind ? free(kind) : free('ground') + free('naval');
  }
  // Cuándo queda libre el próximo hueco de esa cola (epoch ms; 0 si ya hay hueco).
  function unitQueueNextFree(townId, kind) {
    if (unitQueueFree(townId, kind) > 0) return 0;
    const ends = townUnitOrders(townId).filter((o) => (o.kind === 'naval') === (kind === 'naval')).map((o) => +o.to_be_completed_at * 1000).sort((a, b) => a - b);
    return ends[0] || 0;
  }
  function freePopulation(townId) {
    let v = NaN;
    try { v = +UW.ITowns.getTown(townId)?.getAvailablePopulation?.(); } catch {}
    if (!Number.isFinite(v)) v = +overview.recruit.get(+townId)?.freePop;
    return Math.max(0, Number.isFinite(v) ? v : 0);
  }

  // Lote = UNA sola tropa (cada tropa es una orden y ocupa un hueco de la cola,
  // así que mezclar tropas en un lote gasta huecos de más).
  //  1) Primero las tropas a las que aún les falta al menos un LOTE COMPLETO
  //     (lo máximo que cabe en el almacén para esa tropa), en el orden de la lista.
  //  2) Los restos (lo que falta y ya no llena un lote) se dejan para el final.
  // El lote se recorta por la población libre (no se puede reclutar sin ella).
  // extra: lotes ya pedidos por delante (para calcular el SIGUIENTE lote sin esperar):
  // { units: {id: n}, orders: {ground: n, naval: n} }.
  function recruitBatch(townId, atMs = null, extra = null) {
    const cfg = townRecruitCfg(townId);
    const have = townUnitsHave(townId), queued = { ...queuedUnits(townId) };
    if (extra?.units) for (const [u, n] of Object.entries(extra.units)) queued[u] = (queued[u] || 0) + n;
    const storage = townStorage(townId) || 0;
    const fill = clamp(+state.reclutamiento.fillPct || 95, 10, 100) / 100;
    const fr = reserveAbove(townId, 'reclutamiento');
    const cap = { wood: Math.max(0, storage * fill - fr.wood), stone: Math.max(0, storage * fill - fr.stone), iron: Math.max(0, storage * fill - fr.iron), favor: godMaxFavor() * fill };
    // Inicio programado: coste de entonces (héroe incluido). En espera sin hora aún
    // ("Empezar más tarde" activado): se da por hecho que se esperará a los héroes en camino.
    const costAt = +cfg.startAt > Date.now() ? +cfg.startAt : cfg.hold ? Infinity : null;
    const rows = cfg.goals.map((g) => {
      const c = unitCost(townId, g.id, costAt);
      const rem = Math.max(0, g.target - (+have[g.id] || 0) - (+queued[g.id] || 0));
      let fit = Infinity;
      for (const k of [...RES, 'favor']) if (c[k] > 0) fit = Math.min(fit, Math.floor(cap[k] / c[k]));
      return { id: g.id, c, rem, fit: Number.isFinite(fit) ? fit : 0 };
    });
    // Las tropas aún sin investigar esperan; las siguientes de la lista se adelantan.
    const waitingR = rows.filter((r) => r.rem > 0 && !unitResearched(townId, r.id));
    const pending = rows.filter((r) => r.rem > 0 && unitResearched(townId, r.id));
    if (!pending.length) {
      if (!waitingR.length) return null;
      return { rows: waitingR, units: {}, cost: { wood: 0, stone: 0, iron: 0 }, reason: `Esperando a que se investigue: ${waitingR.map((r) => unitName(r.id)).join(', ')}.` };
    }
    // Solo tropas cuya cola (Cuartel / Puerto) tendrá hueco: si está llena no se
    // recluta ni se piden recursos para ella.
    const kindOf = (id) => (isNavalUnit(id) ? 'naval' : 'ground');
    const open = extra?.ignoreQueue ? pending : pending.filter((r) => unitQueueFree(townId, kindOf(r.id), atMs) - (+extra?.orders?.[kindOf(r.id)] || 0) > 0);
    if (!open.length) {
      const kinds = [...new Set(pending.map((r) => (isNavalUnit(r.id) ? 'naval' : 'ground')))];
      const next = Math.min(...kinds.map((k) => unitQueueNextFree(townId, k) || Infinity));
      return { rows: pending, units: {}, cost: { wood: 0, stone: 0, iron: 0 }, queueFull: true, nextFree: Number.isFinite(next) ? next : 0,
        reason: `Cola de reclutamiento llena${Number.isFinite(next) ? ` hasta ${new Date(next).toLocaleTimeString('es-ES')}` : ''}: no se piden recursos.` };
    }
    rows.splice(0, rows.length, ...open);
    const pick = rows.find((r) => r.fit > 0 && r.rem >= r.fit)   // falta al menos un lote completo
      || rows.filter((r) => r.fit > 0).sort((a, b) => b.rem * b.c.pop - a.rem * a.c.pop)[0]; // restos: el más grande primero
    if (!pick) return { rows, units: {}, cost: { wood: 0, stone: 0, iron: 0 }, reason: 'no cabe ni una tropa en el almacén' };
    const popFree = freePopulation(townId);
    const n = Math.min(pick.rem, pick.fit, Math.floor(popFree / Math.max(1, pick.c.pop)));
    if (n <= 0) return { rows, units: {}, cost: { wood: 0, stone: 0, iron: 0 }, reason: 'sin población libre' };
    const full = n === Math.min(pick.rem, pick.fit);
    return {
      rows, units: { [pick.id]: n }, full, tail: pick.rem < pick.fit,
      // El juego cobra el coste exacto por unidad (p. ej. 49,5) y redondea el TOTAL hacia arriba:
      // 323 honderos = 15 988,5 → 15 989 de madera (visto en una orden real).
      cost: { wood: Math.ceil(n * pick.c.wood), stone: Math.ceil(n * pick.c.stone), iron: Math.ceil(n * pick.c.iron) },
      pop: n * pick.c.pop, favor: n * pick.c.favor
    };
  }

  // Reserva de la ciudad (lo que NO regala a otras): lo de sus próximos lotes (los
  // "pedidos por adelantado", aunque ahora la cola esté llena), con tope del almacén.
  // Lo que tenga por encima de eso sí puede darlo: no hace falta guardarlo para tropas
  // que se reclutarán dentro de horas, y así ayuda a otras ciudades ya.
  function recruitPendingReserve(townId) {
    const out = { wood: 0, stone: 0, iron: 0 };
    const ahead = clamp(+state.reclutamiento.lotsAhead || 2, 1, 4);
    const extra = { units: {}, orders: { ground: 0, naval: 0 }, ignoreQueue: true };
    for (let n = 0; n < ahead; n++) {
      const b = recruitBatch(townId, null, extra);
      if (!b || !sumRes(b.cost)) break;
      for (const k of RES) out[k] += b.cost[k];
      for (const [u, c] of Object.entries(b.units)) extra.units[u] = (extra.units[u] || 0) + c;
    }
    const cap = (townStorage(townId) || 0) * clamp(+state.reclutamiento.fillPct || 95, 10, 100) / 100;
    for (const k of RES) out[k] = Math.min(out[k], cap);
    return out;
  }

  tradeDemandProviders.push(function recruitDemands() {
    if (!anyRecruitOn()) return [];
    const out = [];
    for (const townId of allTownIds()) {
      // Con inicio programado, hasta que llegue la hora la ciudad NO pide ni reserva
      // nada: queda totalmente libre (incluso para donar a otras).
      if (!recruitEnabledFor(townId) || !townRecruitCfg(townId).goals.length) continue;
      const res = recruitPendingReserve(townId);
      if (sumRes(res)) out.push({ townId, module: 'reclutamiento', label: 'reserva reclutamiento', reserveOnly: true, ...res });
      if (!state.comercio.forRecruit) continue;
      // Los recursos llegarán, como pronto, en lo que tarda el donante más cercano:
      // se mira si la cola tendrá hueco para entonces (si no, no se envía nada; y si
      // ahora está llena pero se libera antes de que lleguen, se envía por adelantado).
      const others = allTownIds().filter((id) => id !== townId);
      const eta = others.length ? Math.min(...others.map((id) => travelSec(id, townId))) : 0;
      // Se piden varios lotes por delante (por defecto 2): mientras llega lo del
      // primero ya viaja lo del siguiente, así la ciudad no se queda parada entre lote
      // y lote esperando al donante más lejano. La simulación del almacén del comercio
      // recorta lo que no cabría (nunca se pierde nada).
      const ahead = clamp(+state.reclutamiento.lotsAhead || 2, 1, 4);
      const extra = { units: {}, orders: { ground: 0, naval: 0 } };
      for (let n = 0; n < ahead; n++) {
        const b = recruitBatch(townId, Date.now() + eta * 1000, n ? extra : null);
        if (!b || b.reason || !sumRes(b.cost)) break;
        out.push({ townId, module: 'reclutamiento', label: `${n ? 'siguiente lote' : 'lote'} ${Object.entries(b.units).map(([u, k]) => `${k} ${unitName(u)}`).join(' + ')}`, ...b.cost });
        for (const [u, k] of Object.entries(b.units)) { extra.units[u] = (extra.units[u] || 0) + k; extra.orders[isNavalUnit(u) ? 'naval' : 'ground'] += 1; }
      }
    }
    return out;
  });

  /* ---- Hechizos de reclutamiento (por ciudad) ----
     Cuartel: Entrenamiento espartano (Ares), Crecimiento de la población (Hera).
     Puerto:  La llamada del mar (Poseidón).
     Cada uno: desactivado / opcional (se lanza si hay favor) / obligatorio (no se
     recluta sin él: se espera al favor y se lanza solo).
     · Activos en TODAS las ciudades: GET frontend_bridge?action=refetch
       {collections:{CastedPowers:[]}} (solo lectura, devuelve los de todas).
     · Lanzar: POST frontend_bridge?action=execute {model_url:"CastedPowers",
       action_name:"cast", arguments:{power_id, target_id}} (el mismo que usa el juego). */
  const RECRUIT_SPELLS = [
    { id: 'spartan_training', kind: 'ground' },
    { id: 'fertility_improvement', kind: 'ground' },
    { id: 'call_of_the_ocean', kind: 'naval' }
  ];
  const spellInfo = { at: 0, busy: false, active: new Map() }; // townId -> { power_id: endMs }
  // Hechizos activos de TODAS las ciudades: vista general de dioses (solo lectura,
  // lo mismo que abrir esa ventana): data.towns[].casted_powers = { power_id: fin (s) }.
  // (Comprobado: el "refetch" de CastedPowers devuelve vacío aunque haya hechizos.)
  async function refreshCastedPowers() {
    if (spellInfo.busy) return;
    spellInfo.busy = true;
    try {
      const d = await gpGet('town_overviews', 'gods_overview', { nl_init: true });
      const towns = d?.data?.towns;
      if (Array.isArray(towns)) {
        const map = new Map();
        for (const t of towns) {
          const cp = t?.casted_powers;
          const o = {};
          if (cp && typeof cp === 'object' && !Array.isArray(cp)) for (const [k, v] of Object.entries(cp)) o[k] = +v * 1000 || 0;
          else if (Array.isArray(t?.casted_power_ids)) for (const k of t.casted_power_ids) o[k] = Date.now() + 3600000; // sin fin conocido
          map.set(+t.id, o);
        }
        // Los recién lanzados por el bot que la vista aún no trae se mantienen.
        for (const [t, o] of spellInfo.active) for (const [k, end] of Object.entries(o)) if (end > Date.now() && !(map.get(t)?.[k] > 0)) { if (!map.has(t)) map.set(t, {}); map.get(t)[k] = end; }
        spellInfo.active = map; spellInfo.at = Date.now();
      }
    } catch {} finally { spellInfo.busy = false; }
  }
  function spellEnd(townId, id) {
    let end = spellInfo.active.get(+townId)?.[id] || 0;
    try { // lo que tenga cargado el juego (ciudad actual)
      for (const c of [].concat(UW.MM.getCollections().CastedPowers || [])) for (const m of c?.models || []) {
        const a = m.attributes; if (+a.town_id === +townId && a.power_id === id) end = Math.max(end, +a.end_at * 1000 || 0);
      }
    } catch {}
    return end;
  }
  const spellActive = (townId, id) => spellEnd(townId, id) > Date.now() + 30000;
  // Lanza los hechizos configurados para ese tipo de cola (tierra/mar) que no estén
  // activos. Devuelve el motivo de espera si falta uno OBLIGATORIO.
  async function ensureRecruitSpells(townId, kind) {
    const cfg = townRecruitCfg(townId).spells || {};
    for (const sd of RECRUIT_SPELLS.filter((x) => x.kind === kind)) {
      const mode = cfg[sd.id];
      if (!mode || spellActive(townId, sd.id)) continue;
      // Antes de lanzar, datos frescos (no lanzar uno que ya está activo).
      if (Date.now() - spellInfo.at > 15000) { await refreshCastedPowers(); if (spellActive(townId, sd.id)) continue; }
      const p = UW.GameData?.powers?.[sd.id]; if (!p) continue;
      const cost = +p.favor || 0, fav = godFavor(p.god_id);
      const key = `${townId}:${sd.id}`;
      if ((recruitRuntime.cooldown.get(key) || 0) > Date.now()) { if (mode === 'required') return `${p.name}: reintentando en unos minutos`; continue; }
      if (fav < cost) { if (mode === 'required') return `Esperando favor de ${UW.GameData?.gods?.[p.god_id]?.name || p.god_id} para ${p.name} (${Math.floor(fav)}/${cost})`; continue; }
      try {
        await gpPostAs(townId, 'frontend_bridge', 'execute', { model_url: 'CastedPowers', action_name: 'cast', captcha: null, arguments: { power_id: sd.id, target_id: +townId }, nl_init: true });
        if (!spellInfo.active.has(+townId)) spellInfo.active.set(+townId, {});
        spellInfo.active.get(+townId)[sd.id] = Date.now() + (+p.lifetime || 3600) * 1000;
        recruitLog(`${farmTownName(townId)}: hechizo ${p.name} lanzado (${cost} favor).`, 'ok');
        setTimeout(refreshCastedPowers, 3000);
        await sleep(600 + Math.random() * 600);
      } catch (e) {
        // Si el juego dice que ya está activo, se da por activo (no bloquea el reclutamiento).
        if (/activ|ya est|already|en curso|lanzad/i.test(e.message)) {
          if (!spellInfo.active.has(+townId)) spellInfo.active.set(+townId, {});
          spellInfo.active.get(+townId)[sd.id] = Date.now() + 10 * 60000;
          recruitLog(`${farmTownName(townId)}: ${p.name} ya estaba activo.`, 'info');
          setTimeout(refreshCastedPowers, 2000);
          continue;
        }
        recruitRuntime.cooldown.set(key, Date.now() + 5 * 60000);
        recruitLog(`${farmTownName(townId)}: ${p.name} — ${e.message}`, 'error');
        if (mode === 'required') return `${p.name}: ${e.message}`;
      }
    }
    return null;
  }

  // Objetivos cumplidos: en cuanto todo lo que faltaba está ya en la cola del juego (o
  // hecho), el bot no tiene nada más que hacer → se quitan (como en Construcción).
  function pruneRecruitGoals(townId) {
    const cfg = townRecruitCfg(townId);
    if (!cfg.goals.length) return;
    const have = townUnitsHave(townId), queued = queuedUnits(townId);
    const done = cfg.goals.filter((g) => (+have[g.id] || 0) + (+queued[g.id] || 0) >= g.target);
    if (!done.length) return;
    cfg.goals = cfg.goals.filter((g) => !done.includes(g));
    saveState();
    recruitLog(`${farmTownName(townId)}: ${done.map((g) => `${g.target} ${unitName(g.id)}`).join(', ')} ya en cola del juego o hechas (se quita del bot).`, 'ok');
  }

  async function recruitTick() {
    if (!anyRecruitOn()) return;
    if (!overviewReady()) return; // sin conocer TODAS las colas se podrían pasar de 7 órdenes
    // Coste real (héroes, investigaciones…): refrescar las ciudades con tropas pedidas.
    const stale = allTownIds().filter((id) => recruitOnFor(id) && townRecruitCfg(id).goals.length && realCostsStale(id));
    for (const id of stale.slice(0, 3)) await refreshRealCosts(id);
    for (const id of allTownIds()) pruneRecruitGoals(id);
    const anySpells = allTownIds().some((id) => recruitEnabledFor(id) && Object.values(townRecruitCfg(id).spells || {}).some(Boolean));
    if (anySpells && Date.now() - spellInfo.at > 60000) await refreshCastedPowers();
    for (const townId of allTownIds()) {
      if (!recruitEnabledFor(townId)) continue;
      const tc = townRecruitCfg(townId);
      if (tc.startAt && tc.startAt <= Date.now()) { delete tc.startAt; saveState(); recruitLog(`${farmTownName(townId)}: empieza el reclutamiento programado.`, 'ok'); }
      // (Los hechizos NO se lanzan por lo que ya está en la cola del juego: solo
      // afectan a lo que se recluta después, así que se lanzan justo antes de
      // mandar un lote del bot — ver abajo.)
      if (!townRecruitCfg(townId).goals.length || !unitQueueFree(townId)) continue;
      if ((recruitRuntime.cooldown.get(townId) || 0) > Date.now()) continue;
      // (recruitBatch sin atMs = huecos de ahora mismo)
      const b = recruitBatch(townId);
      if (!b || b.reason) continue;
      const cur = townResources(townId);
      // Solo con lo que no necesitan los módulos con más prioridad (ver 8a).
      const fr = reserveAbove(townId, 'reclutamiento');
      if (RES.some((k) => cur[k] - fr[k] < b.cost[k])) continue;
      if (b.favor && godFavor(townGod(townId)) < b.favor) continue;
      // Hechizos del cuartel / puerto: los obligatorios deben estar activos antes de reclutar.
      const lotKinds = [...new Set(Object.entries(b.units).filter(([, n]) => n > 0).map(([u]) => (isNavalUnit(u) ? 'naval' : 'ground')))];
      let waitSpell = null;
      for (const kind of lotKinds) { waitSpell = await ensureRecruitSpells(townId, kind); if (waitSpell) break; }
      if (waitSpell) { if (recruitRuntime.wait.get(townId) !== waitSpell) { recruitRuntime.wait.set(townId, waitSpell); renderIfIdle('reclutamiento'); } continue; }
      recruitRuntime.wait.delete(townId);
      for (const [unitId, amount] of Object.entries(b.units)) {
        if (!(amount > 0)) continue;
        try {
          await gpPostAs(townId, isNavalUnit(unitId) ? 'building_docks' : 'building_barracks', 'build', { unit_id: unitId, amount, nl_init: true });
          recruitLog(`${farmTownName(townId)}: ${amount} ${unitName(unitId)} reclutados.`, 'ok');
          setTimeout(refreshOverviews, 3000);
        } catch (e) {
          recruitLog(`${farmTownName(townId)}: ${unitName(unitId)} — ${e.message}`, 'error');
          recruitRuntime.cooldown.set(townId, Date.now() + 5 * 60000);
          break;
        }
        await sleep(700 + Math.random() * 800);
      }
      renderIfIdle('reclutamiento');
    }
  }

  function startRecruitEngine() {
    if (recruitRuntime.timer) return;
    recruitRuntime.timer = setInterval(() => {
      if (!anyRecruitOn() || recruitRuntime.running) return;
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
    if (overviewReady()) pruneRecruitGoals(townId);
    const tcfg = townRecruitCfg(townId);
    if (realCostsStale(townId) && !renderReclutamientoTab.loading) {
      renderReclutamientoTab.loading = true;
      refreshRealCosts(townId).finally(() => { renderReclutamientoTab.loading = false; if (state.activeTab === 'reclutamiento' && +UW.Game?.townId === townId) renderBody(); });
    }

    const sw = switchEl(!!cfg.enabled, (v) => { setModuleGlobal('reclutamiento', v); renderBody(); recruitLog(v ? 'Reclutamiento activado en todas las ciudades.' : 'Reclutamiento desactivado en todas las ciudades.'); }, false);
    const isExc = typeof tcfg.enabled === 'boolean' && tcfg.enabled !== !!cfg.enabled;
    const townSw = switchEl(recruitOnFor(townId), (v) => {
      if (v === !!cfg.enabled) delete tcfg.enabled; else tcfg.enabled = v;
      if (!v) { delete tcfg.startAt; delete tcfg.hold; }
      saveState(); renderBody();
      recruitLog(`${farmTownName(townId)}: reclutamiento ${v ? 'activado' : 'desactivado'} solo en esta ciudad.`);
    });
    // Inicio programado (solo esta ciudad) — desactivado por defecto
    // Al activar el interruptor la ciudad queda YA en espera (no pide ni reserva
    // recursos) aunque todavía no se haya puesto la hora.
    const delayIn = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '1', value: '', placeholder: 'min' });
    const scheduled = tcfg.startAt && tcfg.startAt > Date.now();
    const program = () => {
      const min = pos(delayIn.value, 0);
      if (!min) { delayIn.focus(); return; }
      tcfg.startAt = Date.now() + min * 60000; delete tcfg.hold;
      if (!recruitOnFor(townId)) tcfg.enabled = true;
      saveState(); renderBody();
      recruitLog(`${farmTownName(townId)}: reclutamiento programado para dentro de ${min} min.`, 'ok');
    };
    delayIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') program(); });
    const startBox = scheduled
      ? el('div', { class: 'nb-alert nb-alert-info' }, [
          el('span', {}, ['Empieza en ', el('b', { 'data-nb-until': Math.round(tcfg.startAt / 1000) }, formatLeft(Math.round(tcfg.startAt / 1000))), ` (${new Date(tcfg.startAt).toLocaleTimeString('es-ES')})`]),
          el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { delete tcfg.startAt; delete tcfg.hold; saveState(); renderBody(); recruitLog(`${farmTownName(townId)}: inicio programado cancelado.`); } }, 'Cancelar')
        ])
      : tcfg.hold
      ? el('div', { class: 'nb-row' }, [
          el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, 'Empezar dentro de'), el('span', { class: 'nb-option-hint nb-warn-txt' }, 'En espera: no recibe ni reserva recursos hasta que empiece')]),
          el('span', { class: 'nb-stepper' }, [delayIn, el('span', { class: 'nb-add-level' }, 'min'),
            el('span', { class: 'nb-mini', title: 'Quitar la espera', onclick: () => { delete tcfg.hold; saveState(); renderBody(); recruitLog(`${farmTownName(townId)}: espera quitada.`); } }, '✕'),
            el('span', { class: 'nb-btn nb-btn-sm', onclick: program }, 'Programar')])
        ])
      : optionRow('Empezar más tarde', 'Solo en esta ciudad. Desde que lo activas no recibe ni reserva recursos (puede donar)', false, (v) => {
          if (!v) return;
          tcfg.hold = true; saveState(); renderBody();
          recruitLog(`${farmTownName(townId)}: en espera, sin pedir recursos hasta que se programe.`);
        });

    const fillIn = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '10', max: '100', value: cfg.fillPct });
    fillIn.addEventListener('change', () => { cfg.fillPct = clamp(pos(fillIn.value, 95), 10, 100); saveState(); renderBody(); });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('div', { class: 'nb-option-text' }, [el('b', {}, 'Reclutamiento automático'), el('span', { class: 'nb-option-hint' }, 'Todas las ciudades')]), sw]),
      el('div', { class: 'nb-row nb-option' }, [el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, `Solo ${farmTownName(townId)}`),
        el('span', { class: `nb-option-hint${isExc ? ' nb-warn-txt' : ''}` }, isExc ? `Excepción: ${tcfg.enabled ? 'activado' : 'desactivado'} aunque el general esté ${cfg.enabled ? 'activado' : 'desactivado'}` : 'Sigue al general')]), townSw]),
      startBox,
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Lote = % del almacén'), el('span', {}, [fillIn, ' %'])]),
      (() => { const inp = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '1', max: '4', value: String(clamp(+cfg.lotsAhead || 2, 1, 4)) });
        inp.addEventListener('change', () => { cfg.lotsAhead = clamp(pos(inp.value, 2), 1, 4); saveState(); renderBody(); });
        return el('div', { class: 'nb-row' }, [el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, 'Lotes pedidos por adelantado'), el('span', { class: 'nb-option-hint' }, 'El comercio ya envía lo del siguiente lote mientras llega el actual')]), inp]); })(),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Ciudad actual'), el('span', { class: 'nb-row-value' }, farmTownName(townId))]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Cola Cuartel / Puerto'),
        el('span', { class: 'nb-row-value' }, ['ground', 'naval'].map((k) => `${buildQueueLimit() - unitQueueFree(townId, k)}/${buildQueueLimit()}`).join(' · '))])
    ]));
    const prioWarn = anyRecruitOn() ? prioExcludedAlert('reclutamiento') : null;
    if (prioWarn) bodyEl.appendChild(prioWarn);

    // Hechizos de reclutamiento de esta ciudad
    if (Date.now() - spellInfo.at > 60000 && !spellInfo.busy) refreshCastedPowers().then(() => renderIfIdle('reclutamiento'));
    const spellRows = RECRUIT_SPELLS.map((sd) => {
      const p = UW.GameData?.powers?.[sd.id]; if (!p) return null;
      const mode = tcfg.spells?.[sd.id] || '';
      const fav = Math.floor(godFavor(p.god_id)), end = spellEnd(townId, sd.id);
      const setMode = (m) => { tcfg.spells = { ...(tcfg.spells || {}) }; if (m) tcfg.spells[sd.id] = m; else delete tcfg.spells[sd.id]; if (!Object.keys(tcfg.spells).length) delete tcfg.spells; saveState(); renderBody(); };
      const seg = el('div', { class: 'nb-seg nb-seg-sm' }, [['', 'No'], ['optional', 'Opcional'], ['required', 'Obligatorio']].map(([v, l]) =>
        el('span', { class: `nb-seg-btn${mode === v ? ' active' : ''}`, onclick: () => setMode(v) }, l)));
      return el('div', { class: 'nb-spell-row' }, [
        el('span', { class: `nb-icon nb-icon-30 power_icon30x30 ${sd.id}`, title: String(p.short_effect || p.effect || '') }),
        el('div', { class: 'nb-goal-main' }, [
          el('div', { class: 'nb-goal-name' }, `${p.name} · ${sd.kind === 'naval' ? 'Puerto' : 'Cuartel'}`),
          el('div', { class: 'nb-goal-sub' }, [
            `${UW.GameData?.gods?.[p.god_id]?.name || p.god_id} · ${p.favor} favor (tienes ${fav}) · `,
            end > Date.now() ? el('span', { class: 'nb-ok' }, ['activo ', el('b', { 'data-nb-until': Math.round(end / 1000) }, formatLeft(Math.round(end / 1000)))]) : 'inactivo'
          ])
        ]),
        seg
      ]);
    });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Hechizos de reclutamiento · ${farmTownName(townId)}`),
      ...spellRows,
      el('p', { class: 'nb-placeholder nb-mt' }, 'Opcional: se lanza si hay favor. Obligatorio: no recluta hasta tenerlo activo (espera al favor y lo lanza solo). Mientras haya órdenes en cola se mantiene activo.')
    ]));

    // Siguiente lote
    const b = recruitBatch(townId);
    const cur = townResources(townId);
    let lotBox;
    if (!b) lotBox = el('p', { class: 'nb-placeholder' }, tcfg.goals.length ? 'Objetivos cumplidos.' : 'Sin tropas pedidas.');
    else if (b.queueFull) lotBox = el('div', { class: 'nb-alert nb-alert-warn' }, b.reason);
    else if (b.reason) lotBox = el('p', { class: 'nb-placeholder' }, b.reason);
    else {
      const bars = RES.filter((k) => b.cost[k] > 0).map((k) => {
        const pct = Math.min(100, Math.round(cur[k] / b.cost[k] * 100));
        return el('div', { class: 'nb-bar-row' }, [
          el('span', { class: 'nb-bar-label' }, [resIcon(k), ({ wood: 'Madera', stone: 'Piedra', iron: 'Plata' })[k]]),
          el('div', { class: 'nb-bar' }, [el('div', { class: 'nb-bar-fill', style: `width:${pct}%` })]),
          el('span', { class: 'nb-bar-num' }, `${Math.floor(cur[k])}/${Math.ceil(b.cost[k])}`)
        ]);
      });
      lotBox = el('div', {}, [
        el('div', { class: 'nb-goal-name' }, Object.entries(b.units).map(([u, n]) => `${n} ${unitName(u)}`).join(' + ')),
        el('div', { class: 'nb-goal-sub' }, b.tail ? 'Resto final (ya no llena un lote completo)' : b.full ? 'Lote completo: lo máximo que cabe en el almacén' : 'Lote recortado por la población libre'),
        el('div', { class: 'nb-goal-sub nb-res-list' }, [el('span', { class: 'nb-res' }, [resIcon('population'), `${b.pop} de población`]), b.favor ? el('span', { class: 'nb-res' }, [resIcon('favor'), `${Math.ceil(b.favor)} favor (${Math.floor(godFavor(townGod(townId)))} disponible)`]) : null]),
        ...bars
      ]);
      // Hay recursos pero parte está apartada para un módulo con más prioridad.
      const fr = reserveAbove(townId, 'reclutamiento');
      if (RES.every((k) => cur[k] >= b.cost[k]) && RES.some((k) => cur[k] - fr[k] < b.cost[k])) {
        lotBox.appendChild(el('div', { class: 'nb-alert nb-alert-warn' }, `Esperando: parte de los recursos está reservada para ${reserveOwner(townId, 'reclutamiento') || 'otro módulo'} (prioridad).`));
      }
    }
    const heroNotes = [];
    for (const h of heroCostBonuses(townId)) {
      const units = h.units.map((u) => unitName(u)).join(', ');
      const pctTxt = `−${Math.round(h.pct * 100)} %${h.favorOnly ? ' de favor' : ''} en ${h.units.length > 4 ? (h.favorOnly ? 'unidades míticas' : 'todas las naves') : units}`;
      const left = el('b', { 'data-nb-until': Math.round(h.arrival / 1000) }, formatLeft(Math.round(h.arrival / 1000)));
      const note = (kind, parts) => heroNotes.push(el('div', { class: `nb-alert nb-alert-${kind} nb-hero-note` }, [heroIcon(h.type), el('span', {}, parts)]));
      if (h.arrival <= Date.now()) note('info', [`${h.name} está en la ciudad: ${pctTxt} (ya incluido en el coste).`]);
      else if (scheduled && h.arrival <= tcfg.startAt) note('info', [`${h.name} llega en `, left, `, antes de empezar: el lote ya cuenta con su descuento (${pctTxt}).`]);
      else if (scheduled) note('warn', [`${h.name} (${pctTxt}) llega en `, left, ', DESPUÉS de empezar: retrasa el inicio para aprovecharlo.']);
      else if (tcfg.hold) note('info', [`${h.name} llega en `, left, `: el lote ya cuenta con su descuento (${pctTxt}). Programa el inicio para después de que llegue.`]);
      else note('warn', [`${h.name} (${pctTxt}) llega en `, left, '. Activa "Empezar más tarde" para esperarlo.']);
    }
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Siguiente lote'),
      recruitRuntime.wait.get(townId) ? el('div', { class: 'nb-alert nb-alert-warn' }, recruitRuntime.wait.get(townId)) : null,
      scheduled ? el('div', { class: 'nb-countdown' }, [el('span', {}, 'Empieza a reclutar en'), el('b', { 'data-nb-until': Math.round(tcfg.startAt / 1000) }, formatLeft(Math.round(tcfg.startAt / 1000))), el('small', {}, new Date(tcfg.startAt).toLocaleTimeString('es-ES'))])
        : tcfg.hold ? el('div', { class: 'nb-alert nb-alert-warn' }, 'En espera: no pide recursos. Pon los minutos y pulsa Programar.') : null,
      ...heroNotes,
      lotBox
    ]));

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
    const goalsNaval = el('div', { class: 'nb-goals' });
    for (const g of tcfg.goals) {
      const h = (+have[g.id] || 0) + (+queued[g.id] || 0);
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '0', value: g.target });
      input.addEventListener('change', () => setTarget(g.id, pos(input.value, g.target)));
      (isNavalUnit(g.id) ? goalsNaval : goalsBox).appendChild(el('div', { class: `nb-goal${h >= g.target ? ' nb-goal-done' : ''}` }, [
        unitIcon(g.id),
        el('div', { class: 'nb-goal-main' }, [
          el('div', { class: 'nb-goal-name' }, unitName(g.id)),
          el('div', { class: 'nb-goal-sub' }, `tienes ${+have[g.id] || 0}${queued[g.id] ? ` + ${queued[g.id]} en cola` : ''} · faltan ${Math.max(0, g.target - h)}${unitResearched(townId, g.id) ? '' : ' · esperando a que se investigue'}`)
        ]),
        el('div', { class: 'nb-stepper' }, [
          el('span', { class: 'nb-mini', onclick: () => setTarget(g.id, g.target - 50) }, '−50'),
          input,
          el('span', { class: 'nb-mini', onclick: () => setTarget(g.id, g.target + 50) }, '+50'),
          el('span', { class: 'nb-mini nb-mini-danger', title: 'Quitar', onclick: () => setTarget(g.id, 0) }, '✕')
        ])
      ]));
    }
    const nNaval = tcfg.goals.filter((g) => isNavalUnit(g.id)).length, nLand = tcfg.goals.length - nNaval;
    // Una tarjeta por edificio, con el mismo formato que las de "añadir".
    const goalCard = (bid, title, n, box, empty) => el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, [buildingIcon(bid, true), `${title} (${n})`]),
      n ? box : el('p', { class: 'nb-placeholder' }, empty)
    ]);
    bodyEl.appendChild(goalCard('barracks', 'Cuartel · tropas objetivo', nLand, goalsBox, 'Sin tropas pedidas. Añádelas abajo.'));
    bodyEl.appendChild(goalCard('docks', 'Puerto · barcos objetivo', nNaval, goalsNaval, 'Sin barcos pedidos. Añádelos abajo.'));

    // Añadir tropa
    const avail = landUnitsFor(townId).filter((id) => !tcfg.goals.some((g) => g.id === id));
    const addList = el('div', { class: 'nb-add-list' });
    const addListNaval = el('div', { class: 'nb-add-list' });
    // Lo que vas escribiendo se guarda (por ciudad y tropa) para que no se borre
    // al añadir otra tropa o al repintarse el panel. Sin número por defecto.
    const drafts = (renderReclutamientoTab.drafts ||= {});
    const draftKey = (id) => `${townId}:${id}`;
    for (const id of avail) {
      const c = unitCost(townId, id);
      const h = (+have[id] || 0) + (+queued[id] || 0);
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '1', placeholder: 'total', value: drafts[draftKey(id)] || '' });
      input.addEventListener('input', () => { if (input.value) drafts[draftKey(id)] = input.value; else delete drafts[draftKey(id)]; });
      const add = () => {
        const v = pos(input.value, 0);
        if (!v || v <= h) { input.focus(); input.select?.(); return; }
        delete drafts[draftKey(id)];
        setTarget(id, v);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      (isNavalUnit(id) ? addListNaval : addList).appendChild(el('div', { class: 'nb-add-row' }, [
        unitIcon(id),
        el('div', { class: 'nb-add-name' }, [
          el('span', {}, unitName(id)),
          el('span', { class: 'nb-add-level' }, `tienes ${h} · ${Math.round(c.wood)}/${Math.round(c.stone)}/${Math.round(c.iron)}${c.favor ? ` · ${Math.round(c.favor)} favor` : ''} · ${c.pop} pob${unitResearched(townId, id) ? '' : ' · en investigación'}`)
        ]),
        el('div', { class: 'nb-stepper' }, [input, el('span', { class: 'nb-mini nb-mini-add', title: 'Añadir (total objetivo)', onclick: add }, '✓')])
      ]));
    }
    // Cuartel y Puerto por separado (cada uno con su cola).
    const nAddNaval = avail.filter(isNavalUnit).length, nAddLand = avail.length - nAddNaval;
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, [buildingIcon('barracks', true), 'Cuartel · añadir tropa']),
      nAddLand ? addList : el('p', { class: 'nb-placeholder' }, 'No hay más tropas de cuartel disponibles en esta ciudad.')
    ]));
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, [buildingIcon('docks', true), 'Puerto · añadir barco']),
      nAddNaval ? addListNaval : el('p', { class: 'nb-placeholder' }, 'No hay barcos disponibles en esta ciudad (¿sin Puerto?).')
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
      .sort((a, b) => (normTxt(a.name).startsWith(n) ? 0 : 1) - (normTxt(b.name).startsWith(n) ? 0 : 1) || String(a.name).localeCompare(String(b.name)))
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
  // Héroes asignados a la ciudad. available = está YA en la ciudad (no viajando hacia
  // ella, no herido y no fuera con tropas): solo esos pueden salir con un ataque.
  function heroesIn(townId, all = false) {
    const now = Date.now();
    const list = heroModels().map((m) => {
      const arrival = +mval(m, 'town_arrival_at') * 1000 || 0, cured = +mval(m, 'cured_at') * 1000 || 0;
      const assign = mval(m, 'assignment_type'), away = mval(m, 'current_units_id') == null && assign === 'town' && !(arrival > now);
      const why = arrival > now ? `llega en ${fmtDur(arrival - now)}` : cured > now ? `herido ${fmtDur(cured - now)}` : away ? 'fuera con tropas' : '';
      return { id: heroIdOf(m), town: heroTownOf(m), level: +mval(m, 'level') || null, assign, available: !why, why };
    }).filter((h) => h.id && h.town === +townId && (!h.assign || h.assign === 'town'));
    return all ? list : list.filter((h) => h.available);
  }
  const heroName = (id) => UW.GameData?.heroes?.[id]?.name || String(id).replace(/_/g, ' ');
  // Hechizos para lanzar sobre TU orden al enviarla (como en la ventana de ataque):
  // poderes de dios con objetivo "orden" que no son negativos (los negativos se lanzan
  // sobre órdenes enemigas), menos Sabiduría (espía una tropa enemiga) y Purificación.
  // De todos los dioses que tienes (el favor es por dios, no por ciudad).
  const ATK_SPELL_EXCLUDE = new Set(['wisdom', 'cleanse']);
  function playerGods() {
    try { return Object.keys(Object.values(UW.MM.getModels().PlayerGods || {})[0]?.attributes?.production_overview || {}); } catch { return []; }
  }
  function attackSpells(type) {
    const need = type === 'support' ? 'target_support_command' : 'target_command';
    const gods = new Set(playerGods());
    const order = Object.keys(UW.GameData?.gods || {});
    return Object.entries(UW.GameData?.powers || {})
      .filter(([k, d]) => d && typeof d.name === 'string' && gods.has(d.god_id) && !d.negative && !d.is_fake_power && !ATK_SPELL_EXCLUDE.has(k) && [].concat(d.targets || []).includes(need))
      .map(([k, d]) => ({ id: k, name: d.name, cost: +d.favor || 0, god: d.god_id, effect: String(d.short_effect || d.effect || '') }))
      .sort((a, b) => (order.indexOf(a.god) - order.indexOf(b.god)) || a.cost - b.cost);
  }
  function powerList() {
    const out = new Map();
    for (const src of [UW.GameData?.powers, UW.GameData?.god_powers].filter(Boolean)) {
      for (const [k, d] of Object.entries(src)) if (!out.has(k) && d && typeof d === 'object' && typeof d.name === 'string') out.set(k, { id: k, name: d.name, cost: +(d.favor || d.favor_cost) || 0 });
    }
    return [...out.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
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

  /* Duración del viaje: la calcula el MISMO código del juego que usa la ventana de ataque
     (módulo "helpers/runtime", getSlowestRuntimeByDistance), pero con la ciudad de ORIGEN
     (el juego usa siempre la ciudad abierta). Así entran todas sus reglas:
       · si hay barcos, solo cuentan los barcos (las tropas de tierra y voladoras van con
         ellos), aunque sea la misma isla; el héroe cuenta siempre;
       · Sirenas: +2 % de velocidad a los barcos por cada una (máx. +100 %);
       · bonus de la ciudad (Meteorología, Cartografía…), de hechizos y del héroe;
       · tiempo = floor(distancia × 50 / velocidad) + preparación (900 s / velocidad del mundo, mín. 60).
     Comprobado contra lo que devuelve el servidor (town_info?action=attack): coincide al
     segundo tropa a tropa. Si el módulo no está, se calcula igual a mano. */
  function gameRuntimeHelper() { try { return UW.require?.('helpers/runtime') || null; } catch { return null; } }
  function travelFromInfo(info, units, heroId, sourceId) {
    const sel = {};
    for (const [k, n] of Object.entries(units || {})) if (+n > 0 && UW.GameData?.units?.[k]) sel[k] = Math.floor(+n);
    if (!Object.keys(sel).length) return { error: 'Elige al menos una tropa.' };
    const ground = Object.keys(sel).filter((k) => !U(k).is_naval && !isFlying(k));
    const naval = Object.keys(sel).filter((k) => U(k).is_naval);
    if (!info.same_island && ground.length && !naval.length) return { error: 'Otra isla: las tropas de tierra necesitan barcos de transporte.' };
    const dist = +info.distance;
    const R = gameRuntimeHelper();
    const town = (() => { try { return UW.ITowns?.getTown?.(+(sourceId || UW.Game?.townId)) || null; } catch { return null; } })();
    if (R && town && dist > 0) {
      try {
        const heroM = heroId ? heroModels().find((m) => heroIdOf(m) === String(heroId)) || null : null;
        const all = { ...sel };
        const rel = R.getRelevantUnitsForSlowestRuntime(all, heroM);
        const speeds = R.getUnitSpeedsWithBonus(rel, town, heroM);
        const rt = R.getUnitRuntimes(all, dist, speeds);
        const setup = +R.getSetupTimeByType() || 0;
        let slow = null, max = 0;
        for (const k of Object.keys(rel)) if (Number.isFinite(rt[k]) && rt[k] + setup > max) { max = rt[k] + setup; slow = GameData_isHero(k) ? 'hero' : k; }
        if (max > 0) return { ms: max * 1000, slow, how: 'juego' };
      } catch (e) { console.warn('[NOVABOT][ataques] cálculo del juego falló, uso el propio:', e); }
    }
    // Respaldo: duración por tropa del servidor + las mismas reglas.
    const dur = (k) => +info.units?.[k]?.duration || 0;
    const counted = naval.length ? naval : Object.keys(sel);
    const sirens = +sel.siren || 0;
    const setupS = Math.max(60, 900 / (+UW.Game?.game_speed || 1));
    let slow = null, max = 0;
    for (const k of counted) {
      let d = dur(k);
      if (sirens && U(k).is_naval && d > setupS) d = Math.floor((d - setupS) / (1 + Math.min(0.02 * sirens, 1))) + setupS;
      if (d > max) { max = d; slow = k; }
    }
    if (heroId) { const h = +info.heroes_durations?.[heroId]?.duration || 0; if (h > max) { max = h; slow = 'hero'; } }
    if (!max) return { error: 'El juego no devolvió la duración de esas tropas.' };
    return { ms: max * 1000, slow, how: 'servidor' };
  }
  const GameData_isHero = (k) => !!UW.GameData?.heroes?.[k];

  // Hace falta transporte si hay tropa de tierra y o bien es otra isla o bien van barcos
  // (en el juego, con barcos la tropa de tierra siempre va embarcada).
  const needsTransport = (info, units) => {
    const ks = Object.keys(units || {}).filter((k) => +units[k] > 0);
    const ground = ks.some((k) => UW.GameData?.units?.[k] && !U(k).is_naval && !isFlying(k));
    return ground && (!info?.same_island || ks.some((k) => U(k).is_naval));
  };
  function transportCheck(sourceId, info, units) {
    if (!needsTransport(info, units)) return null;
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

  /* Otra isla: la tropa de tierra que no cabe en los barcos que salen se deja en la
     ciudad, a partes iguales (el mismo % de cada tipo), hasta que quepa.
     Hueco de cada barco = capacidad del juego (Bote de transporte 26, Bote rápido 10)
     + Literas (info.researches.berth: +6 por barco si está investigada). Cada tropa
     ocupa su población; las voladoras y el héroe no ocupan. */
  function fitToShips(units, info) {
    const none = { units, left: {}, cap: 0, need: 0 };
    if (!info || !needsTransport(info, units)) return none;
    const berth = +info.researches?.berth || 0;
    const pop = (k) => +U(k).population || 1;
    let cap = 0, need = 0;
    const ground = [];
    for (const [k, n] of Object.entries(units)) {
      if (!(+n > 0)) continue;
      if (U(k).is_naval) { if (isTransport(k)) cap += (+U(k).capacity + berth) * n; }
      else if (!isFlying(k)) { need += pop(k) * n; ground.push(k); }
    }
    if (need <= cap) return { ...none, cap, need };
    const out = { ...units }, left = {};
    const f = cap / need;
    let used = 0;
    for (const k of ground) { out[k] = Math.floor(units[k] * f); used += out[k] * pop(k); }
    // El hueco que queda se rellena una a una con la tropa que más se ha quedado por debajo de su parte.
    for (;;) {
      const k = ground.filter((x) => out[x] < units[x] && used + pop(x) <= cap).sort((a, b) => out[a] / units[a] - out[b] / units[b])[0];
      if (!k) break;
      out[k] += 1; used += pop(k);
    }
    for (const k of ground) { if (out[k] < units[k]) left[k] = units[k] - out[k]; if (!out[k]) delete out[k]; }
    return { units: out, left, cap, need };
  }

  // Avisos de Grepolis para un plan concreto.
  function atkWarnings(item, info, arrivalAt) {
    const w = [];
    const type = item.type;
    const own = item.target != null && allTownIds().includes(+item.target);
    if (own && type !== 'support') w.push({ lvl: 'warn', txt: 'Es una ciudad TUYA: sirve para probar, pero el juego puede rechazar el ataque.' });
    else if (type !== 'support' && info.same_alliance) w.push({ lvl: 'danger', txt: 'El objetivo es de TU ALIANZA.' });
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
    if (tr && !tr.ok) w.push({ lvl: 'danger', fix: 'transport', txt: `No caben en los barcos: hueco ${tr.have} para ${tr.need} de población.${item.onMissing === 'skip'
      ? ' Así, al salir NO se enviará (configurado para no enviar si faltan tropas).'
      : ' Así, al salir se dejará en la ciudad tropa de tierra (el mismo % de cada una) hasta que quepa.'}` });
    // Tropas que aún no hay en la ciudad (ataque futuro).
    const notYet = Object.entries(item.units).filter(([k, n]) => +n > (+info.units?.[k]?.count || 0));
    if (notYet.length) w.push({ lvl: 'info', txt: `Aún no tienes todas: ${notYet.map(([k, n]) => `${atkUnitName(k)} ${+info.units?.[k]?.count || 0}/${n}`).join(', ')}. Al salir se ${item.onMissing === 'skip' ? 'cancelará si siguen faltando' : 'enviará lo que haya'}.` });
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
  function atkLoad() { try { atk.queue = JSON.parse(localStorage.getItem(acctKey(ATK_KEY)) || '[]'); } catch { atk.queue = []; } }
  function atkSave() {
    // (los campos "_" son de esta sesión: precarga, armado… no se guardan)
    try { localStorage.setItem(acctKey(ATK_KEY), JSON.stringify(atk.queue.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_')))))); } catch {}
    try { cloudMarkDirty(); } catch {}
  }
  const atkCorrection = () => clamp(+state.ataques?.correctionMs || 0, -1500, 1500);

  function buildPayload(a, info) {
    const p = { id: +a.target, type: a.type, nl_init: true };
    const used = {}, missing = [];
    let total = 0;
    // Tren desde la misma ciudad: las tropas de los envíos anteriores aún sin salir
    // no están disponibles para este (si no, se pediría de más y el juego lo rechaza).
    const before = {};
    for (const o of atk.queue) {
      if (o === a || +o.source !== +a.source || !['pending', 'sending'].includes(o.status) || o.executeAt > a.executeAt) continue;
      if (o.executeAt === a.executeAt && String(o.id) > String(a.id)) continue;
      for (const [k, v] of Object.entries(o.units || {})) before[k] = (before[k] || 0) + Math.max(0, Math.floor(+v || 0));
    }
    for (const [k, v] of Object.entries(a.units)) {
      const req = Math.max(0, Math.floor(+v || 0)); if (!req) continue;
      const have = Math.max(0, Math.floor(+info?.units?.[k]?.count || 0) - (before[k] || 0));
      const n = Math.min(req, have);
      if (n > 0) { p[k] = n; used[k] = n; total += n; }
      if (n < req) missing.push(`${atkUnitName(k)} ${n}/${req}`);
    }
    if (!total) throw new Error('No queda ninguna de las tropas elegidas en la ciudad.');
    if (missing.length && a.onMissing === 'skip') throw new Error(`Faltan tropas (${missing.join(', ')}); configurado para no enviar.`);
    // Otra isla: lo que no cabe en los barcos que salen se queda (mismo % de cada tropa).
    const fit = fitToShips(used, info);
    const left = Object.entries(fit.left).map(([k, n]) => `${n} ${atkUnitName(k)}`);
    if (left.length) {
      if (a.onMissing === 'skip') throw new Error(`No caben en los barcos (hueco ${fit.cap} para ${fit.need}); configurado para no enviar.`);
      for (const k of Object.keys(fit.left)) { if (fit.units[k]) { p[k] = fit.units[k]; used[k] = fit.units[k]; } else { delete p[k]; delete used[k]; } }
      if (!Object.values(used).some((n) => n > 0)) throw new Error(`Ninguna tropa de tierra cabe en los barcos (hueco ${fit.cap}).`);
    }
    if (a.type === 'attack' && a.strategy) p.attacking_strategy = [a.strategy];
    if (a.spell) p.power_id = a.spell;
    if (a.hero && heroesIn(a.source).some((h) => h.id === String(a.hero))) p.heroes = a.hero;
    return { payload: p, used, missing, left };
  }

  // Llegada real que devuelve el juego (arrival_at en las notificaciones).
  function arrivalFromResponse(res, expectedMs) {
    let txt = ''; try { txt = JSON.stringify(res); } catch {}
    const vals = [...txt.matchAll(/arrival_at\\*"?\s*:\s*\\*"?(\d{10})/g)].map((m) => +m[1] * 1000);
    if (!vals.length) return null;
    vals.sort((a, b) => Math.abs(a - expectedMs) - Math.abs(b - expectedMs));
    return Math.abs(vals[0] - expectedMs) < 6 * 3600000 ? vals[0] : null;
  }

  // Id de la orden creada (para poder cancelarla): el objeto de la respuesta que
  // trae esa llegada y su command_id / id.
  function commandIdFromResponse(res, arrivalMs) {
    let txt = ''; try { txt = JSON.stringify(res).replace(/\\/g, ''); } catch {}
    const want = Math.round(arrivalMs / 1000);
    for (const m of txt.matchAll(/\{[^{}]*"arrival_at"\s*:\s*"?(\d{10})"?[^{}]*\}/g)) {
      if (Math.abs(+m[1] - want) > 1) continue;
      const id = /"command_id"\s*:\s*"?(\d+)/.exec(m[0]) || /"id"\s*:\s*"?(\d+)/.exec(m[0]);
      if (id) return +id[1];
    }
    return null;
  }
  // Orden recién enviada, buscada en los movimientos del juego (por si la respuesta no trae su id).
  async function findSentCommand(a, arrivalMs) {
    for (let i = 0; i < 4; i++) {
      try {
        const list = [].concat(UW.MM.getCollections()?.MovementsUnits || []).flatMap((c) => c?.models || []).map((m) => m.attributes);
        const hit = list.filter((m) => +m.home_town_id === +a.source && +m.target_town_id === +a.target && m.command_id && (!arrivalMs || Math.abs(+m.arrival_at * 1000 - arrivalMs) <= 1500))
          .sort((x, y) => +y.started_at - +x.started_at)[0];
        if (hit) return +hit.command_id;
      } catch {}
      await sleep(700);
    }
    return null;
  }
  /* Hechizo sobre una orden YA enviada (como «Lanzar poder divino» en la ventana de la
     orden). Leído del juego (spells_dialog_command.castSpell):
       POST frontend_bridge?action=execute {model_url:"Commands", action_name:"cast",
            arguments:{ id:<command_id>, power_id }} */
  async function castSpellOnCommand(a, cmdId) {
    await gpPostAs(a.source, 'frontend_bridge', 'execute', { model_url: 'Commands', action_name: 'cast', captcha: null, arguments: { id: +cmdId, power_id: a.spell }, nl_init: true });
  }

  // Último momento (hora del servidor) en que aún tiene sentido enviar.
  const atkLastSend = (a) => (a.windowEnd ? a.windowEnd + 999 - a.duration : a.executeAt + ATK_MISS_TOLERANCE_MS);

  async function atkFire(a) {
    if (a.status !== 'pending') return;
    // El temporizador puede dispararse tarde (PC en reposo, pestaña congelada): no se envía tarde.
    const late = srvNow() - a.executeAt;
    if (srvNow() > atkLastSend(a)) {
      a.status = 'missed'; a.error = `No se envió: la hora de salida pasó hace ${fmtDur(late)} (¿página cerrada o PC en reposo?).`;
      atkLog(`${farmTownName(a.source)} → ${a.targetName}: perdido (no se envía tarde).`, 'error');
      delete a._pre; delete a._armed; atkSave(); atkRefreshQueue(); return;
    }
    a.status = 'sending'; atkRefreshQueue();
    const retry = !!a.windowEnd && (a.method === 'ultra' || a.method === 'human');
    const inWindow = (t) => a.accepted ? a.accepted.includes(Math.floor(t / 1000) * 1000) : (!a.windowEnd || (t >= a.wantAt && t < a.windowEnd + 1000));
    // Con reintentos el hechizo NO va con el envío (se perdería al cancelar): se lanza sobre
    // la orden que se queda, en cuanto el bot sabe que ya no la va a cancelar.
    const lateSpell = retry && !!a.spell;
    a.attempts = 0;
    try {
      for (;;) {
        a.attempts += 1;
        let pre = a.attempts === 1 ? a._pre : null;
        if (!pre || Date.now() - pre.at > 20000) {
          const info = await attackInfo(a.source, a.target, 0);
          pre = { at: Date.now(), ...buildPayload(a, info) };
        }
        const sentLocal = Date.now();
        const payload = { ...pre.payload };
        if (lateSpell) delete payload.power_id;
        const res = await gpPostAs(a.source, 'town_info', 'send_units', payload);
        const expected = a.executeAt + a.duration;
        const real = arrivalFromResponse(res, expected);
        if (!retry || !real || inWindow(real)) {
          a.status = 'sent'; a.sentAt = srvNow();
          const less = [pre.missing.length ? `faltaban ${pre.missing.join(', ')}` : '', pre.left?.length ? `sin sitio en los barcos se quedaron ${pre.left.join(', ')}` : ''].filter(Boolean);
          if (less.length) a.note = `Enviado con menos tropas: ${less.join(' · ')}`;
          if (real) {
            a.realArrival = real;
            const errS = Math.round((real - expected) / 1000);
            a.arrivalErr = a.windowEnd ? (inWindow(real) ? 0 : errS) : errS;
            // Auto-corrección (solo envío único y con el reloj bien sincronizado).
            if (!retry && errS !== 0 && Math.abs(errS) <= 2 && clockOffset().err < 250) {
              state.ataques.correctionMs = clamp(atkCorrection() + (errS > 0 ? 250 : -250), -1500, 1500);
              saveState();
            }
          }
          if (lateSpell) {
            // Ya no se cancela: ahora sí, el hechizo.
            const spellName = UW.GameData?.powers?.[a.spell]?.name || a.spell;
            try {
              const cmd = (real && commandIdFromResponse(res, real)) || await findSentCommand(a, real);
              if (!cmd) throw new Error('no se encontró la orden enviada');
              await castSpellOnCommand(a, cmd);
              a.spellCast = true;
              atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${spellName} lanzado sobre la orden.`, 'ok');
            } catch (e) {
              a.note = [a.note, `No se pudo lanzar ${spellName}: ${e.message}`].filter(Boolean).join(' · ');
              atkLog(`${farmTownName(a.source)} → ${a.targetName}: no se pudo lanzar ${spellName} (${e.message}).`, 'error');
            }
          }
          const tries = a.attempts > 1 ? ` · ${a.attempts} intentos` : '';
          atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${a.type === 'support' ? 'apoyo' : 'ataque'} enviado${real ? ` · llega ${fmtClock(real)}${a.windowEnd ? (inWindow(real) ? ` ✓ ${a.accepted ? 'hora aceptada' : 'dentro del rango'}` : ` (${a.accepted ? 'no es una hora aceptada' : 'fuera del rango'})`) : a.arrivalErr ? ` (${a.arrivalErr > 0 ? '+' : ''}${a.arrivalErr} s)` : ' ✓ exacto'}` : ''}${tries}.`, 'ok');
          break;
        }
        // Fuera del rango: cancelar y reintentar si aún da tiempo.
        const cmd = commandIdFromResponse(res, real);
        if (!cmd) {
          a.status = 'sent'; a.sentAt = srvNow(); a.realArrival = real;
          a.note = 'Llegada fuera del rango y no se pudo identificar la orden para cancelarla.';
          atkLog(`${farmTownName(a.source)} → ${a.targetName}: llega ${fmtClock(real)}, fuera del rango (no se pudo cancelar).`, 'error');
          break;
        }
        await gpPostAs(a.source, 'command_info', 'cancel_command', { id: cmd });
        const away = Date.now() - sentLocal; // las tropas tardan lo mismo en volver
        atkLog(`${farmTownName(a.source)} → ${a.targetName}: intento ${a.attempts} llegaba ${fmtClock(real)} → cancelado.`, 'info');
        if (real >= a.windowEnd + 1000) throw new Error(`Llegaba ${fmtClock(real)}, después ${a.accepted ? 'de la última hora aceptada' : 'del rango'}: ya no se puede acertar.`);
        if (a.attempts >= 60) throw new Error('Demasiados intentos sin acertar el rango.');
        let wait = away + 300 + (a.method === 'human' ? 1000 + Math.random() * 1500 : 100 + Math.random() * 200);
        // Apuntar a la primera hora aceptada que aún se pueda alcanzar (con lista, saltando
        // los segundos que no quieres); si llegaba antes del rango, esperar a ese momento.
        let goal = a.wantAt;
        if (a.accepted) {
          const earliest = srvNow() + wait + a.duration;
          goal = a.accepted.find((x) => x + 999 >= earliest);
          if (!goal) throw new Error('Ya no da tiempo a acertar ninguna de las horas aceptadas.');
        }
        const ideal = goal - a.duration + ATK_INTO_SECOND_MS - clockOffset().off - latencyOneWay();
        wait = Math.max(wait, ideal - Date.now());
        if (srvNow() + wait > atkLastSend(a)) throw new Error('Ya no da tiempo a acertar el rango.');
        atkRefreshQueue();
        await sleep(wait);
      }
    } catch (e) {
      a.status = /configurado para no enviar/.test(e.message) ? 'skipped' : 'error';
      a.error = e.message;
      atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${e.message}`, 'error');
    }
    delete a._pre; delete a._armed;
    atkSave(); atkRefreshQueue();
  }

  // ~35 s antes: se mira qué va a salir DE VERDAD (lo que haya, lo que quepa en los barcos,
  // el héroe si está) y con eso se recalcula el viaje, para que la llegada siga siendo exacta
  // aunque falte justo la tropa más lenta. Si algo no va a salir bien, se avisa en la orden.
  async function atkRecheck(a) {
    try {
      const info = await attackInfo(a.source, a.target, 0);
      let units = a.units, hero = a.hero, warn = '';
      try {
        const pre = buildPayload(a, info);
        units = pre.used; hero = pre.payload.heroes || '';
        warn = [pre.missing.length ? `faltan ${pre.missing.join(', ')}` : '', pre.left.length ? `no caben en los barcos ${pre.left.join(', ')}` : '', a.hero && !hero ? 'el héroe no está' : ''].filter(Boolean).join(' · ');
      } catch (e) { warn = e.message; }
      if (warn) { a.note = `Al salir: ${warn}`; atkLog(`${farmTownName(a.source)} → ${a.targetName}: ${warn}.`, 'error'); }
      const t = travelFromInfo(info, units, hero, a.source);
      if (t.error) { atkSave(); return; }
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
      if (now > atkLastSend(a)) {
        a.status = 'missed'; a.error = `No se envió: la hora de salida pasó hace ${fmtDur(-left)} (¿página cerrada o PC en reposo?).`;
        atkLog(`${farmTownName(a.source)} → ${a.targetName}: perdido (no se envía tarde).`, 'error');
        atkSave(); atkRefreshQueue(); continue;
      }
      if (!a._rechecked && left < ATK_RECHECK_MS && left > ATK_PREFETCH_MS) {
        a._rechecked = true; atkRecheck(a);
      }
      // Precarga (como mucho un intento cada 2 s: si falla no se inunda al servidor).
      if (!a._pre && !a._prefetching && left < ATK_PREFETCH_MS && left > 400 && Date.now() - (a._prefetchAt || 0) > 2000) {
        a._prefetching = true; a._prefetchAt = Date.now();
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


  /* ---------- botón «Atacar con bot» dentro de la ventana de ataque del juego ----------
     La ventana de ataque/apoyo del juego (WndHandlerAttack) ya tiene todo: las tropas
     que has escrito (getSelectedUnits), el héroe (casilla cbx_include_hero), el hechizo
     elegido (#spells_1 → data "attack"), el tipo y la estrategia (.attack_type/.attack_strategy
     .checked) y la respuesta de town_info?action=attack (handler.data: duraciones de cada
     tropa, isla, moral…), que es la MISMA que usa el bot. Con eso se rellena el formulario
     de Ataques y se ve al momento cuánto tarda ese ejército. */
  function isAttackHandler(h) { return !!h && typeof h.getSelectedUnits === 'function' && !!h.data && h.data.target_id != null; }
  function hookGameAttackWindows() {
    const W = UW.GPWindowMgr;
    if (!W?.getOpenedWindows) return;
    let list = [];
    try { list = W.getOpenedWindows() || []; } catch { return; }
    for (const w of list) {
      let h = null; try { h = w.getHandler?.(); } catch {}
      if (!isAttackHandler(h)) continue;
      let root = null; try { root = w.getJQElement?.()?.[0]; } catch {}
      if (!root) continue;
      const wrap = root.querySelector('#btn_attack_town')?.parentElement || root.querySelector('.button_wrapper');
      if (!wrap || wrap.querySelector('.nb-ingame-atk')) continue;
      const support = h.data.type === 'support';
      const b = document.createElement('div');
      b.className = 'nb-ingame-atk';
      b.textContent = support ? 'Apoyar con bot' : 'Atacar con bot';
      b.title = 'Abre NOVABOT con estas tropas, héroe y hechizo para programar la hora exacta';
      b.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-left:6px;padding:0 12px;height:23px;line-height:23px;vertical-align:top;cursor:pointer;border-radius:4px;font:bold 12px Verdana,Arial,sans-serif;color:#2b1a05;background:linear-gradient(#f3d27a,#c9973a);border:1px solid #7a5418;box-shadow:inset 0 1px 0 rgba(255,255,255,.5);white-space:nowrap;user-select:none;';
      b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.08)'; });
      b.addEventListener('mouseleave', () => { b.style.filter = ''; });
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { attackFromGameWindow(w, h); } catch (err) { console.warn('[NOVABOT][ataques]', err); atkLog(`No se pudo leer la ventana del juego: ${err.message}`, 'error'); }
      });
      wrap.appendChild(b);
    }
  }
  function attackFromGameWindow(w, h) {
    const $e = w.getJQElement();
    const units = {};
    for (const [k, n] of Object.entries(h.getSelectedUnits() || {})) if (+n > 0 && k !== 'heroes' && k !== 'town_id') units[k] = Math.floor(+n);
    let hero = '';
    try { const cb = UW.CM?.get?.(w.getContext(), 'cbx_include_hero'); if (cb?.isChecked?.()) { const m = h.getHeroInTheTown?.(); if (m) hero = String(m.getId?.() ?? ''); } } catch {}
    let spell = '';
    try { const v = $e.find('#spells_1').data('attack'); if (v && v !== 'no_power') spell = String(v); } catch {}
    let type = h.data.type || 'attack';
    try { const v = $e.find('.attack_type.checked').data('attack'); if (v) type = String(v); } catch {}
    let strategy = '';
    try { const v = $e.find('.attack_strategy.checked').first().data('attack'); if (v) strategy = String(v); } catch {}
    const source = +h.origin_town_id || +UW.Game?.townId;
    const tid = +h.data.target_id;
    let title = ''; try { title = String(w.getTitle?.() || ''); } catch {}
    const target = atk.worldById.get(tid) || { id: tid, name: title || `Ciudad #${tid}`, player: '', ally: '', points: 0 };
    const f = atk.form;
    Object.assign(f, { source, target, units, hero, spell, type, search: '', replaceId: null, infoError: '', infoLoading: false });
    if (strategy) f.strategy = strategy;
    // La respuesta del juego es la misma que pide el bot: se usa tal cual (sin volver a pedirla).
    f.infoKey = `${source}>${tid}`; f.info = h.data;
    atk.infoCache.set(f.infoKey, { at: Date.now(), info: h.data });
    atk.view = 'new';
    state.activeTab = 'ataques'; saveState();
    if (!state.open) setOpen(true);
    try { buildTabs(); } catch {}
    renderBody();
    const t = travelFromInfo(h.data, units, hero, source);
    // Comprobación con lo que muestra la propia ventana del juego ("Duración").
    try {
      const txt = String($e.find('span.way_duration').first().text() || '');
      const m = /(\d+):(\d{2}):(\d{2})/.exec(txt);
      if (m && t.ms) {
        const shown = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
        if (Math.abs(shown - t.ms) > 1000) atkLog(`Ojo: el juego muestra ${fmtDur(shown)} de viaje y el bot calcula ${fmtDur(t.ms)}. Revisa las tropas antes de programar.`, 'error');
      }
    } catch {}
    atkLog(`Desde el juego: ${farmTownName(source)} → ${target.name} · ${Object.entries(units).map(([k, n]) => `${n} ${atkUnitName(k)}`).join(', ') || 'sin tropas'}${hero ? ` · ${heroName(hero)}` : ''}${spell ? ` · ${UW.GameData?.powers?.[spell]?.name || spell}` : ''}${t.ms ? ` · viaje ${fmtDur(t.ms)}` : ''}. Elige la hora y programa.`, 'info');
    setTimeout(() => { try { TQ.step(5)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {} }, 80);
  }

  function startAttackEngine() {
    if (atk.started) return;
    atk.started = true;
    setInterval(() => { try { hookGameAttackWindows(); } catch {} }, 700);
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
    const order = { sending: 0, pending: 1, editing: 1, error: 2, missed: 2, skipped: 3, sent: 4 };
    const list = atk.queue.slice().sort((a, b) => (order[a.status] - order[b.status]) || (a.status === 'sent' ? b.executeAt - a.executeAt : a.executeAt - b.executeAt));
    if (!list.length) { atkQueueEl.appendChild(el('p', { class: 'nb-placeholder' }, 'No hay nada programado.')); return; }
    const label = { pending: 'programado', editing: 'en edición', sending: 'enviando…', sent: 'enviado', error: 'error', missed: 'perdido', skipped: 'no enviado' };
    for (const a of list) {
      const units = Object.entries(a.units).map(([k, n]) => `${n} ${atkUnitName(k)}`).join(' · ');
      const actions = [];
      if (a.status === 'pending') {
        actions.push(el('span', { class: 'nb-mini', title: 'Duplicar llegando 1 s después (tren)', onclick: () => atkDuplicate(a) }, '+1s'));
        actions.push(el('span', { class: 'nb-mini', title: 'Editar', onclick: () => atkEdit(a) }, '✎'));
        actions.push(el('span', { class: 'nb-mini nb-mini-danger', title: 'Cancelar', onclick: () => { atkTimerClear(a.id); atk.queue = atk.queue.filter((x) => x !== a); atkSave(); atkRefreshQueue(); } }, '✕'));
      } else if (a.status === 'editing') {
        actions.push(el('span', { class: 'nb-mini', title: 'Reanudar sin cambios', onclick: () => { a.status = 'pending'; if (atk.form.replaceId === a.id) atk.form.replaceId = null; atkSave(); atkRefreshQueue(); } }, '▶'));
        actions.push(el('span', { class: 'nb-mini', title: 'Editar', onclick: () => atkEdit(a) }, '✎'));
        actions.push(el('span', { class: 'nb-mini nb-mini-danger', title: 'Cancelar', onclick: () => { atk.queue = atk.queue.filter((x) => x !== a); atkSave(); atkRefreshQueue(); } }, '✕'));
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
        el('div', { class: 'nb-goal-sub nb-res-list', title: units }, [
          ...Object.entries(a.units).map(([k, n]) => el('span', { class: 'nb-res' }, [unitIcon(k, 25), String(n)])),
          a.hero ? el('span', { class: 'nb-res', title: heroName(a.hero) }, [heroIcon(a.hero), heroName(a.hero)]) : null,
          a.spell ? el('span', { class: 'nb-res' }, [el('span', { class: `nb-icon nb-icon-25 power_icon30x30 ${a.spell}` }), 'hechizo']) : null
        ]),
        a.windowEnd ? el('div', { class: 'nb-goal-sub' }, `Acepta: ${a.accepted ? acceptSummary(a.accepted) : `${fmtClock(a.wantAt)} – ${fmtClock(a.windowEnd)}`} · ${({ exact: 'preciso', ultra: 'ultra', human: 'humano' })[a.method] || 'preciso'}`) : null,
        a.error ? el('div', { class: 'nb-goal-sub nb-err' }, a.error) : a.note ? el('div', { class: 'nb-goal-sub' }, a.note) : null,
        el('div', { class: 'nb-atk-actions' }, actions)
      ]));
    }
    atkUpdateLive();
  }

  // [t, t+1, t+2, t+5] → "22:00:01–22:00:03, 22:00:06"
  function acceptSummary(list) {
    const out = [];
    for (let i = 0; i < list.length;) {
      let j = i; while (j + 1 < list.length && list[j + 1] - list[j] === 1000) j++;
      out.push(j > i ? `${fmtClock(list[i])}–${fmtClock(list[j])}` : fmtClock(list[i]));
      i = j + 1;
    }
    return out.join(', ');
  }

  function atkEdit(a) {
    const f = atk.form;
    Object.assign(f, {
      source: a.source, target: atk.worldById.get(a.target) || { id: a.target, name: a.targetName, player: '', ally: '', points: 0 },
      units: { ...a.units }, hero: a.hero || '', spell: a.spell || '', type: a.type, strategy: a.strategy || '',
      mode: a.mode, time: fmtClock(a.wantAt), onMissing: a.onMissing || 'partial', future: !!a.future, info: null, replaceId: a.id,
      until: a.windowEnd && a.rangeKind !== 'list' ? fmtClock(a.windowEnd) : '', method: a.method || 'exact',
      rangeKind: a.rangeKind === 'list' ? 'list' : 'range', accept: a.acceptText || (a.accepted ? a.accepted.map((x) => fmtClock(x)).join(', ') : '')
    });
    // No se borra: queda "en edición" (no sale) hasta que guardes el cambio; si
    // sales del formulario sin guardar, se puede reanudar desde la lista.
    atkTimerClear(a.id);
    if (a.status === 'pending') { a.status = 'editing'; delete a._pre; delete a._armed; }
    atkSave();
    atk.view = 'new';
    renderBody();
    atkLoadInfo();
  }

  function atkDuplicate(a) {
    const b = { ...a, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, status: 'pending', note: '', error: '' };
    delete b._pre; delete b._armed; delete b._rechecked; delete b.realArrival; delete b.arrivalErr;
    b.wantAt = a.wantAt + 1000; b.executeAt = a.executeAt + 1000; b.arrivalAt = a.arrivalAt + 1000;
    if (a.windowEnd) b.windowEnd = a.windowEnd + 1000;
    if (a.accepted) { b.accepted = a.accepted.map((x) => x + 1000); b.acceptText = b.accepted.map((x) => fmtClock(x)).join(', '); }
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

  // "22:00:01, 22:00:03-22:00:05 22:00:09" → segundos del día aceptados (en el orden escrito).
  // Un rango se expande segundo a segundo (máx. 1 h).
  function parseAcceptList(txt) {
    const toSec = (v) => { const n = normTime(v); const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(n); return m && +m[1] < 24 && +m[2] < 60 && +m[3] < 60 ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
    const out = [], bad = [];
    for (const part of String(txt || '').replace(/\s*[-–]\s*/g, '-').split(/[,;\s]+/).filter(Boolean)) {
      const [a, b] = part.split(/\s*[-–]\s*/);
      const x = toSec(a), y = b !== undefined ? toSec(b) : x;
      if (x === null || y === null) { bad.push(part); continue; }
      const len = ((y - x + 86400) % 86400);
      if (len > 3600) { bad.push(part); continue; }
      for (let i = 0; i <= len; i++) out.push((x + i) % 86400);
    }
    return { secs: [...new Set(out)], bad };
  }
  const secToHms = (n) => `${two(Math.floor(n / 3600))}:${two(Math.floor(n % 3600 / 60))}:${two(n % 60)}`;

  function atkComputePlan() {
    const f = atk.form;
    if (!f.info) return null;
    const t = travelFromInfo(f.info, f.units, f.hero, f.source);
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
    // Fin del rango (solo al fijar la llegada): la misma hora o una posterior.
    let windowEnd = null, accepted = null;
    const u = normTime(f.until || '');
    if (f.mode === 'arrival' && f.rangeKind === 'list') {
      // Horas aceptadas puestas a mano: la primera que aún se pueda alcanzar manda.
      const { secs, bad } = parseAcceptList(f.accept);
      if (bad.length) note = [note, `No entiendo: ${bad.join(', ')}`].filter(Boolean).join(' · ');
      if (secs.length) {
        const base = now + t.ms + 1500;
        const first = Math.min(...secs.map((x) => nextWallTime(secToHms(x), base)));
        const list = secs.map((x) => nextWallTime(secToHms(x), first - 1000)).filter((x) => x - first <= 3600000).sort((a, b) => a - b);
        const dropped = secs.length - list.length;
        if (dropped) note = [note, `${dropped} hora(s) ya no alcanzables o a más de 1 h de la primera: se ignoran.`].filter(Boolean).join(' · ');
        accepted = list; wantAt = list[0]; windowEnd = list[list.length - 1];
        executeAt = wantAt - t.ms; arrivalAt = wantAt;
      }
    } else if (f.mode === 'arrival' && wantAt && /^\d{2}:\d{2}:\d{2}$/.test(u)) {
      windowEnd = nextWallTime(u, wantAt - 1000);
      if (windowEnd - wantAt > 3600000) windowEnd = null; // rango absurdo (> 1 h): se ignora
    }
    return { ms: t.ms, slow: t.slow, executeAt, arrivalAt, wantAt, windowEnd, accepted, note };
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
    const draft = { id: null, source: f.source, target: f.target?.id, type: f.type, units: f.units, executeAt: plan.executeAt, onMissing: f.onMissing };
    for (const w of atkWarnings(draft, f.info, plan.arrivalAt)) {
      const box = el('div', { class: `nb-alert nb-alert-${w.lvl}` }, w.txt);
      if (w.fix === 'transport') box.appendChild(el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { f.units = addNeededTransports(f.source, f.info, f.units); renderBody(); } }, 'Añadir barcos'));
      atkPlanEl.appendChild(box);
    }
  }

  async function atkSubmit() {
    const f = atk.form;
    if (!f.target) throw new Error('Elige un objetivo.');
    const info = await attackInfo(f.source, f.target.id, 0);
    f.info = info;
    const plan = atkComputePlan();
    if (!plan || plan.error) throw new Error(plan?.error || 'Plan no válido.');
    if (!plan.executeAt) throw new Error(f.mode === 'arrival' && f.rangeKind === 'list' ? 'Pon al menos una hora aceptada válida (HH:MM:SS).' : 'Pon una hora válida (HH:MM:SS).');
    const units = Object.fromEntries(Object.entries(f.units).filter(([, n]) => +n > 0).map(([k, n]) => [k, Math.floor(+n)]));
    if (!f.future) for (const [k, n] of Object.entries(units)) if (n > (+info.units?.[k]?.count || 0)) throw new Error(`Solo hay ${+info.units?.[k]?.count || 0} ${atkUnitName(k)} en la ciudad (activa «Tropas que aún no tengo» para un ataque futuro).`);
    const item = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, source: +f.source, target: +f.target.id,
      targetName: f.target.name + (f.target.player ? ` (${f.target.player})` : ''), type: f.type, strategy: f.strategy,
      units, hero: f.hero, spell: f.spell, mode: f.mode, wantAt: plan.wantAt, duration: plan.ms,
      windowEnd: plan.windowEnd || null, method: plan.windowEnd ? (f.method || 'exact') : 'exact',
      accepted: plan.accepted && plan.accepted.length > 1 ? plan.accepted : null, rangeKind: f.rangeKind === 'list' ? 'list' : 'range', acceptText: f.accept || '',
      executeAt: plan.executeAt, arrivalAt: plan.arrivalAt, onMissing: f.onMissing, status: 'pending', future: !!f.future,
      note: plan.note || '', error: '', createdAt: Date.now()
    };
    const danger = atkWarnings(item, info, plan.arrivalAt).filter((w) => w.lvl === 'danger');
    if (danger.length && !confirm(`Atención:\n· ${danger.map((w) => w.txt).join('\n· ')}\n\n¿Programar igualmente?`)) return;
    if (f.replaceId) {
      const old = atk.queue.find((x) => x.id === f.replaceId);
      if (old && ['editing', 'missed', 'error', 'skipped'].includes(old.status)) { atkTimerClear(old.id); atk.queue = atk.queue.filter((x) => x !== old); }
      f.replaceId = null;
    }
    atk.queue.push(item); atkSave();
    atk.recent =[f.target, ...atk.recent.filter((t) => t.id !== f.target.id)].slice(0, 6);
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
    // Objetivo que llegó sin datos del mundo (p. ej. desde la ventana del juego): completarlo.
    if (f.target && !f.target.player && atk.worldLoaded) { const t = atk.worldById.get(+f.target.id); if (t) f.target = t; }

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
    else { try { Object.assign(counts, UW.ITowns.getTown(f.source)?.units?.() || {}); } catch {} } // solo las que están en la ciudad
    // Con «Tropas que aún no tengo»: todas las que el juego da con duración (aunque haya 0).
    const future = !!f.future && !!info;
    const rows = Object.entries(counts).filter(([k, n]) => (n > 0 || (future && +info.units?.[k]?.duration > 0) || +f.units[k] > 0) && k !== 'militia' && UW.GameData?.units?.[k])
      .sort(([a], [b]) => ((U(a).is_naval ? 1 : 0) - (U(b).is_naval ? 1 : 0)) || atkUnitName(a).localeCompare(atkUnitName(b), 'es'));
    const plan = info ? atkComputePlan() : null;
    const grid = el('div', { class: 'nb-units-grid' });
    for (const [k, n] of rows) {
      const cap = future ? 99999 : n;
      const input = el('input', { class: 'nb-input nb-input-inline', type: 'number', min: '0', max: String(cap), placeholder: '0', value: f.units[k] || '' });
      input.addEventListener('input', () => { f.units[k] = clamp(pos(input.value, 0), 0, cap); if (+input.value > cap) input.value = cap; atkPaintPlan(); markSlow(); });
      const d = +info?.units?.[k]?.duration;
      grid.appendChild(el('div', { class: `nb-unit-cell${plan?.slow === k ? ' nb-slow' : ''}`, 'data-unit': k, title: d ? `Viaje de ${atkUnitName(k)}: ${fmtDur(d * 1000)}` : atkUnitName(k) }, [
        unitIcon(k, 25),
        el('div', { class: 'nb-unit-info' }, [el('span', { class: 'nb-unit-name' }, atkUnitName(k)), el('span', { class: `nb-unit-sub${+f.units[k] > n ? ' nb-warn-txt' : ''}` }, `${future ? `tienes ${n}` : n}${d ? ` · ${fmtDur(d * 1000)}` : ''}`)]),
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
    // Selectores con imagen: héroes de la ciudad de origen y hechizos (uno solo).
    const chip = (active, icon, title, sub, onclick, disabled = false, tip = '') => el('div', { class: `nb-pick${active ? ' active' : ''}${disabled ? ' nb-pick-off' : ''}`, title: tip || null, onclick: disabled ? null : onclick }, [icon, el('div', { class: 'nb-pick-text' }, [el('b', {}, title), sub ? el('small', {}, sub) : null])]);
    const noneIcon = () => el('span', { class: 'nb-pick-none' }, '∅');
    const heroesAll = heroesIn(f.source, true);
    if (f.hero && !heroesAll.some((h) => h.id === f.hero && h.available)) f.hero = '';
    const heroSel = el('div', { class: 'nb-picks' }, [
      chip(!f.hero, noneIcon(), 'Sin héroe', null, () => { f.hero = ''; renderBody(); }),
      ...heroesAll.map((h) => chip(f.hero === h.id, el('span', { class: `nb-icon nb-icon-25 hero_icon hero25x25 ${h.id}` }), heroName(h.id),
        h.available ? (h.level ? `nivel ${h.level}` : null) : h.why, () => { f.hero = h.id; renderBody(); }, !h.available))
    ]);
    if (!heroesAll.length) heroSel.appendChild(el('span', { class: 'nb-placeholder' }, 'Ningún héroe en esta ciudad.'));
    const spells = attackSpells(f.type);
    if (f.spell && !spells.some((p) => p.id === f.spell)) f.spell = '';
    const spellSel = el('div', { class: 'nb-spells' }, [chip(!f.spell, noneIcon(), 'Sin hechizo', null, () => { f.spell = ''; renderBody(); })]);
    for (const god of [...new Set(spells.map((p) => p.god))]) {
      const fav = Math.floor(godFavor(god));
      spellSel.appendChild(el('div', { class: 'nb-spell-god' }, [
        el('div', { class: 'nb-spell-god-head' }, [el('span', { class: 'nb-god-ico' }, [el('span', { class: `god_micro ${god}`, style: 'display:block;width:30px;height:30px;transform:scale(.733);transform-origin:0 0' })]),
          el('b', {}, UW.GameData?.gods?.[god]?.name || god), el('small', {}, `${fav} favor`)]),
        el('div', { class: 'nb-picks' }, spells.filter((p) => p.god === god).map((p) => chip(f.spell === p.id,
          el('span', { class: `nb-icon nb-icon-30 power_icon30x30 ${p.id}` }), p.name, `${p.cost} favor${p.cost > fav ? ' · falta favor' : ''}`,
          () => { f.spell = f.spell === p.id ? '' : p.id; renderBody(); }, false, p.effect)))
      ]));
    }
    if (!spells.length) spellSel.appendChild(el('span', { class: 'nb-placeholder' }, 'No hay hechizos que se puedan lanzar sobre esta orden.'));

    const futureRow = optionRow('Tropas que aún no tengo', 'Ataque futuro: puedes pedir más de las que hay ahora (tú te aseguras de tenerlas). Al salir se envía lo que haya', !!f.future, (v) => { f.future = v; renderBody(); });
    const retryMode = f.mode === 'arrival' && (f.rangeKind === 'list' ? !!String(f.accept || '').trim() : !!normTime(f.until || '')) && (f.method === 'ultra' || f.method === 'human');
    const spellNote = f.spell && retryMode ? el('p', { class: 'nb-placeholder' }, 'Con Ultra/Humano el hechizo no va con el envío: se lanza sobre la orden en cuanto acierta el rango y ya no se va a cancelar (así no se pierde el favor en los intentos).') : null;

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

    // Rango de llegada + método de envío (solo con "Llegar a las")
    const untilIn = el('input', { class: 'nb-input nb-input-time', type: 'text', inputmode: 'numeric', placeholder: 'hasta (opcional)', value: f.until || '', maxlength: '8' });
    untilIn.addEventListener('input', () => { f.until = untilIn.value; atkPaintPlan(); });
    untilIn.addEventListener('blur', () => { const n = normTime(untilIn.value); if (untilIn.value && n !== untilIn.value) { untilIn.value = n; f.until = n; atkPaintPlan(); } });
    const methodSeg = el('div', { class: 'nb-seg nb-seg-sm' }, [
      ['exact', 'Preciso (1 envío)'], ['ultra', 'Ultra (envía y cancela rápido)'], ['human', 'Humano (reintenta cada 1-2 s)']
    ].map(([v, l]) => el('span', { class: `nb-seg-btn${(f.method || 'exact') === v ? ' active' : ''}`, onclick: () => { f.method = v; renderBody(); } }, l)));
    // Horas aceptadas a mano (lista): la primera pasa a ser la hora de arriba.
    const acceptIn = el('input', { class: 'nb-input', type: 'text', placeholder: '22:00:01, 22:00:03-22:00:05, 22:00:09', value: f.accept || '' });
    const syncFirst = () => {
      const { secs } = parseAcceptList(f.accept);
      if (!secs.length) return;
      const p = atkComputePlan();
      const first = p?.accepted?.[0] ? fmtClock(p.accepted[0]) : secToHms(secs[0]);
      if (first !== f.time) { f.time = first; timeIn.value = first; }
    };
    acceptIn.addEventListener('input', () => { f.accept = acceptIn.value; syncFirst(); atkPaintPlan(); });
    const kindSeg = el('div', { class: 'nb-seg nb-seg-sm' }, [['range', 'Rango (desde – hasta)'], ['list', 'Horas a mano']].map(([v, l]) =>
      el('span', { class: `nb-seg-btn${(f.rangeKind || 'range') === v ? ' active' : ''}`, onclick: () => { f.rangeKind = v; if (v === 'list') syncFirst(); renderBody(); } }, l)));
    const isList = f.rangeKind === 'list';
    const rangeBox = f.mode === 'arrival' ? el('div', { class: 'nb-range' }, [
      kindSeg,
      isList
        ? el('div', {}, [el('span', { class: 'nb-row-label' }, 'Horas de llegada aceptadas (sueltas o rangos; las que no pongas no valen)'), acceptIn])
        : el('div', { class: 'nb-time-row' }, [el('span', { class: 'nb-row-label' }, 'Rango aceptado: de la hora de arriba hasta'), untilIn]),
      methodSeg,
      el('p', { class: 'nb-placeholder' }, (f.method || 'exact') === 'exact'
        ? `Un solo envío calculado al milisegundo${isList ? ', a la primera hora de la lista' : ''}.`
        : `Envía; si la llegada ${isList ? 'no es una de las horas aceptadas' : 'cae fuera del rango'}, cancela la orden y vuelve a intentarlo (esperando a que vuelvan las tropas${isList ? ', apuntando a la siguiente hora aceptada' : ''}) hasta acertar o hasta que ya no dé tiempo.`)
    ]) : null;

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
    const editing = f.replaceId ? atk.queue.find((x) => x.id === f.replaceId) : null;
    if (f.replaceId && !editing) f.replaceId = null;
    const editBanner = editing ? el('div', { class: 'nb-alert nb-alert-info' }, [
      el('span', {}, `Editando: ${farmTownName(editing.source)} → ${editing.targetName}. Al programar se sustituye.`),
      el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { if (editing.status === 'editing') editing.status = 'pending'; f.replaceId = null; atkSave(); renderBody(); } }, 'Cancelar edición')
    ]) : null;
    bodyEl.appendChild(el('div', { class: 'nb-card nb-form' }, [
      editBanner,
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
        futureRow,
        el('div', { class: 'nb-mt nb-pick-label' }, 'Héroe'), heroSel,
        el('div', { class: 'nb-mt nb-pick-label' }, 'Hechizo (solo uno)'), spellSel,
        spellNote
      ] : [el('p', { class: 'nb-placeholder' }, 'No hay tropas en esta ciudad.'), futureRow]),
      section(5, 'Hora del servidor', [modeSeg, el('div', { class: 'nb-time-row' }, [timeIn, quick]), rangeBox]),
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
     8g) INVESTIGACIÓN (Academia) — cola por ciudad, todo por API
     -----------------------------------------------------------------------------
     Peticiones (leídas en game.min.js, modelo ResearchOrder):
       POST frontend_bridge?action=execute {model_url:"ResearchOrder", action_name:"research",
            arguments:{id:<investigación>}}
       GET  frontend_bridge?action=refetch {collections:{ResearchOrders:[]}} → las órdenes de
            investigación en curso de TODAS las ciudades (solo lectura).
     Puntos: Academia × 4 (+ Biblioteca × 12); se gastan los de lo investigado y lo que
     está en cola. Coste: GameData.researches[x].resources × modificador de la ciudad.
     El comercio solo manda recursos para una investigación si la ciudad YA tiene
     puntos (y Academia / requisitos) para ella.
  --------------------------------------------------------------------------------- */
  const researchRuntime = { timer: null, running: false, log: [], cooldown: new Map(), orders: [], ordersAt: 0, busy: false };
  let researchLogEl = null;
  const RD = (r) => UW.GameData?.researches?.[r] || null;
  const researchName = (r) => RD(r)?.name || r;
  const researchIcon = (r) => { let c = r; try { c = UW.GameDataResearches?.getResearchCssClass?.(r) || r; } catch {} return el('span', { class: `nb-icon nb-icon-40 research_icon research40x40 ${c}` }); };
  function townResearchCfg(townId) {
    const all = state.investigacion.towns;
    if (!all[townId]) all[townId] = { queue: [] };
    if (!Array.isArray(all[townId].queue)) all[townId].queue = [];
    return all[townId];
  }
  const researchEnabledFor = (townId) => { const v = state.investigacion.towns[townId]?.enabled; return typeof v === 'boolean' ? v : !!state.investigacion.enabled; };
  const anyResearchOn = () => allTownIds().some(researchEnabledFor);

  async function refreshResearchOrders() {
    if (researchRuntime.busy) return;
    researchRuntime.busy = true;
    try {
      const d = await gpGet('frontend_bridge', 'refetch', { collections: { ResearchOrders: [] }, nl_init: true });
      const raw = d?.collections?.ResearchOrders;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      researchRuntime.orders = list.map((x) => x?.d || x).filter((o) => o?.research_type);
      researchRuntime.ordersAt = Date.now();
    } catch {} finally { researchRuntime.busy = false; }
  }
  function researchOrdersOf(townId) {
    const byId = new Map();
    try { for (const c of [].concat(UW.MM.getCollections().ResearchOrder || [])) for (const m of c?.models || []) byId.set(+m.attributes.id, m.attributes); } catch {}
    for (const o of researchRuntime.orders) if (!byId.has(+o.id)) byId.set(+o.id, o);
    const now = Date.now();
    return [...byId.values()].filter((o) => +o.town_id === +townId && +o.to_be_completed_at * 1000 > now)
      .sort((a, b) => +a.to_be_completed_at - +b.to_be_completed_at);
  }
  function researchesOf(townId) { try { return UW.ITowns.getTown(townId)?.getResearches?.()?.attributes || {}; } catch { return {}; } }
  const isResearched = (townId, r) => researchesOf(townId)[r] === true;
  const isResearchQueued = (townId, r) => researchOrdersOf(townId).some((o) => o.research_type === r);
  // Investigada, en la cola del juego o en la del bot.
  const researchPending = (townId, r) => isResearched(townId, r) || isResearchQueued(townId, r) || townResearchCfg(townId).queue.includes(r);
  function unitResearched(townId, unitId) {
    const deps = [].concat(UW.GameData?.units?.[unitId]?.research_dependencies || []);
    if (!deps.length) return true;
    const rs = researchesOf(townId);
    if (!Object.keys(rs).length) return true; // sin datos: no bloquear
    return deps.every((r) => rs[r] === true);
  }
  function realBuildingLevel(townId, b) { try { return +UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes?.[b] || 0; } catch { return 0; } }
  function researchPoints(townId) {
    let perA = 4, perL = 12;
    try { perA = +UW.GameDataResearches.getResearchPointsPerAcademyLevel() || 4; perL = +UW.GameDataResearches.getResearchPointsPerLibraryLevel() || 12; } catch {}
    const total = realBuildingLevel(townId, 'academy') * perA + realBuildingLevel(townId, 'library') * perL;
    const rs = researchesOf(townId);
    let used = 0;
    for (const [k, v] of Object.entries(rs)) if (v === true && RD(k)) used += +RD(k).research_points || 0;
    for (const o of researchOrdersOf(townId)) used += +RD(o.research_type)?.research_points || 0;
    return { total, used, free: Math.max(0, total - used) };
  }
  function researchCost(townId, r) {
    const base = RD(r)?.resources || {};
    let f = 1; try { f = +UW.GeneralModifications?.getResearchResourcesModification?.(+townId) || 1; } catch {}
    return { wood: Math.ceil((+base.wood || 0) * f), stone: Math.ceil((+base.stone || 0) * f), iron: Math.ceil((+base.iron || 0) * f) };
  }
  // Estado de la cola del bot: cada investigación con su bloqueo (si lo tiene).
  // Los puntos y los huecos se van "gastando" en orden, como pasaría al investigarlas.
  function researchPlan(townId) {
    const q = townResearchCfg(townId).queue;
    if (!q.length) return [];
    const pts = researchPoints(townId);
    let free = pts.free, slots = buildQueueLimit() - researchOrdersOf(townId).length;
    const acad = realBuildingLevel(townId, 'academy');
    const ahead = new Set(); // lo que estará investigado/en cola antes que este
    return q.map((r) => {
      const d = RD(r);
      let block = null;
      if (!d) block = 'desconocida';
      else if (isResearched(townId, r) || isResearchQueued(townId, r)) block = 'ya investigada';
      else {
        const needA = +d.building_dependencies?.academy || 0;
        const other = Object.entries(d.building_dependencies || {}).find(([b, l]) => b !== 'academy' && realBuildingLevel(townId, b) < +l);
        const dep = [].concat(d.research_dependencies || []).find((x) => !isResearched(townId, x));
        if (acad < needA) block = `requiere Academia ${needA}`;
        else if (other) block = `requiere ${buildingName(other[0])} ${other[1]}`;
        else if (dep) block = isResearchQueued(townId, dep) ? `tras investigar ${researchName(dep)}` : ahead.has(dep) ? `tras ${researchName(dep)}` : `requiere ${researchName(dep)}`;
        else if ((+d.research_points || 0) > free) block = `faltan puntos (${free}/${+d.research_points || 0})`;
        else if (slots <= 0) block = 'cola de investigación llena';
      }
      if (!block) { free -= +d.research_points || 0; slots -= 1; }
      ahead.add(r);
      return { r, block, cost: researchCost(townId, r), points: +d?.research_points || 0 };
    });
  }
  function nextResearchFor(townId) {
    const plan = researchPlan(townId);
    const n = plan.find((x) => !x.block && (researchRuntime.cooldown.get(`${townId}:${x.r}`) || 0) <= Date.now());
    if (!n) return { reason: plan.length ? (plan.find((x) => x.block && x.block !== 'ya investigada')?.block || 'esperando') : 'nada pendiente' };
    const cur = townResources(townId), fr = reserveAbove(townId, 'investigacion');
    if (RES.some((k) => cur[k] < n.cost[k])) return { reason: `${researchName(n.r)}: faltan recursos` };
    if (RES.some((k) => cur[k] - fr[k] < n.cost[k])) return { reason: `${researchName(n.r)}: reservado para ${reserveOwner(townId, 'investigacion') || 'otro módulo'}` };
    return { r: n.r };
  }
  function pruneResearchQueue(townId) {
    const cfg = townResearchCfg(townId);
    const before = cfg.queue.length;
    cfg.queue = cfg.queue.filter((r) => RD(r) && !isResearched(townId, r) && !isResearchQueued(townId, r));
    if (cfg.queue.length !== before) saveState();
  }

  // Comercio: solo las investigaciones que ya se pueden hacer (puntos, Academia, requisitos).
  tradeDemandProviders.push(function researchDemands() {
    if (state.comercio.forResearch === false) return [];
    const out = [];
    for (const townId of allTownIds()) {
      if (!researchEnabledFor(townId)) continue;
      for (const x of researchPlan(townId)) if (!x.block) out.push({ townId, module: 'investigacion', label: researchName(x.r), ...x.cost });
    }
    return out;
  });

  async function researchTick() {
    if (!anyResearchOn()) return;
    if (Date.now() - researchRuntime.ordersAt > 60000) await refreshResearchOrders();
    for (const townId of allTownIds()) {
      if (!researchEnabledFor(townId) || !townResearchCfg(townId).queue.length) continue;
      pruneResearchQueue(townId);
      if ((researchRuntime.cooldown.get(townId) || 0) > Date.now()) continue;
      const next = nextResearchFor(townId);
      if (!next.r) continue;
      try {
        await gpPostAs(townId, 'frontend_bridge', 'execute', { model_url: 'ResearchOrder', action_name: 'research', captcha: null, arguments: { id: next.r }, nl_init: true });
        researchLog(`${farmTownName(townId)}: investigando ${researchName(next.r)}.`, 'ok');
        researchRuntime.cooldown.set(townId, Date.now() + 20000);
        // Se da por encargada ya (sin esperar a releer la cola del juego).
        researchRuntime.orders.push({ id: -Date.now(), town_id: +townId, research_type: next.r, to_be_completed_at: Date.now() / 1000 + 60 });
        pruneResearchQueue(townId);
        setTimeout(() => refreshResearchOrders().then(() => renderIfIdle('investigacion')), 3000);
        renderIfIdle('investigacion');
      } catch (e) {
        researchLog(`${farmTownName(townId)}: ${researchName(next.r)} — ${e.message}`, 'error');
        researchRuntime.cooldown.set(`${townId}:${next.r}`, Date.now() + 5 * 60000);
      }
      await sleep(800 + Math.random() * 1000);
    }
  }
  function startResearchEngine() {
    if (researchRuntime.timer) return;
    researchRuntime.timer = setInterval(() => {
      if (!anyResearchOn() || researchRuntime.running) return;
      researchRuntime.running = true;
      researchTick().catch((e) => researchLog(`Error: ${e.message}`, 'error')).finally(() => { researchRuntime.running = false; });
    }, 15000);
  }
  function researchLog(text, kind = 'info') {
    researchRuntime.log.unshift({ at: Date.now(), text, kind });
    researchRuntime.log = researchRuntime.log.slice(0, 30);
    if (researchLogEl) paintLog(researchLogEl, researchRuntime.log);
  }

  function renderInvestigacionTab() {
    const cfg = state.investigacion;
    const townId = +UW.Game?.townId || allTownIds()[0];
    const tcfg = townResearchCfg(townId);
    if (Date.now() - researchRuntime.ordersAt > 30000 && !researchRuntime.busy) refreshResearchOrders().then(() => renderIfIdle('investigacion'));
    pruneResearchQueue(townId);

    // Activación: general + excepción de esta ciudad
    const sw = switchEl(!!cfg.enabled, (v) => { setModuleGlobal('investigacion', v); renderBody(); researchLog(v ? 'Investigación activada en todas las ciudades.' : 'Investigación desactivada en todas las ciudades.'); }, false);
    const isExc = typeof tcfg.enabled === 'boolean' && tcfg.enabled !== !!cfg.enabled;
    const townSw = switchEl(researchEnabledFor(townId), (v) => { if (v === !!cfg.enabled) delete tcfg.enabled; else tcfg.enabled = v; saveState(); renderBody(); });
    const pts = researchPoints(townId);
    const orders = researchOrdersOf(townId);
    const next = nextResearchFor(townId);
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('div', { class: 'nb-option-text' }, [el('b', {}, 'Investigación automática'), el('span', { class: 'nb-option-hint' }, 'Todas las ciudades')]), sw]),
      el('div', { class: 'nb-row nb-option' }, [el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, `Solo ${farmTownName(townId)}`),
        el('span', { class: `nb-option-hint${isExc ? ' nb-warn-txt' : ''}` }, isExc ? `Excepción: ${tcfg.enabled ? 'activada' : 'desactivada'} aunque el general esté ${cfg.enabled ? 'activado' : 'desactivado'}` : 'Sigue al general')]), townSw]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Ciudad actual'), el('span', { class: 'nb-row-value' }, farmTownName(townId))]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Puntos de investigación'), el('span', { class: 'nb-row-value' }, `${pts.free} libres · ${pts.used}/${pts.total} usados (Academia ${realBuildingLevel(townId, 'academy')})`)]),
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Siguiente'), el('span', { class: 'nb-row-value' }, !researchEnabledFor(townId) ? 'desactivada en esta ciudad' : next.r ? researchName(next.r) : next.reason)])
    ]));
    const pw = anyResearchOn() ? prioExcludedAlert('investigacion') : null;
    if (pw) bodyEl.appendChild(pw);

    // Cola del juego
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Cola del juego (${orders.length}/${buildQueueLimit()})`),
      orders.length ? el('div', { class: 'nb-queue' }, orders.map((o) => el('div', { class: 'nb-queue-item' }, [
        el('span', { class: 'nb-with-icon' }, [researchIcon(o.research_type), researchName(o.research_type)]),
        o.to_be_completed_at > 0 ? el('span', { class: 'nb-queue-time', 'data-nb-until': Math.round(+o.to_be_completed_at) }, formatLeft(+o.to_be_completed_at)) : null
      ]))) : el('p', { class: 'nb-placeholder' }, 'Nada investigándose.')
    ]));

    // Cola del bot (orden = orden de investigación); se puede quitar cualquiera.
    const plan = researchPlan(townId);
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= tcfg.queue.length) return; [tcfg.queue[i], tcfg.queue[j]] = [tcfg.queue[j], tcfg.queue[i]]; saveState(); renderBody(); };
    const qBox = el('div', { class: 'nb-goals' }, plan.map((x, i) => el('div', { class: `nb-goal${next.r === x.r ? ' nb-goal-next' : ''}` }, [
      el('span', { class: 'nb-goal-idx' }, String(i + 1)),
      researchIcon(x.r),
      el('div', { class: 'nb-goal-main' }, [
        el('div', { class: 'nb-goal-name' }, researchName(x.r)),
        el('div', { class: 'nb-goal-sub nb-res-list' }, [el('span', {}, `${x.points} pts`), fmtResEl(x.cost), el('span', { class: x.block ? 'nb-warn-txt' : '' }, next.r === x.r ? '· siguiente' : x.block ? `· ${x.block}` : '· en espera de recursos')])
      ]),
      el('div', { class: 'nb-goal-actions' }, [
        el('span', { class: `nb-mini${i === 0 ? ' nb-mini-off' : ''}`, title: 'Subir', onclick: () => move(i, -1) }, '▲'),
        el('span', { class: `nb-mini${i === plan.length - 1 ? ' nb-mini-off' : ''}`, title: 'Bajar', onclick: () => move(i, 1) }, '▼'),
        el('span', { class: 'nb-mini nb-mini-danger', title: 'Quitar solo esta', onclick: () => { tcfg.queue.splice(i, 1); saveState(); renderBody(); } }, '✕')
      ])
    ])));
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-head' }, [el('div', { class: 'nb-card-title' }, `Cola del bot (${plan.length})`),
        plan.length ? el('span', { class: 'nb-btn', onclick: () => { if (confirm('¿Vaciar la cola de investigación de esta ciudad?')) { tcfg.queue = []; saveState(); renderBody(); } } }, 'Vaciar') : null]),
      plan.length ? qBox : el('p', { class: 'nb-placeholder' }, 'Sin investigaciones. Añádelas abajo; se investigan en este orden.')
    ]));

    // Añadir: lo que falta por investigar en esta ciudad
    const avail = Object.keys(UW.GameData?.researches || {}).filter((r) => !isResearched(townId, r) && !isResearchQueued(townId, r) && !tcfg.queue.includes(r));
    const acad = realBuildingLevel(townId, 'academy');
    const list = el('div', { class: 'nb-add-list' }, avail.map((r) => {
      const d = RD(r), c = researchCost(townId, r), needA = +d.building_dependencies?.academy || 0;
      return el('div', { class: `nb-add-row${acad < needA ? ' nb-add-row-off' : ''}` }, [
        researchIcon(r),
        el('div', { class: 'nb-add-name' }, [researchName(r), el('span', { class: 'nb-add-level' }, `${+d.research_points || 0} pts · Academia ${needA} · ${c.wood}/${c.stone}/${c.iron}`)]),
        el('div', { class: 'nb-stepper' }, [el('span', { class: 'nb-mini nb-mini-add', title: 'Añadir al final de la cola', onclick: () => { tcfg.queue.push(r); saveState(); renderBody(); } }, '✓')])
      ]);
    }));
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Añadir investigación (${avail.length} sin investigar)`),
      avail.length ? list : el('p', { class: 'nb-placeholder' }, 'Todo investigado.')
    ]));

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    researchLogEl = logBox; paintLog(logBox, researchRuntime.log);
    updateCountdown();
  }

  /* ---------------------------------------------------------------------------------
     8f) FESTIVALES (cultura)
     -----------------------------------------------------------------------------
     Solo ciudades con Academia ≥ 30 y sin festival en curso.
     Coste (leído del Ágora del juego): 15 000 madera · 18 000 piedra · 15 000 plata; dura 6 h.
     Petición (la misma que BuildingPlace.startCelebration del juego):
       POST building_place?action=start_celebration  json: { celebration_type:"party", town_id }
     Festivales en curso: MM.getModels().Celebration → { town_id, celebration_type, finished_at }.
     Comercio: cada ciudad apta sin festival publica como demanda JUSTO lo que le falta
     para el festival. Quién gasta primero en la ciudad lo decide la Prioridad (8a).
  --------------------------------------------------------------------------------- */
  const FESTIVAL_COST = { wood: 15000, stone: 18000, iron: 15000 };
  const FESTIVAL_ACADEMY = 30;
  const festRuntime = { timer: null, running: false, log: [], cooldown: new Map(), startedUntil: new Map() };
  let festLogEl = null;

  // Nivel REAL (terminado). building_data.level ya cuenta lo que está en cola,
  // y con la Academia 30 aún en cola el festival no se puede hacer.
  function academyLevel(townId) {
    try {
      const v = UW.ITowns.getTown(townId)?.getBuildings?.()?.attributes?.academy;
      if (v !== undefined && v !== null && Number.isFinite(+v)) return +v;
    } catch {}
    return +buildDataFor(townId)?.building_data?.academy?.level || 0;
  }
  function festivalEnd(townId) {
    try {
      const all = [];
      const m = UW.MM.getModels().Celebration;
      if (m) all.push(...Object.values(m));
      all.push(...[].concat(UW.MM.getCollections().Celebration || []).flatMap((c) => c?.models || []));
      let end = 0;
      for (const x of all) {
        const a = x?.attributes || {};
        if (+a.town_id !== +townId || a.celebration_type !== 'party') continue;
        const f = +a.finished_at * 1000;
        if (f > Date.now()) end = Math.max(end, f);
      }
      return end;
    } catch { return 0; }
  }
  /* Festival evento ("Temporada de festivales"), leído del juego (24/09/2026):
     MM.getCollections().Benefit → { type:'party', start, end,
       params:{ hours:'12', wood:'5000', stone:'5000', iron:'5000', min_academy_level:'5' } }
     Mientras está activo, el mismo festival (celebration_type:'party') cuesta eso y pide
     esa Academia. hours son horas de juego → reales = hours / velocidad (12/4 = 3 h). */
  function partyEvent() {
    try {
      const now = Date.now() / 1000;
      for (const c of [].concat(UW.MM.getCollections().Benefit || [])) for (const m of c?.models || []) {
        const a = m.attributes || {};
        if (a.type !== 'party' || !(+a.start <= now && +a.end > now)) continue;
        const p = a.params || {};
        return {
          cost: { wood: +p.wood || 0, stone: +p.stone || 0, iron: +p.iron || 0 },
          academy: +p.min_academy_level || 0,
          hours: (+p.hours || 12) / Math.max(1, +UW.Game?.game_speed || 1),
          end: +a.end * 1000
        };
      }
    } catch {}
    return null;
  }
  // "Festival evento" OCULTO (el evento terminó, 25/09/2026). El código se queda: si el
  // juego vuelve a sacar la «Temporada de festivales», basta con poner esto a true
  // (vuelve la tarjeta, su paso del tour y el modo evento).
  const FEST_EVENT_ON = false;
  // Festival que toca ahora: el del evento (si está elegido y activo) o el normal.
  function festCfg() {
    const f = state.festivales;
    if (!FEST_EVENT_ON) return f.enabled ? { cost: FESTIVAL_COST, academy: FESTIVAL_ACADEMY, hours: 6, event: false } : null;
    if (f.event) { const e = partyEvent(); return e ? { ...e, event: true } : null; }
    if (f.enabled) return { cost: FESTIVAL_COST, academy: FESTIVAL_ACADEMY, hours: 6, event: false };
    return null;
  }
  const festCost = () => festCfg()?.cost || FESTIVAL_COST;
  const festAcademy = () => festCfg()?.academy ?? (FEST_EVENT_ON && state.festivales.event ? (partyEvent()?.academy ?? 5) : FESTIVAL_ACADEMY);
  const canFestival = (townId) => academyLevel(townId) >= festAcademy();
  // (tras iniciarlo, hasta que el juego actualice sus datos, se da por en marcha)
  const festivalPending = (townId) => !!festCfg() && canFestival(townId) && !festivalEnd(townId) && !((festRuntime.startedUntil.get(+townId) || 0) > Date.now());

  tradeDemandProviders.push(function festivalDemands() {
    const f = festCfg();
    if (!f || !state.comercio.forFestival) return [];
    const out = [];
    for (const townId of allTownIds()) {
      if (!festivalPending(townId)) continue;
      out.push({ townId, module: 'festivales', label: f.event ? 'Festival evento' : 'Festival', ...f.cost });
    }
    return out;
  });

  async function festTick() {
    if (!festCfg()) return;
    for (const townId of allTownIds()) {
      const f = festCfg();
      if (!f) return;
      if (!festivalPending(townId)) continue;
      if ((festRuntime.cooldown.get(townId) || 0) > Date.now()) continue;
      const cur = townResources(townId);
      const fr = reserveAbove(townId, 'festivales');
      if (RES.some((k) => cur[k] - fr[k] < f.cost[k])) continue;
      try {
        await gpPostAs(townId, 'building_place', 'start_celebration', { celebration_type: 'party', nl_init: true });
        festLog(`${farmTownName(townId)}: ${f.event ? 'festival evento' : 'festival'} iniciado.`, 'ok');
        festRuntime.cooldown.set(townId, Date.now() + 60000);
        festRuntime.startedUntil.set(+townId, Date.now() + f.hours * 3600000);
      } catch (e) {
        festLog(`${farmTownName(townId)}: ${e.message}`, 'error');
        festRuntime.cooldown.set(townId, Date.now() + 5 * 60000);
      }
      await sleep(600 + Math.random() * 700);
    }
    renderIfIdle('festivales');
  }

  function startFestivalEngine() {
    if (festRuntime.timer) return;
    festRuntime.timer = setInterval(() => {
      if (!festCfg() || festRuntime.running) return;
      festRuntime.running = true;
      festTick().catch((e) => festLog(`Error: ${e.message}`, 'error')).finally(() => { festRuntime.running = false; });
    }, 10000);
  }

  function festLog(text, kind = 'info') {
    festRuntime.log.unshift({ at: Date.now(), text, kind });
    festRuntime.log = festRuntime.log.slice(0, 30);
    if (festLogEl) paintLog(festLogEl, festRuntime.log);
  }

  function renderFestivalesTab() {
    const cfg = state.festivales;
    const fmtN = (n) => Math.round(n).toLocaleString('es-ES');
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Festivales automáticos')]),
        switchEl(!!cfg.enabled, (v) => { cfg.enabled = v; if (v) cfg.event = false; saveState(); renderBody(); festLog(v ? 'Festivales activados.' : 'Festivales desactivados.'); }, false)]),
      el('p', { class: 'nb-placeholder' }, `Solo ciudades con Academia ${FESTIVAL_ACADEMY}+ y sin festival en curso. Coste: 15 000 madera · 18 000 piedra · 15 000 plata.`)
    ]));

    // Festival evento ("Temporada de festivales") — oculto mientras FEST_EVENT_ON = false.
    const ev = FEST_EVENT_ON ? partyEvent() : null;
    if (FEST_EVENT_ON) bodyEl.appendChild(el('div', { class: `nb-card${cfg.event ? ' nb-card-accent' : ''}` }, [
      el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, [el('b', {}, 'Festival evento')]),
        switchEl(!!cfg.event, (v) => { cfg.event = v; if (v) cfg.enabled = false; saveState(); renderBody(); festLog(v ? 'Festival evento activado (festivales normales desactivados).' : 'Festival evento desactivado.'); }, false)]),
      ev
        ? el('div', {}, [
            el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Coste'), el('span', { class: 'nb-row-value' }, fmtResEl(ev.cost))]),
            el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Requisito'), el('span', { class: 'nb-row-value' }, `Academia ${ev.academy}`)]),
            el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Duración'), el('span', { class: 'nb-row-value' }, `${+ev.hours.toFixed(2)} h reales`)]),
            el('div', { class: 'nb-row' }, [el('span', { class: 'nb-row-label' }, 'Evento activo hasta'), el('span', { class: 'nb-row-value' }, new Date(ev.end).toLocaleString('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))])
          ])
        : el('div', { class: 'nb-alert nb-alert-warn nb-mt' }, 'Ahora no hay «Temporada de festivales» activa: no se hace nada hasta que empiece.'),
      el('p', { class: 'nb-placeholder' }, `Al activarlo se apagan los festivales normales. En cuanto termina uno, lanza otro en todas las ciudades con la Academia pedida${ev ? ` (${fmtN(ev.cost.wood)} / ${fmtN(ev.cost.stone)} / ${fmtN(ev.cost.iron)})` : ''}.`)
    ]));

    // Estado por ciudad
    const transit = (() => { try { return transitRows(); } catch { return []; } })();
    const ACAD = festAcademy(), COST = festCost();
    const rows = allTownIds().map((id) => ({ id, name: farmTownName(id), acad: academyLevel(id), end: festivalEnd(id) }))
      .sort((a, b) => (b.acad >= ACAD) - (a.acad >= ACAD) || a.name.localeCompare(b.name, 'es'));
    const apt = rows.filter((r) => r.acad >= ACAD);
    const list = el('div', { class: 'nb-goals' });
    for (const r of apt) {
      const cur = townResources(r.id), inc = incomingTo(r.id, transit);
      let sub, cls = '';
      if (r.end) { sub = el('span', {}, ['En curso · termina en ', el('b', { 'data-nb-until': Math.round(r.end / 1000) }, formatLeft(Math.round(r.end / 1000)))]); cls = ' nb-goal-done'; }
      else {
        const miss = Object.fromEntries(RES.map((k) => [k, Math.max(0, COST[k] - cur[k])]));
        const missAfter = Object.fromEntries(RES.map((k) => [k, Math.max(0, miss[k] - inc[k])]));
        const fr = reserveAbove(r.id, 'festivales');
        if (!festCfg()) sub = 'Desactivado';
        else if (!sumRes(miss) && RES.some((k) => cur[k] - fr[k] < COST[k])) sub = `Esperando: recursos reservados para ${reserveOwner(r.id, 'festivales') || 'otro módulo'} (prioridad)`;
        else if (!sumRes(miss)) { sub = 'Listo: se inicia en el próximo ciclo'; cls = ' nb-goal-next'; }
        else sub = el('span', {}, ['Faltan ', fmtResEl(miss), ...(sumRes(inc) ? [' · en camino ', fmtResEl(inc), sumRes(missAfter) ? '' : ' (cubre)'] : [])]);
      }
      const pct = Math.min(100, Math.round(RES.reduce((s, k) => s + Math.min(cur[k], COST[k]), 0) / Math.max(1, sumRes(COST)) * 100));
      list.appendChild(el('div', { class: `nb-goal${cls}` }, [
        el('div', { class: 'nb-goal-main' }, [el('div', { class: 'nb-goal-name' }, r.name), el('div', { class: 'nb-goal-sub' }, [sub])]),
        r.end ? el('span', { class: 'nb-pill' }, 'festival') : el('div', { class: 'nb-bar nb-bar-mini' }, [el('div', { class: 'nb-bar-fill', style: `width:${pct}%` })])
      ]));
    }
    const noApt = rows.length - apt.length;
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, `Ciudades aptas (${apt.length})`),
      apt.length ? list : el('p', { class: 'nb-placeholder' }, `Ninguna ciudad tiene Academia ${ACAD}.`),
      noApt ? el('p', { class: 'nb-placeholder nb-mt' }, `${noApt} ciudades con Academia < ${ACAD} (no pueden festejar).`) : null
    ]));

    const logBox = el('div', { class: 'nb-log' });
    bodyEl.appendChild(el('div', { class: 'nb-card' }, [el('div', { class: 'nb-card-title' }, 'Actividad'), logBox]));
    festLogEl = logBox; paintLog(logBox, festRuntime.log);
  }

  /* ---------------------------------------------------------------------------------
     10) TOUR GUIADO — botón "?" de la cabecera
     -----------------------------------------------------------------------------
     Enseña TODO el bot paso a paso: oscurece la pantalla y recuadra el elemento del
     que habla cada paso (como los tutoriales de las webs). Se puede hacer entero o
     solo un apartado (índice). No cambia NINGUNA opción: solo cambia de pestaña o de
     vista para enseñar cosas y, al salir, deja el panel como estaba.
     Mientras está abierto, los motores siguen trabajando pero el panel no se repinta
     solo (si no, el recuadro perdería el elemento); al salir se repinta.
     Teclado: → / Intro = siguiente · ← = anterior · Esc = salir.
  --------------------------------------------------------------------------------- */
  const tour = { active: false, steps: [], i: 0, rendering: false, dirty: false, saved: null, els: null, timer: null, target: null, menu: null };

  const TOUR_CSS = `
#novabot-root .nb-tour-block{position:fixed;inset:0;pointer-events:auto;background:transparent;z-index:1000001}
#novabot-root .nb-tour-dim{position:fixed;inset:0;background:rgba(6,8,12,.74);pointer-events:none;z-index:1000002;transition:opacity .2s}
#novabot-root .nb-tour-spot{position:fixed;border-radius:12px;pointer-events:none;z-index:1000002;
  box-shadow:0 0 0 9999px rgba(6,8,12,.74),0 0 0 2px var(--nb-gold,#d4af6a),0 0 26px 6px rgba(212,175,106,.35);
  transition:left .3s cubic-bezier(.2,.7,.2,1),top .3s cubic-bezier(.2,.7,.2,1),width .3s cubic-bezier(.2,.7,.2,1),height .3s cubic-bezier(.2,.7,.2,1)}
#novabot-root .nb-tour-card{position:fixed;z-index:1000003;pointer-events:auto;width:370px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;
  background:var(--nb-surface,#181c23);color:var(--nb-text,#ece9e1);border:1px solid var(--nb-gold-line,rgba(212,175,106,.45));border-radius:14px;
  box-shadow:0 24px 60px rgba(0,0,0,.6),0 4px 14px rgba(0,0,0,.4);padding:16px 18px 14px;font-size:13px;line-height:1.5;
  transition:left .3s cubic-bezier(.2,.7,.2,1),top .3s cubic-bezier(.2,.7,.2,1);font-family:var(--nb-font,system-ui,sans-serif)}
#novabot-root .nb-tour-card.nb-tour-wide{width:520px}
#novabot-root .nb-tour-ch{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--nb-gold,#d4af6a);font-weight:700}
#novabot-root .nb-tour-title{font-size:16px;font-weight:700;margin:3px 0 8px;color:var(--nb-text,#ece9e1)}
#novabot-root .nb-tour-body p{margin:0 0 8px}
#novabot-root .nb-tour-body ul{margin:0 0 8px;padding-left:18px}
#novabot-root .nb-tour-body li{margin:3px 0}
#novabot-root .nb-tour-body b{color:var(--nb-gold-bright,#f1cf8f);font-weight:600}
#novabot-root .nb-tour-body i{color:var(--nb-text-dim,#a8a59c)}
#novabot-root .nb-tour-auto{margin:8px 0 6px;padding:8px 10px;border-radius:9px;background:rgba(127,182,230,.1);border:1px solid rgba(127,182,230,.28)}
#novabot-root .nb-tour-auto::before{content:"⚙ Lo hace solo";display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#7fb6e6;font-weight:700;margin-bottom:3px}
#novabot-root .nb-tour-tip{margin:8px 0 6px;padding:8px 10px;border-radius:9px;background:rgba(124,199,154,.1);border:1px solid rgba(124,199,154,.28)}
#novabot-root .nb-tour-tip::before{content:"✔ Consejo";display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#7cc79a;font-weight:700;margin-bottom:3px}
#novabot-root .nb-tour-warn{margin:8px 0 6px;padding:8px 10px;border-radius:9px;background:rgba(227,110,99,.1);border:1px solid rgba(227,110,99,.3)}
#novabot-root .nb-tour-warn::before{content:"⚠ Ojo";display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#e36e63;font-weight:700;margin-bottom:3px}
#novabot-root .nb-tour-miss{margin:6px 0;font-size:12px;color:var(--nb-text-dim,#a8a59c);font-style:italic}
#novabot-root .nb-tour-body kbd{display:inline-block;padding:0 5px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);font-size:11px}
#novabot-root .nb-tour-foot{display:flex;align-items:center;gap:6px;margin-top:12px}
#novabot-root .nb-tour-prog{flex:1;height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden}
#novabot-root .nb-tour-prog i{display:block;height:100%;background:var(--nb-gold,#d4af6a);transition:width .3s}
#novabot-root .nb-tour-count{font-size:11px;color:var(--nb-text-dim,#a8a59c);white-space:nowrap}
#novabot-root .nb-tour-btn{padding:6px 11px;border-radius:8px;border:1px solid var(--nb-border-strong,rgba(255,255,255,.16));background:var(--nb-surface-2,#1f242d);
  color:var(--nb-text,#ece9e1);cursor:pointer;font-size:12px;user-select:none;white-space:nowrap}
#novabot-root .nb-tour-btn:hover{border-color:var(--nb-gold-line,rgba(212,175,106,.45))}
#novabot-root .nb-tour-btn.primary{background:var(--nb-gold,#d4af6a);color:#1a1408;border-color:var(--nb-gold,#d4af6a);font-weight:700}
#novabot-root .nb-tour-btn.off{opacity:.35;pointer-events:none}
#novabot-root .nb-tour-top{display:flex;align-items:flex-start;gap:8px}
#novabot-root .nb-tour-top > div{flex:1}
#novabot-root .nb-tour-x{cursor:pointer;color:var(--nb-text-dim,#a8a59c);font-size:18px;line-height:1;padding:0 2px}
#novabot-root .nb-tour-x:hover{color:var(--nb-text,#ece9e1)}
#novabot-root .nb-tour-chapters{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0 4px}
#novabot-root .nb-tour-chapter{padding:8px 10px;border-radius:9px;border:1px solid var(--nb-border,rgba(255,255,255,.09));background:var(--nb-surface-2,#1f242d);cursor:pointer;font-size:12.5px}
#novabot-root .nb-tour-chapter:hover{border-color:var(--nb-gold-line,rgba(212,175,106,.45))}
#novabot-root .nb-tour-chapter small{display:block;color:var(--nb-text-dim,#a8a59c);font-size:11px}
#novabot-root .nb-tour-chapter.cur{border-color:var(--nb-gold,#d4af6a)}
#novabot-panel .nb-help-btn{color:var(--nb-gold,#d4af6a)}
@media (max-width:560px){#novabot-root .nb-tour-chapters{grid-template-columns:1fr}}
`;
  function tourCss() {
    if (document.getElementById('novabot-tour-css')) return;
    const st = document.createElement('style');
    st.id = 'novabot-tour-css';
    st.textContent = TOUR_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // Buscadores de elementos (por texto: sobreviven a los repintados y a los números cambiantes).
  const TQ = {
    card: (re) => $$('.nb-card', bodyEl).find((c) => re.test(((c.querySelector('.nb-card-title, .nb-row-label, .nb-option-text, .nb-hero-label')?.textContent) || '').trim())) || null,
    row: (re, within) => $$('.nb-row, .nb-field', within || bodyEl).find((r) => re.test((r.textContent || '').trim())) || null,
    txt: (s, re, within) => $$(s, within || bodyEl).find((n) => re.test((n.textContent || '').trim())) || null,
    sel: (s, within) => (within || panel)?.querySelector(s) || null,
    tab: (id) => tabsEl?.querySelector(`[data-tab="${id}"]`) || null,
    lastCard: (re) => { const l = $$('.nb-card', bodyEl).filter((c) => re.test(((c.querySelector('.nb-card-title, .nb-row-label')?.textContent) || '').trim())); return l[l.length - 1] || null; },
    step: (n) => $$('.nb-step', bodyEl)[n - 1] || null
  };
  const inCard = (cardRe, rowRe) => () => { const c = TQ.card(cardRe); return c ? (TQ.row(rowRe, c) || c) : null; };
  const AUTO = (h) => `<div class="nb-tour-auto">${h}</div>`;
  const TIP = (h) => `<div class="nb-tour-tip">${h}</div>`;
  const WARN = (h) => `<div class="nb-tour-warn">${h}</div>`;

  /* Contenido. Cada paso: { ch (apartado), tab, t (título), h (html), find (elemento a
     recuadrar; sin find = paso centrado), before (cambia una vista; true = repintar),
     wide (tarjeta ancha) }. */
  function tourSteps() {
    const S = [];
    const add = (ch, tab, list) => { for (const s of list) S.push({ ch, tab, ...s }); };

    // ------------------------------------------------------------------ Bienvenida
    add('Bienvenida', null, [
      { t: '¡Bienvenido a NOVABOT!', wide: true, h: `
        <p>NOVABOT juega por ti las partes repetitivas de Grepolis en <b>todas tus ciudades a la vez</b>, sin que tengas que cambiar de ciudad: recolecta aldeas, construye, investiga, recluta, reparte recursos, hace festivales, guarda plata en la cueva y lanza ataques al segundo.</p>
        <p>Este tour te enseña <b>cada apartado y cada opción</b>, y también lo que el bot hace <b>por su cuenta</b> por detrás (lo verás en las cajas azules <i>⚙ Lo hace solo</i>).</p>
        <ul><li><kbd>→</kbd> o <kbd>Intro</kbd>: siguiente · <kbd>←</kbd>: anterior · <kbd>Esc</kbd>: salir.</li>
        <li>Con <b>Índice</b> saltas a un apartado concreto.</li>
        <li>El tour <b>no cambia ninguna opción</b>: puedes seguirlo tranquilo.</li></ul>
        ${WARN('El bot funciona dentro de esta pestaña del navegador: <b>si cierras el juego o el PC se duerme, se para</b>. Úsalo en un solo PC a la vez.')}` }
    ]);

    // ------------------------------------------------------------------ Panel
    add('El panel', 'inicio', [
      { t: 'Cabecera', find: () => TQ.sel('.nb-header'), h: `
        <p>Arrastra la cabecera para <b>mover el panel</b> por la pantalla; se recuerda dónde lo dejas.</p>
        <p>Al lado del nombre ves la <b>versión</b> del script y de los estilos (útil si algo se ve raro: compara con la del repositorio).</p>` },
      { t: 'Ayuda, minimizar y cerrar', find: () => TQ.sel('.nb-header-actions'), h: `
        <p><b>?</b> abre este tour (entero o por apartados) cuando quieras.</p>
        <p><b>—</b> y <b>✕</b> esconden el panel. Queda un <b>botón redondo</b> flotante: púlsalo para volver a abrirlo o arrástralo para moverlo.</p>
        ${TIP('Cerrar el panel NO para el bot: todo sigue funcionando por detrás.')}` },
      { t: 'Pestañas', find: () => TQ.sel('.nb-tabs'), h: `
        <p>Cada pestaña es un apartado del bot. Casi todos tienen un <b>interruptor general</b> arriba y una tarjeta <b>Actividad</b> abajo con lo último que ha hecho.</p>
        <p>Las pestañas que trabajan por ciudad (Construcción, Investigación, Reclutamiento) muestran siempre <b>la ciudad que tienes abierta en el juego</b>: cambia de ciudad en el juego y el panel cambia con ella.</p>` },
      { t: 'Tamaño', find: () => TQ.sel('.nb-resize'), h: `<p>Arrastra esta esquina para hacer el panel más grande o más pequeño. También se recuerda.</p>` }
    ]);

    // ------------------------------------------------------------------ Inicio
    add('Inicio', 'inicio', [
      { t: 'Inicio', find: () => TQ.tab('inicio'), h: `<p>La portada: ciudad actual, la <b>prioridad de recursos</b> (muy importante), la nube y un resumen de cada módulo.</p>` },
      { t: 'Ciudad actual', find: () => TQ.card(/^Ciudad actual/), h: `<p>La ciudad que tienes abierta en el juego. Se actualiza sola al cambiar de ciudad.</p>` },
      { t: 'Prioridad de recursos', find: () => TQ.card(/^Prioridad de recursos/), wide: true, h: `
        <p>Decide <b>quién gasta primero</b> cuando los recursos no llegan para todo: Construcción, Investigación, Reclutamiento, Festivales y Cueva. Afecta a lo que cada módulo puede gastar en su ciudad y a qué abastece el Comercio.</p>
        <ul>
          <li><b>Equilibrado</b> (por defecto): todos reciben a la vez. En cada ciudad un módulo solo gasta lo que no necesita el <i>siguiente gasto</i> de los de arriba (orden fijo: Construcción → Investigación → Reclutamiento → Festivales).</li>
          <li><b>Personalizado · por orden</b>: tú pones el orden. El comercio abastece <b>primero al 1º en todas las ciudades</b>; cuando en ninguna puede hacer más (colas llenas o nada pendiente) pasa al 2º, y en cuanto el 1º vuelve a tener hueco recupera el turno.</li>
          <li><b>Personalizado · por niveles</b>: cada módulo tiene un nivel N1–N4. Los del mismo nivel reciben a la vez; el nivel 2 solo cuando el 1 no puede hacer nada más en ninguna ciudad.</li>
        </ul>` },
      { t: 'Qué entra en la prioridad', find: () => { const c = TQ.card(/^Prioridad de recursos/); return c?.querySelector('.nb-goals') || c; }, h: `
        <p>En los modos personalizados cada módulo tiene su interruptor: si lo <b>quitas</b>, ese módulo sigue funcionando pero <b>solo con lo que sobre</b> en su ciudad y <b>no pide nada al comercio</b>.</p>
        <p>Con ▲▼ cambias el orden (modo por orden) y con N1–N4 el nivel (modo por niveles). Debajo verás qué módulo tiene ahora el turno en tu ciudad.</p>
        ${TIP('Si algo "no avanza" y pone <i>reservado para …</i>, es la prioridad: otro módulo más importante está guardando esos recursos.')}` },
      { t: 'Sincronización en la nube (opcional)', find: () => TQ.card(/^Sincronización en la nube/), h: `
        <p>Guarda toda tu configuración (objetivos, colas, prioridad, ataques programados…) en un <b>Gist secreto de tu GitHub</b>, <b>cifrado</b> con tu contraseña, para tenerla igual en otro PC.</p>
        <ul><li>Necesitas un token de GitHub con permiso <b>solo de Gists</b> y una contraseña (8+ caracteres, la misma en todos tus PC).</li>
        <li>Al conectar: si ya hay datos en la nube se cargan; si no, se suben los de este PC.</li></ul>
        ${AUTO('Cada cambio se sube a los 8 s y cada 60 s baja lo del otro PC. Al arrancar, primero sincroniza y después empieza a trabajar.')}
        ${WARN('Aun con la nube, usa el bot en <b>un solo PC a la vez</b>: si está abierto en dos, los dos enviarían recursos y ataques.')}` },
      { t: 'Módulos', find: () => TQ.sel('.nb-tiles', bodyEl), h: `
        <p>Una ficha por módulo con su dato principal. El interruptor lo activa o desactiva para <b>todas</b> las ciudades; pulsa la ficha para ir a su pestaña.</p>` }
    ]);

    // ------------------------------------------------------------------ Vista general
    add('Vista general', 'resumen', [
      { t: 'Vista general', find: () => TQ.tab('resumen'), before: () => { if ((state.resumenView || 'ciudades') !== 'ciudades') { state.resumenView = 'ciudades'; return true; } }, h: `
        <p>Todo el imperio de un vistazo. <b>Solo lectura</b>: aquí no se cambia nada.</p>
        <p>Arriba eliges la vista: <b>Ciudades</b> (una fila por ciudad) o lo que lleva el bot en <b>Construcción</b>, <b>Investigación</b> y <b>Reclutamiento</b>, ciudad a ciudad.</p>` },
      { t: 'Ciudades', find: () => TQ.card(/^Vista general/), wide: true, h: `
        <p>Una fila por ciudad (la tuya resaltada):</p>
        <ul><li><b>Construcción</b>: órdenes en la cola del juego / huecos y lo primero que termina; cuántos objetivos tiene el bot.</li>
        <li><b>Reclutamiento</b>: cola del Cuartel y del Puerto y el estado del bot en esa ciudad.</li>
        <li><b>Festival</b>: en curso (cuenta atrás) o si puede hacerlo.</li>
        <li><b>Llega (comercio)</b>: envíos en camino y cuándo llega el primero.</li>
        <li><b>Ataques del bot</b>: ataques programados que salen de ella.</li></ul>` },
      { t: 'Construcción del bot', before: () => { if (state.resumenView !== 'construccion') { state.resumenView = 'construccion'; return true; } }, find: () => TQ.sel('.nb-rc-stats', bodyEl) || TQ.sel('.nb-seg-main', bodyEl), h: `
        <p>Vista <b>Construcción</b>: una ficha por ciudad con objetivos en el bot. Cada edificio con su nivel → objetivo (barra: clara = con la cola del juego), cuántos niveles faltan y por qué espera.</p>
        <p><b>Siguiente</b>: el nivel que toca y sus recursos (verde = ya los tiene). Abajo, la cola del juego (lo primero que termina) y si esa ciudad <b>intercala</b> o va <b>en orden</b>.</p>
        <p>Colores del estado: <b>listo</b> para construir, reuniendo recursos, en espera (cola llena, falta población, requisitos…), desactivado o completo.</p>` },
      { t: 'Investigación del bot', before: () => { if (state.resumenView !== 'investigacion') { state.resumenView = 'investigacion'; return true; } }, find: () => TQ.sel('.nb-rc-stats', bodyEl) || TQ.sel('.nb-seg-main', bodyEl), h: `
        <p>Vista <b>Investigación</b>: por ciudad, la cola del bot con el estado de cada investigación (siguiente, requisitos, faltan puntos…), la <b>siguiente</b> con sus recursos, la cola de la Academia y los <b>puntos</b> libres.</p>` },
      { t: 'Reclutamiento del bot', before: () => { if (state.resumenView !== 'reclutamiento') { state.resumenView = 'reclutamiento'; return true; } }, find: () => TQ.sel('.nb-rc-stats', bodyEl) || TQ.sel('.nb-seg-main', bodyEl), h: `
        <p>Vista <b>Reclutamiento</b>: por ciudad, qué tropas le has pedido al bot, cuánto falta (barra), el <b>siguiente lote</b> con sus recursos, las colas y los hechizos.</p>
        <p>Colores del estado: <b>listo</b> para reclutar, reuniendo recursos, en espera (cola llena, programado, falta población…), desactivado o completo.</p>` }
    ]);

    // ------------------------------------------------------------------ Granjas
    add('Granjas', 'granjas', [
      { t: 'Granjas (aldeas)', find: () => TQ.tab('granjas'), h: `<p>Recolecta recursos de las <b>aldeas</b> de todas tus islas y cambia recursos con ellas.</p>` },
      { t: 'Recolección automática', find: () => TQ.card(/^Recolección automática/), h: `
        <p>Enciéndelo y el bot recolecta todas tus aldeas en cuanto están listas. Debajo, la <b>cuenta atrás</b> hasta la próxima recolección.</p>
        ${AUTO(`<ul>
          <li>Recolecta <b>todas las ciudades en una sola petición</b>, igual que el botón «Seleccionar todas» del juego.</li>
          <li>Las aldeas son de la isla: si tienes varias ciudades en una isla, recoge <b>una por isla</b>, la que <b>menos perdería</b> por tener el almacén lleno (recurso a recurso).</li>
          <li>Si algo falla, reintenta en 1 min; si todas las ciudades están llenas, vuelve a mirar en 5 min.</li></ul>`)}` },
      { t: 'Tiempo de recolección', find: () => TQ.card(/^Tiempo de recolección/), h: `
        <p>Cada cuánto se recolecta. Más corto = más recursos por hora pero más peticiones.</p>
        <p>Los botones dicen 10 min / 40 min / 3 h / 8 h (los tiempos con la investigación <b>Lealtad de los aldeanos</b>). Las ciudades sin ella usan su equivalente: 5 min / 20 min / 1h30 / 4 h.</p>` },
      { t: 'Retraso aleatorio', find: () => TQ.card(/^Retraso aleatorio/), h: `<p>Segundos al azar (entre mínimo y máximo) que se suman a cada ciclo, para que no recoja siempre al segundo exacto.</p>` },
      { t: 'No recolectar si el almacén está lleno', find: () => TQ.card(/^No recolectar/), h: `
        <p>Si en una ciudad <b>madera, piedra y plata</b> han llegado todas a ese %, no recolecta en ella (se perdería). Si a alguna le falta, sí recolecta.</p>
        ${TIP('Con el <b>Equilibrio</b> del Comercio activo casi nunca llegarás a esto: antes de cada recolección mueve lo que no cabría.')}` },
      { t: 'Intercambio con aldeas', find: () => TQ.card(/^Intercambio con aldeas/), wide: true, h: `
        <p>Las aldeas cambian un recurso por otro con una <b>tasa</b> (ej. 1,25 = por 100 que das te dan 125).</p>
        ${AUTO(`<ul>
          <li>Cada minuto, en todas las islas, hasta 3 cambios. Cada aldea la usa la ciudad de su isla donde más ayuda.</li>
          <li>Da lo que más <b>sobra</b> (en la ciudad y en todo el imperio) por lo que menos hay.</li>
          <li>La tasa baja 0,03 por cada 100 que cambias y se recupera sola (0,02 × velocidad por hora, hasta 1,25). La <b>Oficina comercial</b> suma +0,1 a la ciudad que la tiene: el bot calcula la tasa real de cada ciudad.</li>
          <li>Nunca da lo reservado para encargos, ni lo que otra ciudad está esperando, ni hace rebosar lo que recibe. Mínimo 100 y máximo 3000 por cambio.</li>
          <li>Si hay ciudades esperando recursos, los cambios normales no usan más que la parte pequeña de comerciantes (la misma que el equilibrio, 20 %), para no frenar al comercio.</li></ul>`)}` },
      { t: 'Tasa para equilibrar', find: inCard(/^Intercambio con aldeas/, /^Tasa para equilibrar/), h: `
        <p>Los cambios normales solo se hacen con la tasa <b>así de alta</b> (por defecto 1,2).</p>
        <p>¿Por qué alta? La tasa se recupera a ritmo fijo: cambiar 3000 a 0,85 o a 1,25 "gasta" lo mismo, pero a 1,25 recibes un 47 % más. Esperar a la tasa alta rinde mucho más.</p>` },
      { t: 'Tasa si se va a perder', find: inCard(/^Intercambio con aldeas/, /^Tasa si se va a perder/), h: `
        <p>Tasa mínima para un <b>rescate</b>: si un recurso va a rebosar en la próxima recolección, se cambia aunque la tasa sea baja (mejor 0,85 que perderlo).</p>
        ${AUTO('Con tasa menor que 1 solo rescata lo que de verdad se perdería, y solo si no cabe en otra ciudad (o la recolección es inminente).')}` },
      { t: 'Cambiar con pérdida si sobra mucho', find: inCard(/^Intercambio con aldeas/, /^Cambiar con pérdida/), h: `
        <p>Si una ciudad pasa de ese % del almacén en un recurso (85 % por defecto) y en <b>todo el imperio</b> sobra ese recurso mucho más que otro (15 puntos o más, ej. madera al 80 % y plata al 45 %), lo cambia por el que falta aunque la tasa sea baja (desde <b>0,6</b>).</p>
        <p>Deja la ciudad un poco por debajo de ese % y nunca pasa de igualar los dos recursos.</p>` },
      { t: 'Traer de otras ciudades', find: inCard(/^Intercambio con aldeas/, /^Traer de otras/), h: `
        <p>Si una aldea con buena tasa pide, por ejemplo, madera y en esa isla no queda, el comercio <b>trae madera de una ciudad a la que le sobra</b> y, al llegar, se cambia.</p>
        <p>Solo si al imperio le sobra más ese recurso que el que da la aldea. Necesita <b>Comercio</b> y <b>Equilibrio</b> encendidos y solo lo hace cuando no hay encargos pendientes.</p>` },
      { t: 'Vista previa', find: () => TQ.txt('.nb-card-title', /^Próximos cambios|^Aldeas de/)?.parentElement || TQ.card(/^Intercambio con aldeas/), h: `
        <p>Las aldeas de tu ciudad actual con <b>su tasa para esta ciudad</b> (atenuadas si no llegan a la tasa para equilibrar) y los <b>próximos cambios</b> que haría en todo el imperio, con su tipo:</p>
        <ul><li><b>equilibrar</b>: cambio normal con tasa alta.</li><li><b>exceso</b>: sobra muchísimo de ese recurso; se cambia aunque la tasa sea baja.</li><li><b>rescate</b>: el recurso iba a rebosar.</li><li><b>alimentar</b>: cambia lo que el comercio trajo para esa aldea.</li></ul>
        <p>Si la <b>Cueva</b> está activa, solo se cambia por plata (para guardarla) y aparece el ajuste «Con Cueva: cambiar por plata lo que pase de…».</p>` },
      { t: 'Actividad', find: () => TQ.lastCard(/^Actividad/), h: `<p>Lo último que ha hecho: recolecciones, cambios con aldeas, errores. Cada pestaña tiene la suya.</p>` }
    ]);

    // ------------------------------------------------------------------ Construcción
    add('Construcción', 'construccion', [
      { t: 'Construcción', find: () => TQ.tab('construccion'), h: `<p>Le dices hasta qué nivel quieres cada edificio (en cada ciudad) y el bot lo va subiendo solo, sin cambiar de ciudad.</p>` },
      { t: 'Activar: general y por ciudad', find: () => TQ.card(/^Construcción automática/), h: `
        <ul><li><b>Construcción automática</b>: enciende o apaga en <b>todas</b> las ciudades.</li>
        <li><b>Solo [ciudad]</b>: una <b>excepción</b> para la ciudad actual (apagada aunque el general esté encendido, o al revés). Arriba ves cuántas excepciones hay.</li></ul>
        <p>Este patrón general + excepción es igual en Investigación y Reclutamiento.</p>` },
      { t: 'Intercalar y orden estricto', find: inCard(/^Construcción automática/, /^Intercalar/), h: `
        <ul><li><b>Intercalar edificios</b> (<b>por ciudad</b>): sube un nivel de cada edificio por turnos, en el orden de la lista (el turno rota de verdad). Apagado: termina un objetivo antes de empezar el siguiente. Cada ciudad tiene el suyo.</li>
        <li><b>Orden estricto</b>: si el primero está bloqueado (faltan requisitos, almacén pequeño, población…), <b>espera</b> en vez de saltar al siguiente.</li></ul>` },
      { t: 'Siguiente y copiar', find: () => TQ.card(/^Ciudad actual/), h: `
        <p><b>Siguiente</b>: lo próximo que va a encargar en esta ciudad, o por qué no puede (faltan recursos, cola llena, reservado para otro módulo…).</p>
        <p><b>Copiar a todas</b>: copia la lista de objetivos de esta ciudad (y si intercala o no) a todas las demás (pide confirmación).</p>` },
      { t: 'Cola del juego', find: () => TQ.card(/^Cola del juego/), h: `<p>Lo que ya está construyéndose en el juego, con el nivel que deja cada orden y cuánto le queda. Solo lectura.</p>` },
      { t: 'Objetivos del bot', find: () => TQ.card(/^Objetivos del bot/), wide: true, h: `
        <p>La lista de lo que quieres, <b>en orden de prioridad</b>:</p>
        <ul><li><b>− / +</b>: cambia el nivel objetivo. <b>▲ ▼</b>: sube o baja su prioridad. <b>✕</b>: lo quita. <b>Vaciar</b>: quita todos.</li>
        <li>Un mismo edificio puede estar varias veces (Senado 20, Muralla 10, Senado 25…) para intercalar a mano.</li>
        <li>La etiqueta roja <b>derribar</b> baja el edificio hasta ese nivel.</li>
        <li>El resaltado es el <b>siguiente</b>; debajo de cada uno, por qué espera.</li></ul>
        ${AUTO('Cuando un objetivo se cumple (o lo subes tú a mano) se quita solo de la lista.')}` },
      { t: 'Añadir edificio', find: () => TQ.card(/^Añadir edificio/), h: `
        <p>Busca el edificio, pon el nivel con <b>− / +</b> (o escríbelo) y pulsa <b>✓</b>. Se añade <b>al final</b> de la lista.</p>
        <ul><li>Número por encima del actual (verde) = construir.</li><li>Por debajo (rojo) = <b>derribar</b> (pide confirmación).</li></ul>
        <p>El nivel que ves ya cuenta la cola del juego y lo que hay en la lista.</p>` },
      { t: 'Qué hace solo', find: () => TQ.lastCard(/^Actividad/), h: `
        ${AUTO(`<ul>
          <li>Cada 15 s, en todas las ciudades con la construcción activa, encarga el siguiente nivel si hay hueco en la cola (<b>7</b> con Administrador, si no <b>2</b>) y recursos que no estén reservados por la prioridad.</li>
          <li>Salta los edificios bloqueados (requisitos, almacén pequeño, población, nivel máximo) salvo con orden estricto.</li>
          <li>El <b>Comercio</b> le manda lo que falta para <b>todos los niveles que caben en la cola</b>, en el orden en que los va a construir.</li></ul>`)}` }
    ]);

    // ------------------------------------------------------------------ Investigación
    add('Investigación', 'investigacion', [
      { t: 'Investigación', find: () => TQ.tab('investigacion'), h: `<p>Una cola de investigaciones por ciudad que el bot va lanzando en la Academia.</p>` },
      { t: 'Activar y puntos', find: () => TQ.card(/^Investigación automática/), h: `
        <p>Interruptor general + excepción por ciudad (igual que Construcción).</p>
        <p><b>Puntos de investigación</b>: los libres y usados de esta ciudad (según su Academia). <b>Siguiente</b>: lo próximo que investigará o por qué espera.</p>` },
      { t: 'Cola del juego', find: () => TQ.card(/^Cola del juego/), h: `<p>Lo que se está investigando ahora en esta ciudad.</p>` },
      { t: 'Cola del bot', find: () => TQ.card(/^Cola del bot/), h: `<p>Lo que quieres investigar, <b>en este orden</b>. Puedes reordenar y quitar; <b>Vaciar</b> la borra entera.</p>` },
      { t: 'Añadir investigación', find: () => TQ.card(/^Añadir investigación/), h: `
        <p>Las investigaciones que aún no tiene esta ciudad. Pulsa para añadirla al final de la cola.</p>
        ${AUTO('Investiga en cuanto hay hueco, puntos y recursos. El comercio solo le manda recursos para una investigación si la ciudad <b>ya tiene puntos</b> (y Academia/requisitos) para ella. Una tropa sin investigar se puede pedir en Reclutamiento si su investigación está en esta cola.')}` }
    ]);

    // ------------------------------------------------------------------ Reclutamiento
    add('Reclutamiento', 'reclutamiento', [
      { t: 'Reclutamiento', find: () => TQ.tab('reclutamiento'), h: `<p>Pides un <b>total</b> de cada tropa o barco por ciudad y el bot los recluta en <b>lotes grandes</b> hasta llegar.</p>` },
      { t: 'Activar', find: () => TQ.card(/^Reclutamiento automático/), h: `<p>Interruptor general + excepción para la ciudad actual (igual que en Construcción).</p>` },
      { t: 'Empezar más tarde / programar', find: () => TQ.txt('.nb-alert, .nb-row', /^Empezar más tarde|^Empieza en|^Empezar dentro/) || TQ.card(/^Reclutamiento automático/), h: `
        <p><b>Empezar más tarde</b>: la ciudad queda <b>en espera</b>: no recluta, no pide ni reserva recursos (hasta puede donar a otras). Luego pones los minutos y <b>Programar</b>: empezará a esa hora.</p>
        <p>Útil para esperar a un <b>héroe</b> que abarata tropas: el bot te avisa si llega antes o después de empezar.</p>` },
      { t: 'Tamaño del lote', find: inCard(/^Reclutamiento automático/, /^Lote = /), h: `
        <p>Un lote es lo máximo de <b>una sola tropa</b> que cabe en ese % del almacén (cada tropa distinta ocupa un hueco de la cola, por eso no se mezclan).</p>
        ${AUTO(`<ul><li>Primero las tropas a las que les falta al menos un lote completo, en el orden de la lista; los restos, al final.</li>
        <li>El lote se recorta por la <b>población libre</b> y espera a tener <b>todo</b> el lote para reclutarlo de golpe.</li></ul>`)}` },
      { t: 'Lotes por adelantado', find: inCard(/^Reclutamiento automático/, /^Lotes pedidos/), h: `
        <p>Cuántos lotes pide al comercio por delante (1–4). Con 2, mientras llega lo del primero ya viaja lo del segundo: la ciudad no se queda parada esperando al donante más lejano.</p>
        <p>Debajo: <b>Cola Cuartel / Puerto</b> (órdenes en cola / huecos). Si la cola está llena no pide recursos.</p>` },
      { t: 'Hechizos de reclutamiento', find: () => TQ.card(/^Hechizos de reclutamiento/), h: `
        <p>Por ciudad, para Entrenamiento espartano, Crecimiento de la población y La llamada del mar:</p>
        <ul><li><b>No</b>: no se usa.</li><li><b>Opcional</b>: se lanza si hay favor.</li><li><b>Obligatorio</b>: no recluta hasta tenerlo activo (espera al favor y lo lanza solo).</li></ul>
        ${AUTO('Se lanzan justo antes de mandar un lote (a lo que ya está en cola no le afectan).')}` },
      { t: 'Siguiente lote', find: () => TQ.card(/^Siguiente lote/), h: `
        <p>Qué tropa y cuántas, población y favor que usa, y barras con los recursos que tiene la ciudad frente a lo que cuesta.</p>
        <p>Si no hay lote, te dice por qué: cola llena (hasta qué hora), esperando investigación, sin población, en espera, reservado para otro módulo…</p>
        ${AUTO('El coste es el <b>real</b> que muestra el Cuartel/Puerto (con héroes e investigaciones); se relee cada 5 min y al llegar un héroe.')}` },
      { t: 'Tropas y barcos objetivo', find: () => TQ.card(/^Cuartel · tropas objetivo/), h: `
        <p>Lo que has pedido: <b>total</b> que quieres tener. Cambia con <b>−50 / +50</b> o escribiendo; <b>✕</b> lo quita. Debajo está la tarjeta del <b>Puerto</b> con los barcos.</p>
        ${AUTO('Cuenta las tropas en casa, las que están fuera (atacando o apoyando) y las de la cola del juego. Cuando llegas al total, se quita sola de la lista.')}` },
      { t: 'Añadir tropa o barco', find: () => TQ.card(/^Cuartel · añadir/), h: `
        <p>Escribe el <b>total</b> que quieres (no cuántas más) y pulsa <b>✓</b>. Ves cuántas tienes y su coste. Abajo, lo mismo para barcos.</p>
        ${TIP('Lo que escribes no se borra aunque el panel se repinte.')}` },
      { t: 'Qué hace solo', find: () => TQ.lastCard(/^Actividad/), h: `
        ${AUTO(`<ul><li>Cada 15 s revisa todas las ciudades y recluta el lote en cuanto lo tiene (respetando la prioridad).</li>
        <li>El comercio le manda lo que falta para sus lotes y, mientras, la ciudad <b>reserva</b> lo de sus próximos lotes (no lo regala a otras).</li></ul>`)}` }
    ]);

    // ------------------------------------------------------------------ Comercio
    add('Comercio', 'comercio', [
      { t: 'Comercio', find: () => TQ.tab('comercio'), h: `<p>Reparte recursos entre <b>tus</b> ciudades: manda a cada una lo que le falta para lo que tiene pedido, y además evita que se pierdan recursos.</p>` },
      { t: 'Comercio automático', find: () => TQ.card(/^Comercio automático/), wide: true, h: `
        <p>El interruptor general y <b>a qué módulos abastece</b> (es el único sitio donde se elige): construcción, reclutamiento, investigación y festivales.</p>
        ${AUTO(`<ul><li>Cada 10 s calcula qué falta en cada ciudad y lo envía desde las que tienen de sobra.</li>
        <li>Primero lee <b>todos los envíos en camino</b> (vista de comercio del juego) para no mandar de más.</li>
        <li>Nunca dona lo que la ciudad donante va a gastar; una ciudad que espera recursos solo da los que ella no necesita.</li>
        <li>Reparto justo: las ciudades lejanas no se quedan olvidadas (cuanto más esperan, más prioridad).</li>
        <li>Simula el almacén de destino: puede mandar más de lo que cabe si se va a gastar antes de llegar, pero <b>nunca</b> hace que se pierda nada. Descuenta lo que la ciudad producirá mientras viaja el envío.</li>
        <li>Aprende la velocidad real de los comerciantes con cada envío.</li></ul>`)}` },
      { t: 'Ajustes', find: () => TQ.card(/^Ajustes/), h: `
        <ul><li><b>Envío mínimo</b>: no manda envíos más pequeños (salvo que completen lo que falta).</li>
        <li><b>Margen almacén %</b>: hueco que deja libre en el almacén de destino.</li>
        <li><b>Dejar siempre en donante</b>: cantidad mínima que nunca se saca de una ciudad.</li>
        <li><b>Envíos por ciclo</b>: máximo de envíos cada 10 s.</li>
        <li><b>Peso de la espera</b>: cuánto sube la prioridad de una ciudad por cada segundo esperando.</li></ul>` },
      { t: 'Equilibrio entre ciudades', find: () => TQ.card(/^Equilibrio entre ciudades/), wide: true, h: `
        <p>Usa los comerciantes que sobran para que <b>no se pierda nada</b> y cada ciudad tenga de todo. Va <b>siempre detrás de los encargos</b>: solo actúa en las vueltas en que el comercio no tiene nada que enviar.</p>
        <p>La etiqueta dice en qué modo está:</p>
        <ul><li><b>encargos en curso</b>: alguna ciudad espera recursos → evita pérdidas e iguala con poca parte de los comerciantes (20 %), sin tocar lo que alguien espera.</li>
        <li><b>encargos a punto</b>: algo empieza pronto (hueco de cola, lote, festival que termina) → además <b>adelanta</b> a esa ciudad lo que le va a faltar.</li>
        <li><b>libre</b>: usa más comerciantes (60 %) y también trae recursos a las aldeas con buena tasa.</li></ul>` },
      { t: 'Igualar ciudades', find: inCard(/^Equilibrio entre ciudades/, /^Igualar ciudades/), h: `
        <p>Si una ciudad tiene mucho de un recurso y otra poco, lo reparte. Compara con la <b>media del imperio</b>: las que pasan de la media + tolerancia dan a las que están por debajo de la media − tolerancia.</p>
        ${AUTO('La tolerancia se adapta: con el imperio muy lleno se estrecha por arriba (con todo al 78 %, dan las que pasan del 89 % y reciben las que están por debajo del 65 %). Con encargos pendientes o a punto también iguala, pero solo con la parte pequeña de comerciantes.')}` },
      { t: 'Evitar pérdidas al recolectar', find: () => { const c = TQ.card(/^Equilibrio entre ciudades/); return c ? (TQ.txt('.nb-alert', /Rebosaría|Ninguna ciudad rebosa/, c) || c) : null; }, h: `
        ${AUTO(`<ul><li>Calcula el <b>botín de la próxima recolección</b> de cada ciudad (de cada recurso) + lo que produce + lo que le llega.</li>
        <li>Si no cabría, manda lo que sobra a ciudades con sitio: primero a las que lo van a necesitar, luego a las que menos tienen.</li>
        <li>Deja la ciudad en su «línea de seguridad»: sitio para 2 recolecciones y media hora de producción.</li></ul>`)}
        <p>Aquí ves qué ciudades rebosarían ahora mismo y cuánto.</p>` },
      { t: 'Ajustes del equilibrio', find: () => { const c = TQ.card(/^Equilibrio entre ciudades/); return c ? (TQ.row(/^Comerciantes con encargos/, c)?.parentElement || c) : null; }, h: `
        <ul><li><b>Igualar ciudades</b>: si una tiene mucho de un recurso y otra poco, lo reparte.</li>
        <li><b>Comerciantes con encargos</b> (20 %): lo que puede usar como mucho cada ciudad cuando hay encargos pendientes o a punto; el resto queda libre.</li>
        <li><b>Comerciantes sin encargos</b> (60 %).</li>
        <li><b>Encargos «a punto»</b>: qué se considera "pronto" (30 min).</li>
        <li><b>Tolerancia por arriba / por abajo</b>: al igualar, cuánto puede pasarse una ciudad de la media del imperio antes de dar (20) o quedarse corta antes de recibir (13).</li>
        <li><b>Viaje máximo</b>, <b>envío mínimo al igualar</b> y <b>envíos por vuelta</b>.</li></ul>` },
      { t: 'Qué haría ahora', find: () => TQ.txt('.nb-card-title', /^Ahora movería/)?.parentElement || TQ.card(/^Equilibrio entre ciudades/), h: `
        <p>El llenado medio del imperio por recurso, los <b>encargos a punto</b> (si hay) y la lista de envíos que haría ahora, con su tipo: <b>Evitar pérdida</b>, <b>Adelantar encargo</b>, <b>Para cambiar en aldea</b> o <b>Equilibrio</b>.</p>` },
      { t: 'Prioridad de recursos', find: () => TQ.card(/^Prioridad de recursos/), h: `<p>La misma tarjeta que en Inicio, aquí a mano porque decide qué abastece primero el comercio.</p>` },
      { t: 'Necesidades y en camino', find: () => TQ.card(/^Necesidades/), h: `
        <p><b>Necesidades</b>: ciudades esperando recursos, para qué y cuánto falta.</p>
        <p>Debajo, <b>En camino</b>: todos los envíos hacia tus ciudades (también los de aldeas) con su cuenta atrás.</p>` }
    ]);

    // ------------------------------------------------------------------ Festivales
    add('Festivales', 'festivales', [
      { t: 'Festivales', find: () => TQ.tab('festivales'), h: `<p>Lanza festivales (puntos de cultura) en todas las ciudades que pueden.</p>` },
      { t: 'Festivales automáticos', find: () => TQ.card(/^Festivales automáticos/), h: `
        <p>Ciudades con <b>Academia 30+</b> y sin festival en curso. Coste 15 000 madera · 18 000 piedra · 15 000 plata.</p>
        ${AUTO('Cada 10 s: en cuanto una ciudad tiene los recursos (y no están reservados por la prioridad) lo lanza. El comercio le manda justo lo que falta si tienes «Abastecer festivales» encendido.')}` },
      // (oculto con el festival evento: vuelve solo al poner FEST_EVENT_ON = true)
      ...(FEST_EVENT_ON ? [{ t: 'Festival evento', find: () => TQ.card(/^Festival evento/), h: `
        <p>Para la <b>Temporada de festivales</b> del juego: usa el coste, la Academia y la duración del evento. Al encenderlo se apagan los festivales normales.</p>
        <p>Si ahora no hay evento, no hace nada hasta que empiece.</p>` }] : []),
      { t: 'Ciudades aptas', find: () => TQ.card(/^Ciudades aptas/), h: `<p>Estado de cada ciudad: en curso (cuenta atrás), listo, cuánto falta y lo que ya viene de camino, o si está esperando por la prioridad.</p>` }
    ]);

    // ------------------------------------------------------------------ Cueva
    add('Cueva', 'cueva', [
      { t: 'Cueva', find: () => TQ.tab('cueva'), h: `<p>Mete plata en las cuevas (protege contra espías y sirve para espiar).</p>` },
      { t: 'Meter plata en las cuevas', find: () => TQ.card(/^Meter plata/), wide: true, h: `
        <ul><li><b>Plata que se deja siempre</b>: % de la suma de todos tus almacenes que se queda en plata en el imperio para gastar.</li>
        <li><b>Tope por cueva</b>: máximo por cueva (0 = sin tope).</li>
        <li><b>Mínimo por ingreso</b>: no mete menos de esto de una vez.</li></ul>
        ${AUTO('Cada 2 min mira la plata de <b>todo el imperio</b>: lo que pasa de ese % se mete, primero donde más sobra, sin tocar lo que cada ciudad necesita según la prioridad (la Cueva es un módulo más de la prioridad) ni lo que otras ciudades esperan. Cueva 10 = sin límite; si no, 1000 por nivel.')}` },
      { t: 'Relación con las aldeas', find: () => TQ.txt('.nb-alert', /Intercambio con aldeas|Con la Cueva activa/) || TQ.card(/^Meter plata/), h: `
        <p>Con la Cueva activa, el <b>Intercambio con aldeas</b> solo cambia <b>por plata</b>: la madera o piedra que sobra se convierte en plata y la Cueva la guarda. El equilibrio entre ciudades deja de mover plata.</p>` },
      { t: 'Estado de las cuevas', find: () => TQ.card(/^Cuevas/), h: `<p>Por ciudad: nivel de la cueva, plata guardada / máximo y lo siguiente que meterá. <b>Actualizar</b> relee las cuevas del juego.</p>` }
    ]);

    // ------------------------------------------------------------------ Ataques
    add('Ataques', 'ataques', [
      { t: 'Ataques y apoyos', find: () => TQ.tab('ataques'), before: () => { if (atk.view !== 'new') { atk.view = 'new'; return true; } }, h: `<p>Programa ataques y apoyos para que <b>lleguen</b> (o salgan) al segundo exacto.</p>` },
      { t: 'Desde la ventana del juego', find: () => TQ.tab('ataques'), h: `
        <p>En la ventana de <b>Atacar</b> (o Apoyar) del propio juego hay un botón más: <b>Atacar con bot</b>. Elige allí las tropas, el héroe y el hechizo como siempre y púlsalo: se abre aquí el formulario ya relleno, con el <b>tiempo de viaje</b> de ese ejército. Solo te queda poner la hora y programar.</p>` },
      { t: 'Hora del servidor', find: () => TQ.sel('.nb-hero-atk', bodyEl), h: `
        <p>El reloj del <b>servidor</b> (no el de tu PC) y su precisión, y la próxima salida programada.</p>
        ${AUTO('Sincroniza el reloj con cada respuesta del juego hasta unas decenas de milisegundos, y dispara cada orden para que el servidor la procese a mitad del segundo buscado.')}` },
      { t: 'Nuevo / Programados', find: () => TQ.sel('.nb-seg-main', bodyEl), h: `<p><b>Nuevo</b>: el formulario. <b>Programados</b>: la lista de lo que tienes pendiente y lo ya enviado.</p>` },
      { t: '1 y 2 · Origen y objetivo', find: () => TQ.step(2) || TQ.step(1), h: `
        <p><b>Origen</b>: tu ciudad desde la que sale.</p>
        <p><b>Objetivo</b>: busca por nombre, jugador, alianza, id o pega un <b>[town]…[/town]</b>. Debajo salen los recientes. Las tuyas aparecen como <b>tuya</b>: se pueden atacar para probar (avisa de que el juego puede rechazarlo).</p>` },
      { t: '3 · Tipo', find: () => TQ.step(3), h: `<p>Ataque, los tipos especiales que permita el juego (asedio, revuelta…) o <b>Apoyo</b>. Si hay estrategias de ataque, se eligen aquí.</p>` },
      { t: '4 · Tropas, héroe y hechizo', find: () => TQ.step(4), wide: true, h: `
        <ul><li>Escribe cuántas de cada una o pulsa <b>máx</b>. Atajos: Todas, Ofensivas, Solo tierra, Ninguna.</li>
        <li>Cada tropa muestra su tiempo de viaje; la que <b>marca</b> el tiempo se resalta. El viaje se calcula con el <b>mismo código que la ventana del juego</b>: si van barcos, mandan los barcos (la tierra va embarcada, aunque sea la misma isla); cada <b>Sirena</b> acelera los barcos un 2 %; y cuentan los bonus de la ciudad, hechizos y héroe.</li>
        <li><b>Tropas que aún no tengo</b>: para un ataque futuro puedes pedir más de las que hay ahora (tú te aseguras de tenerlas a esa hora). Al salir se envía lo que haya.</li>
        <li><b>Héroe</b>: solo los de la ciudad de origen que estén disponibles.</li>
        <li><b>Hechizo</b>: uno, de los que se pueden lanzar sobre esa orden, con su coste de favor. Con <b>Ultra</b> o <b>Humano</b> no va con el envío: se lanza sobre la orden cuando ya acertó el rango y no se va a cancelar, así no se pierde favor en los intentos.</li></ul>` },
      { t: '5 · Hora', find: () => TQ.step(5), wide: true, h: `
        <ul><li><b>Llegar a las</b> o <b>Salir a las</b> + hora HH:MM:SS del servidor. Botones: <b>ya</b> (lo antes posible), −1s, +1s, +10s, +1m, +10m.</li>
        <li><b>Rango</b> (solo llegar): acepta llegadas entre la hora y el «hasta».</li>
        <li><b>Horas a mano</b> (solo llegar): escribe las horas de llegada que valen, sueltas o por rangos (<code>22:00:01, 22:00:03-22:00:05</code>). Las que no pongas no valen, así puedes saltarte un segundo del medio. La primera pasa a ser la hora de arriba.</li>
        <li><b>Preciso</b>: un envío calculado al milisegundo. <b>Ultra</b> y <b>Humano</b>: envía y, si la llegada cae fuera del rango, cancela y reintenta (esperando a que vuelvan las tropas) hasta acertar o hasta que no dé tiempo.</li></ul>` },
      { t: 'Plan y avisos', find: () => TQ.sel('.nb-plan', bodyEl), h: `
        <p>Viaje, hora de <b>salida</b> y de <b>llegada</b> calculadas con los datos del juego, y avisos: objetivo de tu alianza o con pacto, protección de principiante, <b>modo noche</b>, moral, <b>no caben en los barcos</b> (con botón para añadirlos), tropas que aún no tienes o ya usadas en otro ataque.</p>
        <p>Hueco de los barcos: Bote de transporte 26, Bote rápido 10, +6 cada uno con <b>Literas</b>. Cada tropa ocupa su población; voladoras y héroe no ocupan.</p>` },
      { t: 'Opciones y programar', find: () => TQ.sel('.nb-options', bodyEl), h: `
        <ul><li><b>Si faltan tropas al salir</b>: enviar lo que haya o no enviar. Con «enviar lo que haya», si a otra isla no cabe todo en los barcos, se deja en la ciudad tropa de tierra, el <b>mismo %</b> de cada tipo, hasta que quepa.</li>
        <li><b>Modo tren</b>: tras programar, mantiene el objetivo y adelanta la hora X segundos para meter el siguiente.</li></ul>
        <p>Después, <b>Programar ataque/apoyo</b>: primero lo comprueba con el juego.</p>` },
      { t: 'Programados', before: () => { if (atk.view !== 'queue') { atk.view = 'queue'; return true; } }, find: () => TQ.card(/^Programados/), wide: true, h: `
        <p>Cada orden con su estado (programado, enviando, enviado con el error de llegada, perdido, no enviado…).</p>
        <ul><li><b>+1s</b>: duplica llegando 1 s después (para trenes). <b>✎</b>: editar. <b>✕</b>: cancelar/quitar.</li>
        <li><b>Limpiar terminados</b>: quita los ya enviados.</li></ul>
        ${AUTO(`<ul><li>Los temporizadores van en un proceso aparte: funcionan aunque la pestaña esté en segundo plano.</li>
        <li>35 s antes mira qué va a salir de verdad (tropas que haya, lo que quepa en los barcos, el héroe) y recalcula el viaje con eso, para que la llegada siga siendo exacta; si falta algo, lo avisa en la orden.</li>
        <li>6 s antes precarga las tropas disponibles; después de enviar lee la llegada real y corrige el desfase para los siguientes.</li>
        <li>Si la hora pasó hace más de 8 s (p. ej. el PC se durmió), <b>no lo envía</b> y lo marca como perdido.</li></ul>`)}
        ${WARN('Para que salgan, el juego tiene que estar abierto y el PC despierto a esa hora.')}` }
    ]);

    // ------------------------------------------------------------------ Por detrás + primeros pasos
    add('Resumen final', 'inicio', [
      { t: 'Lo que el bot hace solo (todo junto)', wide: true, h: `
        <ul><li><b>Granjas</b>: recolecta todas las islas en una petición; cada isla, la ciudad que menos pierde.</li>
        <li><b>Aldeas</b> (cada minuto): cambios con tasa alta para equilibrar; con tasa baja (desde 0,6) si sobra muchísimo de algo; rescates si algo va a rebosar.</li>
        <li><b>Construcción / Investigación / Reclutamiento</b> (cada 15 s): encargan lo siguiente sin cambiar de ciudad.</li>
        <li><b>Comercio</b> (cada 10 s): manda lo que falta para los encargos; después, el <b>equilibrio</b> evita pérdidas, adelanta encargos e iguala.</li>
        <li><b>Festivales</b> (cada 10 s) y <b>Cueva</b> (cada 2 min).</li>
        <li><b>Ataques</b>: al segundo, aunque la pestaña esté en segundo plano.</li>
        <li>Lee las vistas generales del juego al arrancar y cada minuto (envíos y colas de todas las ciudades).</li>
        <li>Guarda la configuración por <b>cuenta</b> (mundo + jugador): otra cuenta en el mismo PC no ve la tuya.</li></ul>` },
      { t: 'Primeros pasos recomendados', wide: true, h: `
        <ol style="margin:0 0 8px;padding-left:18px">
          <li><b>Granjas</b>: enciende la recolección y elige el tiempo.</li>
          <li><b>Comercio</b>: enciéndelo (el equilibrio ya viene activado).</li>
          <li><b>Construcción</b>: en cada ciudad añade los edificios y niveles que quieres (o hazlo en una y <b>Copiar a todas</b>).</li>
          <li><b>Investigación</b> y <b>Reclutamiento</b>: añade lo que quieras por ciudad.</li>
          <li>Revisa la <b>Prioridad de recursos</b> en Inicio si quieres que algo vaya antes.</li>
          <li>Opcional: Intercambio con aldeas, Festivales, Cueva, nube.</li></ol>
        <p>Mira la tarjeta <b>Actividad</b> de cada pestaña para ver qué va haciendo. Y si algo no avanza, el propio panel te dice por qué (cola llena, faltan recursos, reservado…).</p>
        ${TIP('Puedes volver a este tour cuando quieras con el botón <b>?</b> de la cabecera, entero o por apartados.')}` }
    ]);
    return S;
  }


  /* Novedades por versión — REGLA: cada cambio que se note en el bot se apunta aquí
     (y se explica en su apartado del tour, arriba). Al actualizar, el panel ofrece
     verlas paso a paso; también están en el índice del "?". Lo más nuevo, primero. */
  const TOUR_NEWS = [
    { v: '1.13.1', items: [
      { t: 'Horas a mano y viaje exacto', tab: 'ataques', find: () => TQ.step(5) || TQ.tab('ataques'), h: `
        <ul><li><b>Horas a mano</b>: en vez de un rango, las horas de llegada que valen (p. ej. <code>22:00:01, 22:00:03</code>, sin el :02). Con Ultra/Humano apunta a la siguiente que valga.</li>
        <li>El viaje se calcula con el mismo código que la ventana del juego (Sirenas, barcos, bonus). Si al venir del juego no coincide con lo que muestra, avisa.</li>
        <li>Puedes atacar tus propias ciudades para probar.</li></ul>` }
    ] },
    { v: '1.13.0', items: [
      { t: 'Atacar con bot desde el juego', tab: 'ataques', before: () => { if (atk.view !== 'new') { atk.view = 'new'; return true; } }, find: () => TQ.tab('ataques'), h: `
        <p>En la ventana de <b>Atacar</b> del juego hay un botón <b>Atacar con bot</b>: se lleva aquí las tropas, el héroe y el hechizo que elegiste, con el tiempo de viaje. Tú pones la hora.</p>` },
      { t: 'Hechizo sin gastar favor en vano', tab: 'ataques', find: () => TQ.step(5) || TQ.tab('ataques'), h: `
        <p>Con <b>Ultra</b> o <b>Humano</b> el hechizo ya no va en cada intento: se lanza sobre la orden cuando acierta el rango y el bot ya no la va a cancelar.</p>` },
      { t: 'Barcos y tropas futuras', tab: 'ataques', find: () => TQ.step(4) || TQ.tab('ataques'), h: `
        <ul><li>Si a otra isla no cabe todo en los barcos, al salir deja tropa de tierra en la ciudad (el mismo % de cada una) hasta que quepa, y lo avisa antes.</li>
        <li><b>Tropas que aún no tengo</b>: programa un ataque con tropas que tendrás a esa hora.</li>
        <li>35 s antes recalcula el viaje con lo que va a salir de verdad.</li></ul>` }
    ] },
    { v: '1.12.6', items: [
      { t: 'Vista general: Construcción e Investigación', tab: 'resumen', before: () => { if (state.resumenView !== 'construccion') { state.resumenView = 'construccion'; return true; } }, find: () => TQ.sel('.nb-seg-main', bodyEl), h: `
        <p>Además de <b>Reclutamiento</b>, la Vista general tiene ahora <b>Construcción</b> e <b>Investigación</b>: una ficha por ciudad con lo que le has pedido al bot, lo siguiente que toca con sus recursos, por qué espera y la cola del juego.</p>` }
    ] },
    { v: '1.12.5', items: [
      { t: 'Intercalar, por ciudad', tab: 'construccion', find: inCard(/^Construcción automática/, /^Intercalar/), h: `<p><b>Intercalar edificios</b> ya no es general: cada ciudad tiene el suyo. Las ciudades que no toques siguen como estaban. <b>Copiar a todas</b> también copia esta opción.</p>` }
    ] },
    { v: '1.12.4', items: [
      { t: 'Festivales: vuelven los normales', tab: 'festivales', find: () => TQ.card(/^Festivales automáticos/), h: `<p>La «Temporada de festivales» terminó: se quita la opción <b>Festival evento</b> y, si la tenías puesta, se vuelve a los <b>festivales normales</b> (Academia 30+, 15 000 / 18 000 / 15 000).</p>` }
    ] },
    { v: '1.12.3', items: [
      { t: 'Novedades en la ayuda', find: () => TQ.sel('.nb-help-btn'), h: `<p>Cada vez que el bot se actualiza, te enseña aquí lo que ha cambiado, paso a paso. También lo tienes en <b>?</b> → <b>Novedades</b>.</p>` }
    ] },
    { v: '1.12.2', items: [
      { t: 'Tolerancia por abajo', tab: 'comercio', find: () => { const c = TQ.card(/^Equilibrio entre ciudades/); return c ? (TQ.row(/^Tolerancia por abajo/, c) || c) : null; }, h: `<p>Al igualar, ahora <b>reciben</b> las ciudades que están por debajo de la media del imperio − 13 puntos (con la media al 78 %, las que tienen menos del <b>65 %</b>). Antes era el 58 %.</p>` }
    ] },
    { v: '1.12.1', items: [
      { t: 'Igualar también con encargos', tab: 'comercio', find: () => { const c = TQ.card(/^Equilibrio entre ciudades/); return c ? (TQ.row(/^Igualar ciudades/, c) || c) : null; }, h: `
        <p>Antes solo se igualaba cuando no había nada pendiente, y con 20+ ciudades casi nunca pasaba. Ahora iguala <b>siempre</b>; con encargos, solo con el 20 % de los comerciantes y sin tocar lo que alguien espera.</p>
        <p>La tolerancia por arriba se adapta a lo lleno que esté el imperio: con todo al 78 %, dan las ciudades que pasan del <b>89 %</b> (antes hacía falta pasar del 98 %).</p>` },
      { t: 'Cambiar con pérdida si sobra mucho', tab: 'granjas', find: inCard(/^Intercambio con aldeas/, /^Cambiar con pérdida/), h: `
        <p>Si una ciudad pasa del <b>85 %</b> de un recurso y en todo el imperio sobra ese recurso mucho más que otro (p. ej. madera 78 % y plata 49 %), lo cambia en las aldeas por el que falta aunque la tasa sea baja (desde <b>0,6</b>). Los dos números se pueden cambiar.</p>` }
    ] },
    { v: '1.12.0', items: [
      { t: 'Tour guiado', find: () => TQ.sel('.nb-help-btn'), h: `<p>El botón <b>?</b> enseña todo el bot paso a paso, entero o por apartados.</p>` }
    ] },
    { v: '1.11.0', items: [
      { t: 'Los encargos van primero', tab: 'comercio', find: () => TQ.card(/^Equilibrio entre ciudades/), h: `
        <p>El equilibrio solo actúa en las vueltas en que el comercio no tiene nada que enviar para encargos, y con encargos pendientes o a punto deja libre el <b>80 %</b> de los comerciantes (ajustable).</p>
        <p><b>Adelantar encargos</b>: si algo empieza pronto (hueco en la cola de construcción, lote de tropas, festival que termina), le lleva antes lo que le va a faltar. La lista sale en <b>Encargos a punto</b>.</p>` }
    ] },
    { v: '1.10.1', items: [
      { t: 'Qué abastece el comercio: solo en Comercio', tab: 'comercio', find: () => TQ.card(/^Comercio automático/), h: `<p>Los interruptores de abastecer (construcción, reclutamiento, investigación y ahora también <b>festivales</b>) están solo aquí; se quitaron de Reclutamiento y Festivales.</p>` }
    ] },
    { v: '1.10.0', items: [
      { t: 'Equilibrio entre ciudades', tab: 'comercio', find: () => TQ.card(/^Equilibrio entre ciudades/), h: `
        <p>Nuevo: antes de cada recolección calcula el botín de cada ciudad y lo que no cabría lo manda a otras ciudades con sitio. También reparte entre ciudades y trae recursos a las aldeas que tienen buena tasa.</p>` },
      { t: 'Intercambio con aldeas más listo', tab: 'granjas', find: () => TQ.card(/^Intercambio con aldeas/), h: `
        <ul><li>Calcula la <b>tasa real de cada ciudad</b> (antes usaba la de la ciudad abierta y el +0,1 de la Oficina comercial engañaba).</li>
        <li>Los cambios normales, solo con <b>tasa alta</b> (rinde mucho más); con tasa baja solo si se iba a perder.</li>
        <li><b>Traer de otras ciudades</b> lo que pide una aldea con buena tasa.</li></ul>` },
      { t: 'Granjas: recolecta la que menos pierde', tab: 'granjas', find: () => TQ.card(/^Recolección automática/), h: `<p>En islas con varias ciudades, recolecta la que menos perdería por tener el almacén lleno.</p>` }
    ] }
  ];
  const vNum = (v) => String(v || '0').split('.').map((n) => +n || 0).reduce((a, n) => a * 1000 + n, 0);
  const newsSince = (seen) => TOUR_NEWS.filter((n) => vNum(n.v) > vNum(seen));
  function newsSteps(seen = '') {
    const list = newsSince(seen);
    if (!list.length) return [];
    const out = [{ ch: 'Novedades', t: `Novedades${seen ? ` desde la v${seen}` : ''}`, wide: true, h: `
      <p>Lo que ha cambiado, versión a versión. Ahora te lo enseño en el panel.</p>
      <ul>${list.map((n) => `<li><b>v${n.v}</b>: ${n.items.map((i) => i.t).join(' · ')}</li>`).join('')}</ul>` }];
    for (const n of list) for (const i of n.items) out.push({ ch: 'Novedades', tab: i.tab || 'inicio', ...i, t: `v${n.v} · ${i.t}` });
    return out;
  }
  function markNewsSeen() { if (state.newsSeen !== VERSION) { state.newsSeen = VERSION; saveState(); } }
  // Al arrancar / abrir: primera vez → bienvenida; tras actualizar → novedades.
  function tourAutoOffer() {
    if (!state.open || tour.active || tour.menu) return;
    if (!state.tourSeen) { tourMenu(true); return; }
    if (state.newsSeen !== VERSION && newsSince(state.newsSeen || '').length) tourMenu('news');
  }

  // ---- Motor ----
  function tourOverlay() {
    if (tour.els) return tour.els;
    const block = el('div', { class: 'nb-tour-block' });
    const dim = el('div', { class: 'nb-tour-dim' });
    const spot = el('div', { class: 'nb-tour-spot' });
    const card = el('div', { class: 'nb-tour-card' });
    block.addEventListener('mousedown', (e) => e.stopPropagation());
    block.addEventListener('click', (e) => e.stopPropagation());
    // La rueda sigue moviendo el panel (para ver lo que hay alrededor del recuadro).
    block.addEventListener('wheel', (e) => { if (bodyEl) bodyEl.scrollTop += e.deltaY; }, { passive: true });
    root.appendChild(block); root.appendChild(dim); root.appendChild(spot); root.appendChild(card);
    tour.els = { block, dim, spot, card };
    return tour.els;
  }
  function tourRemoveOverlay() {
    if (!tour.els) return;
    for (const n of Object.values(tour.els)) n.remove();
    tour.els = null;
  }
  function tourRender() {
    tour.rendering = true;
    try { renderBodyNow(); } finally { tour.rendering = false; tour.dirty = false; }
  }
  function tourKey(e) {
    if (!tour.active && !tour.menu) return;
    const k = e.key;
    if (!['ArrowRight', 'ArrowLeft', 'Enter', 'Escape'].includes(k)) return;
    e.preventDefault(); e.stopPropagation();
    if (tour.menu) { if (k === 'Escape') tourMenuClose(true); return; }
    if (k === 'Escape') tourEnd();
    else if (k === 'ArrowLeft') tourGo(tour.i - 1);
    else tourGo(tour.i + 1);
  }
  function tourStart(steps, idx = 0) {
    if (!panel || !steps.length) return;
    tourCss();
    tourMenuClose(false);
    if (!tour.active) tour.saved = { tab: state.activeTab, resumenView: state.resumenView, atkView: atk.view };
    tour.steps = steps; tour.active = true; tour.i = -1;
    if (!state.open) setOpen(true);
    tourOverlay().card.style.display = '';
    document.addEventListener('keydown', tourKey, true);
    window.addEventListener('resize', tourPlace);
    clearInterval(tour.timer);
    tour.timer = setInterval(tourPlace, 200);
    tourGo(idx);
  }
  function tourGo(i) {
    if (!tour.active) return;
    if (i >= tour.steps.length) { tourEnd(); return; }
    i = clamp(i, 0, tour.steps.length - 1);
    tour.i = i;
    const s = tour.steps[i];
    let need = tour.dirty;
    if (s.tab && state.activeTab !== s.tab) { state.activeTab = s.tab; buildTabs(); need = true; }
    try { if (s.before && s.before() === true) need = true; } catch {}
    if (need) tourRender();
    // Tras el repintado (y los iconos que se añaden en un microtask).
    setTimeout(() => {
      if (!tour.active || tour.i !== i) return;
      let t = null;
      try { t = s.find ? s.find() : null; } catch {}
      tour.target = t;
      if (t) {
        const r = t.getBoundingClientRect();
        t.scrollIntoView({ block: r.height > window.innerHeight * 0.7 ? 'start' : 'center', behavior: 'smooth' });
      }
      tourPaintCard(s, !!(s.find && !t));
      tourPlace();
    }, 30);
  }
  function tourPaintCard(s, missing) {
    const { card } = tourOverlay();
    const n = tour.steps.length, i = tour.i;
    card.className = `nb-tour-card${s.wide ? ' nb-tour-wide' : ''}`;
    card.innerHTML = '';
    const body = el('div', { class: 'nb-tour-body', html: s.h || '' });
    card.appendChild(el('div', { class: 'nb-tour-top' }, [
      el('div', {}, [el('div', { class: 'nb-tour-ch' }, s.ch), el('div', { class: 'nb-tour-title' }, s.t)]),
      el('span', { class: 'nb-tour-x', title: 'Salir (Esc)', onclick: () => tourEnd() }, '×')
    ]));
    card.appendChild(body);
    if (missing) card.appendChild(el('div', { class: 'nb-tour-miss' }, 'Ahora mismo este elemento no se ve en tu partida (depende de tus datos), pero funciona como se explica.'));
    const last = i === n - 1;
    card.appendChild(el('div', { class: 'nb-tour-foot' }, [
      el('span', { class: 'nb-tour-btn', onclick: () => tourMenu(false) }, 'Índice'),
      el('div', { class: 'nb-tour-prog' }, [el('i', { style: `width:${Math.round((i + 1) / n * 100)}%` })]),
      el('span', { class: 'nb-tour-count' }, `${i + 1} / ${n}`),
      el('span', { class: `nb-tour-btn${i === 0 ? ' off' : ''}`, onclick: () => tourGo(i - 1) }, '‹'),
      el('span', { class: 'nb-tour-btn primary', onclick: () => tourGo(i + 1) }, last ? 'Terminar' : 'Siguiente ›')
    ]));
  }
  // Coloca el recuadro sobre el elemento y la tarjeta a su lado (donde quepa).
  function tourPlace() {
    if (!tour.active || !tour.els) return;
    const { spot, dim, card } = tour.els;
    const vw = window.innerWidth, vh = window.innerHeight, M = 12;
    let t = tour.target;
    if (t && !t.isConnected) {
      // El panel se repintó: se vuelve a buscar el elemento.
      try { t = tour.target = tour.steps[tour.i]?.find?.() || null; } catch { t = null; }
    }
    const r = t ? t.getBoundingClientRect() : null;
    const visible = r && r.width > 0 && r.height > 0;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x, y;
    if (!visible) {
      spot.style.display = 'none'; dim.style.display = 'block';
      x = (vw - cw) / 2; y = (vh - ch) / 2;
    } else {
      dim.style.display = 'none'; spot.style.display = 'block';
      const pad = 6;
      const L = clamp(r.left - pad, 2, vw - 4), T = clamp(r.top - pad, 2, vh - 4);
      const R = clamp(r.right + pad, L + 4, vw - 2), B = clamp(r.bottom + pad, T + 4, vh - 2);
      Object.assign(spot.style, { left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px` });
      const tries = [
        () => ({ x: R + 14, y: clamp(T, M, vh - ch - M), ok: R + 14 + cw <= vw - M }),
        () => ({ x: L - 14 - cw, y: clamp(T, M, vh - ch - M), ok: L - 14 - cw >= M }),
        () => ({ x: clamp(L, M, vw - cw - M), y: B + 14, ok: B + 14 + ch <= vh - M }),
        () => ({ x: clamp(L, M, vw - cw - M), y: T - 14 - ch, ok: T - 14 - ch >= M })
      ];
      let p = null;
      for (const f of tries) { const q = f(); if (q.ok) { p = q; break; } }
      // Sin sitio alrededor (elemento enorme): abajo a la derecha, encima del elemento.
      if (!p) p = { x: vw - cw - M, y: vh - ch - M };
      x = p.x; y = p.y;
    }
    card.style.left = `${Math.round(clamp(x, M, Math.max(M, vw - cw - M)))}px`;
    card.style.top = `${Math.round(clamp(y, M, Math.max(M, vh - ch - M)))}px`;
  }
  function tourEnd() {
    if (!tour.active) return;
    tour.active = false;
    clearInterval(tour.timer); tour.timer = null;
    window.removeEventListener('resize', tourPlace);
    if (!tour.menu) document.removeEventListener('keydown', tourKey, true);
    tourRemoveOverlay();
    const sv = tour.saved || {};
    if (sv.tab) state.activeTab = sv.tab;
    if (sv.resumenView !== undefined) state.resumenView = sv.resumenView;
    if (sv.atkView) atk.view = sv.atkView;
    state.tourSeen = true;
    if (tour.steps.some((x) => x.ch === 'Novedades') || !state.newsSeen) state.newsSeen = VERSION;
    saveState();
    try { buildTabs(); } catch {}
    renderBodyNow();
  }

  // Índice: tour completo, solo la pestaña actual o un apartado.
  function tourMenu(welcome = false) {
    tourCss();
    const isNews = welcome === 'news';
    if (isNews) welcome = false;
    const steps = tourSteps();
    const news = newsSteps(isNews ? (state.newsSeen || '') : '');
    const chapters = [];
    for (const s of steps) if (!chapters.some((c) => c.ch === s.ch)) chapters.push({ ch: s.ch, tab: s.tab, n: steps.filter((x) => x.ch === s.ch).length });
    const wasActive = tour.active;
    const curCh = wasActive ? tour.steps[tour.i]?.ch : null;
    if (wasActive) { tour.els.card.style.display = 'none'; tour.els.spot.style.display = 'none'; tour.els.dim.style.display = 'block'; clearInterval(tour.timer); }
    tourMenuClose(false);
    const dim = el('div', { class: 'nb-tour-dim', style: 'display:block' });
    const block = el('div', { class: 'nb-tour-block' });
    const tabCh = chapters.find((c) => c.tab === state.activeTab && c.ch !== 'El panel' && c.ch !== 'Resumen final');
    const go = (list) => { tourMenuClose(false); tourStart(list, 0); };
    const goNews = () => { markNewsSeen(); go(news); };
    const card = el('div', { class: 'nb-tour-card nb-tour-wide' }, [
      el('div', { class: 'nb-tour-top' }, [
        el('div', {}, [el('div', { class: 'nb-tour-ch' }, isNews ? 'Actualización' : 'Tour guiado'), el('div', { class: 'nb-tour-title' }, isNews ? `NOVABOT se ha actualizado a la v${VERSION}` : welcome ? '¿Primera vez con NOVABOT?' : '¿Qué quieres ver?')]),
        el('span', { class: 'nb-tour-x', title: 'Cerrar (Esc)', onclick: () => tourMenuClose(true) }, '×')
      ]),
      el('div', { class: 'nb-tour-body', html: isNews
        ? `<p>Esto es lo nuevo:</p><ul>${newsSince(state.newsSeen || '').map((n) => `<li><b>v${n.v}</b>: ${n.items.map((i) => i.t).join(' · ')}</li>`).join('')}</ul>`
        : welcome
        ? '<p>Te enseño el bot paso a paso: cada pestaña, cada opción y lo que hace solo por detrás. No cambia nada de tu configuración.</p>'
        : '<p>El tour completo recorre todo en orden. También puedes ver solo un apartado o las novedades de cada versión.</p>' }),
      el('div', { class: 'nb-tour-foot', style: 'margin-top:4px' }, [
        isNews ? el('span', { class: 'nb-tour-btn primary', onclick: goNews }, `Ver novedades (${news.length} pasos)`) : null,
        isNews ? el('span', { class: 'nb-tour-btn', onclick: () => { markNewsSeen(); tourMenuClose(true); } }, 'Ahora no') : null,
        !isNews ? el('span', { class: 'nb-tour-btn primary', onclick: () => go(steps) }, `Tour completo (${steps.length} pasos)`) : null,
        tabCh && !isNews ? el('span', { class: 'nb-tour-btn', onclick: () => go(steps.filter((s) => s.ch === tabCh.ch)) }, `Solo ${tabCh.ch}`) : null,
        !isNews && news.length ? el('span', { class: 'nb-tour-btn', onclick: goNews }, 'Novedades') : null,
        welcome ? el('span', { class: 'nb-tour-btn', onclick: () => tourMenuClose(true) }, 'Ahora no') : null
      ]),
      isNews ? null : el('div', { class: 'nb-tour-chapters' }, chapters.map((c) => el('div', { class: `nb-tour-chapter${c.ch === curCh ? ' cur' : ''}`, onclick: () => go(steps.filter((s) => s.ch === c.ch)) }, [
        el('b', {}, c.ch), el('small', {}, `${c.n} paso${c.n > 1 ? 's' : ''}`)
      ])))
    ]);
    root.appendChild(block); root.appendChild(dim); root.appendChild(card);
    tour.menu = { dim, block, card, wasActive };
    document.addEventListener('keydown', tourKey, true);
    requestAnimationFrame(() => {
      card.style.left = `${Math.max(12, Math.round((window.innerWidth - card.offsetWidth) / 2))}px`;
      card.style.top = `${Math.max(12, Math.round((window.innerHeight - card.offsetHeight) / 2))}px`;
    });
  }
  // resume = volver al tour que estaba abierto (o cerrar del todo si no había).
  function tourMenuClose(resume) {
    const m = tour.menu;
    if (!m) return;
    for (const n of [m.dim, m.block, m.card]) n.remove();
    tour.menu = null;
    if (resume) {
      if (m.wasActive && tour.active) {
        tour.els.card.style.display = '';
        clearInterval(tour.timer); tour.timer = setInterval(tourPlace, 200);
        tourGo(tour.i);
      } else {
        document.removeEventListener('keydown', tourKey, true);
        if (!state.tourSeen) { state.tourSeen = true; saveState(); }
        markNewsSeen();
      }
    }
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


  /* ---------------------------------------------------------------------------------
     9) SINCRONIZACIÓN EN LA NUBE (misma configuración en cualquier PC)
     -----------------------------------------------------------------------------
     Dónde: un Gist SECRETO de tu cuenta de GitHub ("NOVABOT sync"), un archivo por
     mundo y jugador (novabot_<mundo>_<jugador>.json).
     Seguridad:
       · El token de GitHub (solo permiso "Gists") y la contraseña se guardan en el
         almacenamiento privado de Tampermonkey de ESE PC: no van en el script ni en
         GitHub, y la página del juego no puede leerlos.
       · Los datos se CIFRAN (AES-GCM 256, clave PBKDF2 de tu contraseña) antes de
         subirlos: quien viera el gist solo vería texto cifrado, y cualquier cambio
         hecho por otro rompe el cifrado y se descarta.
       · Lo que se descarga son solo datos (JSON): nunca se ejecuta nada, así que no
         puede afectar al PC.
     Qué se sincroniza: toda la configuración del bot (objetivos, colas, prioridad,
     comercio…) y los ataques programados. NO: posición/tamaño del panel.
     Al conectar: si ya hay datos en la nube se CARGAN; si no, se suben los de este PC.
     Después: cada cambio se sube (a los 8 s) y cada 60 s se baja lo del otro PC.
  --------------------------------------------------------------------------------- */
  const CLOUD_LOCAL_ONLY = new Set(['open', 'activeTab', 'pos', 'fabPos', 'size', 'layoutV', 'resumenView']);
  const gmGet = (k, d = '') => { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d; } catch { return d; } };
  const gmSet = (k, v) => { try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch {} };
  const cloud = {
    token: '', pass: '', gistId: '', booting: false, // credenciales POR CUENTA: se cargan en cloudLoadCreds()
    pcId: gmGet('nb_pc_id') || (() => { const id = Math.random().toString(36).slice(2, 10); gmSet('nb_pc_id', id); return id; })(),
    status: '', error: '', lastPush: 0, lastPull: 0, remoteAt: 0, dirty: false, applying: false, busy: false, pushTimer: null, pollTimer: null, started: false
  };
  const cloudOn = () => !!(ACCOUNT && cloud.token && cloud.pass && cloud.gistId);
  // Credenciales de ESTA cuenta (otra cuenta en el mismo PC sale desconectada).
  function cloudLoadCreds() {
    cloud.token = gmGet(acctKey('nb_cloud_token')); cloud.pass = gmGet(acctKey('nb_cloud_pass')); cloud.gistId = gmGet(acctKey('nb_cloud_gist'));
  }
  function cloudSaveCreds() {
    gmSet(acctKey('nb_cloud_token'), cloud.token); gmSet(acctKey('nb_cloud_pass'), cloud.pass); gmSet(acctKey('nb_cloud_gist'), cloud.gistId);
  }
  // Último cambio local aún SIN subir (sobrevive a recargas y a cerrar la pestaña).
  const cloudDirtyAt = () => +gmGet(acctKey('nb_cloud_dirty_at'), 0) || 0;
  // Al arrancar: SIEMPRE se sincroniza primero con la nube (antes de que los módulos
  // empiecen): se baja lo nuevo y solo se sube lo que este PC cambió y no subió.
  async function cloudBoot() {
    if (!cloudOn()) return;
    cloud.booting = true; cloud.status = 'Bajando de la nube…'; paintCloudStatus();
    try { await cloudSync(); } finally { cloud.booting = false; }
  }
  const cloudFile = () => `novabot_${UW.Game?.world_id || 'mundo'}_${UW.Game?.player_id || 'jugador'}.json`;

  function ghApi(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: `https://api.github.com${path}`, timeout: 20000,
        headers: { Authorization: `Bearer ${cloud.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => { let j = null; try { j = JSON.parse(r.responseText || 'null'); } catch {} (r.status >= 200 && r.status < 300) ? resolve(j) : reject(new Error(`GitHub ${r.status}${j?.message ? `: ${j.message}` : ''}`)); },
        onerror: () => reject(new Error('Sin conexión con GitHub')), ontimeout: () => reject(new Error('GitHub no responde'))
      });
    });
  }
  function rawGet(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, timeout: 20000, headers: { Authorization: `Bearer ${cloud.token}` },
      onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error(`GitHub ${r.status}`))), onerror: () => reject(new Error('Sin conexión')), ontimeout: () => reject(new Error('Tiempo agotado')) }));
  }
  // ---- cifrado (WebCrypto) ----
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function cloudKey(salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(cloud.pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function cloudEncrypt(obj) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cloudKey(salt), new TextEncoder().encode(JSON.stringify(obj)));
    return JSON.stringify({ novabot: 1, alg: 'AES-GCM-256/PBKDF2-200k', salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) });
  }
  async function cloudDecrypt(text) {
    const o = JSON.parse(text);
    if (!o?.novabot || !o.data) throw new Error('Formato desconocido en la nube');
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await cloudKey(unb64(o.salt)), unb64(o.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch { throw new Error('No se pudo descifrar: contraseña distinta o datos alterados'); }
  }
  // ---- qué se sube / cómo se aplica ----
  /* Sincronización con FUSIÓN a 3 bandas (como git): se guarda la "base" = lo último
     que este PC y la nube tuvieron en común. En cada sincronización se compara, trozo a
     trozo (cada módulo y, dentro, cada ciudad; cada ataque por separado):
       · solo cambió aquí → se sube lo de aquí;  · solo cambió en la nube → se baja;
       · cambió en los dos → gana el cambio más reciente.
     Así, si dejas este PC abierto (o dormido), usas otro y vuelves, al despertar o al
     volver a la pestaña baja lo del otro PC sin pisarlo, y nunca sube nada sin antes
     haber mirado la nube. */
  function cloudPayload() {
    const st = {};
    for (const [k, v] of Object.entries(state)) if (!CLOUD_LOCAL_ONLY.has(k)) st[k] = v;
    const attacks = atk.queue.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_'))));
    return { v: 1, updatedAt: Date.now(), pcId: cloud.pcId, version: VERSION, state: st, attacks };
  }
  // Trocea estado + ataques en unidades comparables: "modulo", "modulo.towns.<id>", "atk.<id>".
  function cloudUnits(st, attacks) {
    const u = new Map();
    for (const [k, v] of Object.entries(st || {})) {
      if (CLOUD_LOCAL_ONLY.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.towns && typeof v.towns === 'object' && !Array.isArray(v.towns)) {
        const { towns, ...rest } = v;
        u.set(k, JSON.stringify(rest));
        for (const [id, tv] of Object.entries(towns)) u.set(`${k}.towns.${id}`, JSON.stringify(tv));
      } else u.set(k, JSON.stringify(v));
    }
    for (const a of attacks || []) if (a && a.id) u.set(`atk.${a.id}`, JSON.stringify(Object.fromEntries(Object.entries(a).filter(([x]) => !x.startsWith('_')))));
    return u;
  }
  function cloudFromUnits(u) {
    const st = {}, towns = {}, attacks = [];
    for (const [path, json] of u) {
      if (json === undefined) continue;
      const v = JSON.parse(json);
      if (path.startsWith('atk.')) { attacks.push(v); continue; }
      const m = /^([^.]+)\.towns\.(.+)$/.exec(path);
      if (m) { (towns[m[1]] || (towns[m[1]] = {}))[m[2]] = v; continue; }
      st[path] = v;
    }
    for (const [k, t] of Object.entries(towns)) { if (!st[k] || typeof st[k] !== 'object') st[k] = {}; st[k].towns = t; }
    attacks.sort((a, b) => (+a.executeAt || 0) - (+b.executeAt || 0));
    return { state: st, attacks };
  }
  // base/local/remote: Map ruta → json (undefined = no existe). preferLocal decide empates.
  function cloudMerge(base, local, remote, preferLocal) {
    const out = new Map();
    const keys = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
    for (const k of keys) {
      const b = base.get(k), l = local.get(k), r = remote.get(k);
      const v = l === r ? l : l === b ? r : r === b ? l : (preferLocal ? l : r);
      if (v !== undefined) out.set(k, v);
    }
    return out;
  }
  const sameUnits = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  function cloudLoadBase() {
    try { const o = JSON.parse(gmGet(acctKey('nb_cloud_base'), '') || 'null'); return o && Array.isArray(o.u) ? new Map(o.u) : null; } catch { return null; }
  }
  const cloudSaveBase = (u) => gmSet(acctKey('nb_cloud_base'), JSON.stringify({ u: [...u] }));

  function cloudApply(r) {
    if (!r || typeof r !== 'object' || typeof r.state !== 'object') return;
    cloud.applying = true;
    try {
      const def = defaultState();
      for (const [k, v] of Object.entries(r.state)) {
        if (CLOUD_LOCAL_ONLY.has(k) || !(k in def)) continue;          // solo claves conocidas
        if (typeof v !== typeof def[k] && def[k] !== null) continue;    // y del tipo esperado
        state[k] = (v && typeof v === 'object' && !Array.isArray(v) && def[k] && typeof def[k] === 'object') ? { ...def[k], ...v } : v;
      }
      saveState();
      if (Array.isArray(r.attacks)) {
        const sending = atk.queue.filter((a) => a.status === 'sending');
        for (const a of atk.queue) atkTimerClear(a.id);
        atk.queue = [...r.attacks.filter((a) => a && typeof a === 'object' && a.id && !sending.some((x) => x.id === a.id)), ...sending];
        atkSave();
      }
      cloud.remoteAt = +r.updatedAt || Date.now();
    } finally { cloud.applying = false; }
    if (bodyEl) renderIfIdle();
  }
  function cloudMarkDirty() {
    if (cloud.applying || !cloudOn()) return;
    cloud.dirty = true; cloud.gen = (cloud.gen || 0) + 1;
    gmSet(acctKey('nb_cloud_dirty_at'), Date.now());
    if (cloud.booting) return; // no subir nada hasta haber sincronizado al arrancar
    clearTimeout(cloud.pushTimer);
    cloud.pushTimer = setTimeout(() => cloudSync(), 8000);
  }
  // force: 'remote' = quedarse con lo de la nube tal cual; 'local' = subir lo de aquí tal cual.
  async function cloudSync(force = null) {
    if (!cloudOn()) return;
    if (cloud.busy) { clearTimeout(cloud.pushTimer); cloud.pushTimer = setTimeout(() => cloudSync(force), 3000); return; }
    cloud.busy = true; paintCloudStatus();
    const gen0 = cloud.gen || 0;
    try {
      const g = await ghApi('GET', `/gists/${cloud.gistId}`);
      cloud.lastPull = Date.now(); cloud.error = '';
      const f = g?.files?.[cloudFile()];
      // Nada nuevo en la nube ni aquí → no hace falta descifrar.
      if (!force && f && !cloud.dirty && g.updated_at && g.updated_at === cloud.gistAt) { cloud.status = 'Sincronizado'; return; }
      const r = f ? await cloudDecrypt(f.truncated && f.raw_url ? await rawGet(f.raw_url) : f.content) : null;
      const localAt = cloudDirtyAt();
      const local = cloudUnits(cloudPayload().state, cloudPayload().attacks);
      const remote = r ? cloudUnits(r.state, r.attacks) : new Map();
      const base = cloudLoadBase();
      let merged;
      if (!r || force === 'local') merged = local;
      else if (force === 'remote') merged = remote;
      else if (!base) merged = localAt > +r.updatedAt ? local : remote;   // primera vez en este PC: gana lo más reciente
      else merged = cloudMerge(base, local, remote, localAt > +r.updatedAt);
      let changedHere = false;
      if (r && !sameUnits(merged, local)) {
        const m = cloudFromUnits(merged);
        cloudApply({ ...m, updatedAt: r.updatedAt });
        changedHere = true;
      }
      const now = cloudUnits(cloudPayload().state, cloudPayload().attacks);
      if (!r || !sameUnits(now, remote)) {
        const content = await cloudEncrypt(cloudPayload());
        const res = await ghApi('PATCH', `/gists/${cloud.gistId}`, { files: { [cloudFile()]: { content } } });
        cloud.gistAt = res?.updated_at || ''; cloud.lastPush = Date.now();
        cloudSaveBase(now);
        cloud.status = changedHere ? 'Sincronizado (fusionado con lo de otro PC)' : 'Sincronizado (subido)';
      } else {
        cloud.gistAt = g.updated_at || '';
        cloudSaveBase(remote);
        cloud.status = changedHere ? `Cargado de la nube (${new Date(+r.updatedAt).toLocaleTimeString('es-ES')})` : 'Sincronizado';
      }
      // Si algo cambió aquí mientras se sincronizaba, queda pendiente para la siguiente.
      if ((cloud.gen || 0) === gen0) { cloud.dirty = false; gmSet(acctKey('nb_cloud_dirty_at'), 0); }
      else { clearTimeout(cloud.pushTimer); cloud.pushTimer = setTimeout(() => cloudSync(), 5000); }
    } catch (e) { cloud.error = e.message; if (cloud.dirty) { clearTimeout(cloud.pushTimer); cloud.pushTimer = setTimeout(() => cloudSync(), 60000); } }
    finally { cloud.busy = false; paintCloudStatus(); }
  }
  // (nombres antiguos usados por los botones)
  const cloudPush = () => cloudSync('local');
  const cloudPull = (force = false) => cloudSync(force ? 'remote' : null);
  async function cloudReadRemote() {
    const g = await ghApi('GET', `/gists/${cloud.gistId}`);
    const f = g?.files?.[cloudFile()];
    if (!f) return null;
    const text = f.truncated && f.raw_url ? await rawGet(f.raw_url) : f.content;
    return cloudDecrypt(text);
  }
  // Conectar: busca (o crea) el gist secreto "NOVABOT sync". Si ya hay datos de esta
  // cuenta, se CARGAN; si no, se suben los de este PC.
  async function cloudConnect(token, pass) {
    cloud.token = token.trim(); cloud.pass = pass;
    cloud.error = ''; cloud.status = 'Conectando…'; paintCloudStatus();
    try {
      let gist = null;
      for (let page = 1; page <= 5 && !gist; page++) {
        const list = await ghApi('GET', `/gists?per_page=100&page=${page}`);
        if (!Array.isArray(list) || !list.length) break;
        gist = list.find((g) => g.description === 'NOVABOT sync') || null;
      }
      if (!gist) {
        const content = await cloudEncrypt(cloudPayload());
        gist = await ghApi('POST', '/gists', { description: 'NOVABOT sync', public: false, files: { [cloudFile()]: { content } } });
        cloud.gistId = gist.id; cloud.lastPush = Date.now();
        cloudSaveBase(cloudUnits(cloudPayload().state, cloudPayload().attacks));
        cloud.status = 'Conectado: configuración de este PC subida a la nube';
      } else {
        cloud.gistId = gist.id;
        // Si esta cuenta ya tiene datos en la nube, se CARGAN (si no, se sube lo de aquí).
        gmSet(acctKey('nb_cloud_base'), ''); gmSet(acctKey('nb_cloud_dirty_at'), 0);
        await cloudSync();
      }
      cloudSaveCreds(); gmSet(acctKey('nb_cloud_dirty_at'), 0);
      startCloudSync(true);
    } catch (e) { cloud.error = e.message; cloud.status = ''; cloud.gistId = ''; }
    renderIfIdle('inicio'); paintCloudStatus();
  }
  function cloudDisconnect() {
    clearTimeout(cloud.pushTimer); clearInterval(cloud.pollTimer); cloud.pollTimer = null; cloud.started = false;
    cloud.token = cloud.pass = cloud.gistId = ''; cloud.status = ''; cloud.error = '';
    cloudSaveCreds();
    renderIfIdle('inicio');
  }
  function startCloudSync(alreadySynced = false) {
    if (!cloudOn() || cloud.started) return;
    cloud.started = true;
    if (!alreadySynced) cloudSync();
    cloud.pollTimer = setInterval(() => cloudSync(), 60000);
    // Volver a la pestaña / al PC: sincronizar YA (no esperar al minuto).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cloudSync(); });
    window.addEventListener('focus', () => { if (Date.now() - cloud.lastPull > 15000) cloudSync(); });
    // PC dormido / pestaña congelada: si el reloj salta más de 90 s, se sincroniza al despertar.
    let last = Date.now();
    setInterval(() => { const n = Date.now(); if (n - last > 90000) cloudSync(); last = n; }, 10000);
    window.addEventListener('beforeunload', () => { if (cloud.dirty) cloudSync(); });
  }
  let cloudStatusEl = null;
  function paintCloudStatus() {
    if (!cloudStatusEl) return;
    cloudStatusEl.textContent = cloud.error ? `Error: ${cloud.error}` : cloud.busy ? 'Sincronizando…' : cloud.dirty ? 'Cambios pendientes de subir…'
      : (cloud.status || 'Sincronizado') + (cloud.lastPull ? ` · última comprobación ${new Date(Math.max(cloud.lastPull, cloud.lastPush)).toLocaleTimeString('es-ES')}` : '');
    cloudStatusEl.className = `nb-goal-sub${cloud.error ? ' nb-err' : ''}`;
  }
  function renderCloudCard() {
    if (cloudOn()) {
      cloudStatusEl = el('div', { class: 'nb-goal-sub' });
      paintCloudStatus();
      return el('div', { class: 'nb-card' }, [
        el('div', { class: 'nb-card-title' }, 'Sincronización en la nube'),
        el('div', { class: 'nb-row' }, [el('div', { class: 'nb-option-text' }, [el('span', { class: 'nb-option-label' }, `Conectada · ${cloudFile()}`), cloudStatusEl]),
          el('span', { class: 'nb-btn-group' }, [
            el('span', { class: 'nb-btn nb-btn-sm', onclick: () => cloudPull(true) }, 'Bajar de la nube'),
            el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { cloud.dirty = true; cloudPush(); } }, 'Subir ahora'),
            el('span', { class: 'nb-btn nb-btn-sm', onclick: () => { if (confirm('¿Desconectar la nube en este PC? (los datos de la nube no se borran)')) cloudDisconnect(); } }, 'Desconectar')
          ])]),
        el('p', { class: 'nb-placeholder nb-mt' }, 'Usa el bot en un solo PC a la vez: si está abierto en dos, los dos actuarían (envíos, ataques…).')
      ]);
    }
    cloudStatusEl = el('div', { class: 'nb-goal-sub' }); paintCloudStatus();
    const tok = el('input', { class: 'nb-input', type: 'password', placeholder: 'Token de GitHub (solo permiso Gists)', autocomplete: 'off' });
    const pw = el('input', { class: 'nb-input', type: 'password', placeholder: 'Contraseña para cifrar (la misma en todos tus PC)', autocomplete: 'new-password' });
    return el('div', { class: 'nb-card' }, [
      el('div', { class: 'nb-card-title' }, 'Sincronización en la nube (opcional)'),
      el('p', { class: 'nb-placeholder' }, 'Guarda la configuración en un Gist SECRETO de tu GitHub, cifrada con tu contraseña, para tenerla igual en cualquier PC. Crea un token en github.com/settings/tokens (Fine-grained → Account permissions → Gists: Read and write; nada más).'),
      el('div', { class: 'nb-field-row nb-mt' }, [tok, pw]),
      el('div', { class: 'nb-row nb-mt' }, [cloudStatusEl, el('span', { class: 'nb-btn nb-btn-primary', onclick: () => {
        if (!tok.value.trim()) return tok.focus();
        if (pw.value.length < 8) { alert('La contraseña debe tener al menos 8 caracteres.'); return pw.focus(); }
        cloudConnect(tok.value, pw.value);
      } }, 'Conectar')])
    ]);
  }

  async function init() {
    await waitFor(() => !!document.body);
    // Primero la cuenta (su configuración) y, si tiene nube, bajar de la nube ANTES de
    // arrancar ningún módulo.
    await waitFor(() => !!(UW.Game && UW.Game.player_id && UW.Game.world_id), 30000);
    if (bindAccount()) {
      cloudLoadCreds();
      if (cloudOn()) await Promise.race([cloudBoot(), sleep(25000)]);
    }
    buildUI();
    window.addEventListener('resize', () => { applyPanelSize(); applyPanelPosition(); applyFabPosition(); });
    setTimeout(tourAutoOffer, 2500);
    startFarmEngine();
    startOverviewSync();
    startBuildEngine();
    startResearchEngine();
    startTradeEngine();
    startExchangeEngine();
    startCaveEngine();
    startRecruitEngine();
    startAttackEngine();
    startFestivalEngine();
    if (cloudOn()) startCloudSync(true);

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
      setInterval(() => { updateCityLabel(); onTownMaybeChanged(); flushTownRender(); checkBuildChanges(); }, 1000); // red de seguridad por si el evento no llega
    });
  }

  init();
})();