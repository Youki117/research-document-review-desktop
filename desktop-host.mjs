import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createReviewServer} from './tool/web/server.mjs';

const server = await createReviewServer({
  toolKind: 'xiasha', skillRoot: fileURLToPath(new URL('./tool/', import.meta.url)),
  configPath: process.argv[2], dataDir: process.argv[3], queueLimit: 200
});
server.on('error', () => { process.stderr.write('本地审查服务失败。\n'); process.exitCode = 1; });
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({port: server.address().port}) + '\n'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await server.stop(); } finally { process.exit(); }
}
const input = createInterface({input: process.stdin});
input.on('line', line => { if (line === 'stop') void stop(); });
input.on('close', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
