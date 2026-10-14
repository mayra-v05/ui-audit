const fs = require('fs');
const path = require('path');

const SEV = { error: 'ERROR', warning: 'WARNING', info: 'INFO' };
const CAT = { layout: 'Layout & alignment', spacing: 'Spacing & consistency', responsive: 'Responsive / mobile', functional: 'Functional (buttons & links)', backend: 'Backend & console', content: 'Content & images', a11y: 'Accessibility' };
const VP = { desktop: 'desktop', tablet: 'tablet', mobile: 'mobile' };

function measureText(m) {
  if (!m) return '';
  if (m.expected !== undefined && m.actual !== undefined) return `expected ${m.expected}${m.property ? ` (${m.property})` : ''}, found ${m.actual}`;
  const L = { ratio: 'contrast', need: 'minimum', w: 'width', h: 'height', diff: 'difference (px)', value: 'value', count: 'count', docWidth: 'page width', viewport: 'viewport' };
  return Object.entries(m).map(([k, v]) => `${L[k] || k}: ${v}`).join(', ');
}

function header(project, scan, issues) {
  const c = { error: 0, warning: 0, info: 0 };
  issues.forEach((i) => c[i.severity]++);
  const vps = (scan.viewports || []).map((v) => `${v.label} ${v.width}px`).join(', ');
  return { c, vps, date: new Date(scan.scannedAt).toLocaleString('en-GB') };
}

/** Markdown prompt you can paste straight into Claude (chat or Claude Code). */
function toClaudeMarkdown(project, scan, issues, opts = {}) {
  const { c, vps, date } = header(project, scan, issues);
  const out = [];
  out.push(`# UI audit: ${project.name}`);
  out.push(`URL: ${scan.url} · scanned ${date} · viewports: ${vps}`);
  out.push(`Total: ${c.error} errors, ${c.warning} warnings, ${c.info} info.\n`);
  out.push(`## Task`);
  out.push(`Fix the UI, layout and functional problems below in the source code of this project.`);
  out.push(`- Work through the issues in order (errors first).`);
  out.push(`- Use the selector, the source file and the HTML snippet to find the element.`);
  out.push(`- Apply the smallest possible fix and keep existing design tokens / CSS variables and naming.`);
  out.push(`- For spacing/alignment: match the element to the other elements of the same kind, not the other way around.`);
  out.push(`- For responsive issues, check that the fix still works on desktop.`);
  out.push(`- Don't change anything that isn't in this list. At the end, briefly state per issue what you changed (or why not).\n`);
  out.push(`## Issues`);
  issues.forEach((i, n) => {
    out.push(`\n### ${n + 1}. [${SEV[i.severity]}] ${i.title}`);
    out.push(`- **Category:** ${CAT[i.category] || i.category} · **Viewports:** ${(i.viewports || []).map((v) => VP[v] || v).join(', ')}`);
    if (i.selector) out.push(`- **Selector:** \`${i.selector}\``);
    const src = [];
    if (i.source) src.push(`\`${i.source.file}:${i.source.line}\``);
    if (i.style) src.push(`CSS \`${i.style.file}:${i.style.line}\` (${i.style.selector})`);
    if (src.length) out.push(`- **Likely source:** ${src.join(' · ')}`);
    if (i.detail) out.push(`- **Problem:** ${i.detail.replace(/\n/g, '\n  ')}`);
    const m = measureText(i.measure);
    if (m) out.push(`- **Measurement:** ${m}`);
    if (i.suggestion) out.push(`- **Suggested fix:** ${i.suggestion}`);
    if (opts.shots && opts.shots[i.id]) out.push(`- **Screenshot:** \`${opts.shots[i.id]}\``);
    if (i.html) out.push(`- **Element:**\n  \`\`\`html\n  ${i.html.replace(/\n/g, ' ')}\n  \`\`\``);
  });
  return out.join('\n');
}

function toCSV(project, scan, issues) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = [['no', 'severity', 'category', 'title', 'viewports', 'selector', 'source file', 'css', 'problem', 'measurement', 'fix', 'url'].join(',')];
  issues.forEach((i, n) =>
    rows.push([n + 1, i.severity, i.category, i.title, (i.viewports || []).join(' '), i.selector, i.source ? `${i.source.file}:${i.source.line}` : '', i.style ? `${i.style.file}:${i.style.line}` : '', i.detail, measureText(i.measure), i.suggestion, scan.url].map(q).join(','))
  );
  return rows.join('\n');
}

function toJSON(project, scan, issues) {
  return JSON.stringify({ project: project.name, url: scan.url, scannedAt: scan.scannedAt, viewports: scan.viewports, issues: issues.map(({ crops, rects, hints, isNew, ...rest }) => rest) }, null, 2);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function imgData(p) {
  try {
    if (p && fs.existsSync(p)) return 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
  } catch {}
  return null;
}

/** Standalone HTML report (with screenshots embedded) — ideal as a mail attachment. */
function toHTML(project, scan, issues) {
  const { c, vps, date } = header(project, scan, issues);
  const cards = issues.map((i, n) => {
    const vp = (i.viewports || []).find((v) => i.crops && i.crops[v]);
    const img = vp ? imgData(i.crops[vp]) : null;
    return `<article class="issue ${i.severity}">
      <div class="num">${n + 1}</div>
      <div class="body">
        <div class="meta"><span class="sev">${SEV[i.severity]}</span><span>${esc(CAT[i.category] || i.category)}</span><span>${(i.viewports || []).map((v) => VP[v] || v).join(' · ')}</span></div>
        <h3>${esc(i.title)}</h3>
        ${i.detail ? `<p>${esc(i.detail).replace(/\n/g, '<br>')}</p>` : ''}
        ${i.suggestion ? `<p class="fix"><b>Fix:</b> ${esc(i.suggestion)}</p>` : ''}
        ${i.selector ? `<code>${esc(i.selector)}</code>` : ''}
        ${i.source ? `<div class="src">📄 ${esc(i.source.file)}:${i.source.line}${i.style ? ` · 🎨 ${esc(i.style.file)}:${i.style.line}` : ''}</div>` : ''}
      </div>
      ${img ? `<img src="${img}" alt="">` : ''}
    </article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI audit – ${esc(project.name)}</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--text:#16161a;--muted:#6b6b76;--line:#e6e6ea;--err:#e5484d;--warn:#f5a524;--info:#3e63dd}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1a1a1d;--text:#ededef;--muted:#9b9ba4;--line:#2a2a2e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 20px}
h1{font-size:28px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.stats{display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:120px}
.stat b{display:block;font-size:24px}.stat.error b{color:var(--err)}.stat.warning b{color:var(--warn)}.stat.info b{color:var(--info)}
.issue{display:grid;grid-template-columns:36px 1fr auto;gap:16px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:12px;padding:16px;margin-bottom:12px;align-items:start}
.issue.error{border-left-color:var(--err)}.issue.warning{border-left-color:var(--warn)}
.num{font-weight:700;color:var(--muted)}h3{margin:4px 0 6px;font-size:16px}p{margin:4px 0;color:var(--muted)}.fix{color:var(--text)}
.meta{display:flex;gap:10px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.sev{font-weight:700}
.error .sev{color:var(--err)}.warning .sev{color:var(--warn)}.info .sev{color:var(--info)}
code{display:inline-block;margin-top:6px;font-size:12px;background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}
.src{font-size:12px;color:var(--muted);margin-top:6px}a{color:var(--info)}
.issue img{max-width:260px;max-height:180px;border-radius:8px;border:1px solid var(--line)}
@media (max-width:700px){.issue{grid-template-columns:28px 1fr}.issue img{grid-column:1/-1;max-width:100%}}
</style></head><body><main>
<h1>UI audit: ${esc(project.name)}</h1>
<p class="sub"><a href="${esc(scan.url)}">${esc(scan.url)}</a> · ${esc(date)} · ${esc(vps)}</p>
<div class="stats"><div class="stat error"><b>${c.error}</b>errors</div><div class="stat warning"><b>${c.warning}</b>warnings</div><div class="stat info"><b>${c.info}</b>info</div></div>
${cards}
</main></body></html>`;
}

function toMailBody(project, scan, issues, max = 15) {
  const { c, date } = header(project, scan, issues);
  const lines = [
    `Hi,`,
    ``,
    `Here is the UI audit of ${project.name} (${scan.url}), scanned on ${date}.`,
    `Found: ${c.error} errors, ${c.warning} warnings, ${c.info} info.`,
    ``,
    `Main points:`,
  ];
  issues.slice(0, max).forEach((i, n) => {
    lines.push(`${n + 1}. [${SEV[i.severity]}] ${i.title}${i.viewports ? ` (${i.viewports.map((v) => VP[v] || v).join(', ')})` : ''}`);
    if (i.selector) lines.push(`   Element: ${i.selector}`);
    if (i.suggestion) lines.push(`   Fix: ${i.suggestion}`);
  });
  if (issues.length > max) lines.push(`… and ${issues.length - max} more. See the attached report.`);
  lines.push('', 'The full report (with screenshots) is attached.', '', 'Best regards');
  return lines.join('\n');
}

/** Writes a .ui-audit folder in the project with issues.md + screenshots, so Claude Code can read them. */
function writeClaudeBundle(dir, project, scan, issues) {
  const shotsDir = path.join(dir, 'shots');
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const shots = {};
  issues.forEach((i, n) => {
    const vp = (i.viewports || []).find((v) => i.crops && i.crops[v] && fs.existsSync(i.crops[v]));
    if (!vp) return;
    const name = `${String(n + 1).padStart(2, '0')}-${i.rule}-${vp}.jpg`;
    fs.copyFileSync(i.crops[vp], path.join(shotsDir, name));
    shots[i.id] = `.ui-audit/shots/${name}`;
  });
  const md = toClaudeMarkdown(project, scan, issues, { shots });
  fs.writeFileSync(path.join(dir, 'issues.md'), md);
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return path.join(dir, 'issues.md');
}

module.exports = { toClaudeMarkdown, toCSV, toJSON, toHTML, toMailBody, writeClaudeBundle, CAT, SEV };
