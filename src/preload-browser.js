/* eslint-disable */
// Draait vóór alle scripts van de pagina (evaluateOnNewDocument).
// Houdt bij welke elementen interactie-listeners krijgen, zodat we "dode" knoppen kunnen herkennen.
module.exports = function uiaPreload() {
  if (window.__uiaInstalled) return;
  window.__uiaInstalled = true;
  const CLICKISH = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'submit', 'dblclick'];
  const reg = new WeakMap();
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    try {
      if (CLICKISH.includes(type)) {
        let s = reg.get(this);
        if (!s) reg.set(this, (s = new Set()));
        s.add(type);
      }
    } catch (e) {}
    return orig.call(this, type, fn, o);
  };

  const frameworkHandler = (el, types) => {
    // React: __reactProps$xxx bevat de props, inclusief onClick
    for (const k in el) {
      if (k.startsWith('__reactProps$')) {
        const p = el[k] || {};
        if (p.onClick || p.onMouseDown || p.onMouseUp || p.onPointerDown || p.onPointerUp || p.onTouchStart || p.onKeyDown || p.onSubmit) return true;
      }
      if (k === '_vei') {
        const v = el._vei || {};
        if (Object.keys(v).some((x) => /^on(click|mousedown|mouseup|pointerdown|pointerup|touchstart|keydown|submit)/i.test(x) && v[x])) return true;
      }
    }
    if (el.attributes) {
      for (const a of el.attributes) {
        if (/^(onclick|onmousedown|onmouseup|onpointerdown|onsubmit|ng-click|\(click\)|@click|x-on:click|v-on:click|hx-(get|post|put|patch|delete)|wire:click|data-action|phx-click|on:click|_)$/i.test(a.name)) return true;
      }
    }
    if (typeof el.onclick === 'function' || typeof el.onmousedown === 'function' || typeof el.onpointerdown === 'function' || (types.includes('submit') && typeof el.onsubmit === 'function')) return true;
    return false;
  };

  const isReactManaged = (el) => { for (const k in el) if (k.startsWith('__reactProps$') || k.startsWith('__reactFiber$')) return true; return false; };
  const isRoot = (el) => el === document.body || el === document.documentElement || (() => { for (const k in el) if (k.startsWith('__reactContainer$') || k === '_reactRootContainer' || k === '__vue_app__') return true; return false; })();

  window.__uiaHasHandler = function (el, types) {
    types = types || CLICKISH;
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && !isRoot(cur) && depth < 25) {
      const s = reg.get(cur);
      if (s && types.some((t) => s.has(t))) return depth === 0 ? 'direct' : 'ancestor';
      if (frameworkHandler(cur, types)) return depth === 0 ? 'direct' : 'ancestor';
      cur = cur.parentElement;
      depth++;
    }
    // Gedelegeerde listeners op document/body/root?
    const globals = [window, document, document.documentElement, document.body];
    let c = el;
    while (c && c.nodeType === 1) { if (isRoot(c)) globals.push(c); c = c.parentElement; }
    const delegated = globals.some((g) => { const s = g && reg.get(g); return s && types.some((t) => s.has(t)); });
    if (delegated) {
      // React delegeert altijd via de root, maar roept alleen props-handlers aan → geen prop = dood
      if (isReactManaged(el)) return 'none';
      return 'unknown';
    }
    return 'none';
  };
};
