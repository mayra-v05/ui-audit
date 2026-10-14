/* eslint-disable */
// Deze functie wordt als string in de pagina geïnjecteerd (page.evaluate).
// Ze moet dus volledig zelfstandig zijn: geen imports, geen closures naar buiten.
module.exports = function uiAudit(opts) {
  const issues = [];
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const isMobile = !!opts.isMobile;
  const base = opts.spacingBase || 4;
  const MAX_EL = 6000;

  // ---------- helpers ----------
  const r1 = (n) => Math.round(n * 10) / 10;
  const px = (v) => parseFloat(v) || 0;

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll('#' + cssEscape(cur.id)).length === 1) {
        parts.unshift('#' + cssEscape(cur.id));
        break;
      }
      const cls = [...cur.classList].filter((c) => !/^(uia-|is-|has-|active|hover|focus|ng-|css-[a-z0-9]{5,}|sc-|jsx-)/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function snippet(el) {
    if (!el || !el.outerHTML) return '';
    const clone = el.cloneNode(false);
    let open = clone.outerHTML.replace(/<\/[a-z0-9-]+>$/i, '');
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (open.length > 220) open = open.slice(0, 220) + '…>';
    return open + (text ? text : '') + (el.children.length || text ? '…' : '');
  }

  function textOf(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r1(r.left + window.scrollX), y: r1(r.top + window.scrollY), w: r1(r.width), h: r1(r.height) };
  }

  function isVisible(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.width <= 2 && r.height <= 2) return false; // sr-only / visually-hidden
    if (el.closest('[aria-hidden="true"], [hidden], dialog:not([open])')) return false;
    return true;
  }

  function sourceHints(el) {
    // Info die helpt het element in de broncode terug te vinden
    const hints = { id: el.id || null, classes: [...el.classList].slice(0, 6), text: textOf(el).slice(0, 50) };
    const ancestorWithId = el.parentElement && el.parentElement.closest('[id]');
    if (ancestorWithId) hints.ancestorId = ancestorWithId.id;
    return hints;
  }

  let seq = 0;
  function add(rule, category, severity, el, title, detail, suggestion, extra) {
    const issue = {
      rule, category, severity, title, detail, suggestion,
      selector: el ? selectorOf(el) : null,
      html: el ? snippet(el) : null,
      rect: el ? rectOf(el) : null,
      hints: el ? sourceHints(el) : null,
      seq: seq++,
    };
    if (extra) Object.assign(issue, extra);
    issues.push(issue);
    return issue;
  }

  function mode(values, tol) {
    // Geeft de meest voorkomende waarde (met tolerantie) terug en hoe vaak die voorkomt
    const buckets = [];
    for (const v of values) {
      const b = buckets.find((x) => Math.abs(x.v - v) <= tol);
      if (b) b.n++;
      else buckets.push({ v, n: 1 });
    }
    buckets.sort((a, b) => b.n - a.n);
    return buckets[0] || { v: 0, n: 0 };
  }

  // ---------- verzamel zichtbare elementen ----------
  const all = [];
  const csCache = new Map();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node && all.length < MAX_EL) {
    const tag = node.tagName;
    if (!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK|BR|WBR|svg|path|g|defs|use|SVG)$/.test(tag) && !(node.ownerSVGElement)) {
      const cs = getComputedStyle(node);
      csCache.set(node, cs);
      if (isVisible(node, cs)) all.push(node);
    }
    node = walker.nextNode();
  }
  const visibleSet = new Set(all);
  const cs = (el) => csCache.get(el) || getComputedStyle(el);
  const inFlow = (el) => {
    const p = cs(el).position;
    return p !== 'absolute' && p !== 'fixed' && p !== 'sticky';
  };

  const kindOf = (el) => el.tagName + '|' + [...el.classList].filter((c) => !/^(active|current|selected|is-|has-)/.test(c)).sort().join('.');
  const sameKind = (a, b) => kindOf(a) === kindOf(b);

  // ---------- 1. Uitlijning & gaps binnen groepen broers/zussen ----------
  const parents = new Set(all.map((e) => e.parentElement).filter(Boolean));
  for (const parent of parents) {
    if (/^(PRE|CODE|P|SPAN|A|LABEL|H[1-6]|TEXTAREA|svg)$/.test(parent.tagName)) continue;
    const kids = [...parent.children].filter((k) => visibleSet.has(k) && inFlow(k) && !/^(contents|inline)$/.test(cs(k).display) && cs(k).transform === 'none');
    if (kids.length < 3) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());

    // Bepaal of de kinderen in een kolom (onder elkaar) of rij (naast elkaar) staan
    let stacked = 0, sideBySide = 0;
    for (let i = 1; i < rects.length; i++) {
      if (rects[i].top >= rects[i - 1].bottom - 2) stacked++;
      else if (rects[i].left >= rects[i - 1].right - 2) sideBySide++;
    }
    const n = rects.length - 1;

    if (stacked === n) {
      // Kolom: linkerranden moeten gelijk zijn (of midden/rechts uitgelijnd)
      const L = rects.map((r) => r.left), C = rects.map((r) => r.left + r.width / 2);
      const mL = mode(L, 0.5), mC = mode(C, 0.5);
      if (mL.n >= 2 && mL.n >= kids.length / 2) {
        kids.forEach((k, i) => {
          const d = L[i] - mL.v;
          const centered = Math.abs(C[i] - mC.v) < 0.5 && mC.n >= mL.n;
          if (Math.abs(d) >= 1 && Math.abs(d) <= 8 && !centered) {
            add('align-x', 'layout', 'warning', k,
              `Element staat ${r1(Math.abs(d))}px ${d > 0 ? 'naar rechts' : 'naar links'} t.o.v. de rest`,
              `${mL.n} van de ${kids.length} items in deze kolom beginnen op x=${r1(mL.v)}px, dit item op x=${r1(L[i])}px.`,
              `Lijn dit element uit met de andere items (controleer margin-left/padding-left of een afwijkende wrapper).`,
              { measure: { expected: r1(mL.v), actual: r1(L[i]), diff: r1(d) } });
          }
        });
      }
      // Verticale gaps
      if (kids.length >= 3) {
        const gaps = [];
        for (let i = 1; i < rects.length; i++) gaps.push(sameKind(kids[i], kids[i - 1]) ? rects[i].top - rects[i - 1].bottom : null);
        const valid = gaps.filter((g) => g !== null);
        const mG = mode(valid, 0.5);
        if (valid.length >= 2 && mG.n >= 2 && mG.n >= valid.length / 2) {
          gaps.forEach((g, i) => {
            if (g === null) return;
            const d = g - mG.v;
            if (Math.abs(d) >= 1 && Math.abs(d) <= 12) {
              add('gap-y', 'spacing', 'warning', kids[i + 1],
                `Afwijkende verticale ruimte: ${r1(g)}px i.p.v. ${r1(mG.v)}px`,
                `Tussen de andere items in deze lijst zit ${r1(mG.v)}px ruimte, boven dit item ${r1(g)}px (${d > 0 ? '+' : ''}${r1(d)}px).`,
                `Gebruik dezelfde margin/gap als de andere items (bij voorkeur 'gap' op de parent).`,
                { measure: { expected: r1(mG.v), actual: r1(g), diff: r1(d) } });
            }
          });
        }
      }
    } else if (sideBySide === n) {
      // Rij: boven-, midden- of onderkant moet gelijk zijn
      const T = rects.map((r) => r.top), M = rects.map((r) => r.top + r.height / 2), B = rects.map((r) => r.bottom);
      const mT = mode(T, 0.5), mM = mode(M, 0.5), mB = mode(B, 0.5);
      const best = [mT, mM, mB].sort((a, b) => b.n - a.n)[0];
      if (best.n >= 2 && best.n >= kids.length / 2) {
        kids.forEach((k, i) => {
          const offT = T[i] - mT.v, offM = M[i] - mM.v, offB = B[i] - mB.v;
          const aligned = Math.abs(offT) < 1 || Math.abs(offM) < 1 || Math.abs(offB) < 1;
          if (aligned) return;
          const which = best === mT ? offT : best === mM ? offM : offB;
          if (Math.abs(which) >= 1 && Math.abs(which) <= 8) {
            add('align-y', 'layout', 'warning', k,
              `Element staat ${r1(Math.abs(which))}px ${which > 0 ? 'lager' : 'hoger'} dan de rest van de rij`,
              `${best.n} van de ${kids.length} items in deze rij zijn uitgelijnd, dit item wijkt ${r1(which)}px af.`,
              `Gebruik align-items op de parent en verwijder afwijkende margin-top/padding of line-height op dit item.`,
              { measure: { diff: r1(which) } });
          }
        });
      }
      const gaps = [];
      for (let i = 1; i < rects.length; i++) gaps.push(sameKind(kids[i], kids[i - 1]) ? rects[i].left - rects[i - 1].right : null);
      const valid = gaps.filter((g) => g !== null);
      const mG = mode(valid, 0.5);
      if (valid.length >= 2 && mG.n >= 2 && mG.n >= valid.length / 2) {
        gaps.forEach((g, i) => {
          if (g === null) return;
          const d = g - mG.v;
          if (Math.abs(d) >= 1 && Math.abs(d) <= 12) {
            add('gap-x', 'spacing', 'warning', kids[i + 1],
              `Afwijkende horizontale ruimte: ${r1(g)}px i.p.v. ${r1(mG.v)}px`,
              `De andere items in deze rij hebben ${r1(mG.v)}px tussenruimte, links van dit item ${r1(g)}px (${d > 0 ? '+' : ''}${r1(d)}px).`,
              `Gebruik 'gap' op de parent i.p.v. losse margins, of maak de margin gelijk aan de andere items.`,
              { measure: { expected: r1(mG.v), actual: r1(g), diff: r1(d) } });
          }
        });
      }
    }
  }

  // ---------- 2. Consistentie van knoppen / inputs (zelfde soort = zelfde maten) ----------
  const isButtonLike = (el) => {
    const t = el.tagName;
    if (t === 'BUTTON') return true;
    if (t === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (t === 'A' && /(^|[-_\s])(btn|button|cta)([-_\s]|$)/i.test(el.className)) return true;
    return false;
  };
  const buttons = all.filter(isButtonLike);
  const props = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius', 'fontSize', 'fontWeight', 'height'];
  const stateCls = /^(active|current|selected|disabled|open|show|is-|has-|focus|hover)/;
  const groups = new Map();
  for (const b of buttons) {
    const sig = b.tagName + '|' + [...b.classList].filter((c) => !stateCls.test(c)).sort().join('.');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(b);
  }
  const valOf = (el, p) => p === 'height' ? r1(el.getBoundingClientRect().height) : cs(el)[p];
  for (const [sig, list] of groups) {
    if (list.length < 3 || sig.endsWith('|')) continue; // zonder classes geen betrouwbare groep
    for (const p of props) {
      const vals = list.map((el) => String(valOf(el, p)));
      const counts = {};
      vals.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
      const [top, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (topN < 2 || topN === list.length || topN < list.length / 2) continue;
      list.forEach((el, i) => {
        if (vals[i] !== top) {
          add('btn-inconsistent', 'spacing', 'warning', el,
            `Knop wijkt af van zijn variant: ${p} = ${vals[i]} i.p.v. ${top}`,
            `${topN} van de ${list.length} knoppen met dezelfde classes hebben ${p}: ${top}. Deze heeft ${vals[i]}.`,
            `Verwijder de afwijkende ${p} (inline style of extra selector) zodat de knop overeenkomt met de rest.`,
            { measure: { property: p, expected: top, actual: vals[i] } });
        }
      });
    }
  }
  // Bijna-gelijke knophoogtes over de hele pagina (bv. 42px vs 44px)
  const nearMiss = (els, getter, label, unit, maxDiff) => {
    const vals = els.map(getter);
    const counts = {};
    vals.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
    const common = Object.entries(counts).filter(([, n]) => n >= 2).map(([v, n]) => ({ v: +v, n }));
    els.forEach((el, i) => {
      const v = vals[i];
      if (counts[v] > 1 && counts[v] >= 3) return;
      const near = common.find((c) => c.v !== v && Math.abs(c.v - v) > 0.4 && Math.abs(c.v - v) <= maxDiff && c.n > counts[v]);
      if (near) {
        add('near-miss-' + label, 'spacing', 'info', el,
          `${label[0].toUpperCase() + label.slice(1)} ${v}${unit} lijkt op ${near.v}${unit} (${near.n}× gebruikt)`,
          `Bijna-gelijke maten wijzen meestal op een slordigheid i.p.v. een bewuste keuze.`,
          `Gebruik ${near.v}${unit} (of een design token) voor consistentie.`,
          { measure: { expected: near.v, actual: v } });
      }
    });
  };
  nearMiss(buttons, (b) => Math.round(b.getBoundingClientRect().height), 'knophoogte', 'px', 4);
  nearMiss(buttons, (b) => Math.round(px(cs(b).borderRadius)), 'border-radius', 'px', 3);
  const inputs = all.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|hidden|range|color|file|submit|button)$/i.test(el.type || ''));
  nearMiss(inputs.filter((i) => i.tagName !== 'TEXTAREA'), (b) => Math.round(b.getBoundingClientRect().height), 'inputhoogte', 'px', 4);

  // Koppen van hetzelfde niveau met verschillende stijl
  for (const h of ['H1', 'H2', 'H3', 'H4']) {
    const hs = all.filter((e) => e.tagName === h);
    if (hs.length < 3) continue;
    for (const p of ['fontSize', 'fontWeight', 'marginBottom']) {
      const vals = hs.map((e) => cs(e)[p]);
      const counts = {};
      vals.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
      const [top, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (topN < 2 || topN === hs.length || topN < hs.length / 2) continue;
      const dev = {};
      hs.forEach((e, i) => {
        if (vals[i] !== top && (p !== 'marginBottom' || Math.abs(px(vals[i]) - px(top)) <= 12)) (dev[vals[i]] = dev[vals[i]] || []).push(e);
      });
      for (const [v, els] of Object.entries(dev)) {
        if (els.length > topN / 2) continue; // twee bewuste varianten, geen uitschieter
        add('heading-inconsistent', 'spacing', 'info', els[0],
          `${h.toLowerCase()} met afwijkende ${p}: ${v} i.p.v. ${top}${els.length > 1 ? ` (${els.length}×)` : ''}`,
          `${topN} van de ${hs.length} ${h.toLowerCase()}-koppen gebruiken ${p}: ${top}.`,
          `Maak deze kop gelijk aan de andere ${h.toLowerCase()}-koppen of gebruik een aparte, bewuste variant.`,
          { measure: { property: p, expected: top, actual: v }, examples: els.length > 1 ? els.slice(0, 6).map(selectorOf) : undefined });
      }
    }
  }

  // ---------- 3. Spacing buiten het grid ----------
  const offGrid = new Map();
  for (const el of all) {
    const s = cs(el);
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) {
      const v = px(s[p]);
      if (!v || Math.abs(v) <= 2) continue;
      if (Math.abs(v - Math.round(v)) > 0.01) continue; // em/rem-afgeleide waardes (bv. browser-defaults) overslaan
      if (s[p].endsWith('%') || Math.abs(v) > 200) continue;
      if (p.startsWith('margin') && (s[p] === 'auto')) continue;
      const rounded = Math.round(Math.abs(v) * 100) / 100;
      if (rounded % base === 0) continue;
      // margin-left/right die van 'auto' komt (centreren) overslaan
      if ((p === 'marginLeft' || p === 'marginRight') && Math.abs(px(s.marginLeft) - px(s.marginRight)) < 1 && rounded > 20) continue;
      const key = rounded + 'px';
      if (!offGrid.has(key)) offGrid.set(key, { count: 0, els: [], props: new Set() });
      const o = offGrid.get(key);
      o.count++;
      o.props.add(p);
      if (o.els.length < 5) o.els.push(el);
    }
  }
  for (const [val, o] of [...offGrid].sort((a, b) => b[1].count - a[1].count).slice(0, 15)) {
    add('off-grid', 'spacing', 'info', o.els[0],
      `Spacing ${val} valt buiten het ${base}px-grid (${o.count}×)`,
      `Gebruikt in: ${[...o.props].join(', ')}. Voorbeelden: ${o.els.map(selectorOf).slice(0, 3).join(' | ')}`,
      `Rond af naar het dichtstbijzijnde veelvoud van ${base}px (${Math.round(px(val) / base) * base}px) of gebruik een spacing-token.`,
      { measure: { value: val, count: o.count }, examples: o.els.map(selectorOf) });
  }

  // ---------- 4. Responsive / mobiel ----------
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    // zoek de veroorzakers: elementen die buiten de viewport steken en niet in een clip-container zitten
    const clipped = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const o = cs(p);
        if (/(hidden|auto|scroll|clip)/.test(o.overflowX)) return true;
        p = p.parentElement;
      }
      return false;
    };
    const culprits = all.filter((el) => {
      const r = el.getBoundingClientRect();
      if (cs(el).position === 'fixed' || clipped(el)) return false;
      if (r.right > vw + 1 || r.left < -1) return true;
      // tekst/inhoud die buiten een element zonder overflow-clip loopt (bv. white-space: nowrap)
      return cs(el).overflowX === 'visible' && r.left + el.scrollWidth > vw + 1 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    });
    const roots = culprits.filter((el) => !culprits.includes(el.parentElement)).slice(0, 8);
    add('h-overflow', 'responsive', isMobile ? 'error' : 'warning', roots[0] || document.body,
      `Pagina scrollt horizontaal (${docW}px breed bij ${vw}px viewport)`,
      `Er steekt content ${docW - vw}px buiten het scherm. Veroorzakers: ${roots.map(selectorOf).join(' | ') || 'onbekend'}.`,
      `Geef deze elementen max-width: 100%, laat tekst/flex-items wrappen (flex-wrap, min-width: 0) of gebruik overflow-x: auto op tabellen/codeblokken.`,
      { measure: { docWidth: docW, viewport: vw } });
    roots.slice(1).forEach((el) => {
      const r = el.getBoundingClientRect();
      const over = Math.max(r.right - vw, -r.left, r.left + el.scrollWidth - vw);
      add('overflow-el', 'responsive', isMobile ? 'error' : 'warning', el,
        `Element steekt ${r1(over)}px buiten het scherm`,
        `Breedte ${r1(Math.max(r.width, el.scrollWidth))}px, viewport ${vw}px.`,
        `Gebruik max-width: 100% / width: auto of laat inhoud wrappen.`);
    });
  }

  if (!document.querySelector('meta[name="viewport"]')) {
    add('no-viewport', 'responsive', 'error', null,
      'Geen <meta name="viewport"> gevonden',
      'Zonder viewport-meta tonen telefoons de desktopversie uitgezoomd.',
      'Voeg <meta name="viewport" content="width=device-width, initial-scale=1"> toe aan de <head>.');
  }

  const interactive = all.filter((el) => el.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick], summary, label[for]'));
  if (isMobile) {
    const centers = interactive.map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const crowded = (el) => {
      const me = centers.find((c) => c.el === el);
      return centers.some((c) => c.el !== el && !c.el.contains(el) && !el.contains(c.el) && Math.hypot(c.x - me.x, c.y - me.y) < 24);
    };
    const smallOk = [];
    for (const el of interactive) {
      // inline links in lopende tekst zijn uitgezonderd (WCAG 2.5.8)
      if (el.tagName === 'A' && cs(el).display === 'inline' && el.parentElement && /^(P|LI|SPAN|TD|DD)$/.test(el.parentElement.tagName)) continue;
      if (el.tagName === 'LABEL' || /^(checkbox|radio)$/i.test(el.type || '')) continue;
      const r = el.getBoundingClientRect();
      const min = Math.min(r.width, r.height);
      if (min < 24 && crowded(el)) {
        add('tap-target', 'responsive', 'error', el,
          `Tikdoel te klein en te dicht op andere knoppen: ${r1(r.width)}×${r1(r.height)}px`,
          `Op mobiel moet een klikbaar element minimaal 24×24px zijn, of genoeg ruimte hebben tot andere tikdoelen (WCAG 2.5.8). Hier ligt een ander tikdoel binnen 24px → mis-tikken.`,
          `Vergroot padding of min-height naar 44px, of zet meer ruimte tussen de links/knoppen.`, { measure: { w: r1(r.width), h: r1(r.height) } });
      } else if (min < 24) {
        add('tap-target', 'responsive', 'warning', el,
          `Tikdoel klein: ${r1(r.width)}×${r1(r.height)}px`,
          `Kleiner dan 24px. Er is wel ruimte omheen, maar 44×44px tikt een stuk prettiger.`,
          `Vergroot padding of min-height naar 44px.`, { measure: { w: r1(r.width), h: r1(r.height) } });
      } else if (min < 40) smallOk.push(el);
    }
    if (smallOk.length) {
      add('tap-target-small', 'responsive', 'info', smallOk[0],
        `${smallOk.length} tikdoelen kleiner dan 44px`,
        `Voldoet aan WCAG-minimum (24px), maar is kleiner dan de 44×44px uit Apple HIG / 48px Material.`,
        `Overweeg extra padding op mobiel.`, { examples: smallOk.slice(0, 8).map(selectorOf) });
    }
    const smallText = new Map();
    for (const el of all) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
      if (!hasText) continue;
      const fs = px(cs(el).fontSize);
      if (fs < 12) {
        const k = fs + 'px';
        if (!smallText.has(k)) smallText.set(k, []);
        smallText.get(k).push(el);
      }
    }
    for (const [k, els] of smallText) {
      add('small-text', 'responsive', 'warning', els[0],
        `Tekst van ${k} is te klein op mobiel (${els.length}×)`,
        `Tekst kleiner dan 12px is op een telefoon slecht leesbaar. Body-tekst liefst 16px.`,
        `Verhoog font-size naar minimaal 12px (labels) / 16px (body).`, { examples: els.slice(0, 5).map(selectorOf) });
    }
    // fixed/sticky elementen die veel van het scherm bedekken
    for (const el of all) {
      const p = cs(el).position;
      if (p !== 'fixed' && p !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (inView && r.width >= vw * 0.9 && r.height > vh * 0.3 && r.height < vh * 0.95) {
        add('fixed-cover', 'responsive', 'warning', el,
          `Vast element bedekt ${Math.round((r.height / vh) * 100)}% van het scherm`,
          `Een ${p}-element van ${r1(r.height)}px hoog neemt op mobiel veel ruimte in.`,
          `Maak de header/banner compacter op kleine schermen of laat hem wegscrollen.`);
      }
    }
  }

  // Afgekapte tekst
  for (const el of all) {
    const s = cs(el);
    if (!/(hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) continue;
    const xClip = el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis';
    const yClip = el.scrollHeight > el.clientHeight + 2 && !s.webkitLineClamp && s.webkitLineClamp !== 'none' && !/-webkit-box/.test(s.display);
    if (xClip || yClip) {
      add('text-clipped', 'responsive', 'warning', el,
        'Tekst wordt afgekapt',
        `Inhoud is ${xClip ? (el.scrollWidth - el.clientWidth) + 'px te breed' : (el.scrollHeight - el.clientHeight) + 'px te hoog'} voor het element, en overflow staat op hidden.`,
        xClip ? 'Laat de tekst wrappen of gebruik text-overflow: ellipsis.' : 'Verwijder de vaste hoogte of gebruik line-clamp bewust.');
    }
  }

  // Overlappende broers/zussen
  let overlapCount = 0;
  for (const parent of parents) {
    if (overlapCount > 15) break;
    if (/grid/.test(cs(parent).display)) continue; // grid-items mogen bewust dezelfde area delen
    const kids = [...parent.children].filter((k) => visibleSet.has(k) && inFlow(k) && cs(k).transform === 'none' && (k.innerText || '').trim());
    for (let i = 0; i < kids.length && overlapCount <= 15; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 2 && iy > 2 && ix * iy > 40) {
          overlapCount++;
          add('overlap', 'layout', 'warning', kids[j],
            'Elementen overlappen elkaar',
            `Overlapt ${r1(ix)}×${r1(iy)}px met ${selectorOf(kids[i])}.`,
            'Controleer negatieve margins, vaste hoogtes of te smalle containers (vooral op mobiel).',
            { related: selectorOf(kids[i]) });
          break;
        }
      }
    }
  }

  // ---------- 5. Afbeeldingen ----------
  for (const img of document.images) {
    if (!visibleSet.has(img)) continue;
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) {
      add('img-broken', 'content', 'error', img, 'Afbeelding laadt niet', `Bron: ${img.currentSrc}`, 'Controleer het pad / de bestandsnaam of de server-respons.');
      continue;
    }
    if (!img.hasAttribute('alt')) {
      add('img-alt', 'a11y', 'warning', img, 'Afbeelding zonder alt-tekst', `Bron: ${img.currentSrc || img.src}`, 'Voeg een beschrijvende alt toe, of alt="" voor decoratieve afbeeldingen.');
    }
    const s = cs(img);
    if (img.naturalWidth && (s.objectFit === 'fill' || !s.objectFit)) {
      const r = img.getBoundingClientRect();
      const nat = img.naturalWidth / img.naturalHeight, ren = r.width / r.height;
      const diff = Math.abs(ren - nat) / nat;
      if (diff > 0.05 && r.width > 20) {
        add('img-distorted', 'content', 'warning', img, `Afbeelding is ${Math.round(diff * 100)}% vervormd`,
          `Origineel ${img.naturalWidth}×${img.naturalHeight}, getoond als ${r1(r.width)}×${r1(r.height)}.`,
          'Gebruik object-fit: cover/contain of zet height: auto.');
      }
    }
    if (img.naturalWidth && img.getBoundingClientRect().width * (window.devicePixelRatio || 1) > img.naturalWidth * 1.3) {
      add('img-lowres', 'content', 'info', img, 'Afbeelding is te laag van resolutie',
        `Origineel ${img.naturalWidth}px breed, getoond op ${r1(img.getBoundingClientRect().width)}px → wazig.`,
        'Lever een grotere versie aan (of gebruik srcset).');
    }
  }

  // ---------- 6. Toegankelijkheid & contrast ----------
  for (const el of interactive) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const labelled = el.labels && el.labels.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      if (!labelled && !/^(submit|button|reset|image)$/i.test(el.type)) {
        add('input-label', 'a11y', 'warning', el, 'Invoerveld zonder label', `Placeholder: "${el.placeholder || ''}"`, 'Koppel een <label for> of aria-label (placeholder is geen label).');
      }
    } else if (!textOf(el) && !el.querySelector('img[alt]:not([alt=""]), svg title')) {
      add('no-name', 'a11y', 'warning', el, 'Klikbaar element zonder tekst/naam', 'Screenreaders kunnen niet zeggen wat dit element doet.', 'Voeg zichtbare tekst of een aria-label toe.');
    }
  }

  const parseColor = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const s = getComputedStyle(cur);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null; // onbetrouwbaar
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.95) return c;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const unreliable = (el) => {
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      const s = cs(cur);
      if (parseFloat(s.opacity) < 1) return true;                 // fade-in animaties
      const fill = s.webkitTextFillColor && parseColor(s.webkitTextFillColor);
      if (s.webkitTextFillColor === 'transparent' || (fill && fill.a === 0)) return true; // gradient-tekst
      if (/text/.test(s.backgroundClip || s.webkitBackgroundClip || '')) return true;
      if (s.mixBlendMode && s.mixBlendMode !== 'normal') return true;
      const bgc = parseColor(s.backgroundColor);
      if (bgc && bgc.a > 0.95) return false;                     // achtergrond gevonden zonder overlay
      if (s.position === 'absolute' || s.position === 'fixed') return true; // tekst over media/overlay
      cur = cur.parentElement;
    }
    return false;
  };
  const contrastGroups = new Map();
  for (const el of all) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) continue;
    const s = cs(el);
    const fg = parseColor(s.color);
    const bg = bgOf(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const fs = px(s.fontSize), bold = parseInt(s.fontWeight) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need && ratio > 1.05 && !unreliable(el)) {
      const key = s.color + '|' + bg.r + ',' + bg.g + ',' + bg.b + '|' + need;
      if (!contrastGroups.has(key)) contrastGroups.set(key, { el, ratio, need, color: s.color, bg, els: [] });
      contrastGroups.get(key).els.push(el);
    }
  }
  for (const g of [...contrastGroups.values()].slice(0, 20)) {
    add('contrast', 'a11y', g.ratio < 3 ? 'error' : 'warning', g.el,
      `Te weinig contrast: ${g.ratio.toFixed(2)}:1 (minimaal ${g.need}:1)${g.els.length > 1 ? ` · ${g.els.length}×` : ''}`,
      `Tekstkleur ${g.color} op achtergrond rgb(${g.bg.r}, ${g.bg.g}, ${g.bg.b}).`,
      'Maak de tekst donkerder/lichter of pas de achtergrond aan (WCAG AA).',
      { measure: { ratio: +g.ratio.toFixed(2), need: g.need }, examples: g.els.length > 1 ? g.els.slice(0, 6).map(selectorOf) : undefined });
  }

  // Bijna-gelijke kleuren (designsysteem-slordigheid)
  const colorUse = new Map();
  for (const el of all) {
    const s = cs(el);
    for (const c of [s.color, s.backgroundColor]) {
      const p = parseColor(c);
      if (!p || p.a < 1) continue;
      const k = `${p.r},${p.g},${p.b}`;
      colorUse.set(k, (colorUse.get(k) || 0) + 1);
    }
  }
  const cols = [...colorUse].map(([k, n]) => { const [r, g, b] = k.split(',').map(Number); return { r, g, b, n, k }; }).sort((a, b) => b.n - a.n);
  const reported = new Set();
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const a = cols[i], b = cols[j];
      const d = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
      if (d > 0 && d < 10 && !reported.has(b.k)) {
        reported.add(b.k);
        const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
        add('near-color', 'spacing', 'info', null,
          `Bijna-gelijke kleuren: ${hex(b)} (${b.n}×) vs ${hex(a)} (${a.n}×)`,
          'Twee kleuren die visueel nauwelijks verschillen wijzen op hardcoded waardes i.p.v. één kleurtoken.',
          `Vervang ${hex(b)} door ${hex(a)} (of een CSS-variabele).`, { measure: { expected: hex(a), actual: hex(b) } });
      }
    }
  }

  // Dubbele IDs
  const ids = {};
  document.querySelectorAll('[id]').forEach((e) => (ids[e.id] = (ids[e.id] || 0) + 1));
  Object.entries(ids).filter(([, n]) => n > 1).slice(0, 10).forEach(([id, n]) => {
    add('dup-id', 'a11y', 'warning', document.getElementById(id), `ID "${id}" komt ${n}× voor`, 'IDs moeten uniek zijn; labels, ankers en scripts pakken anders het verkeerde element.', 'Maak het ID uniek.');
  });

  // Placeholder-tekst
  const bodyText = document.body ? document.body.innerText : '';
  const ph = (bodyText.match(/lorem ipsum|dolor sit amet|\[object Object\]/gi) || []).concat(bodyText.match(/\b(TODO|FIXME|undefined|NaN|null)\b/g) || []);
  if (ph.length) {
    const words = [...new Set(ph.map((w) => w.toLowerCase()))];
    for (const w of words) {
      const el = all.find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.toLowerCase().includes(w)));
      const sev = /^(undefined|nan|null)$|object object/.test(w) ? 'error' : 'warning';
      add('placeholder', sev === 'error' ? 'backend' : 'content', sev, el || null,
        `Tekst "${w}" zichtbaar op de pagina`,
        sev === 'error' ? 'Dit wijst op een kapotte variabele of data die niet goed geladen wordt.' : 'Er staat nog placeholder-/ontwikkeltekst op de pagina.',
        sev === 'error' ? 'Controleer de data/API-respons en de template die deze waarde rendert.' : 'Vervang door echte content.');
    }
  }

  // ---------- 7. Functionele checks: links & knoppen ----------
  const links = [];
  for (const a of all.filter((e) => e.tagName === 'A')) {
    const href = a.getAttribute('href');
    const role = a.getAttribute('role');
    const hstate = window.__uiaHasHandler ? window.__uiaHasHandler(a) : 'unknown';
    const handled = hstate !== 'none';
    if (href === null || href.trim() === '' || href === '#' || /^javascript:\s*(void\(0\)|;)?\s*;?$/i.test(href)) {
      if (handled) continue;
      add('dead-link', 'functional', 'error', a,
        `Link gaat nergens naartoe (href="${href === null ? '' : href}")`,
        `"${textOf(a) || '(geen tekst)'}" heeft geen geldige bestemming en geen click-handler.`,
        'Geef een echte URL op, of maak er een <button> van met een handler.');
      continue;
    }
    if (href.startsWith('#') && href.length > 1) {
      const target = document.getElementById(decodeURIComponent(href.slice(1))) || document.querySelector(`a[name="${href.slice(1)}"]`);
      if (!target && !handled) {
        add('broken-anchor', 'functional', 'error', a, `Anker ${href} bestaat niet op deze pagina`,
          `"${textOf(a)}" verwijst naar een sectie die niet bestaat.`, `Voeg id="${href.slice(1)}" toe aan de juiste sectie of pas de link aan.`);
      }
      continue;
    }
    if (/^(mailto|tel|sms):/i.test(href)) {
      if (/^mailto:\s*$|^tel:\s*$/i.test(href)) add('dead-link', 'functional', 'error', a, `Lege ${href}-link`, '', 'Vul het e-mailadres/nummer in.');
      continue;
    }
    try {
      const u = new URL(href, location.href);
      if (/^https?:$/.test(u.protocol)) links.push({ url: u.href.split('#')[0], selector: selectorOf(a), text: textOf(a), rect: rectOf(a), html: snippet(a), hints: sourceHints(a) });
      if (location.protocol === 'https:' && u.protocol === 'http:') {
        add('insecure-link', 'functional', 'info', a, 'Link naar onbeveiligde http:// URL', u.href, 'Gebruik https:// als de doelsite dat ondersteunt.');
      }
    } catch (e) {
      add('bad-url', 'functional', 'error', a, `Ongeldige URL: ${href}`, '', 'Corrigeer de URL.');
    }
  }

  // Knoppen zonder werking
  const buttonCandidates = [];
  for (const b of all.filter((e) => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || (e.tagName === 'INPUT' && /^(button|submit)$/i.test(e.type)))) {
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    const type = (b.getAttribute('type') || (b.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
    const form = b.form || b.closest('form');
    if (form && type === 'submit') continue;
    if (b.closest('a[href]')) continue;
    if (b.matches('[data-toggle],[data-bs-toggle],[data-dismiss],[data-bs-dismiss],[popovertarget],[commandfor],[command],[aria-controls][aria-expanded]')) continue;
    const state = window.__uiaHasHandler ? window.__uiaHasHandler(b) : 'unknown';
    const id = 'b' + buttonCandidates.length;
    b.setAttribute('data-uia-btn', id);
    buttonCandidates.push({ id, state, selector: selectorOf(b), text: textOf(b), rect: rectOf(b), html: snippet(b), hints: sourceHints(b) });
    if (state === 'none') {
      add('dead-button', 'functional', 'error', b,
        `Knop "${textOf(b) || '(zonder tekst)'}" doet niets`,
        form ? 'Knop staat in een formulier maar is geen submit-knop, en heeft geen click-handler.' : 'Er is geen click-handler, link of formulier gekoppeld aan deze knop.',
        'Koppel een onClick/addEventListener-handler, zet hem in een <form>, of verwijder de knop als hij niet nodig is.');
    }
  }

  // Formulieren zonder action en zonder submit-handler
  for (const f of document.forms) {
    if (!visibleSet.has(f)) continue;
    const handled = window.__uiaHasHandler && window.__uiaHasHandler(f, ['submit']);
    if (!f.getAttribute('action') && handled === 'none' && !f.hasAttribute('onsubmit')) {
      add('form-noop', 'functional', 'warning', f, 'Formulier zonder action of submit-handler',
        'Bij verzenden wordt de huidige pagina herladen zonder dat de data ergens heen gaat.', 'Voeg een action-URL toe of handel submit af in JavaScript.');
    }
  }

  // Lege/kapotte iframes
  for (const fr of all.filter((e) => e.tagName === 'IFRAME')) {
    if (!fr.getAttribute('src') && !fr.getAttribute('srcdoc')) add('iframe-empty', 'content', 'warning', fr, 'Leeg iframe', '', 'Geef een src op of verwijder het iframe.');
  }

  return {
    issues,
    links,
    buttons: buttonCandidates,
    meta: {
      title: document.title,
      url: location.href,
      viewport: { w: vw, h: vh },
      docHeight: document.documentElement.scrollHeight,
      elements: all.length,
      fonts: [...new Set(all.map((e) => cs(e).fontFamily.split(',')[0].replace(/["']/g, '').trim()))].slice(0, 10),
      fontSizes: [...new Set(all.map((e) => cs(e).fontSize))].length,
    },
  };
};
