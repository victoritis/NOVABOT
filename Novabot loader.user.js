// ==UserScript==
// @name         NOVABOT (cargador)
// @namespace    https://github.com/victoritis/NOVABOT
// @version      1.0.0
// @description  Se instala UNA vez: en cada carga del juego baja la última versión de NOVABOT de GitHub y la ejecuta. Para actualizar el bot basta con subir Novabot.user.js al repo.
// @author       victoritis
// @match        *://*.grepolis.com/*
// @resource     NOVABOT_CSS https://raw.githubusercontent.com/victoritis/NOVABOT/main/novabot.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/victoritis/NOVABOT/main/NOVABOT-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/victoritis/NOVABOT/main/NOVABOT-loader.user.js
// ==/UserScript==

/* =====================================================================================
   Cargador de NOVABOT
   -------------------------------------------------------------------------------------
   · Pide a GitHub cuál es el último commit de la rama y baja Novabot.user.js de ESE
     commit (así nunca llega una copia vieja de la caché de GitHub, que guarda los
     archivos "raw" unos 5 minutos). Si la API no responde, baja el de la rama.
   · Guarda la última versión buena: si GitHub no responde (o no hay internet), usa
     esa y el bot funciona igual.
   · Ejecuta el código aquí dentro, así tiene los mismos permisos (GM_*) que si
     estuviera instalado directamente.
   IMPORTANTE: los @grant y @connect de aquí deben incluir todos los que use
   Novabot.user.js. Si el bot empieza a usar uno nuevo, hay que añadirlo aquí y subir
   la @version de este cargador (Tampermonkey lo actualizará solo).
   ===================================================================================== */
(function () {
  'use strict';
  const REPO = 'victoritis/NOVABOT';
  const BRANCH = 'main';
  const FILE = 'Novabot.user.js';
  const TIMEOUT = 8000;

  const get = (url) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, timeout: TIMEOUT, headers: { 'Cache-Control': 'no-cache' },
      onload: (r) => (r.status === 200 && r.responseText ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`))),
      onerror: () => reject(new Error('sin conexión')),
      ontimeout: () => reject(new Error('tiempo agotado'))
    });
  });

  async function latestCode() {
    // 1) Commit más reciente de la rama → archivo de ese commit (siempre fresco).
    try {
      const info = JSON.parse(await get(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`));
      if (info && /^[0-9a-f]{40}$/.test(info.sha)) {
        const code = await get(`https://raw.githubusercontent.com/${REPO}/${info.sha}/${FILE}`);
        return { code, from: `commit ${info.sha.slice(0, 7)}` };
      }
    } catch (e) { console.warn('[NOVABOT cargador] API de GitHub:', e.message); }
    // 2) El de la rama (puede llegar con unos minutos de retraso por la caché).
    const code = await get(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}?t=${Date.now()}`);
    return { code, from: BRANCH };
  }

  const looksValid = (code) => typeof code === 'string' && code.length > 1000 && code.includes('NOVABOT') && code.includes('__NOVABOT_ACTIVE__');

  function run(code, from) {
    try {
      // eval directo: el código ve GM_* y unsafeWindow igual que un script instalado.
      eval(`${code}\n//# sourceURL=NOVABOT-${from.replace(/\W+/g, '_')}.js`);
      console.info(`[NOVABOT cargador] ejecutado (${from}).`);
      return true;
    } catch (e) {
      console.error('[NOVABOT cargador] error al ejecutar NOVABOT:', e);
      return false;
    }
  }

  (async () => {
    let fresh = null;
    try { fresh = await latestCode(); } catch (e) { console.warn('[NOVABOT cargador] no se pudo bajar de GitHub:', e.message); }
    if (fresh && looksValid(fresh.code)) {
      if (run(fresh.code, fresh.from)) { GM_setValue('nb_loader_code', fresh.code); return; }
    }
    // Sin GitHub (o la versión nueva falló al arrancar): la última que funcionó.
    const cached = GM_getValue('nb_loader_code', '');
    if (looksValid(cached) && cached !== fresh?.code) {
      try { delete unsafeWindow.__NOVABOT_ACTIVE__; } catch {}
      run(cached, 'copia guardada');
    }
    else console.error('[NOVABOT cargador] no hay ninguna versión disponible (ni de GitHub ni guardada).');
  })();
})();