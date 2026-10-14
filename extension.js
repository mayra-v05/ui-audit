const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execSync } = require('child_process');
const { Store, countIssues } = require('./src/store');
const { DashboardPanel } = require('./src/dashboard');
const { PreviewPanel } = require('./src/preview');
const { findSources } = require('./src/sourceFinder');
const exporter = require('./src/export');

const COMMON_PORTS = [3000, 3001, 5173, 5174, 4321, 4200, 8080, 8000, 5500, 5000, 1234, 8888, 4000, 3333, 9000];

let store, statusItem, diagnostics, tree;
const scanning = new Map(); // projectId -> CancellationTokenSource-ish
const liveTimers = new Map();

function cfg() {
  return vscode.workspace.getConfiguration('uiAudit');
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  store = new Store(ctx);
  diagnostics = vscode.languages.createDiagnosticCollection('UI Audit');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'uiAudit.openDashboard';
  ctx.subscriptions.push(diagnostics, statusItem);

  tree = new ProjectTree();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('uiAudit.projects', tree));
  ctx.subscriptions.push(store.onChange(() => { tree.refresh(); updateStatus(); }));

  const actions = {
    newProject: () => newProject(ctx),
    quickCheck: () => quickCheck(ctx),
    scan: (id) => runScan(ctx, id),
    preview: (id) => openPreview(ctx, id),
    toggleLive: (id) => toggleLive(id),
    editProject: (id) => editProject(id),
    deleteProject: (id) => deleteProject(id),
    exportIssues: (id, format, ids) => exportIssues(ctx, id, format, ids),
  };
  ctx.uiAuditActions = actions;
  const dash = (id) => DashboardPanel.show(ctx, store, actions, id);
  const pick = async (arg) => (arg && arg.id) || (typeof arg === 'string' ? arg : (await pickProject())?.id);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('uiAudit.openDashboard', async (arg) => dash(arg && arg.id)),
    vscode.commands.registerCommand('uiAudit.newProject', () => newProject(ctx)),
    vscode.commands.registerCommand('uiAudit.quickCheck', (url) => quickCheck(ctx, typeof url === 'string' ? url : undefined)),
    vscode.commands.registerCommand('uiAudit.scan', async (arg) => { const id = await pick(arg); if (id) runScan(ctx, id); }),
    vscode.commands.registerCommand('uiAudit.scanAll', async () => { for (const p of store.all()) await runScan(ctx, p.id); }),
    vscode.commands.registerCommand('uiAudit.preview', async (arg) => { const id = await pick(arg); if (id) openPreview(ctx, id); }),
    vscode.commands.registerCommand('uiAudit.toggleLive', async (arg) => { const id = await pick(arg); if (id) toggleLive(id); }),
    vscode.commands.registerCommand('uiAudit.editProject', async (arg) => { const id = await pick(arg); if (id) editProject(id); }),
    vscode.commands.registerCommand('uiAudit.deleteProject', async (arg) => { const id = await pick(arg); if (id) deleteProject(id); }),
    vscode.commands.registerCommand('uiAudit.copyForClaude', async (arg) => { const id = await pick(arg); if (id) exportIssues(ctx, id, 'claude'); }),
    vscode.commands.registerCommand('uiAudit.fixWithClaudeCode', async (arg) => { const id = await pick(arg); if (id) exportIssues(ctx, id, 'claudeCode'); }),
    vscode.commands.registerCommand('uiAudit.mailDeveloper', async (arg) => { const id = await pick(arg); if (id) exportIssues(ctx, id, 'mail'); }),
  );

  // Live-modus: bij opslaan opnieuw scannen (debounced) en de preview herladen
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || /[\\/](\.ui-audit|node_modules|\.git)[\\/]/.test(doc.uri.fsPath)) return;
      if (cfg().get('reloadPreviewOnSave')) setTimeout(() => PreviewPanel.reload(), cfg().get('liveDelayMs', 1500));
      for (const p of store.all()) {
        if (!p.live) continue;
        if (p.workspaceFolder && !doc.uri.fsPath.startsWith(p.workspaceFolder)) continue;
        clearTimeout(liveTimers.get(p.id));
        liveTimers.set(p.id, setTimeout(() => runScan(ctx, p.id, { silent: true }), cfg().get('liveDelayMs', 1500)));
      }
    })
  );

  updateStatus();
  // kleine API (gebruikt door de smoketest)
  return { store, runScan: (id, o) => runScan(ctx, id, o), openDashboard: (id) => dash(id) };
}

// ---------------------------------------------------------------- projecten

async function detectDevServers() {
  const found = [];
  await Promise.all(
    COMMON_PORTS.map(async (port) => {
      for (const host of ['localhost', '127.0.0.1']) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 700);
          const res = await fetch(`http://${host}:${port}/`, { signal: ctrl.signal, redirect: 'manual' });
          clearTimeout(t);
          const type = res.headers.get('content-type') || '';
          let title = '';
          if (type.includes('html')) {
            const body = await res.text();
            title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
          }
          found.push({ url: `http://localhost:${port}/`, port, title: title.trim(), status: res.status });
          return;
        } catch {
          /* niets op deze poort */
        }
      }
    })
  );
  return found.sort((a, b) => a.port - b.port);
}

/** Snel een (net live gezette) URL checken: link plakken → direct scannen. */
async function quickCheck(ctx, presetUrl) {
  let url = normalizeUrl(presetUrl);
  if (!url) {
    let clip = '';
    try { clip = (await vscode.env.clipboard.readText()).trim(); } catch {}
    const input = await vscode.window.showInputBox({
      title: 'UI Audit: check een URL',
      prompt: 'Plak de link van de pagina die je wilt checken (bijv. wat de developer net live heeft gezet)',
      value: /^https?:\/\/\S+$/i.test(clip) ? clip : '',
      placeHolder: 'https://klant.nl/nieuwe-pagina',
      ignoreFocusOut: true,
      validateInput: (v) => (!v || normalizeUrl(v) ? null : 'Dit is geen geldige URL'),
    });
    url = normalizeUrl(input);
  }
  if (!url) return;
  // Zelfde URL al eerder gecheckt? Dan in hetzelfde project, zodat je ziet wat er sinds de vorige keer is opgelost.
  let project = store.all().find((p) => p.url === url);
  if (!project) {
    const u = new URL(url);
    const name = u.host.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '');
    project = await store.create({ name, url, workspaceFolder: null });
  }
  DashboardPanel.show(ctx, store, ctx.uiAuditActions, project.id);
  runScan(ctx, project.id);
}

const isLocalUrl = (u) => /^(file:|https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/]+\.(localhost|test|local))([:/]|$))/i.test(u);

async function newProject(ctx) {
  const qp = vscode.window.createQuickPick();
  qp.title = 'UI Audit: nieuw project';
  qp.placeholder = 'Kies een draaiende dev-server, of typ een URL (https://… of localhost:3000)';
  qp.busy = true;
  const base = [
    { label: '$(globe) Andere URL invoeren…', action: 'url' },
    { label: '$(file-code) Lokaal HTML-bestand kiezen…', action: 'file' },
  ];
  qp.items = base;
  qp.show();
  detectDevServers().then((servers) => {
    qp.busy = false;
    qp.items = [
      ...(servers.length ? [{ label: 'Gevonden dev-servers', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...servers.map((s) => ({ label: `$(server) ${s.url}`, description: s.title || `HTTP ${s.status}`, url: s.url })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...base,
    ];
  });
  const choice = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (!sel && qp.value) resolve({ url: qp.value });
      else resolve(sel);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
  });
  qp.dispose();
  if (!choice) return;

  let url = choice.url;
  if (choice.action === 'url') {
    url = await vscode.window.showInputBox({ title: 'URL van de site of dev-server', placeHolder: 'http://localhost:3000 of https://mijnsite.nl', validateInput: (v) => (normalizeUrl(v) ? null : 'Ongeldige URL') });
  } else if (choice.action === 'file') {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { HTML: ['html', 'htm'] }, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
    if (f && f[0]) url = f[0].toString();
  }
  url = normalizeUrl(url);
  if (!url) return;

  const folders = vscode.workspace.workspaceFolders || [];
  let folder = folders[0];
  if (folders.length > 1) {
    const f = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Bij welke map hoort dit project? (voor bronbestanden & Live-modus)' });
    if (f) folder = f;
  }
  const suggested = folder ? folder.name : safeHost(url);
  const name = await vscode.window.showInputBox({ title: 'Projectnaam', value: suggested });
  if (!name) return;
  const project = await store.create({ name, url, workspaceFolder: folder ? folder.uri.fsPath : null });
  DashboardPanel.show(ctx, store, ctx.uiAuditActions, project.id);
  runScan(ctx, project.id);
}

function normalizeUrl(v) {
  if (!v) return null;
  v = v.trim();
  if (/^\d+$/.test(v)) v = 'localhost:' + v;
  if (!/^[a-z]+:\/\//i.test(v)) v = (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(v) ? 'http://' : 'https://') + v;
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}
const safeHost = (u) => { try { return new URL(u).host || path.basename(u); } catch { return u; } };

async function pickProject() {
  const all = store.all();
  if (!all.length) {
    const a = await vscode.window.showInformationMessage('Nog geen UI Audit-projecten.', 'Nieuw project');
    if (a) vscode.commands.executeCommand('uiAudit.newProject');
    return null;
  }
  if (all.length === 1) return all[0];
  const p = await vscode.window.showQuickPick(all.map((x) => ({ label: x.name, description: x.url, id: x.id })), { placeHolder: 'Kies een project' });
  return p ? store.get(p.id) : null;
}

async function editProject(id) {
  const p = store.get(id);
  const what = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Naam wijzigen', a: 'name' },
      { label: '$(globe) URL wijzigen', a: 'url', description: p.url },
      { label: '$(folder) Gekoppelde map wijzigen', a: 'folder', description: p.workspaceFolder || 'geen' },
      { label: '$(trash) Project verwijderen', a: 'delete' },
    ],
    { title: p.name }
  );
  if (!what) return;
  if (what.a === 'name') {
    const v = await vscode.window.showInputBox({ value: p.name });
    if (v) { p.name = v; await store.save(p); }
  } else if (what.a === 'url') {
    const v = normalizeUrl(await vscode.window.showInputBox({ value: p.url }));
    if (v) { p.url = v; await store.save(p); }
  } else if (what.a === 'folder') {
    const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
    if (f && f[0]) { p.workspaceFolder = f[0].fsPath; await store.save(p); }
  } else if (what.a === 'delete') deleteProject(id);
}

async function deleteProject(id) {
  const p = store.get(id);
  const ok = await vscode.window.showWarningMessage(`Project "${p.name}" en alle scans verwijderen?`, { modal: true }, 'Verwijderen');
  if (ok) {
    await store.remove(id);
    diagnostics.clear();
  }
}

async function toggleLive(id) {
  const p = store.get(id);
  p.live = !p.live;
  await store.save(p);
  vscode.window.setStatusBarMessage(p.live ? `$(eye) Live-modus aan voor ${p.name}: scant opnieuw bij elke save` : `Live-modus uit voor ${p.name}`, 3000);
}

async function openPreview(ctx, id) {
  const p = store.get(id);
  if (p.url.startsWith('file:')) {
    vscode.window.showWarningMessage('Device preview werkt met http(s)-URL\'s. Start een dev-server (bv. Live Server) en pas de project-URL aan.');
    return;
  }
  PreviewPanel.show(ctx, p, (pid) => runScan(ctx, pid));
}

// ---------------------------------------------------------------- scannen

function viewportsFromConfig() {
  const v = cfg().get('viewports');
  if (Array.isArray(v) && v.length) return v.map((x, i) => ({ id: x.id || `vp${i}`, label: x.label || `${x.width}px`, width: x.width, height: x.height || 900, mobile: x.mobile ?? x.width < 1024 }));
  return undefined;
}

async function runScan(ctx, projectId, { silent = false } = {}) {
  const project = store.get(projectId);
  if (!project) return;
  if (scanning.has(projectId)) {
    if (!silent) vscode.window.setStatusBarMessage('Er loopt al een scan voor dit project', 2000);
    return;
  }
  const state = { cancelled: false };
  scanning.set(projectId, state);
  const dash = DashboardPanel.current;
  const log = (t) => {
    dash && dash.setProgress(projectId, t);
    statusItem.text = `$(sync~spin) UI Audit: ${t}`;
    statusItem.show();
  };

  const work = async (progress, token) => {
    token && token.onCancellationRequested(() => (state.cancelled = true));
    const { scanId, dir } = store.newScanDir(projectId);
    const { scan } = require('./src/scanner');
    const result = await scan(project.url, {
      outDir: dir,
      viewports: viewportsFromConfig(),
      clickTest: cfg().get('clickTest'),
      checkLinks: cfg().get('checkLinks'),
      checkExternalLinks: cfg().get('checkExternalLinks'),
      spacingBase: cfg().get('spacingBase'),
      chromePath: cfg().get('chromePath'),
      timeout: cfg().get('timeoutMs'),
      isCancelled: () => state.cancelled,
      log: (t) => { log(t); progress && progress.report({ message: t }); },
    });
    if (state.cancelled) return null;
    log('Bronbestanden zoeken…');
    const folder = project.workspaceFolder
      ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.workspaceFolder)) || { uri: vscode.Uri.file(project.workspaceFolder), name: path.basename(project.workspaceFolder), index: 0 }
      : isLocalUrl(project.url) ? vscode.workspace.workspaceFolders?.[0] : null;
    if (folder) await findSources(result.issues, folder, project.url).catch(() => {});
    const fresh = store.get(projectId) || project;
    await store.addScan(fresh, scanId, result);
    return result;
  };

  try {
    const result = silent
      ? await work(null, null)
      : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `UI Audit · ${project.name}`, cancellable: true }, work);
    if (!result) return;
    const p = store.get(projectId);
    updateDiagnostics(p, result);
    const c = countIssues(result.issues, p.ignored);
    if (!silent && !(DashboardPanel.current && DashboardPanel.current.panel.visible)) {
      const a = await vscode.window.showInformationMessage(`${project.name}: ${c.error} errors, ${c.warning} waarschuwingen, ${c.info} info`, 'Open dashboard');
      if (a) DashboardPanel.show(ctx, store, ctx.uiAuditActions, projectId);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`UI Audit: ${e.message}`, ...(/Chrome/.test(e.message) ? ['Instellingen'] : [])).then((a) => {
      if (a) vscode.commands.executeCommand('workbench.action.openSettings', 'uiAudit.chromePath');
    });
  } finally {
    scanning.delete(projectId);
    dash && dash.setProgress(projectId, null);
    if (DashboardPanel.current) DashboardPanel.current.progress = null;
    updateStatus();
  }
}

function updateDiagnostics(project, result) {
  diagnostics.clear();
  if (!cfg().get('showInProblems')) return;
  const byFile = new Map();
  const sevMap = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
  for (const i of result.issues) {
    if ((project.ignored || []).includes(i.id)) continue;
    const loc = i.source || i.style;
    if (!loc) continue;
    const line = Math.max(0, loc.line - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 500), `${i.title}${i.suggestion ? ' — ' + i.suggestion : ''}`, sevMap[i.severity]);
    d.source = `UI Audit (${(i.viewports || []).join(', ')})`;
    d.code = i.rule;
    if (!byFile.has(loc.path)) byFile.set(loc.path, []);
    byFile.get(loc.path).push(d);
  }
  for (const [file, ds] of byFile) diagnostics.set(vscode.Uri.file(file), ds);
}

function updateStatus() {
  if (scanning.size) return;
  const all = store.all().filter((p) => p.scans && p.scans.length);
  if (!all.length) {
    statusItem.text = '$(device-mobile) UI Audit';
    statusItem.tooltip = 'Open het UI Audit-dashboard';
    statusItem.show();
    return;
  }
  const latest = all.sort((a, b) => (b.scans[0].date > a.scans[0].date ? 1 : -1))[0];
  const c = latest.scans[0].counts;
  statusItem.text = `${latest.live ? '$(eye)' : '$(device-mobile)'} ${latest.name}: $(error) ${c.error} $(warning) ${c.warning}`;
  statusItem.tooltip = `UI Audit · ${latest.name}\n${c.error} errors, ${c.warning} waarschuwingen, ${c.info} info${latest.live ? '\nLive-modus aan' : ''}\nKlik om het dashboard te openen`;
  statusItem.show();
}

// ---------------------------------------------------------------- export

async function exportIssues(ctx, projectId, format, ids) {
  const project = store.get(projectId);
  const scan = store.latestScan(project);
  if (!scan) return vscode.window.showWarningMessage('Scan dit project eerst.');
  let issues = scan.issues.filter((i) => !(project.ignored || []).includes(i.id));
  if (ids && ids.length) issues = issues.filter((i) => ids.includes(i.id));
  if (!issues.length) return vscode.window.showInformationMessage('Geen issues om te exporteren 🎉');
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const folder = project.workspaceFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (format === 'claude') {
    await vscode.env.clipboard.writeText(exporter.toClaudeMarkdown(project, scan, issues));
    const a = await vscode.window.showInformationMessage(`Prompt met ${issues.length} issues gekopieerd. Plak hem in Claude.`, 'Open claude.ai', 'Fix met Claude Code');
    if (a === 'Open claude.ai') vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/new'));
    if (a === 'Fix met Claude Code') exportIssues(ctx, projectId, 'claudeCode', ids);
    return;
  }

  if (format === 'claudeCode') {
    let dirBase = folder;
    if (!dirBase) {
      const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Kies de projectmap (broncode)' });
      if (!f) return;
      dirBase = f[0].fsPath;
    }
    const dir = path.join(dirBase, '.ui-audit');
    fs.mkdirSync(dir, { recursive: true });
    const mdPath = exporter.writeClaudeBundle(dir, project, scan, issues);
    let hasCli = false;
    try {
      execSync(process.platform === 'win32' ? 'where claude' : 'command -v claude', { stdio: 'ignore', shell: process.platform === 'win32' ? undefined : '/bin/sh', env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${os.homedir()}/.local/bin:${os.homedir()}/.claude/local` } });
      hasCli = true;
    } catch {}
    if (hasCli) {
      const term = vscode.window.createTerminal({ name: 'Claude Code · UI fixes', cwd: dirBase });
      term.show();
      term.sendText(`claude "Lees .ui-audit/issues.md en bekijk de screenshots in .ui-audit/shots/. Los daarna de issues één voor één op in de broncode, errors eerst. Geef aan het eind per issue aan wat je hebt aangepast."`);
    } else {
      const doc = await vscode.workspace.openTextDocument(mdPath);
      vscode.window.showTextDocument(doc);
      const a = await vscode.window.showWarningMessage('Claude Code CLI niet gevonden. issues.md is aangemaakt in .ui-audit/ — open Claude Code in deze map en vraag het die te lezen.', 'Installatie-instructies');
      if (a) vscode.env.openExternal(vscode.Uri.parse('https://docs.claude.com/en/docs/claude-code/overview'));
    }
    return;
  }

  if (format === 'mail') {
    let to = cfg().get('developerEmail') || '';
    const input = await vscode.window.showInputBox({ title: 'Mail naar developer', prompt: 'E-mailadres(sen), komma-gescheiden', value: to, placeHolder: 'dev@bureau.nl' });
    if (input === undefined) return;
    if (input && input !== to) {
      const save = await vscode.window.showInformationMessage(`${input} onthouden als standaard developer?`, 'Ja', 'Nee');
      if (save === 'Ja') await cfg().update('developerEmail', input, vscode.ConfigurationTarget.Global);
    }
    to = input;
    const reportDir = path.join(os.tmpdir(), 'ui-audit-reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `UI-audit-${slug}-${stamp}.html`);
    fs.writeFileSync(reportPath, exporter.toHTML(project, scan, issues));
    const c = { error: 0, warning: 0 };
    issues.forEach((i) => (c[i.severity] = (c[i.severity] || 0) + 1));
    const subject = `UI-audit ${project.name}: ${c.error} errors, ${c.warning} waarschuwingen`;
    let body = exporter.toMailBody(project, scan, issues);
    if (body.length > 1800) body = exporter.toMailBody(project, scan, issues, 6);
    const mailto = `mailto:${encodeURIComponent(to).replace(/%2C/gi, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    openRaw(mailto);
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(reportPath));
    vscode.window.showInformationMessage('Mail geopend. Sleep het HTML-rapport (nu zichtbaar in Finder/Verkenner) in de mail als bijlage.');
    return;
  }

  const ext = { md: 'md', html: 'html', csv: 'csv', json: 'json' }[format];
  const content =
    format === 'md' ? exporter.toClaudeMarkdown(project, scan, issues) :
    format === 'html' ? exporter.toHTML(project, scan, issues) :
    format === 'csv' ? '﻿' + exporter.toCSV(project, scan, issues) :
    exporter.toJSON(project, scan, issues);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder || os.homedir(), `ui-audit-${slug}-${stamp}.${ext}`)),
    filters: { [ext.toUpperCase()]: [ext] },
  });
  if (!target) return;
  fs.writeFileSync(target.fsPath, content);
  if (format === 'html') vscode.env.openExternal(target);
  else if (format !== 'csv') vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  else vscode.window.showInformationMessage(`CSV opgeslagen: ${path.basename(target.fsPath)}`, 'Toon in map').then((a) => a && vscode.commands.executeCommand('revealFileInOS', target));
}

function openRaw(url) {
  // mailto rechtstreeks via het OS openen (VS Code's Uri.parse codeert de body dubbel)
  if (process.platform === 'darwin') execFile('open', [url]);
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]);
  else execFile('xdg-open', [url]);
}

// ---------------------------------------------------------------- tree view

class ProjectTree {
  constructor() {
    this._e = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._e.event;
  }
  refresh() {
    this._e.fire();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) {
      const p = store.get(el.id);
      const scan = store.latestScan(p);
      if (!scan) return [Object.assign(new vscode.TreeItem('Nog niet gescand — klik om te scannen'), { command: { command: 'uiAudit.scan', title: 'Scan', arguments: [{ id: p.id }] }, iconPath: new vscode.ThemeIcon('play') })];
      const byCat = {};
      for (const i of scan.issues) if (!(p.ignored || []).includes(i.id)) byCat[i.category] = (byCat[i.category] || 0) + 1;
      const icons = { layout: 'layout', spacing: 'symbol-ruler', responsive: 'device-mobile', functional: 'link', backend: 'server', content: 'file-media', a11y: 'accessibility' };
      return Object.entries(byCat).map(([cat, n]) =>
        Object.assign(new vscode.TreeItem(exporter.CAT[cat] || cat), { description: String(n), iconPath: new vscode.ThemeIcon(icons[cat] || 'circle'), command: { command: 'uiAudit.openDashboard', title: 'Open', arguments: [{ id: p.id }] } })
      );
    }
    return store.all().map((p) => {
      const c = p.scans && p.scans[0] ? p.scans[0].counts : null;
      const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = p.id;
      item.description = c ? `${c.error} ✖  ${c.warning} ⚠${p.live ? '  · live' : ''}` : p.url;
      item.tooltip = `${p.url}${c ? `\n${c.error} errors · ${c.warning} waarschuwingen · ${c.info} info` : ''}`;
      item.iconPath = new vscode.ThemeIcon(scanning.has(p.id) ? 'sync~spin' : c && c.error ? 'error' : c ? 'pass' : 'globe', c && c.error ? new vscode.ThemeColor('errorForeground') : undefined);
      item.contextValue = 'project';
      item.command = { command: 'uiAudit.openDashboard', title: 'Open dashboard', arguments: [{ id: p.id }] };
      return item;
    });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
