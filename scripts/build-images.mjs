import { execFileSync } from 'node:child_process';
const prefix = process.env.IMBOX_IMAGE_PREFIX ?? 'imbox';
const tag = process.env.IMBOX_IMAGE_TAG ?? 'local';
if (!/^[a-z0-9][a-z0-9./:_-]*$/.test(prefix) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
  throw new Error('Invalid container image prefix or tag');
}
for (const target of ['api', 'worker', 'tool-runner', 'web']) {
  execFileSync(
    'docker',
    [
      'build',
      '--file',
      'infra/deployment/Dockerfile',
      '--target',
      target,
      '--tag',
      `${prefix}/${target}:${tag}`,
      '.',
    ],
    { stdio: 'inherit' },
  );
}
