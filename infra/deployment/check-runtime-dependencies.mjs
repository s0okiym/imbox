import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) result.push(path);
  }
  return result;
}
const failures = [];
for (const group of ['apps', 'packages']) {
  for (const entry of await readdir(group, { withFileTypes: true })) {
    if (!entry.isDirectory() || (group === 'apps' && entry.name === 'web')) continue;
    const directory = `${group}/${entry.name}`;
    const manifest = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
    const allowed = new Set([
      manifest.name,
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    for (const path of await files(`${directory}/dist`)) {
      const tree = ts.createSourceFile(
        path,
        await readFile(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const imports = [];
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          imports.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      }
      visit(tree);
      for (const specifier of imports) {
        if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier))
          continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!allowed.has(name)) failures.push(`${path}: undeclared runtime dependency ${name}`);
      }
    }
  }
}
if (failures.length) throw new Error(failures.join('\n'));
