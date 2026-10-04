import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return discover(file);
    return entry.isFile() && /\.(?:test|spec)\.tsx?$/.test(entry.name)
      ? [file.split(sep).join('/')]
      : [];
  });
}
const files = ['apps', 'packages', 'tests'].flatMap(discover).sort();
const rows = [];
function callee(expression) {
  if (ts.isCallExpression(expression)) return callee(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    const name = callee(expression.expression);
    return name ? name + '.' + expression.name.text : null;
  }
  return ts.isIdentifier(expression) ? expression.text : null;
}
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function walk(node, suites = []) {
    if (ts.isCallExpression(node)) {
      const name = callee(node.expression),
        first = node.arguments[0];
      if (
        name &&
        /^(?:describe|it|test)(?:\.|$)/.test(name) &&
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        const callback = node.arguments.find(
          (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        );
        if (name.split('.').includes('describe')) {
          if (callback) walk(callback.body, [...suites, first.text]);
          return;
        }
        rows.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          title: [...suites, first.text].join(' → '),
          declaration: name,
        });
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, suites));
  }
  walk(source);
}
const escape = (value) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = [
  '# 回归用例静态索引',
  '',
  '由 `pnpm test:catalog` 从 TypeScript 测试声明生成。参数化用例在此只登记声明，实际展开数量以测试运行报告为准；测试路径存在和标题登记不等于测试已通过，也不等于 AC/INV 已完整覆盖。',
  '',
  `共 ${files.length} 个测试文件、${rows.length} 个具名声明。执行入口、环境和限制见 [回归说明](README.md)，产品验收映射见 [coverage.json](../../tests/acceptance/coverage.json)。`,
  '',
];
for (const file of files) {
  const tests = rows.filter((row) => row.file === file);
  if (!tests.length) continue;
  lines.push(`## ${file}`, '', '| 声明 | 用例 |', '|---|---|');
  for (const row of tests)
    lines.push(
      `| [${row.declaration}:${row.line}](../../${file}#L${row.line}) | ${escape(row.title)} |`,
    );
  lines.push('');
}
const output = lines.join('\n'),
  target = 'docs/testing/regression-cases.md';
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== output)
    throw new Error('Regression catalog is stale; run pnpm test:catalog');
} else writeFileSync(target, output);
process.stdout.write(`Regression catalog: ${files.length} files, ${rows.length} declarations\n`);
