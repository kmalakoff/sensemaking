import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../../src/config.ts';
import { featureSignature } from '../../src/config.ts';
import { runCli as spawnCli } from '../lib/cli.ts';

// A note in a language written without spaces, which is what the setting exists for: unicode61
// has no segmenter, so the whole run indexes as one token and word search cannot reach it.
function makeTree(tokenize?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-tokenize-'));
  const content = tokenize === undefined ? {} : { content: { tokenize } };
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, ...content, queries: {} }));
  writeFileSync(join(dir, 'cjk.md'), '---\ntitle: notes\n---\n数据库全文搜索很有用。\n');
  writeFileSync(join(dir, 'en.md'), '---\ntitle: english\n---\nRevenue grew.\n');
  return dir;
}

function runCli(dir: string, args: string[]) {
  return spawnCli([...args, '--config', join(dir, 'sense.config.json')]);
}

function setTokenize(dir: string, tokenize: string): void {
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, content: { tokenize }, queries: {} }));
}

// Rows in the cache file as it sits on disk, without going through a command that would
// rebuild it. Returns -1 when the crawl never got as far as creating the table.
function cachedDocs(dir: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dir, '.sense', 'cache.db'), { readOnly: true });
    return (db.prepare('SELECT count(*) AS n FROM frontmatter').get() as { n: number }).n;
  } catch {
    return -1;
  } finally {
    db?.close();
  }
}

function match(dir: string, term: string): string[] {
  const result = runCli(dir, ['sql', 'SELECT path FROM content WHERE content MATCH ?', term, '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as Array<{ path: string }>).map((r) => r.path);
}

describe('content.tokenize', () => {
  it('defaults to porter unicode61, which cannot reach a language written without spaces', () => {
    const dir = makeTree();
    try {
      const ddl = runCli(dir, ['sql', "SELECT sql FROM sqlite_master WHERE name = 'content'", '--format', 'json']);
      assert.match(ddl.stdout, /porter unicode61/);
      assert.deepEqual(match(dir, '全文搜'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trigram indexes the same tree so the words become reachable', () => {
    const dir = makeTree('trigram');
    try {
      const ddl = runCli(dir, ['sql', "SELECT sql FROM sqlite_master WHERE name = 'content'", '--format', 'json']);
      assert.match(ddl.stdout, /tokenize = 'trigram'/);
      assert.deepEqual(match(dir, '全文搜'), ['cjk.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trigram also matches inside a word, which a stemmer cannot', () => {
    const dir = makeTree('trigram');
    try {
      assert.deepEqual(match(dir, 'evenu'), ['en.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trigram needs three characters, so a two-character term still finds nothing', () => {
    const dir = makeTree('trigram');
    try {
      assert.deepEqual(match(dir, '全文'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changing it rebuilds once, naming the tokenizer rather than "features"', () => {
    const dir = makeTree();
    try {
      runCli(dir, ['sql', 'SELECT 1']);
      setTokenize(dir, 'trigram');
      const changed = runCli(dir, ['sql', 'SELECT 1']);
      // A tokenize-only change takes the dedicated fast path (finding #5): it names the content
      // tokenizer, not "features", and says what is kept, not just what rebuilds.
      assert.match(changed.stderr, /config change \(content tokenizer\) rebuilds the text index; vectors, links, and sections are kept/);
      const again = runCli(dir, ['sql', 'SELECT 1']);
      assert.ok(!again.stderr.includes('rebuilds the index'), again.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tree that never sets it carries no signature segment, so upgrading does not rebuild it', () => {
    const base = { presets: { default: { include: ['*.md'] } }, queries: {} } as unknown as Config;
    assert.ok(!featureSignature(base).includes('tokenize:'), featureSignature(base));
    const set = { ...base, content: { tokenize: 'trigram' } } as unknown as Config;
    assert.match(featureSignature(set), /tokenize:trigram/);
  });

  it('a tokenizer this SQLite does not accept is refused by the probe, naming the built-ins', () => {
    const dir = makeTree('nonsense-tokenizer');
    try {
      const result = runCli(dir, ['sql', 'SELECT 1']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /content.tokenize "nonsense-tokenizer" is not a tokenizer this SQLite accepts/);
      assert.match(result.stderr, /unicode61, ascii, porter, and trigram/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a refused tokenizer leaves a warm cache alone, so a typo costs no re-index', () => {
    const dir = makeTree();
    try {
      assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
      const before = cachedDocs(dir);
      assert.ok(before > 0, 'the fixture should have indexed something to lose');

      setTokenize(dir, 'nonsense-tokenizer');
      assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 1);

      // Read the cache file directly rather than through the CLI. Neither `.sense` existing nor
      // a doc count taken afterwards can tell the two apart: open() creates the directory before
      // anything can fail, and a later command's reconcile re-crawls the tree and restores the
      // count. What only survives a cache that was never cleared is the rows already in the file.
      assert.equal(cachedDocs(dir), before, 'the refused tokenizer cleared the cache before rejecting it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cache whose meta was lost still rebuilds when the tokenizer changes, read from the table DDL', () => {
    const dir = makeTree();
    try {
      assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

      const cachePath = join(dir, '.sense', 'cache.db');
      const db = new DatabaseSync(cachePath);
      db.exec(`DELETE FROM meta WHERE key = 'features'`);
      db.close();

      setTokenize(dir, 'trigram');
      const rebuilt = runCli(dir, ['sql', "SELECT sql FROM sqlite_master WHERE name='content'", '--format', 'json']);
      assert.equal(rebuilt.status, 0, rebuilt.stderr);
      assert.match(rebuilt.stderr, /different content tokenizer; rebuilding/);
      assert.match(rebuilt.stdout, /tokenize = 'trigram'/);

      assert.deepEqual(match(dir, '全文搜'), ['cjk.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown key inside the block names itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-tokenize-'));
    try {
      writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, content: { tokeniz: 'trigram' }, queries: {} }));
      const result = runCli(dir, ['sql', 'SELECT 1']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /content has unknown key\(s\) tokeniz; content takes tokenize/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-string value is refused before it reaches DDL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-tokenize-'));
    try {
      writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, content: { tokenize: 7 }, queries: {} }));
      const result = runCli(dir, ['sql', 'SELECT 1']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /content.tokenize must be a non-empty string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Review finding #5: a tokenize-only signature change used to take the same clear/reopen path
// as any other config edit, which destroyed vectors, links, and sections along with content --
// none of which derive from the tokenizer.
describe('content.tokenize: a tokenize-only change rebuilds text only', () => {
  it('keeps embeddings (and everything else file-derived) while content is rebuilt', () => {
    const dir = makeTree();
    try {
      assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);

      // The fixture has no embed config, so reconcile never creates this table; add it by hand
      // with the exact DDL embed.ts uses, carrying a real (non-NULL) vector.
      const cachePath = join(dir, '.sense', 'cache.db');
      const setup = new DatabaseSync(cachePath);
      setup.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
      setup.prepare(`INSERT INTO embeddings VALUES ('cjk.md', 0, 1, 2, 1.0, X'00')`).run();
      setup.close();

      setTokenize(dir, 'trigram');
      const result = runCli(dir, ['sql', 'SELECT 1']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /text index; vectors, links, and sections are kept/);

      const after = new DatabaseSync(cachePath, { readOnly: true });
      const row = after.prepare(`SELECT vector FROM embeddings WHERE "path" = 'cjk.md'`).get() as { vector: Uint8Array } | undefined;
      after.close();
      assert.ok(row?.vector != null, 'the embeddings row should survive the tokenize-only rebuild');

      assert.deepEqual(match(dir, '全文搜'), ['cjk.md']); // content was actually rebuilt, with trigram
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a preset include change still takes the full rebuild, not the text-index-only path', () => {
    const dir = makeTree();
    try {
      assert.equal(runCli(dir, ['sql', 'SELECT 1']).status, 0);
      writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md', '*.mdx'] } }, queries: {} }));
      const result = runCli(dir, ['sql', 'SELECT 1']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /config change \(preset "default"\) rebuilds the index/);
      assert.ok(!result.stderr.includes('text index'), result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
