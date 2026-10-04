import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const commit = process.env.IMBOX_COMPAT_CLIENT_COMMIT ?? '2f751069fc11062f48cfd5d377db2970e9088268';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Historical client requires a full commit SHA');
const actual = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
  encoding: 'utf8',
}).trim();
if (actual !== commit) throw new Error('Historical commit identity mismatch');
const directory = resolve('.artifacts', `historical-web-${commit}`);
mkdirSync(directory, { recursive: true });
const archive = join(directory, 'source.tar');
execFileSync('git', ['archive', '--format=tar', '--output', archive, commit]);
execFileSync('tar', ['-xf', archive, '-C', directory]);
const run = (args) =>
  execFileSync('pnpm', args, {
    cwd: directory,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', VITE_ENABLE_DEV_LOGIN: 'true' },
  });
run(['install', '--frozen-lockfile', '--offline']);
run(['--filter', '@imbox/contracts', 'build']);
run(['--filter', '@imbox/web', 'build']);
run(['--filter', '@imbox/api...', '-r', '--if-present', 'build']);
const dist = join(directory, 'apps/web/dist');
const files = {};
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.isFile())
      files[relative(dist, child)] = createHash('sha256').update(readFileSync(child)).digest('hex');
    else throw new Error('Historical client output must contain only ordinary files');
  }
}
visit(dist);
writeFileSync(
  join(directory, 'client-build.json'),
  JSON.stringify(
    {
      commit,
      files,
      apiEntrySha256: createHash('sha256')
        .update(readFileSync(join(directory, 'apps/api/dist/main.js')))
        .digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Historical web built from ${commit}; ${Object.keys(files).length} hashed files`);
