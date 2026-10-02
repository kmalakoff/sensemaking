import assert from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchSignalContribution } from 'sensemaking';
import { open, SUPPORTED_CONFIG_VERSION, search } from 'sensemaking';
import { runCli } from '../lib/cli.ts';
import { writeModel } from '../lib/model.ts';
import { scratchDir } from '../lib/scratch.ts';
import { forEachStore, withTreeForStore } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

function tmpTree(): string {
  return scratchDir('search');
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>, content: string): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\n${content}\n`);
}

// These tests never need vectors and must never touch the network; no `embed` block means
// no model named, so vectors stay off regardless of signals.
function openTree(baseDir: string) {
  return open({ presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null });
}

const WEIGHTED = 'bm25(content, 10.0, 5.0, 1.0)';

describe('search', () => {
  it('matches on body text, not just frontmatter', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'The quick brown fox jumps.');
    write(baseDir, 'b.md', { title: 'B' }, 'Nothing relevant lives here.');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT path FROM content WHERE content MATCH ?')).all('fox')) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
  });

  it('joins to frontmatter so a frontmatter filter and a content search compose', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'active.md', { status: 'active' }, 'discusses onboarding at length');
    write(baseDir, 'archived.md', { status: 'archived' }, 'also discusses onboarding at length');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT d.path FROM frontmatter d JOIN content ON content.path = d.path WHERE d.status = ? AND content MATCH ? ORDER BY ${WEIGHTED}`)).all('active', 'onboarding')) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['active.md']
    );
  });

  it('weighted bm25 ranks a title hit above a body-only mention', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'passing.md', { title: 'Something else' }, 'A long note that mentions equity once in passing among many other words.');
    write(baseDir, 'titled.md', { title: 'Equity' }, 'A long note about a different subject entirely, of comparable length overall.');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT content.path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED}`)).all('equity')) as Array<{ path: string }>;
    assert.equal(rows[0].path, 'titled.md');
  });

  it('summary is both a frontmatter column and a ranking field', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A', summary: 'about negotiating offers' }, 'unrelated prose');

    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare('SELECT summary FROM frontmatter WHERE path = ?')).get('a.md')) as { summary: string };
    assert.equal(row.summary, 'about negotiating offers');

    const hits = (await (await store.prepare('SELECT path FROM content WHERE content MATCH ?')).all('summary: offers')) as Array<{ path: string }>;
    assert.deepEqual(
      hits.map((r) => r.path),
      ['a.md']
    );
  });

  it('porter stemming matches inflected forms', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'Negotiating below the floor is a hard exclusion.');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT path FROM content WHERE content MATCH ?')).all('negotiate')) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
  });

  it('snippets are single-line so they cannot break the table renderer', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'First line about widgets.\n\nSecond line.\n\n- a list item\n- another');

    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare(`SELECT snippet(content, -1, '', '', '…', 20) AS hit FROM content WHERE content MATCH ?`)).get('widgets')) as { hit: string };
    assert.ok(!row.hit.includes('\n'), `snippet contained a newline: ${JSON.stringify(row.hit)}`);
  });

  it('prose is not reachable from SELECT * on frontmatter', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'SECRETLONGBODYTEXT that must not appear in a frontmatter row');

    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare('SELECT * FROM frontmatter')).get()) as Record<string, unknown>;
    assert.ok(!JSON.stringify(row).includes('SECRETLONGBODYTEXT'), 'SELECT * FROM frontmatter leaked file content');
  });

  it('a frontmatter key named `content` is dropped with a warning; `body` stays an ordinary column', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A', content: 'should be ignored', body: 'an ordinary value' }, 'prose');

    const result = await openTree(baseDir);
    assert.ok(
      result.warnings.some((w) => w.includes('a.md') && w.includes('content')),
      'expected a warning about the reserved `content` frontmatter key'
    );
    const cols = (await (await result.store.prepare('PRAGMA table_info(frontmatter)')).all()) as Array<{ name: string }>;
    assert.ok(!cols.some((c) => c.name === 'content'), '`content` must not become a frontmatter column');
    const row = (await (await result.store.prepare('SELECT body FROM frontmatter WHERE path = ?')).get('a.md')) as { body: string };
    assert.equal(row.body, 'an ordinary value');
  });

  it('markdown syntax is stripped from the index; the text it wrapped is still searchable', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, '# Heading\n\n**Margin** matters, per [[pricing-model|the model]].\n\n| Col | Filter |\n|-----|--------|\n| D | `Remote` only |');

    const { store } = await openTree(baseDir);
    const { text } = (await (await store.prepare('SELECT text FROM content')).get()) as { text: string };
    for (const noise of ['**', '[[', ']]', '|', '#', '`']) {
      assert.ok(!text.includes(noise), `indexed text still contains "${noise}": ${JSON.stringify(text)}`);
    }
    for (const term of ['model', 'Remote', 'Margin']) {
      const n = ((await (await store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get(term)) as { n: number }).n;
      assert.equal(n, 1, `expected "${term}" to be searchable`);
    }
  });

  it('footnote definition text is indexed and searchable; the ref markers are not', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'A claim[^1] and another[^note].\n\n[^1]: gazelles graze at dawn\n[^note]: herons hunt at dusk');

    const { store } = await openTree(baseDir);
    const { text } = (await (await store.prepare('SELECT text FROM content')).get()) as { text: string };
    assert.ok(!text.includes('[^'), `ref markers survive in: ${JSON.stringify(text)}`);
    for (const term of ['gazelles', 'herons', 'claim']) {
      const n = ((await (await store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get(term)) as { n: number }).n;
      assert.equal(n, 1, `expected "${term}" to be searchable`);
    }
  });

  it('the canonical query works on a tree with no title or summary keys anywhere', async () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'bare.md'), '---\n---\n\nProse mentioning gazelles.\n');

    const { store } = await openTree(baseDir);
    const rows = (await (
      await store.prepare(
        `SELECT d.path, content.title, content.summary, snippet(content, -1, '«', '»', '…', 10) AS hit
         FROM frontmatter d JOIN content ON content.path = d.path
         WHERE content MATCH ? ORDER BY ${WEIGHTED} LIMIT 10`
      )
    ).all('gazelles')) as Array<{ path: string; title: string; summary: string; hit: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'bare.md');
    assert.equal(rows[0].title, '');
    assert.equal(rows[0].summary, '');
    assert.ok(rows[0].hit.includes('«gazelles»'));
  });

  it('edits and deletions stay in sync with the search index', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'original zebra content');

    const first = await openTree(baseDir);
    assert.equal(((await (await first.store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get('zebra')) as { n: number }).n, 1);
    await first.store.close();

    write(baseDir, 'a.md', { title: 'A' }, 'replaced walrus content entirely, a different length');
    const second = await openTree(baseDir);
    assert.equal(((await (await second.store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get('zebra')) as { n: number }).n, 0);
    assert.equal(((await (await second.store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get('walrus')) as { n: number }).n, 1);
    assert.equal(((await (await second.store.prepare('SELECT count(*) AS n FROM content')).get()) as { n: number }).n, 1);
    await second.store.close();

    rmSync(join(baseDir, 'a.md'));
    const third = await openTree(baseDir);
    assert.equal(((await (await third.store.prepare('SELECT count(*) AS n FROM content')).get()) as { n: number }).n, 0);
  });

  it('a cache from an older schema is rebuilt rather than left half-empty', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', { title: 'A' }, 'searchable llama content');

    const first = await openTree(baseDir);
    await (await first.store.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`)).run();
    await first.store.exec('DROP TABLE content');
    await first.store.close();

    const second = await openTree(baseDir);
    assert.equal(second.parsed, 1);
    assert.equal(((await (await second.store.prepare('SELECT count(*) AS n FROM content WHERE content MATCH ?')).get('llama')) as { n: number }).n, 1);
  });
});

describe('search explanation', () => {
  it('reports exact first and second word contributions with unchanged default rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'needle' });
    writeNote(baseDir, 'b.md', { body: 'needle' });
    await forEachStore(async (name) =>
      withTreeForStore(
        name,
        baseDir,
        async ({ store, cfg }) => {
          const ordinary = await search(store, cfg, 'needle');
          const disabled = await search(store, cfg, 'needle', { explain: false });
          const explained = await search(store, cfg, 'needle', { explain: true });
          assert.deepEqual(disabled, ordinary);
          assert.equal(JSON.stringify(disabled), JSON.stringify(ordinary));
          assert.deepEqual(
            ordinary.map((row) => row.path),
            ['a.md', 'b.md']
          );
          assert.deepEqual(
            explained.map(({ explanation, ...row }) => row),
            ordinary
          );
          assert.deepEqual(
            explained.map((row) => row.explanation),
            [[{ signal: 'words', rank: 1, weight: 2, contribution: 2 / 60 }], [{ signal: 'words', rank: 2, weight: 2, contribution: 2 / 61 }]]
          );
          assert.ok(ordinary.every((row) => !Object.hasOwn(row, 'explanation')));
          assert.deepEqual(Object.keys(explained[0]), [...Object.keys(ordinary[0]), 'explanation']);
          assert.deepEqual(await search(store, cfg, 'missing', { explain: true }), []);
        },
        { presets: { default: { include: ['**/*.md'], signals: { words: 2 } } } }
      )
    );
  });

  it('reports all fused contributions even when link restart mass leaves via without a link label', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'seed.md', { frontmatter: { status: 'active' }, body: 'apple' });
    writeNote(baseDir, 'other.md', { body: 'stone [[leaf]]' });
    writeNote(baseDir, 'leaf.md', { body: 'stone' });
    const model = writeModel();
    await forEachStore(async (name) =>
      withTreeForStore(
        name,
        baseDir,
        async ({ store, cfg }) => {
          const options = { include: ['seed.md'], where: "f.status = 'active'", snippetCharLimit: 20, snippetCountLimit: 2 };
          const ordinary = await search(store, cfg, 'apple', options);
          const explained = await search(store, cfg, 'apple', { ...options, explain: true });
          assert.deepEqual(
            explained.map(({ explanation, ...row }) => row),
            ordinary
          );
          assert.deepEqual(
            explained.map((row) => row.path),
            ['seed.md']
          );
          assert.equal(explained[0].via, 'match+vector');
          assert.deepEqual(explained[0].explanation, [
            { signal: 'words', rank: 1, weight: 2, contribution: 2 / 60 },
            { signal: 'links', rank: 1, weight: 3, contribution: 3 / 60 },
            { signal: 'vectors', rank: 1, weight: 4, contribution: 4 / 60 },
          ]);
          assert.equal(explained[0].score, 0.15);
          assert.equal(explained[0].snippets.length, 1);
          assert.ok(explained[0].snippets[0].includes('«apple»'));
        },
        { presets: { default: { include: ['**/*.md'], signals: { words: 2, links: 3, vectors: 4 } } }, embed: { provider: 'static', model } }
      )
    );
  });

  it('reports a link-only candidate and vector-only ranks from authored geometry', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'seed.md', { body: 'needle [[leaf]]' });
    writeNote(baseDir, 'leaf.md', { body: 'bird' });
    await forEachStore(async (name) =>
      withTreeForStore(
        name,
        baseDir,
        async ({ store, cfg }) => {
          const ordinary = await search(store, cfg, 'needle');
          const explained = await search(store, cfg, 'needle', { explain: true });
          assert.deepEqual(
            explained.map(({ explanation, ...row }) => row),
            ordinary
          );
          assert.deepEqual(
            explained.map((row) => row.path),
            ['seed.md', 'leaf.md']
          );
          assert.equal(explained[1].via, 'link');
          assert.deepEqual(explained[1].explanation, [{ signal: 'links', rank: 2, weight: 3, contribution: 3 / 61 }]);
        },
        { presets: { default: { include: ['**/*.md'], signals: { words: 2, links: 3 } } } }
      )
    );

    const vectorDir = tmpTree();
    writeNote(vectorDir, 'a.md', { body: 'apple' });
    writeNote(vectorDir, 'b.md', { body: 'apple stone' });
    const model = writeModel();
    await forEachStore(async (name) =>
      withTreeForStore(
        name,
        vectorDir,
        async ({ store, cfg }) => {
          const ordinary = await search(store, cfg, 'pomme');
          const explained = await search(store, cfg, 'pomme', { explain: true });
          assert.deepEqual(
            explained.map(({ explanation, ...row }) => row),
            ordinary
          );
          assert.deepEqual(
            explained.map((row) => row.path),
            ['a.md', 'b.md']
          );
          assert.deepEqual(
            explained.map((row) => row.explanation),
            [[{ signal: 'vectors', rank: 1, weight: 4, contribution: 4 / 60 }], [{ signal: 'vectors', rank: 2, weight: 4, contribution: 4 / 61 }]]
          );
        },
        { presets: { default: { include: ['**/*.md'], signals: { vectors: 4 } } }, embed: { provider: 'static', model } }
      )
    );
  });

  it('explains the retained indexed generation after authored source changes', async () => {
    await forEachStore(async (name) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'seed.md', { body: 'needle' });
      await withTreeForStore(
        name,
        baseDir,
        async ({ store, cfg }) => {
          const ordinary = await search(store, cfg, 'needle');
          writeNote(baseDir, 'seed.md', { body: 'new live source' });
          const explained = await search(store, cfg, 'needle', { explain: true });
          assert.deepEqual(
            explained.map(({ explanation, ...row }) => row),
            ordinary
          );
          assert.deepEqual(explained[0].explanation, [{ signal: 'words', rank: 1, weight: 2, contribution: 2 / 60 }]);
          assert.equal(explained[0].snippets.length, 1);
          assert.ok(explained[0].snippets[0].includes('«needle»'));
          assert.ok(!explained[0].snippets[0].includes('new live source'));
        },
        { presets: { default: { include: ['**/*.md'], signals: { words: 2 } } } }
      );
    });
  });

  it('keeps JSON structured and renders JSON-text explanation cells through the existing CLI formats', async () => {
    await forEachStore(async (name) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'seed.md', { body: 'needle' });
      const configPath = join(baseDir, 'sense.config.json');
      writeFileSync(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store: name, presets: { default: { include: ['*.md'], signals: { words: 2 } } }, queries: {} }));
      const run = (format: string, explain: boolean) => runCli(['search', 'needle', '--config', configPath, '--format', format, ...(explain ? ['--explain'] : [])]);
      const expected: SearchSignalContribution[] = [{ signal: 'words', rank: 1, weight: 2, contribution: 2 / 60 }];
      const ordinary = run('json', false);
      const explained = run('json', true);
      assert.equal(ordinary.status, 0, ordinary.stderr);
      assert.equal(explained.status, 0, explained.stderr);
      const rows = JSON.parse(explained.stdout);
      assert.deepEqual(rows[0].explanation, expected);
      assert.deepEqual(
        rows.map(({ explanation, ...row }: { explanation: unknown; [key: string]: unknown }) => row),
        JSON.parse(ordinary.stdout)
      );
      for (const format of ['table', 'csv']) {
        const first = run(format, false);
        const repeat = run(format, false);
        const result = run(format, true);
        assert.equal(first.status, 0, first.stderr);
        assert.equal(repeat.status, 0, repeat.stderr);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(repeat.stdout, first.stdout);
        assert.doesNotMatch(first.stdout, /explanation/);
        assert.match(result.stdout, /explanation/);
        assert.ok(result.stdout.includes(format === 'csv' ? JSON.stringify(expected).replace(/"/g, '""') : JSON.stringify(expected)), result.stdout);
        assert.doesNotMatch(result.stdout, /\[object Object\]/);
      }
      const help = runCli(['search', '--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--explain/);
      const foreign = runCli(['sql', '--explain', '--config', configPath]);
      assert.equal(foreign.status, 2, foreign.stderr);
    });
  });
});
