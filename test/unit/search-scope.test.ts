import assert from 'node:assert';
import { search } from 'sensemaking';
import { writeModel } from '../lib/model.ts';
import { openConfig, tmpTree, writeNote } from '../lib/tree.ts';

describe('scoped search does not starve on a truncated global pool', () => {
  it('narrow scope: 200 decoys fill the tie-order pool, the one in-scope match still surfaces via vector', async () => {
    const baseDir = tmpTree();
    // 'decoys/' sorts before 'plugins/', so a tie-order rescue is impossible: the target
    // never lands in the global top-fetch even by insertion order.
    for (let i = 0; i < 200; i++) writeNote(baseDir, `decoys/decoy${String(i).padStart(3, '0')}.md`, { frontmatter: { title: 'Decoy' }, body: 'An apple every day' });
    writeNote(baseDir, 'plugins/target.md', { frontmatter: { title: 'Target' }, body: 'An apple every day' });

    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'] } },
      embed: { model: writeModel(), type: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });
    // 'zzzznonexistent' kills every lexical row (FTS5 ANDs bare terms), forcing the vector
    // path to be the only signal, and it drops from the mean pool as an unknown token.
    const rows = (await search(db, cfg, 'apple zzzznonexistent', { k: 8, include: ['plugins/**'] })) as Array<{ path: string }>;
    db.close();
    assert.ok(
      rows.some((r) => r.path === 'plugins/target.md'),
      JSON.stringify(rows)
    );
  });

  it('large scope (40% of the tree): out-of-scope notes outrank in-scope notes on BM25, scoped search still finds the in-scope matches', async () => {
    const baseDir = tmpTree();
    // Out-of-scope paths sort first, so alphabetical/insertion tie-break cannot rescue the
    // in-scope notes either; the displacement here is a real BM25 gap, not a tie.
    for (let i = 0; i < 60; i++) writeNote(baseDir, `decoy${String(i).padStart(3, '0')}.md`, { frontmatter: { title: 'Decoy' }, body: 'gizmo '.repeat(30) });
    for (let i = 0; i < 40; i++)
      writeNote(baseDir, `plugins/target${String(i).padStart(3, '0')}.md`, {
        frontmatter: { title: 'Target' },
        body: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega gizmo',
      });

    const { db, cfg } = openConfig({ presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null });
    const rows = (await search(db, cfg, 'gizmo', { k: 5, include: ['plugins/**'] })) as Array<{ path: string }>;
    db.close();
    assert.equal(rows.length, 5, JSON.stringify(rows));
    assert.ok(
      rows.every((r) => r.path.startsWith('plugins/')),
      JSON.stringify(rows)
    );
  });

  it('--where narrows the vector pool before truncation: decoys with the wrong status do not starve it', async () => {
    const baseDir = tmpTree();
    // 'decoy' sorts before 'target', so tie-order cannot rescue the active notes either.
    for (let i = 0; i < 40; i++) writeNote(baseDir, `decoy${String(i).padStart(3, '0')}.md`, { frontmatter: { title: 'Decoy', status: 'other' }, body: 'An apple every day' });
    for (let i = 0; i < 3; i++) writeNote(baseDir, `target${String(i).padStart(3, '0')}.md`, { frontmatter: { title: 'Target', status: 'active' }, body: 'An apple every day' });

    const { db, cfg } = openConfig({
      presets: { default: { include: ['**/*.md'] } },
      embed: { model: writeModel(), type: 'static' },
      queries: {},
      baseDir,
      configPath: null,
    });
    const rows = (await search(db, cfg, 'pomme', { k: 8, where: "f.status = 'active'" })) as Array<{ path: string }>;
    db.close();
    assert.equal(rows.length, 3, JSON.stringify(rows));
    assert.ok(
      rows.every((r) => r.path.startsWith('target')),
      JSON.stringify(rows)
    );
  });
});
