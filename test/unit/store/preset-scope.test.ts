import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { featureSignature } from '../../../src/config/index.ts';
import { FEATURES } from '../../../src/features/index.ts';
import { forcedPresetPaths, isPresetOnlyChange } from '../../../src/store/preset-scope.ts';
import { scratchDir } from '../../lib/scratch.ts';

function writeFiles(baseDir: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    mkdirSync(join(baseDir, rel, '..'), { recursive: true });
    writeFileSync(join(baseDir, rel), 'body\n');
  }
}

describe('isPresetOnlyChange', () => {
  it('true when every changed key is a preset segment', () => {
    assert.equal(isPresetOnlyChange(new Set(['preset:default'])), true);
    assert.equal(isPresetOnlyChange(new Set(['preset:a', 'preset:b'])), true);
  });

  it('false when any changed key is not a preset segment', () => {
    assert.equal(isPresetOnlyChange(new Set(['preset:default', 'tokenize'])), false);
    assert.equal(isPresetOnlyChange(new Set(['embed'])), false);
  });

  it('false for an empty set (no mismatch to route anywhere)', () => {
    assert.equal(isPresetOnlyChange(new Set()), false);
  });
});

describe('forcedPresetPaths', () => {
  it('a glob narrowed on one preset forces only the files it drops, not the whole preset', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['keep.md', 'drop.md']);
    const before = { presets: { default: { include: ['*.md'] } }, queries: {} };
    const after = { presets: { default: { include: ['*.md'], exclude: ['drop.md'] } }, queries: {} };
    const beforeSig = featureSignature(before, FEATURES);
    const afterSig = featureSignature(after, FEATURES);
    const changedKeys = new Set(['preset:default']);
    assert.notEqual(beforeSig, afterSig);

    const forced = forcedPresetPaths(after, baseDir, beforeSig, changedKeys);
    assert.ok(forced !== null);
    assert.deepEqual([...(forced as Set<string>)].sort(), ['drop.md']);
  });

  it('a file gaining coverage from a widened preset is forced too', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['a.md', 'b.md']);
    const before = { presets: { default: { include: ['a.md'] } }, queries: {} };
    const after = { presets: { default: { include: ['*.md'] } }, queries: {} };
    const beforeSig = featureSignature(before, FEATURES);
    const forced = forcedPresetPaths(after, baseDir, beforeSig, new Set(['preset:default']));
    assert.deepEqual([...(forced as Set<string>)].sort(), ['b.md']);
  });

  it('an on/off-only change (glob unchanged) forces the whole preset, since its vote in the embed union moved', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['a.md', 'b.md']);
    const before = { presets: { default: { include: ['*.md'], signals: { words: 1, vectors: 1 } } }, embed: { model: '/nonexistent' }, queries: {} };
    const after = { presets: { default: { include: ['*.md'], signals: { words: 1 } } }, embed: { model: '/nonexistent' }, queries: {} };
    const beforeSig = featureSignature(before, FEATURES);
    const afterSig = featureSignature(after, FEATURES);
    assert.notEqual(beforeSig, afterSig);
    const forced = forcedPresetPaths(after, baseDir, beforeSig, new Set(['preset:default']));
    assert.deepEqual([...(forced as Set<string>)].sort(), ['a.md', 'b.md']);
  });

  it('a brand-new preset (absent from the old signature) forces exactly the files it newly covers', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['a.md', 'b.md']);
    const before = { presets: { default: { include: ['a.md'] } }, queries: {} };
    const after = { presets: { default: { include: ['a.md'] }, extra: { include: ['b.md'] } }, queries: {} };
    const beforeSig = featureSignature(before, FEATURES);
    const forced = forcedPresetPaths(after, baseDir, beforeSig, new Set(['preset:extra']));
    assert.deepEqual([...(forced as Set<string>)].sort(), ['b.md']);
  });

  it('a removed preset forces the files only it used to cover', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['a.md', 'b.md']);
    const before = { presets: { default: { include: ['a.md'] }, extra: { include: ['b.md'] } }, queries: {} };
    const after = { presets: { default: { include: ['a.md'] } }, queries: {} };
    const beforeSig = featureSignature(before, FEATURES);
    const forced = forcedPresetPaths(after, baseDir, beforeSig, new Set(['preset:extra']));
    assert.deepEqual([...(forced as Set<string>)].sort(), ['b.md']);
  });

  it('an unparseable stored segment refuses to guess and returns null', () => {
    const baseDir = scratchDir('preset-scope');
    writeFiles(baseDir, ['a.md']);
    const after = { presets: { default: { include: ['*.md'] } }, queries: {} };
    // Missing the exclude and on/off fields a real featureSignature() always writes.
    const malformed = 'preset:default:a.md';
    assert.equal(forcedPresetPaths(after, baseDir, malformed, new Set(['preset:default'])), null);
  });
});
