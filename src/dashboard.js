const vscode = require('vscode');
const crypto = require('crypto');

class DashboardPanel {
  /** @type {DashboardPanel|undefined} */
  static current;

  static show(ctx, store, actions, projectId) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.One);
      if (projectId) DashboardPanel.current.setProject(projectId);
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('uiAudit.dashboard', 'UI Audit', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [ctx.globalStorageUri, vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
    DashboardPanel.current = new DashboardPanel(ctx, panel, store, actions, projectId);
    return DashboardPanel.current;
  }

  constructor(ctx, panel, store, actions, projectId) {
    this.ctx = ctx;
    this.panel = panel;
    this.store = store;
    this.actions = actions;
    this.projectId = projectId || (store.all()[0] && store.all()[0].id);
    this.progress = null;
    this.disposables = [];
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.disposables.push(store.onChange(() => this.push()));
  }

  setProject(id) {
    this.projectId = id;
    this.push();
  }

  setProgress(projectId, text) {
    if (projectId !== this.projectId) return;
    this.progress = text;
    this.panel.webview.postMessage({ type: 'progress', text });
  }

  push() {
    const projects = this.store.all();
    let project = projects.find((p) => p.id === this.projectId);
    if (!project && projects.length) {
      project = projects[0];
      this.projectId = project.id;
    }
    const w = this.panel.webview;
    const toUri = (p) => (p ? w.asWebviewUri(vscode.Uri.file(p)).toString() : null);
    let scan = project ? this.store.latestScan(project) : null;
    if (scan) {
      scan = { ...scan };
      scan.screenshotUris = Object.fromEntries(Object.entries(scan.screenshots || {}).map(([k, v]) => [k, toUri(v)]));
      scan.issues = scan.issues.map((i) => ({ ...i, cropUris: Object.fromEntries(Object.entries(i.crops || {}).map(([k, v]) => [k, toUri(v)])) }));
    }
    w.postMessage({
      type: 'state',
      projects: projects.map((p) => ({ id: p.id, name: p.name, url: p.url, counts: p.scans && p.scans[0] ? p.scans[0].counts : null })),
      project,
      scan,
      history: project ? project.scans : [],
      progress: this.progress,
      hasWorkspace: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
    });
  }

  async onMessage(m) {
    const project = this.store.get(this.projectId);
    switch (m.type) {
      case 'ready': return this.push();
      case 'selectProject': return this.setProject(m.id);
      case 'newProject': return this.actions.newProject();
      case 'quickCheck': return this.actions.quickCheck();
      case 'scan': return project && this.actions.scan(project.id);
      case 'preview': return project && this.actions.preview(project.id);
      case 'toggleLive': return project && this.actions.toggleLive(project.id);
      case 'editProject': return project && this.actions.editProject(project.id);
      case 'deleteProject': return project && this.actions.deleteProject(project.id);
      case 'ignore': return project && this.store.setIgnored(project, m.id, m.value);
      case 'openSource': {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
        const line = Math.max(0, (m.line || 1) - 1);
        return vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
      }
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return vscode.window.setStatusBarMessage('$(check) Copied', 2000);
      case 'export': return project && this.actions.exportIssues(project.id, m.format, m.ids);
    }
  }

  dispose() {
    DashboardPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }

  html() {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --err:#f14c4c; --warn:#e2a03f; --info:#4c9aff; --ok:#3fb950;
  --bg:var(--vscode-editor-background); --fg:var(--vscode-foreground); --muted:var(--vscode-descriptionForeground);
  --line:var(--vscode-panel-border, rgba(128,128,128,.25)); --card:var(--vscode-sideBar-background, rgba(128,128,128,.06));
  --hover:var(--vscode-list-hoverBackground); --sel:var(--vscode-list-activeSelectionBackground); --accent:var(--vscode-focusBorder);
  --btn:var(--vscode-button-background); --btnfg:var(--vscode-button-foreground); --btnh:var(--vscode-button-hoverBackground);
  --btn2:var(--vscode-button-secondaryBackground); --btn2fg:var(--vscode-button-secondaryForeground); --btn2h:var(--vscode-button-secondaryHoverBackground);
  --input:var(--vscode-input-background); --inputfg:var(--vscode-input-foreground); --inputb:var(--vscode-input-border, transparent);
  --mono:var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--vscode-font-family);display:flex;flex-direction:column;overflow:hidden}
#app{flex:1;display:flex;flex-direction:column;min-height:0}
button{font:inherit;cursor:pointer;border:0;border-radius:6px;padding:6px 12px;background:var(--btn2);color:var(--btn2fg);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
button:hover{background:var(--btn2h)}
button.primary{background:var(--btn);color:var(--btnfg)}button.primary:hover{background:var(--btnh)}
button.ghost{background:transparent;color:var(--fg)}button.ghost:hover{background:var(--hover)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,select:focus-visible,input:focus-visible{outline:1px solid var(--accent);outline-offset:1px}
select,input[type=search]{font:inherit;background:var(--input);color:var(--inputfg);border:1px solid var(--inputb);border-radius:6px;padding:5px 8px}
.top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.top h1{font-size:15px;margin:0;font-weight:600}
.top .url{color:var(--muted);font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.top .spacer{flex:1}
.live{display:inline-flex;align-items:center;gap:6px}
.live .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.live.on .dot{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
.progress{padding:8px 16px;background:color-mix(in srgb,var(--info) 12%,transparent);border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
.spin{width:12px;height:12px;border:2px solid var(--info);border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
.summary{display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:96px;cursor:pointer;text-align:left;display:block;color:var(--fg)}
.stat b{display:block;font-size:20px;line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.stat.error b{color:var(--err)}.stat.warning b{color:var(--warn)}.stat.info b{color:var(--info)}.stat.new b{color:var(--fg)}.stat.fixed b{color:var(--ok)}
.stat.active{outline:1px solid var(--accent)}
.stat:hover{background:var(--hover)}
.toolbar{display:flex;gap:8px;padding:10px 16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:2px}
.seg button{background:transparent;color:var(--muted);padding:4px 10px;border-radius:6px}
.seg button.on{background:var(--btn);color:var(--btnfg)}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:3px 10px;font-size:12px}
.chip.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,transparent)}
.chip i{font-style:normal;color:var(--muted);margin-left:4px}
.main{flex:1;display:grid;grid-template-columns:minmax(360px,1fr) minmax(320px,1fr);grid-template-rows:minmax(0,1fr);min-height:0}
.list{overflow:auto;border-right:1px solid var(--line)}
.issue{border-bottom:1px solid var(--line)}
.row{display:grid;grid-template-columns:20px 10px 1fr auto;gap:10px;align-items:start;padding:10px 16px;cursor:pointer}
.row:hover{background:var(--hover)}
.issue.sel .row{background:var(--sel)}
.issue.ignored{opacity:.5}
.sev{width:10px;height:10px;border-radius:50%;margin-top:4px}
.sev.error{background:var(--err)}.sev.warning{background:var(--warn)}.sev.info{background:var(--info)}
.title{font-weight:500}
.sub{color:var(--muted);font-size:12px;display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.badge.new{color:var(--btnfg);background:var(--btn);border-color:transparent}
.detail{padding:4px 16px 14px 56px;display:none}
.issue.sel .detail{display:block}
.detail p{margin:6px 0}
.detail .fix{border-left:3px solid var(--ok);padding:6px 10px;background:color-mix(in srgb,var(--ok) 8%,transparent);border-radius:0 6px 6px 0}
.kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;margin:8px 0;font-size:12px}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
code,pre{font-family:var(--mono);font-size:12px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;white-space:pre-wrap;word-break:break-all;margin:6px 0;max-height:160px;overflow:auto}
a.link{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}a.link:hover{text-decoration:underline}
.crop{max-width:100%;max-height:220px;border-radius:6px;border:1px solid var(--line);margin:6px 0;display:block}
.actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.viewer{overflow:auto;position:relative;background:color-mix(in srgb,var(--fg) 4%,transparent)}
.viewer-head{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg);border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
.shot{position:relative;margin:16px auto;box-shadow:0 2px 16px rgba(0,0,0,.25);transform-origin:top left}
.shot img{display:block;width:100%}
.box{position:absolute;border:2px solid var(--warn);border-radius:2px;cursor:pointer;background:color-mix(in srgb,var(--warn) 10%,transparent)}
.box.error{border-color:var(--err);background:color-mix(in srgb,var(--err) 10%,transparent)}
.box.info{border-color:var(--info);background:color-mix(in srgb,var(--info) 8%,transparent)}
.box.sel{outline:3px solid var(--accent);outline-offset:2px;z-index:3;animation:pulse 1.2s ease-out 2}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent)}100%{box-shadow:0 0 0 14px transparent}}
.box .n{position:absolute;top:-10px;left:-10px;background:inherit;min-width:18px;height:18px;border-radius:9px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;color:#fff;background:var(--warn)}
.box.error .n{background:var(--err)}.box.info .n{background:var(--info)}
.footer{display:flex;gap:8px;align-items:center;padding:10px 16px;border-top:1px solid var(--line);flex-wrap:wrap;background:var(--card)}
.footer .count{color:var(--muted);margin-right:auto}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:40px;color:var(--muted)}
.empty h2{color:var(--fg);margin:0;font-size:18px}
.menu{position:relative}
.menu .pop{position:absolute;bottom:110%;right:0;background:var(--vscode-menu-background,var(--bg));color:var(--vscode-menu-foreground,var(--fg));border:1px solid var(--line);border-radius:8px;padding:4px;display:none;min-width:180px;box-shadow:0 4px 18px rgba(0,0,0,.3);z-index:10}
.menu.open .pop{display:block}
.pop button{display:flex;width:100%;background:transparent;color:inherit;justify-content:flex-start}
.pop button:hover{background:var(--vscode-menu-selectionBackground,var(--hover))}
.resolved{padding:10px 16px;color:var(--muted);font-size:12px}
.resolved summary{cursor:pointer}
@media (max-width:860px){.main{grid-template-columns:1fr}.viewer{display:none}}
</style></head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
let S = { projects: [], project: null, scan: null, progress: null };
let ui = Object.assign({ vp: 'all', sev: null, cats: [], q: '', showIgnored: false, sel: null, checked: [] }, saved.ui || {});
const CAT = { layout: 'Layout', spacing: 'Spacing & consistency', responsive: 'Responsive', functional: 'Buttons & links', backend: 'Backend & console', content: 'Content', a11y: 'Accessibility' };
const VPL = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const send = (type, data) => vscode.postMessage(Object.assign({ type }, data || {}));
const persist = () => vscode.setState({ ui });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { S = m; if (!S.progress) S.progress = null; render(); }
  if (m.type === 'progress') { S.progress = m.text; renderProgress(); }
});

function ignored(i) { return S.project && (S.project.ignored || []).includes(i.id); }
function filtered() {
  if (!S.scan) return [];
  const q = ui.q.toLowerCase();
  return S.scan.issues.filter((i) =>
    (ui.showIgnored || !ignored(i)) &&
    (ui.vp === 'all' || (i.viewports || []).includes(ui.vp)) &&
    (!ui.sev || (ui.sev === 'new' ? i.isNew : i.severity === ui.sev)) &&
    (!ui.cats.length || ui.cats.includes(i.category)) &&
    (!q || (i.title + ' ' + (i.selector || '') + ' ' + (i.detail || '') + ' ' + (i.source ? i.source.file : '')).toLowerCase().includes(q))
  );
}
function exportIds() {
  const vis = filtered().map((i) => i.id);
  const chk = ui.checked.filter((id) => vis.includes(id));
  return chk.length ? chk : vis;
}

function renderProgress() {
  const el = document.getElementById('progress');
  if (!el) return render();
  el.style.display = S.progress ? 'flex' : 'none';
  el.querySelector('.txt').textContent = S.progress || '';
  const b = document.getElementById('scanBtn'); if (b) b.disabled = !!S.progress;
}

function render() {
  const app = document.getElementById('app');
  if (!S.projects.length) {
    app.innerHTML = '<div class="empty"><h2>No projects yet</h2><p>Add a project with the URL of your site or local dev server<br>(e.g. http://localhost:3000) and scan it for UI bugs.</p><div style="display:flex;gap:8px"><button class="primary" data-a="quickCheck">🔗 Check a URL</button><button data-a="newProject">+ Project with dev server</button></div></div>';
    return bind();
  }
  const p = S.project, scan = S.scan;
  const counts = { error: 0, warning: 0, info: 0, new: 0 };
  const catCounts = {};
  if (scan) for (const i of scan.issues) {
    if (ignored(i)) continue;
    if (ui.vp !== 'all' && !(i.viewports || []).includes(ui.vp)) continue;
    counts[i.severity]++; if (i.isNew) counts.new++;
    catCounts[i.category] = (catCounts[i.category] || 0) + 1;
  }
  const prevList = document.getElementById('list'), prevViewer = document.getElementById('viewer');
  const keep = { l: prevList ? prevList.scrollTop : 0, v: prevViewer ? prevViewer.scrollTop : 0 };
  const list = filtered();
  const vps = scan ? scan.viewports.map((v) => v.id) : [];
  const shotVp = ui.vp === 'all' ? (ui.sel && list.find((i) => i.id === ui.sel) ? (list.find((i) => i.id === ui.sel).viewports || [])[0] : vps[0]) : ui.vp;

  app.innerHTML = \`
  <div class="top">
    <select id="proj" aria-label="Project">\${S.projects.map((x) => \`<option value="\${x.id}" \${x.id === p.id ? 'selected' : ''}>\${esc(x.name)}\${x.counts ? ' (' + x.counts.total + ')' : ''}</option>\`).join('')}</select>
    <button class="ghost" data-a="newProject" title="New project">+</button>
    <button data-a="quickCheck" title="Paste a link and check that page right away (e.g. just went live)">🔗 Check URL</button>
    <span class="url" title="\${esc(p.url)}">\${esc(p.url)}</span>
    <span class="spacer"></span>
    \${scan ? \`<span class="sub">Last scan \${new Date(scan.scannedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>\` : ''}
    <button class="ghost live \${p.live ? 'on' : ''}" data-a="toggleLive" title="Automatically rescan on save"><span class="dot"></span>Live</button>
    <button data-a="preview" title="View the site at phone, tablet or desktop size">📱 Device preview</button>
    <button class="ghost" data-a="editProject" title="Edit project">⚙︎</button>
    <button class="primary" id="scanBtn" data-a="scan" \${S.progress ? 'disabled' : ''}>⟳ Scan</button>
  </div>
  <div class="progress" id="progress" style="display:\${S.progress ? 'flex' : 'none'}"><div class="spin"></div><span class="txt">\${esc(S.progress || '')}</span></div>
  \${!scan ? \`<div class="empty"><h2>Not scanned yet</h2><p>Scan \${esc(p.url)} on desktop, tablet and mobile.</p><button class="primary" data-a="scan">⟳ Scan now</button></div>\` : \`
  <div class="summary">
    <button class="stat error \${ui.sev === 'error' ? 'active' : ''}" data-sev="error"><b>\${counts.error}</b><span>Errors</span></button>
    <button class="stat warning \${ui.sev === 'warning' ? 'active' : ''}" data-sev="warning"><b>\${counts.warning}</b><span>Warnings</span></button>
    <button class="stat info \${ui.sev === 'info' ? 'active' : ''}" data-sev="info"><b>\${counts.info}</b><span>Info</span></button>
    \${S.history && S.history.length > 1 ? \`<button class="stat new \${ui.sev === 'new' ? 'active' : ''}" data-sev="new"><b>+\${counts.new}</b><span>New</span></button>
    <div class="stat fixed"><b>\${(scan.resolved || []).length}</b><span>Fixed</span></div>\` : ''}
  </div>
  <div class="toolbar">
    <div class="seg" role="tablist">\${['all', ...vps].map((v) => \`<button class="\${ui.vp === v ? 'on' : ''}" data-vp="\${v}">\${v === 'all' ? 'All' : (v === 'mobile' ? '📱 ' : v === 'tablet' ? '▭ ' : '🖥 ') + VPL[v]}</button>\`).join('')}</div>
    <div class="chips">\${Object.keys(CAT).filter((c) => catCounts[c]).map((c) => \`<button class="chip \${ui.cats.includes(c) ? 'on' : ''}" data-cat="\${c}">\${CAT[c]}<i>\${catCounts[c]}</i></button>\`).join('')}</div>
    <span class="spacer" style="flex:1"></span>
    <input type="search" id="q" placeholder="Search issues…" value="\${esc(ui.q)}">
    <label class="sub" style="align-items:center;gap:4px;display:flex"><input type="checkbox" id="showIgn" \${ui.showIgnored ? 'checked' : ''}> ignored</label>
  </div>
  <div class="main">
    <div class="list" id="list">
      \${list.length ? list.map((i, n) => issueHTML(i, n)).join('') : '<div class="empty"><h2>Nothing found 🎉</h2><p>No issues match these filters.</p></div>'}
      \${(scan.resolved || []).length ? \`<details class="resolved"><summary>✓ \${scan.resolved.length} issues fixed since the previous scan</summary><ul>\${scan.resolved.map((r) => '<li>' + esc(r.title) + (r.selector ? ' <code>' + esc(r.selector) + '</code>' : '') + '</li>').join('')}</ul></details>\` : ''}
    </div>
    <div class="viewer" id="viewer">\${viewerHTML(list, shotVp)}</div>
  </div>
  <div class="footer">
    <span class="count">\${ui.checked.filter((id) => list.some((i) => i.id === id)).length ? ui.checked.filter((id) => list.some((i) => i.id === id)).length + ' selected' : list.length + ' issues shown'} → export</span>
    <button data-a="selAll">\${ui.checked.length ? 'Clear selection' : 'Select all'}</button>
    <button class="primary" data-exp="claude" title="Copy a ready-made prompt for Claude to the clipboard">✦ Copy for Claude</button>
    <button data-exp="claudeCode" title="Writes .ui-audit/issues.md + screenshots and starts Claude Code in the terminal">⌘ Fix with Claude Code</button>
    <button data-exp="mail" title="Mail to the developer, with the HTML report as an attachment">✉ Mail developer</button>
    <div class="menu" id="expMenu"><button data-a="expMenu">Export ▾</button>
      <div class="pop">
        <button data-exp="md">Markdown (.md)</button>
        <button data-exp="html">HTML report with screenshots</button>
        <button data-exp="csv">CSV (Excel / Sheets / Jira)</button>
        <button data-exp="json">JSON</button>
      </div>
    </div>
  </div>\`}\`;
  bind();
  const nl = document.getElementById('list'); if (nl) nl.scrollTop = keep.l;
  const nv = document.getElementById('viewer'); if (nv) nv.scrollTop = keep.v;
  fitShot();
}

function issueHTML(i, n) {
  const sel = ui.sel === i.id;
  const crop = i.cropUris && (i.cropUris[ui.vp] || Object.values(i.cropUris)[0]);
  const m = i.measure;
  return \`<div class="issue \${sel ? 'sel' : ''} \${ignored(i) ? 'ignored' : ''}" data-id="\${i.id}">
    <div class="row" data-sel="\${i.id}">
      <input type="checkbox" data-chk="\${i.id}" \${ui.checked.includes(i.id) ? 'checked' : ''} aria-label="Select for export">
      <span class="sev \${i.severity}"></span>
      <div>
        <div class="title">\${esc(i.title)}</div>
        <div class="sub"><span>\${CAT[i.category] || i.category}</span>\${(i.viewports || []).map((v) => '<span class="badge">' + VPL[v] + '</span>').join('')}\${i.isNew ? '<span class="badge new">new</span>' : ''}\${i.source ? '<span>📄 ' + esc(i.source.file) + ':' + i.source.line + '</span>' : ''}</div>
      </div>
      <span class="sub">\${n + 1}</span>
    </div>
    \${sel ? \`<div class="detail">
      \${i.detail ? '<p>' + esc(i.detail).replace(/\\n/g, '<br>') + '</p>' : ''}
      \${i.suggestion ? '<p class="fix"><b>Fix:</b> ' + esc(i.suggestion) + '</p>' : ''}
      <dl class="kv">
        \${i.selector ? '<dt>Selector</dt><dd><code>' + esc(i.selector) + '</code> <a class="link" data-copy="' + esc(i.selector) + '">copy</a></dd>' : ''}
        \${m && m.expected !== undefined ? '<dt>Measurement</dt><dd>expected <b>' + esc(m.expected) + '</b> · found <b>' + esc(m.actual) + '</b>' + (m.property ? ' (' + esc(m.property) + ')' : '') + '</dd>' : ''}
        \${i.source ? '<dt>Source</dt><dd><a class="link" data-open="' + esc(i.source.path) + '" data-line="' + i.source.line + '">' + esc(i.source.file) + ':' + i.source.line + '</a></dd>' : ''}
        \${i.style ? '<dt>CSS</dt><dd><a class="link" data-open="' + esc(i.style.path) + '" data-line="' + i.style.line + '">' + esc(i.style.file) + ':' + i.style.line + '</a> <code>' + esc(i.style.selector) + '</code></dd>' : ''}
        \${i.examples ? '<dt>Also in</dt><dd>' + i.examples.slice(0, 4).map((e) => '<code>' + esc(e) + '</code>').join('<br>') + '</dd>' : ''}
      </dl>
      \${crop ? '<img class="crop" src="' + crop + '" alt="Crop of the element">' : ''}
      \${i.html ? '<pre>' + esc(i.html) + '</pre>' : ''}
      <div class="actions">
        <button data-exp1="claude" data-id="\${i.id}">✦ Copy for Claude</button>
        <button data-ign="\${i.id}">\${ignored(i) ? 'Stop ignoring' : 'Ignore (false positive)'}</button>
      </div>
    </div>\` : ''}
  </div>\`;
}

function viewerHTML(list, vp) {
  const scan = S.scan;
  if (!scan || !vp) return '';
  const uri = scan.screenshotUris && scan.screenshotUris[vp];
  const meta = scan.viewports.find((v) => v.id === vp);
  if (!uri || !meta) return '<div class="empty">No screenshot for this viewport.</div>';
  const boxes = list.map((i, n) => ({ i, n, r: i.rects && i.rects[vp] })).filter((x) => x.r);
  return \`<div class="viewer-head">\${VPL[vp]} · \${meta.width}px\${meta.shotWidth && meta.shotWidth !== meta.width ? ' (page renders ' + meta.shotWidth + 'px wide!)' : ''} · \${boxes.length} markers \${ui.vp === 'all' ? '<span>(choose a viewport at the top to switch)</span>' : ''}</div>
    <div class="shot" id="shot" data-w="\${meta.shotWidth || meta.width}" style="width:\${meta.shotWidth || meta.width}px">
      <img src="\${uri}" alt="Screenshot \${VPL[vp]}">
      \${boxes.map(({ i, n, r }) => \`<div class="box \${i.severity} \${ui.sel === i.id ? 'sel' : ''}" data-sel="\${i.id}" title="\${esc(i.title)}" style="left:\${r.x}px;top:\${r.y}px;width:\${Math.max(r.w, 6)}px;height:\${Math.max(r.h, 6)}px"><span class="n">\${n + 1}</span></div>\`).join('')}
    </div>\`;
}

let lastSel = null;
function fitShot() {
  const shot = document.getElementById('shot'), viewer = document.getElementById('viewer');
  if (!shot || !viewer) return;
  const w = +shot.dataset.w, avail = viewer.clientWidth - 32;
  const scale = Math.min(1, avail / w);
  shot.style.transform = 'scale(' + scale + ')';
  shot.style.marginLeft = Math.max(16, (viewer.clientWidth - w * scale) / 2) + 'px';
  // negative margin so the scaled height doesn't leave empty space
  const img = shot.querySelector('img');
  const apply = () => (shot.style.marginBottom = -(img.naturalHeight * (1 - scale)) + 16 + 'px');
  img.complete ? apply() : img.addEventListener('load', apply, { once: true });
  const selBox = shot.querySelector('.box.sel');
  // only scroll to the marker if the selection just changed
  if (selBox && lastSel !== ui.sel) viewer.scrollTop = Math.max(0, parseFloat(selBox.style.top) * scale - 120);
  lastSel = ui.sel;
}
window.addEventListener('resize', fitShot);

function bind() {
  const app = document.getElementById('app');
  app.onclick = (e) => {
    const t = e.target.closest('[data-a],[data-sev],[data-vp],[data-cat],[data-sel],[data-chk],[data-copy],[data-open],[data-ign],[data-exp],[data-exp1]');
    if (!t) { document.getElementById('expMenu')?.classList.remove('open'); return; }
    const d = t.dataset;
    if (d.chk !== undefined) {
      ui.checked = t.checked ? [...ui.checked, d.chk] : ui.checked.filter((x) => x !== d.chk);
      persist(); e.stopPropagation(); return render();
    }
    if (d.a === 'expMenu') return document.getElementById('expMenu').classList.toggle('open');
    if (d.a === 'selAll') { ui.checked = ui.checked.length ? [] : filtered().map((i) => i.id); persist(); return render(); }
    if (d.a) return send(d.a);
    if (d.sev) { ui.sev = ui.sev === d.sev ? null : d.sev; persist(); return render(); }
    if (d.vp) { ui.vp = d.vp; persist(); return render(); }
    if (d.cat) { ui.cats = ui.cats.includes(d.cat) ? ui.cats.filter((c) => c !== d.cat) : [...ui.cats, d.cat]; persist(); return render(); }
    if (d.copy !== undefined) return send('copy', { text: d.copy });
    if (d.open) return send('openSource', { path: d.open, line: +d.line });
    if (d.ign) return send('ignore', { id: d.ign, value: !(S.project.ignored || []).includes(d.ign) });
    if (d.exp) { document.getElementById('expMenu')?.classList.remove('open'); return send('export', { format: d.exp, ids: exportIds() }); }
    if (d.exp1) return send('export', { format: d.exp1, ids: [d.id] });
    if (d.sel) {
      if (e.target.closest('.detail')) return;
      ui.sel = ui.sel === d.sel ? null : d.sel; persist(); render();
      const row = document.querySelector('.issue[data-id="' + d.sel + '"]');
      if (row && t.classList.contains('box')) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  const proj = document.getElementById('proj');
  if (proj) proj.onchange = () => { ui.sel = null; ui.checked = []; persist(); send('selectProject', { id: proj.value }); };
  const q = document.getElementById('q');
  if (q) q.oninput = () => { ui.q = q.value; persist(); clearTimeout(window.__qt); window.__qt = setTimeout(() => { render(); const nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }, 200); };
  const si = document.getElementById('showIgn');
  if (si) si.onchange = () => { ui.showIgnored = si.checked; persist(); render(); };
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const list = filtered();
  if (!list.length || !['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) return;
  e.preventDefault();
  let idx = list.findIndex((i) => i.id === ui.sel);
  idx = e.key === 'ArrowDown' || e.key === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
  ui.sel = list[idx].id; persist(); render();
  document.querySelector('.issue[data-id="' + ui.sel + '"]')?.scrollIntoView({ block: 'nearest' });
});

send('ready');
</script>
</body></html>`;
  }
}

module.exports = { DashboardPanel };
