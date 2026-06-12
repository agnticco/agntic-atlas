/**
 * Minimal stub Slack server used by the P2 gate.
 * Returns ok:true + a real-looking ts for chat.postMessage.
 * Listens on STUB_PORT (default 3993), sends SIGUSR1 to parent when ready.
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 3993);
const server = http.createServer((req, res) => {
  let buf = ''; req.on('data', (d) => { buf += d; }); req.on('end', () => {
    const ep = req.url.replace(/^\//, '');
    const canned = {
      'chat.postMessage': { ok: true, ts: `${Date.now()}.000100`, channel: 'C001' },
      'auth.test':        { ok: true },
    };
    res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'chat:write,chat:write.public' });
    res.end(JSON.stringify(canned[ep] ?? { ok: true }));
  });
});
server.listen(PORT, () => {
  process.stdout.write(`stub-slack listening on ${PORT}\n`);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
