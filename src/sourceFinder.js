const vscode = require('vscode');
const path = require('path');

const MARKUP = /\.(html?|jsx|tsx|vue|svelte|astro|php|twig|erb|hbs|njk|liquid|mdx|cshtml|razor|js|ts)$/i;
const STYLE = /\.(css|scss|sass|less|styl)$/i;
const EXCLUDE = '**/{node_modules,dist,build,.next,.nuxt,.svelte-kit,out,coverage,.git,vendor,.ui-audit,public/build}/**';

/**
 * Finds the most likely source file (+ line) in the workspace for each issue,
 * based on the element's id, class names and visible text.
 */
async function findSources(issues, folder, pageUrl) {
  // Files matching the scanned URL get priority on equal score
  let urlPath = '/';
  try { urlPath = new URL(pageUrl).pathname; } catch {}
  const routeName = urlPath.replace(/\/$/, '').split('/').pop().replace(/\.\w+$/, '') || 'index';
  const routeBonus = (file) => {
    const b = path.basename(file).replace(/\.\w+$/, '').toLowerCase();
    const dir = path.basename(path.dirname(file)).toLowerCase();
    if (b === routeName.toLowerCase() || dir === routeName.toLowerCase()) return 2;
    if (routeName === 'index' && /^(index|page|app|home|\+page|_app|layout)$/.test(b)) return 1.5;
    return 0;
  };
  const base = folder ? new vscode.RelativePattern(folder, '**/*.{html,htm,jsx,tsx,vue,svelte,astro,php,twig,erb,hbs,njk,liquid,mdx,cshtml,razor,js,ts,css,scss,sass,less,styl}') : '**/*.{html,htm,jsx,tsx,vue,svelte,astro,php,twig,erb,hbs,njk,liquid,mdx,cshtml,razor,js,ts,css,scss,sass,less,styl}';
  let uris;
  try {
    uris = await vscode.workspace.findFiles(base, EXCLUDE, 2500);
  } catch {
    return;
  }
  if (!uris.length) return;
  const files = [];
  for (const uri of uris) {
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      if (buf.byteLength > 600_000) continue;
      const text = Buffer.from(buf).toString('utf8');
      if (/\.(js|ts)$/.test(uri.fsPath) && !/(className|innerHTML|class=|<\w+[\s>])/.test(text)) continue;
      if (/\.min\.(js|css)$/.test(uri.fsPath)) continue;
      files.push({ uri, text, isStyle: STYLE.test(uri.fsPath) || (/\.(html?|vue|svelte|astro)$/i.test(uri.fsPath) && /<style/i.test(text)), isMarkup: MARKUP.test(uri.fsPath) });
    } catch {
      /* skip */
    }
  }

  const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rel = (uri) => (folder ? path.relative(folder.uri.fsPath, uri.fsPath) : vscode.workspace.asRelativePath(uri));

  for (const issue of issues) {
    const h = issue.hints;
    if (!h) continue;
    let best = null;
    for (const f of files.filter((x) => x.isMarkup)) {
      let score = 0, idx = -1;
      if (h.id) {
        const m = f.text.search(new RegExp(`id\\s*=\\s*[{"'\`]+${esc(h.id)}["'\`}]`));
        if (m >= 0) { score += 12; idx = m; }
      }
      const cls = (h.classes || []).filter((c) => c.length > 2 && !/^(flex|grid|block|p-|m-|w-|h-|text-|bg-)/.test(c));
      for (const c of cls) {
        const m = f.text.search(new RegExp(`(class|className)\\s*=\\s*[{"'\`][^"'\`]*\\b${esc(c)}\\b`));
        if (m >= 0) { score += 3; if (idx < 0) idx = m; }
      }
      if (h.text && h.text.length >= 3) {
        const t = h.text.slice(0, 40);
        const m = f.text.indexOf(t);
        if (m >= 0) { score += 6; idx = m; }
      }
      if (score > 0) score += routeBonus(f.uri.fsPath);
      if (score > 0 && (!best || score > best.score)) best = { score, file: rel(f.uri), path: f.uri.fsPath, line: lineOf(f.text, Math.max(idx, 0)) };
    }
    if (best && best.score >= 3) issue.source = { file: best.file, path: best.path, line: best.line };

    // CSS rule for the most specific class (handy for spacing issues)
    const cls = (h.classes || []).filter((c) => c.length > 2);
    for (const c of cls) {
      const f = files.find((x) => x.isStyle && new RegExp(`\\.${esc(c)}\\b[^{]*\\{`).test(x.text));
      if (f) {
        const m = f.text.search(new RegExp(`\\.${esc(c)}\\b[^{]*\\{`));
        issue.style = { file: rel(f.uri), path: f.uri.fsPath, line: lineOf(f.text, m), selector: '.' + c };
        break;
      }
    }
  }
}

module.exports = { findSources };
