import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapTree, peek, search } from 'sensemaking';
import { writeModel } from '../lib/model.ts';
import { forEachStore, forEachStoreByCapability, STORE_NAMES, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

function scopeTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'high.md', { frontmatter: { status: 'active' }, body: 'needle needle needle' });
  writeNote(baseDir, 'low.md', { frontmatter: { status: 'lower' }, body: 'needle' });
  writeNote(baseDir, 'excluded/hidden.md', { frontmatter: { status: 'active' }, body: 'needle' });
  writeNote(baseDir, 'other.md', { frontmatter: { status: 'other' }, body: 'unrelated' });
  return baseDir;
}

function linkedTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'source.md', { body: 'needle source [[target]]' });
  writeNote(baseDir, 'target.md', { body: 'target only' });
  return baseDir;
}

describe('scope resolution and filtering', () => {
  it('applies include, explicit exclude, no-exclude, empty include, and where before k on every store', async () => {
    await forEachStore(async (store) => {
      const baseDir = scopeTree();
      await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          const normal = await search(opened, cfg, 'needle', { k: 10 });
          assert.deepEqual(normal.map((row) => row.path).sort(), ['high.md', 'low.md'], `${store}: preset exclude must apply`);
          const widened = await search(opened, cfg, 'needle', { noExclude: true, k: 10 });
          assert.deepEqual(widened.map((row) => row.path).sort(), ['excluded/hidden.md', 'high.md', 'low.md'], `${store}: no-exclude must clear the preset exclusion`);
          const explicit = await search(opened, cfg, 'needle', { noExclude: true, exclude: ['excluded/**'], k: 10 });
          assert.deepEqual(explicit.map((row) => row.path).sort(), ['high.md', 'low.md'], `${store}: explicit exclude must still apply with no-exclude`);
          const included = await search(opened, cfg, 'needle', { include: ['high.md'] });
          assert.deepEqual(
            included.map((row) => row.path),
            ['high.md'],
            `${store}: nonempty include must select its authored path`
          );
          assert.deepEqual(await search(opened, cfg, 'needle', { include: [] }), [], `${store}: empty include must be an empty ad-hoc scope`);
          const lower = await search(opened, cfg, 'needle', { where: "f.status = 'lower'", k: 1 });
          assert.deepEqual(
            lower.map((row) => row.path),
            ['low.md'],
            `${store}: where must filter before k`
          );
        },
        { presets: { default: { include: ['**/*.md'], exclude: ['excluded/**'] }, all: { include: ['**/*.md'] } } }
      );
    });
  });
});

describe('feature toggles expose separate documented effects', () => {
  it('links false removes link-derived search results while the enabled control returns one', async () => {
    await forEachStore(async (store) => {
      const baseDir = linkedTree();
      await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
        const enabled = await search(opened, cfg, 'needle');
        assert.ok(
          enabled.some((row) => row.path === 'target.md' && row.via === 'link'),
          `${store}: enabled control must return the linked target`
        );
      });
      await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          const disabled = await search(opened, cfg, 'needle');
          assert.deepEqual(
            disabled.map((row) => row.path),
            ['source.md'],
            `${store}: links=false must keep only the lexical source`
          );
        },
        { features: { links: false } }
      );
    });
  });

  it('rank false removes map hubs while the enabled control reports them', async () => {
    await forEachStore(async (store) => {
      const baseDir = linkedTree();
      await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
        const enabled = await mapTree(opened, cfg);
        assert.ok(enabled.hubs.length > 0, `${store}: enabled rank control must report a hub`);
      });
      await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          const disabled = await mapTree(opened, cfg);
          assert.deepEqual(disabled.hubs, [], `${store}: rank=false must remove map hubs`);
        },
        { features: { rank: false } }
      );
    });
  });

  it('sections false omits peek sections while the enabled control returns them', async () => {
    await forEachStore(async (store) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'headed.md', { body: '# Heading\n\nbody' });
      await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
        const enabled = await peek(opened, cfg, 'headed.md');
        assert.ok(enabled.sections.length > 0, `${store}: enabled sections control must return headings`);
      });
      await withTreeForStore(
        store,
        baseDir,
        async ({ store: opened, cfg }) => {
          const disabled = await peek(opened, cfg, 'headed.md');
          assert.deepEqual(disabled.sections, [], `${store}: sections=false must omit headings`);
          assert.ok(disabled.off.includes('sections'), `${store}: sections=false must be reported`);
        },
        { features: { sections: false } }
      );
    });
  });

  it('a real configured model is used only when vectors are declared', async () => {
    await forEachStoreByCapability(
      'vectors',
      async (store) => {
        const baseDir = tmpTree();
        writeNote(baseDir, 'apple.md', { body: 'apple fruit' });
        writeNote(baseDir, 'stone.md', { body: 'stone fruit' });
        const embed = { model: writeModel(), provider: 'static' as const };
        await withTreeForStore(
          store,
          baseDir,
          async ({ store: opened, cfg }) => {
            const vectorRows = await search(opened, cfg, 'pomme');
            assert.equal(vectorRows[0]?.path, 'apple.md', `${store}: vectors-enabled control must return the semantic match`);
            assert.ok(
              vectorRows.some((row) => typeof row.via === 'string' && row.via.includes('vector')),
              `${store}: vectors-enabled control must expose vector provenance`
            );
          },
          { embed }
        );
        await withTreeForStore(
          store,
          baseDir,
          async ({ store: opened, cfg }) => {
            const lexicalOnly = await search(opened, cfg, 'pomme');
            assert.deepEqual(lexicalOnly, [], `${store}: vectors omitted must not fall back to the model`);
          },
          { embed, presets: { default: { include: ['**/*.md'], signals: { words: 1 } } } }
        );
      },
      (store) => assert.fail(`${store}: vectors capability is required by this real-model control`)
    );
  });
});

const multilingualCases = [
  ['Han', '数据库全文搜索很有用', '全文', '全。文'],
  ['Hiragana', 'はとがいます', 'とが', 'と。が'],
  ['Katakana', 'データベース全文検索は便利です', 'データ', 'デー。タ'],
  ['Thai', 'การค้นหาข้อความแบบเต็ม', 'ค้นหา', 'ค้น。หา'],
  ['Khmer', 'សួស្តីពិភពលោក', 'ពិភព', 'ពិ។ភព'],
  ['Lao', 'ສະບາຍດີໂລກ', 'ໂລກ', 'ໂລ。ກ'],
  ['Myanmar', 'မင်္ဂလာပါကမ္ဘာ', 'ကမ္ဘာ', 'ကမ္။ဘာ'],
] as const;

describe('documented multilingual substring and marker contract', () => {
  for (const store of STORE_NAMES) {
    for (const [script, body, query, separated] of multilingualCases) {
      it(`${store}: ${script}`, async () => {
        const tree = tmpTree();
        const notes = [
          ['match.md', [`# ${script}`, `prefix ${body} suffix`, '## Tail', 'tail'].join('\n')],
          ['barrier.md', ['# Barrier', separated].join('\n')],
        ] as const;
        for (const [path, text] of notes) writeFileSync(join(tree, path), `${text}\n`);
        const expected = notes.filter(([, text]) => text.includes(query)).map(([path]) => path);
        await withTreeForStore(store, tree, async ({ store: opened, cfg }) => {
          const rows = (await search(opened, cfg, query)) as Array<{ path: string; snippets: string[]; lines: string | null }>;
          assert.deepEqual(rows.map((row) => row.path).sort(), expected, `${script}: expected literal substring paths`);
          for (const row of rows)
            assert.ok(
              row.snippets.some((snippet) => snippet.includes(`«${query}»`)),
              `${script}: ${JSON.stringify(row.snippets)}`
            );
          assert.equal(rows[0]?.lines, 'L1-2', `${script}: matched snippet must point to its authored section`);
        });
      });
    }
  }
});
