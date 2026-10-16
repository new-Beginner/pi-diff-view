import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const entries = ['main.js', 'agent/index.mjs', 'renderer/index.mjs', 'views/index.js'];
/** Inspect emitted JavaScript, not just source or a loader's spelling. */
export function runtimeViolations(text, name = 'runtime.js') {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems = [];
  const report = (node, message) => problems.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (target.kind === ts.SyntaxKind.ImportKeyword) report(node, 'dynamic import');
      if ((ts.isIdentifier(target) && ['eval', 'Function'].includes(target.text)) || (ts.isPropertyAccessExpression(target) && ['eval', 'Function'].includes(target.name.text))) report(node, 'dynamic execution');
      if (ts.isIdentifier(target) && target.text === 'require' && (!node.arguments.length || !ts.isStringLiteral(node.arguments[0]))) report(node, 'nonliteral require');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report(node, 'Function constructor');
    if (ts.isStringLiteralLike(node) && /app\.asar|review-changes[\\/]|sessions[\\/].*\.jsonl|resolvePluginReviewModules|loadPinned/.test(node.text)) report(node, 'private host dependency');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
export async function checkPublicRuntime(directory = 'plugin') {
  const problems = [];
  for (const entry of entries) problems.push(...runtimeViolations(await fs.readFile(path.join(directory, entry), 'utf8'), entry));
  if (problems.length) throw new Error(`Public runtime check failed:\n${problems.join('\n')}`);
  console.log(`Public runtime check passed: ${entries.length} emitted entry points; no dynamic execution or private host loaders/history paths`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await checkPublicRuntime(process.argv[2]);
