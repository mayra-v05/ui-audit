const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = 'uiAudit.projects';
const KEEP_SCANS = 5;

/**
 * Projecten staan in globalState (klein), scans + screenshots als bestanden in globalStorage.
 * project: { id, name, url, workspaceFolder, live, ignored: string[], scans: [{id, date, counts}] }
 */
class Store {
  constructor(context) {
    this.ctx = context;
    this.root = context.globalStorageUri.fsPath;
    fs.mkdirSync(this.root, { recursive: true });
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;
  }

  all() {
    return this.ctx.globalState.get(KEY, []);
  }

  get(id) {
    return this.all().find((p) => p.id === id);
  }

  async save(project) {
    const list = this.all();
    const i = list.findIndex((p) => p.id === project.id);
    if (i >= 0) list[i] = project;
    else list.push(project);
    await this.ctx.globalState.update(KEY, list);
    this._onChange.fire(project);
    return project;
  }

  async create({ name, url, workspaceFolder }) {
    const project = {
      id: crypto.randomBytes(5).toString('hex'),
      name, url, workspaceFolder: workspaceFolder || null,
      live: false, ignored: [], scans: [], createdAt: new Date().toISOString(),
    };
    return this.save(project);
  }

  async remove(id) {
    await this.ctx.globalState.update(KEY, this.all().filter((p) => p.id !== id));
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    this._onChange.fire(null);
  }

  scanDir(projectId, scanId) {
    return path.join(this.root, projectId, scanId);
  }

  newScanDir(projectId) {
    const scanId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = this.scanDir(projectId, scanId);
    fs.mkdirSync(dir, { recursive: true });
    return { scanId, dir };
  }

  async addScan(project, scanId, result) {
    const dir = this.scanDir(project.id, scanId);
    const prev = this.latestScan(project);
    const prevIds = new Set(prev ? prev.issues.map((i) => i.id) : []);
    const curIds = new Set(result.issues.map((i) => i.id));
    for (const i of result.issues) i.isNew = !!prev && !prevIds.has(i.id);
    result.resolved = prev ? prev.issues.filter((i) => !curIds.has(i.id) && !(project.ignored || []).includes(i.id)).map((i) => ({ id: i.id, title: i.title, selector: i.selector })) : [];
    fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify(result));
    const counts = countIssues(result.issues, project.ignored);
    project.scans = [{ id: scanId, date: result.scannedAt, counts }, ...(project.scans || [])];
    for (const old of project.scans.slice(KEEP_SCANS)) fs.rmSync(this.scanDir(project.id, old.id), { recursive: true, force: true });
    project.scans = project.scans.slice(0, KEEP_SCANS);
    return this.save(project);
  }

  latestScan(project) {
    if (!project || !project.scans || !project.scans.length) return null;
    return this.readScan(project, project.scans[0].id);
  }

  readScan(project, scanId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.scanDir(project.id, scanId), 'scan.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async setIgnored(project, issueId, ignored) {
    const set = new Set(project.ignored || []);
    ignored ? set.add(issueId) : set.delete(issueId);
    project.ignored = [...set];
    const scan = this.latestScan(project);
    if (scan && project.scans[0]) project.scans[0].counts = countIssues(scan.issues, project.ignored);
    return this.save(project);
  }
}

function countIssues(issues, ignored = []) {
  const c = { error: 0, warning: 0, info: 0, total: 0 };
  for (const i of issues) {
    if (ignored.includes(i.id)) continue;
    c[i.severity]++;
    c.total++;
  }
  return c;
}

module.exports = { Store, countIssues };
