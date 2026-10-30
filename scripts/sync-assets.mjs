import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY = 'pdone/FreeControl';
export const MANIFEST = Object.freeze([
  ['assets/icons/desktop/64x64.png', 'public/assets/icons/desktop/64x64.png'],
  ['assets/icons/desktop/128x128.png', 'public/assets/icons/desktop/128x128.png'],
  ['assets/icons/desktop/256x256.png', 'public/assets/icons/desktop/256x256.png'],
  ['assets/icons/desktop/512x512.png', 'public/assets/icons/desktop/512x512.png'],
  ['ui-design/launcher-prototype.html', 'public/preview/launcher-prototype.html'],
  ['assets/screenshots/devices.png', 'public/screenshots/dark/devices.png'],
  ['assets/screenshots/en/devices.png', 'public/screenshots/dark/en/devices.png'],
  ['assets/screenshots/light/devices.png', 'public/screenshots/light/devices.png'],
  ['assets/screenshots/light/en/devices.png', 'public/screenshots/light/en/devices.png'],
].map(Object.freeze));
const RECORD = 'product-snapshot.json';
const INPUTS = [...MANIFEST.map(([source]) => source), 'package.json', 'package-lock.json', 'scripts/gen-icon-subset.mjs'];
const ORIGINS = [
  'git@github.com:pdone/FreeControl.git',
  'https://github.com/pdone/FreeControl.git',
  'https://github.com/pdone/FreeControl',
  'https://gitea.awaw.cc/pdone/FreeControl.git',
];
const read = (root, file) => fs.readFileSync(join(root, file));
const json = (root, file) => JSON.parse(read(root, file).toString('utf8'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function validateRecord(record) {
  if (!exactKeys(record, ['repository', 'commit', 'lucideVersion', 'files']) || record.repository !== REPOSITORY ||
      typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/.test(record.commit) ||
      typeof record.lucideVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.lucideVersion)) {
    throw new Error('Invalid product-snapshot.json repository, commit or lucideVersion');
  }
  if (!Array.isArray(record.files) || record.files.length !== MANIFEST.length) throw new Error('Snapshot must contain exactly nine files');
  for (const [source, target] of MANIFEST) {
    const entries = record.files.filter((item) => item?.source === source && item?.target === target);
    if (entries.length !== 1 || !exactKeys(entries[0], ['source', 'target', 'sha256']) || !/^[a-f0-9]{64}$/.test(entries[0].sha256)) {
      throw new Error(`Invalid snapshot whitelist entry: ${source} -> ${target}`);
    }
  }
  return record;
}

export function checkIconVersions(root = ROOT, { generated = true } = {}) {
  const record = validateRecord(json(root, RECORD));
  const expected = record.lucideVersion;
  const pkg = json(root, 'package.json');
  const lock = json(root, 'package-lock.json');
  const versions = [
    ['package.json', pkg.devDependencies?.['lucide-svelte']],
    ['package-lock.json declaration', lock.packages?.['']?.devDependencies?.['lucide-svelte']],
    ['package-lock.json resolved', lock.packages?.['node_modules/lucide-svelte']?.version],
    ['installed lucide-svelte (run npm ci first)', json(root, 'node_modules/lucide-svelte/package.json').version],
    ['prototype inline', read(root, 'public/preview/launcher-prototype.html').toString('utf8').match(/lucide-svelte@(\d+\.\d+\.\d+)（ISC）/)?.[1]],
  ];
  if (generated) versions.push(['src/lib/icon-set.ts', read(root, 'src/lib/icon-set.ts').toString('utf8').match(/export const LUCIDE_VERSION = '(\d+\.\d+\.\d+)'/)?.[1]]);
  for (const [source, version] of versions) {
    if (version !== expected) throw new Error(`lucide version mismatch: ${source}=${version ?? 'missing'}, snapshot=${expected}; align dependencies and run npm run icons:ui explicitly`);
  }
  return expected;
}

export function checkAssets(root = ROOT) {
  const record = validateRecord(json(root, RECORD));
  for (const { target, sha256: expected } of record.files) {
    ensureLocalPath(root, target);
    if (sha256(read(root, target)) !== expected) throw new Error(`SHA-256 mismatch: ${target}`);
  }
  checkIconVersions(root);
  return record;
}

function ensureLocalPath(root, target) {
  const parts = target.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const file = join(root, ...parts.slice(0, i));
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Snapshot target must be a local regular file: ${target}`);
    }
  }
}

function replaceSnapshot(root, entries) {
  for (const { target } of entries) ensureLocalPath(root, target);
  const stage = fs.mkdtempSync(join(root, '.sync-product-'));
  const changed = [];
  let recoveryFailed = false;
  try {
    entries.forEach(({ bytes }, i) => fs.writeFileSync(join(stage, `new-${i}`), bytes));
    entries.forEach(({ target }, i) => {
      const file = join(root, target);
      fs.mkdirSync(dirname(file), { recursive: true });
      const previous = fs.existsSync(file);
      if (previous) fs.renameSync(file, join(stage, `old-${i}`));
      changed.push({ file, i, previous });
      fs.renameSync(join(stage, `new-${i}`), file);
    });
  } catch (error) {
    const errors = [error];
    for (const { file, i, previous } of changed.reverse()) {
      try {
        fs.rmSync(file, { force: true });
        if (previous) fs.renameSync(join(stage, `old-${i}`), file);
      } catch (restoreError) {
        recoveryFailed = true;
        errors.push(restoreError);
      }
    }
    if (recoveryFailed) throw new AggregateError(errors, `Rollback failed; originals retained in ${stage}`);
    throw error;
  } finally {
    if (!recoveryFailed) {
      try { fs.rmSync(stage, { recursive: true, force: true }); }
      catch (error) { console.warn(`[sync:product] Snapshot transaction finished; temporary cleanup failed: ${stage}: ${error.message}`); }
    }
  }
}

export function syncProduct({ from, ref, root = ROOT }) {
  if (!from || !/^[a-f0-9]{40}$/.test(ref ?? '')) throw new Error('Use --from <product-directory> --ref <full 40-character commit>');
  const sourceRoot = fs.realpathSync(resolve(from));
  const siteRoot = fs.realpathSync(root);
  const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file).replaceAll('\\', '/');
  const sourcePath = normalize(sourceRoot);
  const sitePath = normalize(siteRoot);
  if (sourcePath === sitePath || sitePath.startsWith(sourcePath + '/') || sourcePath.startsWith(sitePath + '/')) {
    throw new Error('Source and website must be separate repositories');
  }
  const git = (args) => execFileSync('git', ['-C', sourceRoot, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!ORIGINS.includes(git(['config', '--get', 'remote.origin.url']).toString().trim())) throw new Error(`Source origin must identify ${REPOSITORY}`);
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  if (commit !== ref) throw new Error('Source ref must be an exact commit');
  const dirty = () => git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...INPUTS]).toString().trim();
  if (dirty()) throw new Error('Uncommitted source inputs; clarify the baseline before syncing');
  const blob = (file) => {
    const tree = git(['ls-tree', commit, '--', file]).toString();
    if (!/^100644 blob /.test(tree)) throw new Error(`Missing or non-regular source: ${file}`);
    return git(['cat-file', 'blob', `${commit}:${file}`]);
  };
  const sourceLock = JSON.parse(blob('package-lock.json').toString('utf8'));
  const lucideVersion = sourceLock.packages?.['node_modules/lucide-svelte']?.version;
  const entries = MANIFEST.map(([source, target]) => ({ source, target, bytes: blob(source) }));
  const prototype = entries.find(({ source }) => source === 'ui-design/launcher-prototype.html').bytes.toString('utf8');
  if (prototype.match(/lucide-svelte@(\d+\.\d+\.\d+)（ISC）/)?.[1] !== lucideVersion) throw new Error('Source prototype and lock lucide versions disagree');
  for (const { source, bytes } of entries) {
    if (source.endsWith('.png') && (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) throw new Error(`Invalid PNG source: ${source}`);
  }
  const record = validateRecord({ repository: REPOSITORY, commit, lucideVersion, files: entries.map(({ source, target, bytes }) => ({ source, target, sha256: sha256(bytes) })) });
  if (dirty()) throw new Error('Source inputs changed while reading; no snapshot written');
  replaceSnapshot(siteRoot, [...entries, { target: RECORD, bytes: Buffer.from(JSON.stringify(record, null, 2) + '\n') }]);
  return record;
}

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('npm run check:assets\n  Read-only, offline validation of nine local assets, SHA-256 and lucide versions (npm ci required).\nnpm run sync:product -- --from <product-directory> --ref <full-commit>\n  Read committed blobs from pdone/FreeControl; reject dirty source inputs.\n  Validate all candidates before replacing only the nine targets and product-snapshot.json.\n  On failure restore the previous snapshot. Never update dependencies, public extras or the product.\n  After a lucide version change, explicitly align package.json/lock, install and run npm run icons:ui.');
    return;
  }
  if (args.length === 1 && args[0] === '--check') {
    const record = checkAssets();
    console.log(`[check:assets] ${record.files.length} files verified at ${record.commit}`);
    return;
  }
  if (args.length !== 4 || args.filter((v) => v === '--from').length !== 1 || args.filter((v) => v === '--ref').length !== 1 || !['--from', '--ref'].includes(args[0]) || !['--from', '--ref'].includes(args[2])) throw new Error('Invalid arguments; run npm run sync:product -- --help');
  const values = Object.fromEntries([[args[0], args[1]], [args[2], args[3]]]);
  const record = syncProduct({ from: values['--from'], ref: values['--ref'] });
  console.log(`[sync:product] ${record.files.length} committed blobs synchronized from ${record.repository}@${record.commit}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[sync-assets] ${error.message}`); process.exitCode = 1; }
}
