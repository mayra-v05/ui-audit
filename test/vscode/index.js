const vscode = require('vscode');
const fs = require('fs');
exports.run = async function () {
  const log = (...a) => fs.appendFileSync(process.env.UIA_LOG, a.join(' ') + '\n');
  try {
    const api = await vscode.extensions.getExtension('mayavx.ui-audit').activate();
    await vscode.commands.executeCommand('uiAudit.quickCheck', 'example.com');
    let p;
    for (let i = 0; i < 90; i++) {
      p = api.store.all().find((x) => x.url === 'https://example.com/');
      if (p && p.scans.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    log('project', p && p.name, 'url', p && p.url, 'scans', p && p.scans.length, 'counts', JSON.stringify(p && p.scans[0] && p.scans[0].counts));
    const scan = api.store.latestScan(p);
    scan.issues.slice(0, 6).forEach((i) => log(' ', i.severity, i.title, i.source ? 'SRC' : ''));
    // tweede keer zelfde URL → zelfde project
    await vscode.commands.executeCommand('uiAudit.quickCheck', 'https://example.com/');
    log('projects with url', api.store.all().filter((x) => x.url === 'https://example.com/').length);
    await new Promise((r) => setTimeout(r, 15000));
    log('DONE');
  } catch (e) { log('FAIL', e.stack); }
};
