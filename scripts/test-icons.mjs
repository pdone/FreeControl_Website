import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { ROOT, checkIconVersions, sha256 } from './sync-assets.mjs';
import { collectIconNames, generateIcons } from './gen-icon-subset.mjs';
import { readJson, website, workspace, write, writeJson } from './test-fixtures.mjs';

for (const [name, mutate] of [
  ['snapshot', (root) => { const value = readJson(root, 'product-snapshot.json'); value.lucideVersion = '0.457.0'; writeJson(root, 'product-snapshot.json', value); }],
  ['package declaration', (root) => { const value = readJson(root, 'package.json'); value.devDependencies['lucide-svelte'] = '^0.456.0'; writeJson(root, 'package.json', value); }],
  ['lock declaration', (root) => { const value = readJson(root, 'package-lock.json'); value.packages[''].devDependencies['lucide-svelte'] = '0.457.0'; writeJson(root, 'package-lock.json', value); }],
  ['lock resolution', (root) => { const value = readJson(root, 'package-lock.json'); value.packages['node_modules/lucide-svelte'].version = '0.457.0'; writeJson(root, 'package-lock.json', value); }],
  ['installed dependency', (root) => writeJson(root, 'node_modules/lucide-svelte/package.json', { version: '0.457.0' })],
  ['generated icons', (root) => { const file = 'src/lib/icon-set.ts'; write(root, file, fs.readFileSync(join(root, file), 'utf8').replaceAll('0.456.0', '0.457.0')); }],
  ['inline prototype', (root) => { const file = 'public/preview/launcher-prototype.html'; write(root, file, fs.readFileSync(join(root, file), 'utf8').replaceAll('lucide-svelte@0.456.0', 'lucide-svelte@0.457.0')); }],
]) {
  test(`version drift fails: ${name}`, (t) => {
    const root = website(join(workspace(t), 'site'));
    assert.equal(checkIconVersions(root), '0.456.0');
    mutate(root);
    assert.throws(() => checkIconVersions(root), /version mismatch/);
  });
}

test('matching versions pass without writes', (t) => {
  const root = website(join(workspace(t), 'site'));
  const before = fs.readFileSync(join(root, 'src/lib/icon-set.ts'));
  assert.equal(checkIconVersions(root), '0.456.0');
  assert.deepEqual(fs.readFileSync(join(root, 'src/lib/icon-set.ts')), before);
});

test('generator scans only website references and does not rewrite the prototype', (t) => {
  const root = website(join(workspace(t), 'site'));
  write(root, 'src/App.svelte', '<script>const NEXT_ICON = { light: \'Moon\', dark: \'Sun\' };</script><Icon name="Download" />');
  write(root, 'src/lib/i18n.ts', "export const items = [{icon: 'Languages'}];\n");
  const available = new Map([...fs.readFileSync(join(ROOT, 'src/lib/icon-set.ts'), 'utf8').matchAll(/^  (\w+): (.+),$/gm)].map(([, name, node]) => [name, JSON.parse(node)]));
  for (const [pascal, kebab] of [['Download', 'download'], ['Languages', 'languages'], ['Moon', 'moon'], ['Sun', 'sun']]) {
    write(root, `node_modules/lucide-svelte/dist/icons/${kebab}.svelte`, `const iconNode = ${JSON.stringify(available.get(pascal)[2])};`);
  }
  const prototype = join(root, 'public/preview/launcher-prototype.html');
  const before = sha256(fs.readFileSync(prototype));
  assert.deepEqual(collectIconNames(root), ['download', 'languages', 'moon', 'sun']);
  assert.equal(generateIcons({ root }).count, 4);
  assert.equal(generateIcons({ root, check: true }).count, 4);
  assert.equal(sha256(fs.readFileSync(prototype)), before);
  assert(!fs.readFileSync(join(root, 'src/lib/icon-set.ts'), 'utf8').includes('Zap:'));
  write(root, 'src/lib/i18n.ts', "export const items = [{icon: 'NotAnIcon'}];\n");
  assert.throws(() => generateIcons({ root, check: true }), /not-an-icon/);
  assert.equal(sha256(fs.readFileSync(prototype)), before);
});

test('website unknown icon evaluates to empty markup and warns', () => {
  const source = fs.readFileSync(join(ROOT, 'src/lib/Icon.svelte'), 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
  const code = stripTypeScriptTypes(source)
    .replace("import { ICONS } from './icon-set';", '')
    .replace(/export let name\s*;/, 'let name = inputName;')
    .replaceAll('export let ', 'let ')
    .replace('$: node =', 'let node =')
    .replace('$: markup =', 'let markup =');
  const warnings = [];
  const context = { ICONS: {}, inputName: 'MissingIcon', console: { warn: (value) => warnings.push(value) } };
  vm.runInNewContext(code + '\nglobalThis.result = markup;', context);
  assert.equal(context.result, '');
  assert.equal(warnings.length, 1);
  assert(warnings[0].includes('MissingIcon'));
});

test('prototype unknown icon remains empty and warns without network APIs', () => {
  const prototype = fs.readFileSync(join(ROOT, 'public/preview/launcher-prototype.html'), 'utf8');
  const code = prototype.match(/<script id="protoIcons">([\s\S]*?)<\/script>/)[1];
  const warnings = [];
  const host = { getAttribute: () => 'missing-icon', innerHTML: '' };
  const context = { window: {}, console: { warn: (value) => warnings.push(value) }, document: { querySelectorAll: () => [host] } };
  vm.runInNewContext(code, context);
  context.window.lucide.createIcons();
  assert.equal(host.innerHTML, '');
  assert.equal(warnings.length, 1);
  assert(warnings[0].includes('missing-icon'));
  assert(!/<script[^>]+src=["'][^"']*(?:lucide|unpkg|jsdelivr)/i.test(prototype));
});
