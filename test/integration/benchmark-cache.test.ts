import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'assert';
import { cached, contentKey, downloadVerified, releaseComplete } from '../../benchmark/lib/cache.ts';
import { CONVERTER_REVISION, CONVERTER_SOURCES } from '../../benchmark/lib/converters.ts';
import { type CorpusSpec, corpusEntryDir, corpusPath, corpusSpecKey, entryComplete } from '../../benchmark/lib/corpus.ts';
import { buildSynthetic, GENERATOR_REVISION, GENERATOR_SOURCES, syntheticSpecKey } from '../../benchmark/lib/synthetic.ts';
import { packageRoot, scratchDir } from '../lib/tree.ts';

const entry = (calls: string[], content = 'built') => ({
  build(staging: string) {
    calls.push('build');
    writeFileSync(join(staging, 'first-write'), 'the staging folder exists when the builder starts');
    mkdirSync(join(staging, 'tree'), { recursive: true });
    writeFileSync(join(staging, 'tree', 'note.md'), content);
  },
  verify: (dir: string) => existsSync(join(dir, 'tree', 'note.md')) && readFileSync(join(dir, 'tree', 'note.md'), 'utf8') === 'built',
});

describe('benchmark fetch-once cache', () => {
  it('builds a missing entry once and reuses it without building again', async () => {
    const root = scratchDir('benchmark-cache-hit');
    const calls: string[] = [];
    const first = await cached('entry-1', entry(calls), root);
    const second = await cached('entry-1', entry(calls), root);
    assert.equal(first, join(root, 'entry-1'));
    assert.equal(second, first);
    assert.deepEqual(calls, ['build']);
    assert.deepEqual(readdirSync(root), ['entry-1']);
  });

  it('rebuilds an entry that does not verify', async () => {
    const root = scratchDir('benchmark-cache-invalid');
    mkdirSync(join(root, 'entry-1', 'tree'), { recursive: true });
    writeFileSync(join(root, 'entry-1', 'tree', 'note.md'), 'truncated');
    const calls: string[] = [];
    const dir = await cached('entry-1', entry(calls), root);
    assert.deepEqual(calls, ['build']);
    assert.equal(readFileSync(join(dir, 'tree', 'note.md'), 'utf8'), 'built');
  });

  it('leaves nothing behind when the build fails or does not verify', async () => {
    const root = scratchDir('benchmark-cache-failed');
    await assert.rejects(cached('broken', { build: () => Promise.reject(new Error('download failed')), verify: () => true }, root), /download failed/);
    await assert.rejects(cached('unverified', { build: () => {}, verify: () => false }, root), /does not verify/);
    assert.deepEqual(readdirSync(root), []);
  });

  it('gives concurrent callers one valid entry', async () => {
    const root = scratchDir('benchmark-cache-race');
    const calls: string[] = [];
    const dirs = await Promise.all([1, 2, 3, 4].map(() => cached('entry-1', entry(calls), root)));
    assert.deepEqual(new Set(dirs), new Set([join(root, 'entry-1')]));
    assert.equal(readFileSync(join(root, 'entry-1', 'tree', 'note.md'), 'utf8'), 'built');
    assert.deepEqual(readdirSync(root), ['entry-1']);
  });
});

const touch = (dir: string, path: string, content = 'x') => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

function git(repo: string, ...argv: string[]) {
  const result = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(repo: string, file: string) {
  touch(repo, file);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-q', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
}

// Each source kind: a complete entry verifies, an incomplete or wrong one does not.
describe('benchmark cache entry verification', () => {
  const spec = (value: object) => value as CorpusSpec;

  it('git: verifies only the pinned commit', () => {
    const repo = scratchDir('entry-git');
    git(repo, 'init', '-q');
    const first = commit(repo, 'a.md');
    const second = commit(repo, 'b.md');
    assert.equal(entryComplete(spec({ type: 'git', repo: 'unused', commit: second }), repo), true);
    assert.equal(entryComplete(spec({ type: 'git', repo: 'unused', commit: first }), repo), false);
    assert.equal(entryComplete(spec({ type: 'git', repo: 'unused', commit: second }), scratchDir('entry-git-empty')), false);
  });

  const labeled = [
    { type: 'beir', files: ['labels/queries.jsonl'] },
    { type: 'fever', files: ['dev.jsonl', 'labels/queries.jsonl'] },
    { type: 'miracl', files: ['labels/queries.jsonl', 'labels/test.tsv'] },
  ];
  for (const { type, files } of labeled) {
    it(`${type}: needs every label file and a non-empty tree`, () => {
      const dir = scratchDir(`entry-${type}`);
      for (const file of files) touch(dir, file);
      assert.equal(entryComplete(spec({ type }), dir), false, 'no tree');
      touch(dir, 'tree/note.md');
      assert.equal(entryComplete(spec({ type }), dir), true);
      for (const file of files) {
        const partial = scratchDir(`entry-${type}-partial`);
        for (const other of [...files, 'tree/note.md']) if (other !== file) touch(partial, other);
        assert.equal(entryComplete(spec({ type }), partial), false, `missing ${file}`);
      }
      const noNotes = scratchDir(`entry-${type}-empty-tree`);
      for (const file of files) touch(noNotes, file);
      mkdirSync(join(noNotes, 'tree'));
      touch(noNotes, 'tree/readme.txt');
      assert.equal(entryComplete(spec({ type }), noNotes), false, 'tree without markdown');
    });
  }

  it('replicate: needs every copy folder', () => {
    const dir = scratchDir('entry-replicate');
    mkdirSync(join(dir, 'copy1'));
    mkdirSync(join(dir, 'copy2'));
    assert.equal(entryComplete(spec({ type: 'replicate', copies: 2 }), dir), true);
    assert.equal(entryComplete(spec({ type: 'replicate', copies: 3 }), dir), false);
  });

  it('synthetic: needs exactly the configured note count', () => {
    const dir = scratchDir('entry-synthetic');
    for (const name of ['a', 'b', 'c']) touch(dir, `${name}.md`);
    assert.equal(entryComplete(spec({ type: 'synthetic', notes: 3 }), dir), true);
    assert.equal(entryComplete(spec({ type: 'synthetic', notes: 4 }), dir), false);
    rmSync(join(dir, 'c.md'));
    assert.equal(entryComplete(spec({ type: 'synthetic', notes: 3 }), dir), false);
  });

  it('release: needs the requested version and its built entry point', () => {
    const dir = scratchDir('entry-release');
    const installed = join('node_modules', 'sensemaking');
    assert.equal(releaseComplete(dir, '1.0.0'), false, 'nothing installed');
    touch(dir, join(installed, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    assert.equal(releaseComplete(dir, '1.0.0'), false, 'no entry point');
    touch(dir, join(installed, 'dist', 'esm', 'index.js'));
    assert.equal(releaseComplete(dir, '1.0.0'), true);
    assert.equal(releaseComplete(dir, '1.0.1'), false, 'other version');
  });
});

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// Every file under dir, path and bytes, so any write into an entry changes the result.
function treeHash(dir: string) {
  const hash = createHash('sha256');
  for (const path of readdirSync(dir, { recursive: true }).map(String).sort()) {
    hash.update(path);
    if (statSync(join(dir, path)).isFile()) hash.update(readFileSync(join(dir, path)));
  }
  return hash.digest('hex');
}

describe('benchmark cache keys name the content', () => {
  const beir = { type: 'beir', url: 'https://example.test/a.zip', sha256: 'a'.repeat(64) };
  const fever = { type: 'fever', wikiUrl: 'https://example.test/w.zip', wikiSha256: 'b'.repeat(64), devUrl: 'https://example.test/d.jsonl', devSha256: 'c'.repeat(64) };
  const miracl = { type: 'miracl', lang: 'de', shards: 32, targetDocs: 4000, labelsSha: 'd'.repeat(40), corpusSha: 'e'.repeat(40), seed: 100 };
  const key = (name: string, value: object) => corpusSpecKey(name, value as CorpusSpec);

  it('changes when any source hash, url or output-shaping parameter changes', () => {
    const variants: [string, object, object[]][] = [
      [
        'beir',
        beir,
        [
          { ...beir, sha256: 'f'.repeat(64) },
          { ...beir, url: 'https://example.test/b.zip' },
        ],
      ],
      [
        'fever',
        fever,
        [
          { ...fever, wikiSha256: 'f'.repeat(64) },
          { ...fever, devSha256: 'f'.repeat(64) },
          { ...fever, wikiUrl: 'https://example.test/x.zip' },
          { ...fever, devUrl: 'https://example.test/x.jsonl' },
        ],
      ],
      [
        'miracl',
        miracl,
        [
          { ...miracl, lang: 'ja' },
          { ...miracl, shards: 31 },
          { ...miracl, targetDocs: 3999 },
          { ...miracl, labelsSha: 'f'.repeat(40) },
          { ...miracl, corpusSha: 'f'.repeat(40) },
          { ...miracl, seed: 101 },
        ],
      ],
    ];
    for (const [name, base, changed] of variants) {
      const keys = new Set([key(name, base), ...changed.map((spec) => key(name, spec))]);
      assert.equal(keys.size, changed.length + 1, name);
      assert.match(key(name, base), new RegExp(`^${name}-[0-9a-f]{12}$`));
    }
    assert.equal(key('beir', beir), key('beir', { ...beir }), 'the same spec keeps its key');
  });

  it('replicate keys follow the copies and the replicate revision; synthetic keys follow every parameter and the generator revision', () => {
    const replicate = { type: 'replicate', source: 'obsidian-hub', copies: 2 };
    assert.notEqual(key('obsidian-hub-x2', replicate), key('obsidian-hub-x2', { ...replicate, copies: 4 }));
    assert.notEqual(corpusSpecKey('obsidian-hub-x2', replicate as CorpusSpec, 1), corpusSpecKey('obsidian-hub-x2', replicate as CorpusSpec, 2));
    const base = { notes: 10, seed: 1 };
    const keys = new Set([syntheticSpecKey(base), syntheticSpecKey({ ...base, notes: 11 }), syntheticSpecKey({ ...base, seed: 2 }), syntheticSpecKey({ ...base, bigNoteBytes: 5 }), syntheticSpecKey({ ...base, adversarial: true }), syntheticSpecKey(base, GENERATOR_REVISION + 1)]);
    assert.equal(keys.size, 6);
    assert.equal(corpusSpecKey('stress', { type: 'synthetic', ...base } as CorpusSpec), syntheticSpecKey(base), 'a catalog synthetic corpus is keyed like the same spec requested directly');
    assert.equal(contentKey('x', { a: 1, b: 2 }), contentKey('x', { b: 2, a: 1 }), 'key order does not matter');
  });

  const sourceHash = (paths: readonly string[]) => {
    const hash = createHash('sha256');
    for (const path of paths) hash.update(path).update(readFileSync(join(packageRoot, path), 'utf8').replace(/\r\n/g, '\n'));
    return hash.digest('hex');
  };
  // Edit a generator or converter source and these fail until its revision is bumped and the new hash recorded here.
  const RECORDED_GENERATOR_SOURCE_HASH: Record<number, string> = { 2: '635ca2188eddba58c3af824d492b28ad9968c92b448a7e24b3c9c6f81af8eddd' };
  const RECORDED_CONVERTER_SOURCE_HASH: Record<number, string> = { 1: 'd1d53f72ebecda9bdc05190d816bb0b7a1544a35636b34860288e550f06e86c8' };
  it('the generator source matches the hash recorded for its revision', () => {
    assert.equal(sourceHash(GENERATOR_SOURCES), RECORDED_GENERATOR_SOURCE_HASH[GENERATOR_REVISION], 'generator source changed: bump GENERATOR_REVISION in benchmark/lib/synthetic.ts and record the new hash for it');
  });
  it('the converter source matches the hash recorded for its revision', () => {
    assert.equal(sourceHash(CONVERTER_SOURCES), RECORDED_CONVERTER_SOURCE_HASH[CONVERTER_REVISION], 'converter source changed: bump CONVERTER_REVISION in benchmark/lib/converters.ts and record the new hash for it');
  });
  it('downloaded-set keys follow the converter revision', () => {
    const beir = { type: 'beir', url: 'https://example.test/a.zip', sha256: 'a'.repeat(64) } as CorpusSpec;
    assert.notEqual(corpusSpecKey('nfcorpus', beir, undefined, undefined, CONVERTER_REVISION), corpusSpecKey('nfcorpus', beir, undefined, undefined, CONVERTER_REVISION + 1));
  });
});

describe('benchmark verified downloads', () => {
  it('refuses an archive with the wrong hash and leaves nothing in the cache', async () => {
    const root = scratchDir('benchmark-download-refused');
    const source = join(root, 'source.zip');
    writeFileSync(source, 'archive bytes');
    const url = pathToFileURL(source).href;
    await assert.rejects(cached('entry', { build: (staging) => downloadVerified(url, join(staging, 'a.zip'), sha256('other bytes')), verify: () => true }, join(root, 'cache')), /does not match the recorded/);
    assert.deepEqual(readdirSync(join(root, 'cache')), []);
  });

  it('keeps an archive whose hash matches', async () => {
    const root = scratchDir('benchmark-download-accepted');
    const source = join(root, 'source.zip');
    writeFileSync(source, 'archive bytes');
    const dir = await cached('entry', { build: (staging) => downloadVerified(pathToFileURL(source).href, join(staging, 'a.zip'), sha256('archive bytes')), verify: (d) => existsSync(join(d, 'a.zip')) }, join(root, 'cache'));
    assert.equal(readFileSync(join(dir, 'a.zip'), 'utf8'), 'archive bytes');
  });

  it('serves a valid shared entry without any network and without touching it', async () => {
    const root = scratchDir('benchmark-shared-hit');
    const entry = corpusEntryDir('nfcorpus', root) as string;
    assert.equal(entry, join(root, '.cache', 'shared', entry.split(/[\\/]/).pop() as string), 'a downloaded corpus lives in .cache/shared');
    touch(entry, 'tree/doc.md', 'alpha');
    touch(entry, 'labels/queries.jsonl', '{}');
    const before = treeHash(entry);
    // A miss would run curl; every proxy here is a closed port, so a miss fails instead of reaching the network.
    const proxies = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
    const saved = proxies.map((name) => process.env[name]);
    for (const name of proxies) process.env[name] = 'http://127.0.0.1:9';
    try {
      assert.equal(await corpusPath('nfcorpus', root), join(entry, 'tree'));
    } finally {
      proxies.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
    assert.equal(treeHash(entry), before);
    assert.deepEqual(readdirSync(join(root, '.cache', 'shared')), [entry.split(/[\\/]/).pop()]);
  });

  it('keeps the Obsidian hub checkout per worktree, outside shared', () => {
    const root = scratchDir('benchmark-hub-local');
    assert.equal(corpusEntryDir('obsidian-hub', root), join(root, '.cache', (corpusEntryDir('obsidian-hub', root) as string).split(/[\\/]/).pop() as string));
  });
});

describe('benchmark replicate copies', () => {
  it('copy the pinned commit, not the hub working folder', async () => {
    const root = scratchDir('benchmark-replicate');
    const lib = join(root, 'benchmark', 'lib');
    mkdirSync(lib, { recursive: true });
    for (const name of readdirSync(join(packageRoot, 'benchmark', 'lib'))) copyFileSync(join(packageRoot, 'benchmark', 'lib', name), join(lib, name));
    symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    const hub = join(root, '.cache', 'hub');
    mkdirSync(hub, { recursive: true });
    git(hub, 'init', '-q');
    const head = commit(hub, 'tracked.md');
    const source = readFileSync(join(packageRoot, 'benchmark', 'lib', 'corpus.ts'), 'utf8');
    const pinned = /commit: '([0-9a-f]{40})'/.exec(source)?.[1] as string;
    writeFileSync(join(lib, 'corpus.ts'), source.replaceAll(pinned, head));
    renameSync(hub, join(root, '.cache', `obsidian-hub-${head.slice(0, 8)}`));
    const checkout = join(root, '.cache', `obsidian-hub-${head.slice(0, 8)}`);
    touch(checkout, 'untracked.md', 'left by Finder or Obsidian');
    touch(checkout, 'tracked.md', 'edited in the working folder');
    const { corpusPath } = await import(pathToFileURL(join(lib, 'corpus.ts')).href);
    const replicate = (await corpusPath('obsidian-hub-x2')) as string;
    for (const copy of ['copy1', 'copy2']) {
      assert.deepEqual(readdirSync(join(replicate, copy)).sort(), ['tracked.md']);
      assert.equal(readFileSync(join(replicate, copy, 'tracked.md'), 'utf8'), 'x');
    }
  });
});

describe('benchmark measure step leaves a shared entry unchanged', () => {
  it('hashes the same before and after one real measure run', function () {
    this.timeout(120_000);
    const root = scratchDir('benchmark-shared-unchanged');
    const entry = join(root, '.cache', 'shared', syntheticSpecKey({ notes: 20 }));
    mkdirSync(entry, { recursive: true });
    buildSynthetic({ notes: 20 }, entry);
    const before = treeHash(entry);
    execFileSync(process.execPath, [join(packageRoot, 'benchmark', 'steps', 'measure-tree.ts'), packageRoot, entry, '--out', join(root, 'row.json')], { cwd: packageRoot, encoding: 'utf8' });
    assert.ok(existsSync(join(root, 'row.json')));
    assert.equal(treeHash(entry), before);
  });
});
