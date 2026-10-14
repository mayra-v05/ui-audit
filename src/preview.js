const vscode = require('vscode');
const crypto = require('crypto');

const DEVICES = [
  { id: 'se', label: 'iPhone SE', w: 375, h: 667, group: 'Telefoon' },
  { id: 'iphone', label: 'iPhone 15', w: 393, h: 852, group: 'Telefoon' },
  { id: 'promax', label: 'iPhone 15 Pro Max', w: 430, h: 932, group: 'Telefoon' },
  { id: 'pixel', label: 'Pixel 8', w: 412, h: 915, group: 'Telefoon' },
  { id: 'galaxy', label: 'Galaxy S (360)', w: 360, h: 780, group: 'Telefoon' },
  { id: 'ipadmini', label: 'iPad mini', w: 768, h: 1024, group: 'Tablet' },
  { id: 'ipadpro', label: 'iPad Pro 11"', w: 834, h: 1194, group: 'Tablet' },
  { id: 'laptop', label: 'Laptop', w: 1280, h: 800, group: 'Desktop' },
  { id: 'desktop', label: 'Desktop', w: 1440, h: 900, group: 'Desktop' },
  { id: 'wide', label: 'Full HD', w: 1920, h: 1080, group: 'Desktop' },
];

class PreviewPanel {
  static current;

  static async show(ctx, project, onScan) {
    const url = (await vscode.env.asExternalUri(vscode.Uri.parse(project.url))).toString(true);
    if (PreviewPanel.current) {
      PreviewPanel.current.project = project;
      PreviewPanel.current.panel.title = `Preview · ${project.name}`;
      PreviewPanel.current.panel.webview.postMessage({ type: 'url', url, name: project.name });
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel('uiAudit.preview', `Preview · ${project.name}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
    PreviewPanel.current = new PreviewPanel(ctx, panel, project, url, onScan);
  }

  static reload() {
    PreviewPanel.current && PreviewPanel.current.panel.webview.postMessage({ type: 'reload' });
  }

  constructor(ctx, panel, project, url, onScan) {
    this.panel = panel;
    this.project = project;
    const last = ctx.globalState.get('uiAudit.previewDevice', 'iphone');
    panel.webview.html = this.html(url, last);
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'scan') onScan(this.project.id);
      if (m.type === 'device') ctx.globalState.update('uiAudit.previewDevice', m.id);
      if (m.type === 'external') vscode.env.openExternal(vscode.Uri.parse(m.url));
    });
    panel.onDidDispose(() => (PreviewPanel.current = undefined));
  }

  html(url, device) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = `default-src 'none'; frame-src * http: https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{--line:var(--vscode-panel-border, rgba(128,128,128,.25));--muted:var(--vscode-descriptionForeground)}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family);display:flex;flex-direction:column}
.bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px}
button,select,input{font:inherit;border-radius:6px;border:0;padding:5px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.seg button{background:transparent;color:var(--muted)}.seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);cursor:auto}
input.w{width:70px}
.dim{color:var(--muted);font-variant-numeric:tabular-nums}
.stage{flex:1;overflow:auto;display:flex;justify-content:center;align-items:flex-start;padding:24px;background:color-mix(in srgb,var(--vscode-foreground) 5%,transparent)}
.device{transform-origin:top left;background:#111;border-radius:var(--r,36px);padding:var(--p,12px);box-shadow:0 10px 40px rgba(0,0,0,.35);flex:none}
.device.desk{border-radius:10px;padding:0;background:transparent}
iframe{display:block;border:0;background:#fff;border-radius:calc(var(--r,36px) - var(--p,12px))}
.device.desk iframe{border-radius:8px}
.spacer{flex:1}
.note{font-size:11px;color:var(--muted);padding:4px 12px;border-top:1px solid var(--line)}
</style></head><body>
<div class="bar">
  <div class="seg" id="groups"></div>
  <select id="dev" aria-label="Apparaat"></select>
  <input class="w" id="w" type="number" min="240" max="3000" aria-label="Breedte"> × <input class="w" id="h" type="number" min="240" max="3000" aria-label="Hoogte">
  <button id="rot" title="Draaien">⟲ Draai</button>
  <button id="fit" title="Passend maken">⤢ Passend</button>
  <span class="dim" id="zoom"></span>
  <span class="spacer"></span>
  <input id="url" style="min-width:220px;flex:1;max-width:420px" aria-label="URL">
  <button id="reload" title="Herladen">⟳</button>
  <button id="ext" title="Open in browser">↗</button>
  <button class="primary" id="scan">Scan op fouten</button>
</div>
<div class="stage" id="stage"><div id="wrap" style="flex:none"><div class="device" id="device"><iframe id="frame" title="Preview"></iframe></div></div></div>
<div class="note">Tip: de breedte bepaalt welke media queries actief zijn. Voor echte touch/user-agent-checks gebruikt de scan een geëmuleerde telefoon.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const DEVICES = ${JSON.stringify(DEVICES)};
let st = Object.assign({ url: ${JSON.stringify(url)}, dev: ${JSON.stringify(device)}, w: 393, h: 852, fit: true, rotated: false }, vscode.getState() || {}, { url: ${JSON.stringify(url)} });
const $ = (id) => document.getElementById(id);
const groups = [...new Set(DEVICES.map((d) => d.group))];
$('groups').innerHTML = groups.map((g) => '<button data-g="' + g + '">' + (g === 'Telefoon' ? '📱 ' : g === 'Tablet' ? '▭ ' : '🖥 ') + g + '</button>').join('');
$('dev').innerHTML = groups.map((g) => '<optgroup label="' + g + '">' + DEVICES.filter((d) => d.group === g).map((d) => '<option value="' + d.id + '">' + d.label + ' — ' + d.w + '×' + d.h + '</option>').join('') + '</optgroup>').join('') + '<option value="custom">Aangepast</option>';

function setDevice(id) {
  const d = DEVICES.find((x) => x.id === id);
  st.dev = id;
  if (d) { st.w = st.rotated ? d.h : d.w; st.h = st.rotated ? d.w : d.h; }
  vscode.postMessage({ type: 'device', id });
  apply();
}
function apply() {
  const d = DEVICES.find((x) => x.id === st.dev);
  const group = d ? d.group : (st.w < 600 ? 'Telefoon' : st.w < 1100 ? 'Tablet' : 'Desktop');
  document.querySelectorAll('[data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === group));
  $('dev').value = d ? d.id : 'custom';
  $('w').value = st.w; $('h').value = st.h;
  const dev = $('device'), f = $('frame');
  dev.classList.toggle('desk', group === 'Desktop');
  dev.style.setProperty('--r', group === 'Telefoon' ? '44px' : group === 'Tablet' ? '24px' : '10px');
  dev.style.setProperty('--p', group === 'Desktop' ? '0px' : '12px');
  f.style.width = st.w + 'px'; f.style.height = st.h + 'px';
  if ($('url').value !== st.url) $('url').value = st.url;
  if (f.dataset.src !== st.url) { f.src = st.url; f.dataset.src = st.url; }
  fit();
  vscode.setState(st);
}
function fit() {
  const stage = $('stage'), dev = $('device');
  const pad = parseInt(getComputedStyle(dev).getPropertyValue('--p')) || 0;
  const W = st.w + pad * 2, H = st.h + pad * 2;
  const s = st.fit ? Math.min(1, (stage.clientWidth - 48) / W, (stage.clientHeight - 48) / H) : 1;
  dev.style.transform = 'scale(' + s + ')';
  $('wrap').style.width = W * s + 'px';
  $('wrap').style.height = H * s + 'px';
  $('zoom').textContent = Math.round(s * 100) + '%';
  $('fit').classList.toggle('primary', st.fit);
}
$('groups').onclick = (e) => { const g = e.target.closest('[data-g]'); if (!g) return; const d = DEVICES.find((x) => x.group === g.dataset.g && (g.dataset.g !== 'Telefoon' || x.id === 'iphone') && (g.dataset.g !== 'Desktop' || x.id === 'desktop')); setDevice(d.id); };
$('dev').onchange = () => $('dev').value !== 'custom' && setDevice($('dev').value);
$('w').onchange = () => { st.w = +$('w').value; st.dev = 'custom'; apply(); };
$('h').onchange = () => { st.h = +$('h').value; st.dev = 'custom'; apply(); };
$('rot').onclick = () => { st.rotated = !st.rotated; [st.w, st.h] = [st.h, st.w]; apply(); };
$('fit').onclick = () => { st.fit = !st.fit; fit(); vscode.setState(st); };
$('reload').onclick = () => { $('frame').src = st.url; };
$('url').onchange = () => { st.url = $('url').value; apply(); };
$('ext').onclick = () => vscode.postMessage({ type: 'external', url: st.url });
$('scan').onclick = () => vscode.postMessage({ type: 'scan' });
window.addEventListener('resize', fit);
window.addEventListener('message', (e) => {
  if (e.data.type === 'reload') $('frame').src = $('frame').src;
  if (e.data.type === 'url') { st.url = e.data.url; apply(); }
});
st.dev === 'custom' ? apply() : setDevice(st.dev);
</script></body></html>`;
  }
}

module.exports = { PreviewPanel, DEVICES };
