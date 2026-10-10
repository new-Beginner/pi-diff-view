import React, { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import { diffWordsWithSpace } from 'diff';
import type { DiffLine } from '../core/contracts';
import type { Messages } from './i18n';
for (const [name, language] of Object.entries({ javascript, typescript, python, json, css, xml, bash, markdown, yaml })) hljs.registerLanguage(name, language);
type Range = [number, number];
type Pair = { left?: DiffLine; right?: DiffLine; oldRanges?: Range[]; newRanges?: Range[] };
function ranges(before: string, after: string): [Range[], Range[]] {
  if (before.length + after.length > 4000) return [[], []];
  const changes = diffWordsWithSpace(before, after, { timeout: 15 });
  if (!changes) return [[], []];
  let old = 0, next = 0;
  const a: Range[] = [], b: Range[] = [];
  for (const c of changes) {
    if (!c.added) { if (c.removed) a.push([old, old + c.value.length]); old += c.value.length; }
    if (!c.removed) { if (c.added) b.push([next, next + c.value.length]); next += c.value.length; }
  }
  return [a, b];
}
export function alignLines(lines: DiffLine[]): Pair[] {
  const result: Pair[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.kind === 'context' || line.kind === 'notice') { result.push({ left: line, right: line }); i++; continue; }
    const removed: DiffLine[] = [], added: DiffLine[] = [];
    while (lines[i]?.kind === 'del') removed.push(lines[i++]);
    while (lines[i]?.kind === 'add') added.push(lines[i++]);
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      const left = removed[j], right = added[j];
      const [oldRanges, newRanges] = left && right ? ranges(left.text, right.text) : [[], []];
      result.push({ left, right, oldRanges, newRanges });
    }
  }
  return result;
}
function language(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python', json: 'json', css: 'css', html: 'xml', svg: 'xml', xml: 'xml', sh: 'bash', md: 'markdown', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[ext ?? ''];
}
function Code({ text, path, changes = [] }: { text: string; path: string; changes?: Range[] }) {
  const nodes = useMemo(() => {
    const lang = language(path);
    const template = document.createElement('template');
    if (lang && text.length <= 8000) template.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else template.content.append(document.createTextNode(text));
    let offset = 0, key = 0;
    function walk(node: Node): React.ReactNode {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? '', start = offset; offset += value.length;
        const cuts = new Set([0, value.length]);
        for (const [a, b] of changes) { if (a > start && a < offset) cuts.add(a - start); if (b > start && b < offset) cuts.add(b - start); }
        const points = [...cuts].sort((a, b) => a - b);
        return points.slice(0, -1).map((a, i) => {
          const segment = value.slice(a, points[i + 1]);
          return changes.some(([lo, hi]) => start + a >= lo && start + a < hi) ? <mark className="dv-word" key={key++}>{segment}</mark> : segment;
        });
      }
      const el = node as Element;
      return <span className={el.getAttribute('class') ?? undefined} key={key++}>{Array.from(node.childNodes).map(walk)}</span>;
    }
    return Array.from(template.content.childNodes).map(walk);
  }, [text, path, changes]);
  return <code className="dv-code">{nodes.length ? nodes : ' '}</code>;
}
export function DiffRows({ lines, path, layout, onLine, t, disabled }: { lines: DiffLine[]; path: string; layout: 'unified' | 'split'; onLine: (line: DiffLine, side: 'old' | 'new') => void; t: Messages; disabled?: boolean }) {
  const pairs = useMemo(() => alignLines(lines), [lines]);
  const button = (line: DiffLine | undefined, side: 'old' | 'new') => {
    const number = side === 'old' ? line?.oldLine : line?.newLine;
    return number == null ? <span className="dv-number" /> : <button className="dv-number" disabled={disabled} aria-label={`${t.addComment}: ${t[side]} ${number}`} onClick={() => onLine(line!, side)}>{number}</button>;
  };
  const cell = (line: DiffLine | undefined, side: 'old' | 'new', changes?: Range[]) => <div className={`dv-side dv-${line?.kind ?? 'blank'}`}>
    {button(line, side)}<span className="dv-sign" aria-hidden="true">{line?.kind === 'add' ? '+' : line?.kind === 'del' ? '−' : ' '}</span>
    {line ? <Code text={line.text} path={path} changes={changes} /> : <span className="dv-code" />}
  </div>;
  if (layout === 'split') return <div className="dv-rows dv-split" role="group" aria-label={`${t.old} / ${t.new}`} style={{ '--dv-code-width': `${Math.max(240, ...lines.map(line => [...line.text].reduce((width, char) => width + (char === '\t' ? 4 : char.charCodeAt(0) > 255 ? 2 : 1), 0) * 8 + 72))}px` } as React.CSSProperties}>
    <div className="dv-side-labels"><span>{t.old}</span><span>{t.new}</span></div>
    {pairs.map((pair, index) => pair.left?.kind === 'notice' ? <div key={index} className="dv-notice-line">{pair.left.text}</div> : <div key={index} className="dv-pair">{cell(pair.left, 'old', pair.oldRanges)}{cell(pair.right, 'new', pair.newRanges)}</div>)}
  </div>;
  const changes = new Map<DiffLine, Range[]>();
  for (const pair of pairs) { if (pair.left) changes.set(pair.left, pair.oldRanges ?? []); if (pair.right) changes.set(pair.right, pair.newRanges ?? []); }
  return <div className="dv-rows dv-unified">{lines.map((line, index) => line.kind === 'notice' ? <div key={index} className="dv-notice-line">{line.text}</div> : <div className={`dv-row dv-${line.kind}`} key={index}>
    {button(line, 'old')}{button(line, 'new')}<span className="dv-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span><Code text={line.text} path={path} changes={changes.get(line)} />
  </div>)}</div>;
}
