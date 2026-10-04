import { execFileSync } from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(`Node.js 24 is required; current runtime is ${process.version}.`);
  process.exit(1);
}
const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
if (!pnpm.startsWith('10.')) {
  console.error(`pnpm 10 is required; current version is ${pnpm}.`);
  process.exit(1);
}
console.log(`Environment OK: Node ${process.version}, pnpm ${pnpm}`);
