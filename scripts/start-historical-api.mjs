import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const commit = process.env.IMBOX_COMPAT_CLIENT_COMMIT ?? '2f751069fc11062f48cfd5d377db2970e9088268';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full historical commit required');
const directory = resolve('.artifacts', `historical-web-${commit}`);
const entry = resolve(directory, 'apps/api/dist/main.js');
const manifest = JSON.parse(readFileSync(resolve(directory, 'client-build.json'), 'utf8'));
if (
  manifest.commit !== commit ||
  manifest.apiEntrySha256 !== createHash('sha256').update(readFileSync(entry)).digest('hex')
)
  throw new Error('Historical API build identity mismatch');
const child = spawn(process.execPath, [entry], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
