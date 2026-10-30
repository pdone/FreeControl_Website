import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ROOT, MANIFEST } from './sync-assets.mjs';

export const write = (root, file, bytes) => {
  const target = join(root, file);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
};
export const writeJson = (root, file, value) => write(root, file, JSON.stringify(value, null, 2) + '\n');
export const readJson = (root, file) => JSON.parse(fs.readFileSync(join(root, file), 'utf8'));

export function workspace(t) {
  const parent = join(ROOT, '.local/tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function website(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'product-snapshot.json', '.gitattributes', 'src/lib/icon-set.ts', ...MANIFEST.map(([, target]) => target)]) {
    write(root, file, fs.readFileSync(join(ROOT, file)));
  }
  writeJson(root, 'node_modules/lucide-svelte/package.json', { version: '0.456.0' });
  return root;
}

export function product(root) {
  fs.mkdirSync(root, { recursive: true });
  const env = {
    ...process.env, GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], { env, input, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  const files = new Map(MANIFEST.map(([source, target]) => [source, fs.readFileSync(join(ROOT, target))]));
  files.set('package.json', Buffer.from(JSON.stringify({ dependencies: { 'lucide-svelte': '^0.456.0' } })));
  files.set('package-lock.json', Buffer.from(JSON.stringify({ packages: { 'node_modules/lucide-svelte': { version: '0.456.0' } } })));
  files.set('scripts/gen-icon-subset.mjs', Buffer.from('// fixture\n'));
  for (const [file, bytes] of files) write(root, file, bytes);
  const commit = () => {
    const tree = {};
    for (const [file, bytes] of files) {
      const parts = file.split('/');
      let node = tree;
      for (const part of parts.slice(0, -1)) node = node[part] ??= {};
      node[parts.at(-1)] = git(['hash-object', '-w', '--stdin'], bytes).toString().trim();
    }
    const saveTree = (node) => git(['mktree'], Object.entries(node).map(([name, value]) => typeof value === 'string' ? `100644 blob ${value}\t${name}\n` : `040000 tree ${saveTree(value)}\t${name}\n`).join('')).toString().trim();
    const ref = git(['commit-tree', saveTree(tree)], 'Isolated test fixture\n').toString().trim();
    git(['update-ref', 'HEAD', ref]);
    git(['read-tree', ref]);
    return ref;
  };
  return { root, files, git, commit };
}

export function withProductOrigin(t) {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const entries = {
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: 'remote.origin.url',
    [`GIT_CONFIG_VALUE_${count}`]: 'git@github.com:pdone/FreeControl.git',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'core.autocrlf',
    [`GIT_CONFIG_VALUE_${count + 1}`]: 'false',
  };
  for (const [key, value] of Object.entries(entries)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
