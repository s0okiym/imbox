import { cp, mkdir, readdir } from 'node:fs/promises';
// Keep workspace paths intact without copying local configuration, source or development tools.
await mkdir('/out', { recursive: true });
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  await cp(name, `/out/${name}`);
}
for (const root of ['apps', 'packages']) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = `${root}/${entry.name}`;
    const target = `/out/${source}`;
    await mkdir(target, { recursive: true });
    await cp(`${source}/package.json`, `${target}/package.json`);
    for (const item of await readdir(source)) {
      if (item === 'dist' || item === 'openapi')
        await cp(`${source}/${item}`, `${target}/${item}`, {
          recursive: true,
          filter: (path) => !/\.test\.(?:js|d\.ts)(?:\.map)?$/.test(path),
        });
    }
  }
}
