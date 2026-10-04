import { readFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync(new URL('../tests/acceptance/coverage.json', import.meta.url), 'utf8'));
const required = [
  ...Array.from({ length: 25 }, (_, i) => `AC-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 16 }, (_, i) => `INV-${String(i + 1).padStart(2, '0')}`),
];
const pending = required.filter((id) => {
  const item = ledger.requirements.find((entry) => entry.id === id);
  return !item || item.status !== 'verified' || !item.evidence?.length;
});
console.log(`Acceptance: ${required.length - pending.length}/${required.length} verified.`);
if (pending.length) {
  console.error(`Release blocked by unverified requirements: ${pending.join(', ')}`);
  process.exit(1);
}
console.log('Evidence manifest is complete; release still requires reviewing the referenced results.');
