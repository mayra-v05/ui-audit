const start = require('./server');
const { scan } = require('../src/scanner');
(async () => {
  const server = await start(5179);
  const t = Date.now();
  const r = await scan('http://localhost:5179/', { log: (m) => console.log('  ·', m), clickTest: process.argv.includes('--click'), outDir: __dirname + '/out' });
  console.log(`\n${r.issues.length} issues in ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
  for (const i of r.issues) console.log(`[${i.severity.padEnd(7)}] [${i.viewports.map((v) => v[0]).join('').padEnd(3)}] ${i.category.padEnd(10)} ${i.title}  ${i.selector ? '→ ' + i.selector : ''}`);
  require('fs').writeFileSync(__dirname + '/out/scan.json', JSON.stringify(r));
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
