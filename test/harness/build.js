// Renders the dashboard outside VS Code with a fake vscode API, for visual checks.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return { Uri: { file: (p) => ({ fsPath: p }), joinPath: () => ({}) }, ViewColumn: {}, window: {}, workspace: {}, env: {} };
  return origLoad.call(this, req, ...rest);
};
const { DashboardPanel } = require('../../src/dashboard');
const scanFile = process.argv[2];
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
const rel = (p) => (p ? path.relative(__dirname, p) : null);
scan.screenshotUris = Object.fromEntries(Object.entries(scan.screenshots).map(([k, v]) => [k, rel(v)]));
scan.issues = scan.issues.map((i, n) => ({ ...i, isNew: n % 7 === 0, source: n === 3 ? { file: 'index.html', path: '/x', line: 42 } : i.source, cropUris: Object.fromEntries(Object.entries(i.crops || {}).map(([k, v]) => [k, rel(v)])) }));
scan.resolved = [{ id: 'x', title: 'Irregular vertical spacing: 20px instead of 16px', selector: '.footer' }];
const project = { id: 'p1', name: 'Test site', url: scan.url, live: true, ignored: [], scans: [{}, {}] };
const fake = { panel: { webview: { cspSource: "'self' file: data:" } } };
let html = DashboardPanel.prototype.html.call(fake);
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '');
const mock = `<script>
window.acquireVsCodeApi = () => ({ postMessage: (m) => { console.log('->', JSON.stringify(m)); if (m.type === 'ready') setTimeout(() => window.postMessage(${JSON.stringify({ type: 'state', projects: [{ id: 'p1', name: 'Test site', url: scan.url, counts: { total: scan.issues.length } }], project, scan, history: project.scans, progress: null })}, '*')); }, getState: () => null, setState: () => {} });
</script><style>:root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-button-secondaryHoverBackground:#45494e;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-focusBorder:#007fd4;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-sideBar-background:#252526;--vscode-panel-border:#3c3c3c;--vscode-textLink-foreground:#3794ff;--vscode-font-family:-apple-system,sans-serif}</style>`;
html = html.replace('<head>', '<head>' + mock).replace(/nonce="[^"]+"/g, '');
fs.writeFileSync(path.join(__dirname, 'dashboard.html'), html);
console.log('ok');
