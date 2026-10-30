import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT, MANIFEST, checkAssets, sha256, syncProduct, validateRecord } from './sync-assets.mjs';
import { product, readJson, website, withProductOrigin, workspace, write } from './test-fixtures.mjs';

const capture = (root) => new Map(['product-snapshot.json', ...MANIFEST.map(([, target]) => target)].map((file) => [file, fs.readFileSync(join(root, file))]));
const unchanged = (root, old) => { for (const [file, bytes] of old) assert.deepEqual(fs.readFileSync(join(root, file)), bytes, file); };
const setup = (t) => {
  withProductOrigin(t);
  const dir = workspace(t);
  const source = product(join(dir, 'product'));
  const root = website(join(dir, 'website'));
  const ref = source.commit();
  return { source, root, ref };
};

test('sync reads committed raw bytes, checks nine hashes and preserves public extras', (t) => {
  const { source, root, ref } = setup(t);
  write(root, 'public/keep.txt', 'outside the whitelist');
  const record = syncProduct({ from: source.root, ref, root });
  assert.equal(record.commit, ref);
  assert.deepEqual(Object.keys(record).sort(), ['commit', 'files', 'lucideVersion', 'repository']);
  for (const file of record.files) {
    const bytes = source.git(['cat-file', 'blob', `${ref}:${file.source}`]);
    assert.deepEqual(fs.readFileSync(join(root, file.target)), bytes);
    assert.equal(sha256(bytes), file.sha256);
  }
  const before = capture(root);
  assert.equal(checkAssets(root).files.length, 9);
  unchanged(root, before);
  assert.equal(fs.readFileSync(join(root, 'public/keep.txt'), 'utf8'), 'outside the whitelist');
  assert.equal(source.git(['status', '--porcelain']).length, 0);
});

for (const [, target] of MANIFEST.filter(([source]) => source.endsWith('devices.png'))) {
  test(`missing screenshot fails local check: ${target}`, (t) => {
    const root = website(join(workspace(t), 'site'));
    fs.rmSync(join(root, target));
    assert.throws(() => checkAssets(root), /ENOENT/);
  });
}

test('hash mismatch fails without rewriting the corrupt file', (t) => {
  const root = website(join(workspace(t), 'site'));
  const target = MANIFEST[0][1];
  write(root, target, 'corrupt');
  assert.throws(() => checkAssets(root), /SHA-256 mismatch/);
  assert.equal(fs.readFileSync(join(root, target), 'utf8'), 'corrupt');
});

for (const file of [MANIFEST[0][0], 'package.json', 'package-lock.json', 'scripts/gen-icon-subset.mjs']) {
  test(`dirty source is rejected and old snapshot retained: ${file}`, (t) => {
    const { source, root, ref } = setup(t);
    const old = capture(root);
    fs.appendFileSync(join(source.root, file), '\ndirty');
    assert.throws(() => syncProduct({ from: source.root, ref, root }), /Uncommitted source/);
    unchanged(root, old);
    assert(fs.readFileSync(join(source.root, file)).includes(Buffer.from('dirty')));
  });
}

test('staged source change is rejected', (t) => {
  const { source, root, ref } = setup(t);
  const old = capture(root);
  const hash = source.git(['hash-object', '-w', '--stdin'], 'staged').toString().trim();
  source.git(['update-index', '--cacheinfo', `100644,${hash},${MANIFEST[0][0]}`]);
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /Uncommitted source/);
  unchanged(root, old);
});

test('source commit missing a screenshot fails before any replacement', (t) => {
  const { source, root } = setup(t);
  const missing = 'assets/screenshots/light/en/devices.png';
  source.files.delete(missing);
  fs.rmSync(join(source.root, missing));
  const ref = source.commit();
  const old = capture(root);
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /Missing or non-regular source/);
  unchanged(root, old);
});

test('invalid PNG or prototype version fails before any replacement', (t) => {
  const { source, root } = setup(t);
  const old = capture(root);
  const file = MANIFEST[0][0];
  source.files.set(file, Buffer.from('not a PNG'));
  write(source.root, file, source.files.get(file));
  let ref = source.commit();
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /Invalid PNG/);
  unchanged(root, old);
  source.files.set(file, fs.readFileSync(join(ROOT, MANIFEST[0][1])));
  write(source.root, file, source.files.get(file));
  const lock = { packages: { 'node_modules/lucide-svelte': { version: '0.457.0' } } };
  source.files.set('package-lock.json', Buffer.from(JSON.stringify(lock)));
  write(source.root, 'package-lock.json', source.files.get('package-lock.json'));
  ref = source.commit();
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /versions disagree/);
  unchanged(root, old);
});

test('new source lucide version is recorded without installing or rewriting website dependencies', (t) => {
  const { source, root } = setup(t);
  const pkg = fs.readFileSync(join(root, 'package.json'));
  for (const file of ['package.json', 'package-lock.json', 'ui-design/launcher-prototype.html']) {
    const bytes = Buffer.from(source.files.get(file).toString().replaceAll('0.456.0', '0.457.0'));
    source.files.set(file, bytes);
    write(source.root, file, bytes);
  }
  const ref = source.commit();
  assert.equal(syncProduct({ from: source.root, ref, root }).lucideVersion, '0.457.0');
  assert.deepEqual(fs.readFileSync(join(root, 'package.json')), pkg);
  assert.throws(() => checkAssets(root), /version mismatch/);
});

test('record cannot expand the whitelist or carry local paths', (t) => {
  const root = website(join(workspace(t), 'site'));
  const original = readJson(root, 'product-snapshot.json');
  for (const transform of [
    (r) => { r.files[0].target = '../outside.png'; },
    (r) => { r.files.push({ ...r.files[0], target: 'public/extra.png' }); },
    (r) => { r.files[1] = r.files[0]; },
    (r) => { r.from = 'C:/private'; },
    (r) => { r.commit = 'main'; },
    (r) => { r.repository = 'other/repository'; },
  ]) {
    const record = structuredClone(original);
    transform(record);
    assert.throws(() => validateRecord(record));
  }
});

for (const failAt of [4, 9]) {
  test(`failure at replacement ${failAt} restores different previous bytes and the record`, (t) => {
    const { source, root } = setup(t);
    const old = capture(root);
    for (const [file] of MANIFEST) {
      const bytes = Buffer.concat([source.files.get(file), Buffer.from('\nchanged fixture bytes')]);
      source.files.set(file, bytes);
      write(source.root, file, bytes);
    }
    const ref = source.commit();
    const rename = fs.renameSync;
    let failed = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (!failed && from.endsWith(`new-${failAt}`)) { failed = true; throw new Error('injected write failure'); }
      return rename(from, to);
    });
    assert.throws(() => syncProduct({ from: source.root, ref, root }), /injected write failure/);
    assert(failed);
    unchanged(root, old);
    assert(!fs.readdirSync(root).some((name) => name.startsWith('.sync-product-')));
  });
}

test('CRLF source worktree still syncs LF committed prototype bytes', (t) => {
  const { source, root, ref } = setup(t);
  const key = `GIT_CONFIG_VALUE_${Number(process.env.GIT_CONFIG_COUNT) - 1}`;
  process.env[key] = 'true';
  const file = 'ui-design/launcher-prototype.html';
  write(source.root, file, source.files.get(file).toString('utf8').replaceAll('\n', '\r\n'));
  assert.equal(source.git(['-c', 'core.autocrlf=true', 'status', '--porcelain', '--', file]).length, 0);
  syncProduct({ from: source.root, ref, root });
  assert.deepEqual(fs.readFileSync(join(root, MANIFEST[4][1])), source.files.get(file));
  assert(!fs.readFileSync(join(root, MANIFEST[4][1])).includes(Buffer.from('\r\n')));
});

test('unrelated dirty files are neither collected nor cleaned', (t) => {
  const { source, root, ref } = setup(t);
  write(source.root, 'unrelated.txt', 'user work');
  syncProduct({ from: source.root, ref, root });
  assert.equal(fs.readFileSync(join(source.root, 'unrelated.txt'), 'utf8'), 'user work');
  assert(!fs.existsSync(join(root, 'unrelated.txt')));
});

test('directory target is rejected before changing the old snapshot', (t) => {
  const { source, root, ref } = setup(t);
  const target = join(root, MANIFEST[4][1]);
  fs.rmSync(target);
  fs.mkdirSync(target);
  const before = fs.readFileSync(join(root, 'product-snapshot.json'));
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /local regular file/);
  assert.deepEqual(fs.readFileSync(join(root, 'product-snapshot.json')), before);
});

test('only the referenced Regular font subset remains loadable', () => {
  const module = fs.readFileSync(join(ROOT, 'src/lib/web-font.ts'), 'utf8');
  assert(module.includes("const FILE = 'puhuiti3-55-subset.woff2'"));
  assert.equal((module.match(/@font-face{/g) || []).length, 1);
  assert(!module.includes('75-subset'));
  assert(fs.existsSync(join(ROOT, 'src/assets/fonts/puhuiti3-55-subset.woff2')));
  assert.deepEqual(fs.readdirSync(join(ROOT, 'src/assets/fonts')).sort(), ['puhuiti3-55-subset.woff2']);
  const generator = fs.readFileSync(join(ROOT, 'scripts/gen-font-subset.mjs'), 'utf8');
  assert(generator.includes("const WEIGHT_TO_FILE = { 400: 'puhuiti3-55-subset.woff2' };"));
  assert(!generator.includes('75-subset'));
});

test('dark screenshots live under the dark directory and keep product source bytes', (t) => {
  const root = website(join(workspace(t), 'site'));
  assert(!fs.existsSync(join(root, 'public/screenshots/devices.png')));
  assert(!fs.existsSync(join(root, 'public/screenshots/en')));
  for (const target of ['public/screenshots/dark/devices.png', 'public/screenshots/dark/en/devices.png']) {
    assert(fs.readFileSync(join(root, target)).length > 0, target);
  }
  assert(checkAssets(root).files.length === 9);
});

test('directory links cannot redirect writes outside the snapshot targets', (t) => {
  const { source, root, ref } = setup(t);
  const external = join(root, '..', 'outside');
  fs.mkdirSync(external);
  fs.rmSync(join(root, 'public/screenshots'), { recursive: true });
  fs.symlinkSync(external, join(root, 'public/screenshots'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readFileSync(join(root, 'product-snapshot.json'));
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /local regular file/);
  assert.deepEqual(fs.readFileSync(join(root, 'product-snapshot.json')), before);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('missing repository and non-commit refs fail without writes', (t) => {
  const { source, root } = setup(t);
  const old = capture(root);
  assert.throws(() => syncProduct({ from: join(source.root, 'missing'), ref: 'a'.repeat(40), root }), /ENOENT/);
  for (const ref of ['main', '--help', 'HEAD;touch injected', 'a'.repeat(39)]) assert.throws(() => syncProduct({ from: source.root, ref, root }), /full 40-character/);
  unchanged(root, old);
});

test('unrelated source origin is rejected', (t) => {
  const { source, root, ref } = setup(t);
  const key = `GIT_CONFIG_VALUE_${Number(process.env.GIT_CONFIG_COUNT) - 2}`;
  process.env[key] = 'https://example.invalid/unrelated.git';
  const old = capture(root);
  assert.throws(() => syncProduct({ from: source.root, ref, root }), /Source origin/);
  unchanged(root, old);
});

test('isolated fixture clones preserve the nine blobs with autocrlf true and false', (t) => {
  const dir = workspace(t);
  const source = product(join(dir, 'fixture'));
  source.files.clear();
  for (const [, target] of MANIFEST) source.files.set(target, fs.readFileSync(join(ROOT, target)));
  source.files.set('.gitattributes', fs.readFileSync(join(ROOT, '.gitattributes')));
  const ref = source.commit();
  for (const mode of ['true', 'false']) {
    const clone = join(dir, `clone-${mode}`);
    source.git(['-c', `core.autocrlf=${mode}`, 'clone', '--quiet', '--no-local', source.root, clone]);
    for (const [, target] of MANIFEST) assert.deepEqual(fs.readFileSync(join(clone, target)), source.git(['cat-file', 'blob', `${ref}:${target}`]), `${mode}: ${target}`);
  }
});
