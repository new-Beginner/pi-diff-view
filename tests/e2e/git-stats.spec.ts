import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';

let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {GitManagement} from './src/view/GitManagement'; import './src/view/git-management.css';
    window.state = {hold:false, fail:false, inline:false, additions:3, removed:false}; window.calls=[]; window.releases=[];
    const transport = {async invoke(method,args) {
      window.calls.push(args);
      const state = window.state;
      if(args.operation==='status') return {root:args.root,branch:'main',head:'head',entries:state.removed ? [] : [{path:'note.txt',index:'M',working:'M',
        ...(state.inline && args.includeStats ? {stats:{path:'note.txt',additions:10,deletions:0}} : {})}]};
      if(args.operation==='stats') {
        const value = {entries:args.paths.map(path=>({path,additions:args.scope==='staged'?5:state.additions,deletions:2}))};
        const fail = state.fail;
        if(state.hold) await new Promise(resolve=>window.releases.push(resolve));
        if(fail) throw Error('unavailable'); return value;
      }
      if(args.operation==='history') return {commits:[],hasMore:false};
      return {text:''};
    }};
    const app=createRoot(document.getElementById('app'));
    window.renderGit=(root='/repo-a',base='light')=>app.render(<GitManagement transport={transport} root={root} base={base}/>);
    window.release=()=>{window.state.hold=false;window.releases.splice(0).forEach(resolve=>resolve());};
  `, resolveDir: process.cwd(), loader: 'tsx' }, outfile: 'git-stats.js', bundle: true, write: false, platform: 'browser', format: 'iife' });
  script = bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(f => f.path.endsWith('.css'))!.text;
});
async function mount(page: Page, inline = false, base = 'light') {
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await page.evaluate(({inline,base}) => { (window as any).state.inline=inline; (window as any).renderGit('/repo-a',base); }, {inline,base});
}
const stats = (page: Page) => page.locator('.gm-file-stats');
const refresh = (page: Page) => page.getByRole('button', {name:'刷新',exact:true}).click();

test('inline status stats are shown without a second statistics request', async ({page}) => {
  await mount(page,true);
  await expect(stats(page)).toHaveText('+10-0');
  expect(await page.evaluate(() => (window as any).calls.filter((a:any)=>a.operation==='stats'))).toHaveLength(0);
});
test('refresh retains cached numbers with explicit updating state and replaces them on completion', async ({page}) => {
  await mount(page); await expect(stats(page)).toHaveText('+3-2');
  const before = await page.locator('.gm-file').boundingBox();
  await page.evaluate(() => Object.assign((window as any).state,{hold:true,additions:7}));
  await refresh(page);
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await expect(stats(page)).toContainText('+3'); await expect(stats(page)).not.toContainText('…');
  await expect(stats(page)).toHaveAttribute('aria-busy','true');
  expect((await page.locator('.gm-file').boundingBox())!.width).toBeCloseTo(before!.width,1);
  await page.evaluate(()=>(window as any).release());
  await expect(stats(page)).toHaveText('+7-2'); await expect(stats(page)).toHaveAttribute('aria-busy','false');
  await page.evaluate(() => { (window as any).state.fail=true; }); await refresh(page);
  await expect(stats(page)).toHaveText('行数未知'); await expect(stats(page)).not.toContainText('+0');
});
test('scope caches stay separate and removed paths are not retained', async ({page}) => {
  await mount(page); await expect(stats(page)).toHaveText('+3-2');
  await page.evaluate(() => { (window as any).state.hold=true; });
  await page.getByRole('button',{name:'暂存区',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await expect(stats(page)).not.toContainText('+3'); await page.evaluate(()=>(window as any).release());
  await expect(stats(page)).toHaveText('+5-2');
  await page.evaluate(() => { (window as any).state.hold=true; });
  await page.getByRole('button',{name:'工作区',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await expect(stats(page)).toContainText('+3'); await expect(stats(page)).not.toContainText('+5');
  await page.evaluate(()=>(window as any).release()); await expect(stats(page)).toHaveAttribute('aria-busy','false');
  await page.evaluate(() => { (window as any).state.removed=true; }); await refresh(page);
  await expect(stats(page)).toHaveCount(0);
});
test('project changes discard old cached and in-flight statistics', async ({page}) => {
  await mount(page); await expect(stats(page)).toHaveText('+3-2');
  await page.evaluate(() => Object.assign((window as any).state,{hold:true,additions:8})); await refresh(page);
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(1);
  await page.evaluate(() => { (window as any).state.additions=20; (window as any).renderGit('/repo-b'); });
  await expect.poll(()=>page.evaluate(()=>(window as any).releases.length)).toBe(2);
  await expect(stats(page)).not.toContainText('+3'); await expect(stats(page)).not.toContainText('+8');
  await page.evaluate(()=>(window as any).release()); await expect(stats(page)).toHaveText('+20-2');
});
for (const base of ['light','dark']) test(`file hover and press stay transparent while focus and selection remain visible: ${base}`, async ({page}) => {
  await mount(page,false,base); await expect(stats(page)).toHaveText('+3-2');
  const file=page.locator('.gm-file');
  await file.hover(); await expect(file).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await expect(file.locator('.gm-file-chevron')).toHaveCSS('opacity','1');
  await page.mouse.down(); await expect(file).toHaveCSS('background-color','rgba(0, 0, 0, 0)'); await page.mouse.up();
  await page.getByRole('checkbox',{name:'选择 note.txt',exact:true}).check();
  await expect(page.locator('.gm-selected')).toHaveCount(1);
  expect(await page.locator('.gm-selected').evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('checkbox',{name:'选择 note.txt',exact:true}).focus(); await page.keyboard.press('Tab');
  await expect(file).toBeFocused(); await expect(file).toHaveCSS('outline-style','solid');
  await expect(file).toHaveCSS('outline-width','2px');
});
