import assert from 'assert';
import { featureSignature } from '../../../src/config/index.ts';
import { FEATURES } from '../../../src/features/index.ts';
import { classifyFeatureToggles, isFeatureOnlyChange } from '../../../src/store/feature-scope.ts';

describe('isFeatureOnlyChange', () => {
  it('true when every changed key is a narrow-supported feature segment', () => {
    assert.equal(isFeatureOnlyChange(new Set(['feature:tags'])), true);
    assert.equal(isFeatureOnlyChange(new Set(['feature:tags', 'feature:sections'])), true);
  });

  it('false when any changed key is not a narrow-supported feature segment', () => {
    assert.equal(isFeatureOnlyChange(new Set(['feature:tags', 'preset:default'])), false);
    assert.equal(isFeatureOnlyChange(new Set(['tokenize'])), false);
    assert.equal(isFeatureOnlyChange(new Set(['embed'])), false);
  });

  it('true for links and rank, alone or paired: links co-changes rank (via featureEnabled), and both are narrow-supported', () => {
    assert.equal(isFeatureOnlyChange(new Set(['feature:links'])), true);
    assert.equal(isFeatureOnlyChange(new Set(['feature:rank'])), true);
    assert.equal(isFeatureOnlyChange(new Set(['feature:links', 'feature:rank'])), true);
  });

  it('false for an empty set (no mismatch to route anywhere)', () => {
    assert.equal(isFeatureOnlyChange(new Set()), false);
  });
});

describe('classifyFeatureToggles', () => {
  it('tags toggled off is recognised as turnedOn: false', () => {
    const before = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    const after = featureSignature({ presets: { default: { include: ['*.md'] } }, features: { tags: false }, queries: {} }, FEATURES);
    assert.notEqual(before, after);
    const toggles = classifyFeatureToggles(before, after, new Set(['feature:tags']));
    assert.deepEqual(toggles, [{ name: 'tags', turnedOn: false }]);
  });

  it('tags toggled back on is recognised as turnedOn: true', () => {
    const off = featureSignature({ presets: { default: { include: ['*.md'] } }, features: { tags: false }, queries: {} }, FEATURES);
    const on = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    const toggles = classifyFeatureToggles(off, on, new Set(['feature:tags']));
    assert.deepEqual(toggles, [{ name: 'tags', turnedOn: true }]);
  });

  it('two features toggling at once each get their own entry', () => {
    const before = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    const after = featureSignature({ presets: { default: { include: ['*.md'] } }, features: { tags: false, sections: false }, queries: {} }, FEATURES);
    const toggles = classifyFeatureToggles(before, after, new Set(['feature:tags', 'feature:sections']));
    assert.deepEqual(
      (toggles ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'sections', turnedOn: false },
        { name: 'tags', turnedOn: false },
      ]
    );
  });

  it('an unparseable stored segment refuses to guess and returns null', () => {
    const after = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    // Missing the on/off field a real featureSignature() always writes.
    const malformed = 'feature:tags';
    assert.equal(classifyFeatureToggles(malformed, after, new Set(['feature:tags'])), null);
  });

  it('rank toggled off alone (links stays on) is recognised as turnedOn: false', () => {
    const before = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    const after = featureSignature({ presets: { default: { include: ['*.md'] } }, features: { rank: false }, queries: {} }, FEATURES);
    const toggles = classifyFeatureToggles(before, after, new Set(['feature:rank']));
    assert.deepEqual(toggles, [{ name: 'rank', turnedOn: false }]);
  });

  it('links toggled off co-changes rank, both surfacing as turnedOn: false', () => {
    const before = featureSignature({ presets: { default: { include: ['*.md'] } }, queries: {} }, FEATURES);
    const after = featureSignature({ presets: { default: { include: ['*.md'] } }, features: { links: false }, queries: {} }, FEATURES);
    const toggles = classifyFeatureToggles(before, after, new Set(['feature:links', 'feature:rank']));
    assert.deepEqual(
      (toggles ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'links', turnedOn: false },
        { name: 'rank', turnedOn: false },
      ]
    );
  });
});
