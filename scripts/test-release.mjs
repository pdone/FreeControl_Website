import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('scripts/fetch-release.mjs', root), 'utf8');
const app = fs.readFileSync(new URL('src/App.svelte', root), 'utf8');
const repo = 'https://github.com/pdone/FreeControl';
const page = `${repo}/releases/latest`;
const api = 'https://api.github.com/repos/pdone/FreeControl/releases/latest';
const suffixes = ['windows_x64.exe', 'windows_arm64.exe', 'linux_amd64.AppImage', 'linux_amd64.deb', 'macos_arm64.dmg', 'macos_x64.dmg'];
const keys = ['windows', 'windowsArm64', 'appimage', 'deb', 'macosArm64', 'macosX64'];
const assetUrl = (suffix, prefix = 'FreeControl') => `${repo}/releases/download/v9.8.7/${prefix}_9.8.7_${suffix}`;

async function run(fetch) {
  const outputs = [];
  const requests = [];
  const code = source.replace(/^import .+;\r?\n/gm, '').replaceAll('import.meta.url', 'scriptUrl');
  await vm.runInNewContext(`(async () => { ${code}\n })()`, {
    scriptUrl: new URL('scripts/fetch-release.mjs', root).href,
    path, fileURLToPath,
    fs: { writeFileSync: (file, bytes) => { assert.equal(file, fileURLToPath(new URL('src/lib/release.json', root))); outputs.push(JSON.parse(bytes)); } },
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); },
    console: { log() {}, warn() {} },
  });
  assert.equal(outputs.length, 1);
  return { release: outputs[0], requests };
}

const response = (data) => ({ ok: true, json: async () => data });
const releaseData = (suffixes, prefix = 'FreeControl') => ({ tag_name: 'v9.8.7', assets: suffixes.map((suffix) => ({ name: `${prefix}_9.8.7_${suffix}`, browser_download_url: assetUrl(suffix, prefix) })) });

test('complete API release retains six product download links', async () => {
  const { release, requests } = await run(async (url) => { assert.equal(url, api); return response(releaseData(suffixes)); });
  assert.equal(release.ok, true);
  assert.equal(release.page, page);
  assert.equal(requests.length, 1);
  keys.forEach((key, i) => assert.equal(release[key], assetUrl(suffixes[i])));
});

test('offline API and redirect produce the original release-page fallback', async () => {
  const { release, requests } = await run(async () => { throw new Error('offline'); });
  assert.equal(release.ok, false);
  assert.equal(release.tag, null);
  assert.equal(release.page, page);
  keys.forEach((key) => assert.equal(release[key], null));
  assert.deepEqual(requests.map(({ url }) => url), [api, page]);
});

test('missing macOS assets leaves other platform links intact', async () => {
  const { release } = await run(async () => response(releaseData(suffixes.slice(0, 4))));
  assert.equal(release.ok, true);
  keys.slice(0, 4).forEach((key, i) => assert.equal(release[key], assetUrl(suffixes[i])));
  assert.equal(release.macosArm64, null);
  assert.equal(release.macosX64, null);
  const asset = app.match(/const asset = \(key: string\): string => ([^;]+);/)[1];
  assert.equal(vm.runInNewContext(asset, { ASSETS: release, key: 'macosArm64', RELEASES: page }), page);
});

test('missing core asset falls back instead of publishing a partial release', async () => {
  const { release } = await run(async () => response(releaseData(suffixes.filter((name) => !name.endsWith('.deb')))));
  assert.equal(release.ok, false);
  keys.forEach((key) => assert.equal(release[key], null));
});

for (const prefix of ['FreeControl', 'FreeControl2']) {
  test(`API failure uses verified redirect assets with ${prefix} prefix and macOS fallback`, async () => {
    const { release, requests } = await run(async (url, options) => {
      if (url === api) return { ok: false, status: 503 };
      if (url === page) return { headers: { get: () => `${repo}/releases/tag/v9.8.7` } };
      assert.equal(options.method, 'HEAD');
      const ok = suffixes.slice(0, 4).some((suffix) => url === assetUrl(suffix, prefix));
      return { ok, status: ok ? 200 : 404 };
    });
    assert.equal(release.ok, true);
    keys.slice(0, 4).forEach((key, i) => assert.equal(release[key], assetUrl(suffixes[i], prefix)));
    assert.equal(release.macosArm64, null);
    assert.equal(release.macosX64, null);
    assert(requests.every(({ url }) => url.includes('pdone/FreeControl')));
  });
}

test('historical API asset names still produce direct links', async () => {
  const { release } = await run(async () => response(releaseData(suffixes, 'FreeControl2')));
  assert.equal(release.ok, true);
  keys.forEach((key, i) => assert.equal(release[key], assetUrl(suffixes[i], 'FreeControl2')));
});

test('product links, changelogs and version trigger remain separate from build inputs', () => {
  const i18n = fs.readFileSync(new URL('src/lib/i18n.ts', root), 'utf8');
  assert(app.includes(`const REPO = '${repo}'`));
  assert(app.includes('class="gh-btn" href={REPO}'));
  assert(app.includes('class="btn btn-ghost" href={REPO}'));
  assert(app.includes('<a href={link.href}>{link.label}</a>'));
  assert(i18n.includes(`href: '${repo}/blob/main/Update.md'`));
  assert(i18n.includes(`href: '${repo}/blob/main/Update.en.md'`));
  assert(app.includes('href="#download"'));
  assert(!source.includes('FreeControlWebsite'));
  assert(!/readFileSync\([^\n]*["'`]version["'`]/.test(source + app));
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  for (const name of ['dev', 'build']) {
    assert(pkg.scripts[name].startsWith('npm run check:assets && npm run fetch-release && vite'));
    assert(!pkg.scripts[name].includes('sync:product'));
  }
  assert(!fs.existsSync(new URL('public/product-snapshot.json', root)));
  assert(!fs.existsSync(new URL('public/version', root)));
});
