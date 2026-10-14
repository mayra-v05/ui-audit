// Mini dev-server voor de testsite: /api/* geeft een 500
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, 'site');
module.exports = function start(port = 5179) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"db down"}'); }
    let p = path.join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(port, () => r(server)));
};
if (require.main === module) module.exports(5179).then(() => console.log('http://localhost:5179'));
