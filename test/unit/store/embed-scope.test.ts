import assert from 'node:assert';
import { CHUNK_VERSION } from '../../../src/chunk/index.ts';
import { featureSignature } from '../../../src/config/index.ts';
import { FEATURES } from '../../../src/features/index.ts';
import { classifyEmbedChange } from '../../../src/store/embed-scope.ts';
import { embeddingSignatureCompatible, embedIdentityAdopted } from '../../../src/store/signature.ts';

const base = { presets: { default: { include: ['*.md'] } }, queries: {} };

function signature(provider: 'static' | 'openai' | 'cohere', model: string, url?: string): string {
  return featureSignature({ ...base, embed: { provider, model, url } }, FEATURES);
}

describe('embedding signature changes', () => {
  const unresolved = `feature:tags:on|embed:static:authored-model:${CHUNK_VERSION}|preset:default:authored-scope`;
  const adopted = `feature:tags:on|embed:static:authored-model:${CHUNK_VERSION}@authored-weight-identity|preset:default:authored-scope`;

  it('accepts an exact captured signature', () => {
    assert.equal(embeddingSignatureCompatible(unresolved, unresolved), true);
  });

  it('accepts only the authored static weight-identity adoption', () => {
    assert.equal(embeddingSignatureCompatible(unresolved, adopted), true);
  });

  it('rejects weight-identity adoption combined with a feature change', () => {
    assert.equal(embeddingSignatureCompatible(unresolved, adopted.replace('feature:tags:on', 'feature:tags:off')), false);
  });

  it('rejects weight-identity adoption combined with a preset change', () => {
    assert.equal(embeddingSignatureCompatible(unresolved, adopted.replace('preset:default:authored-scope', 'preset:default:different-scope')), false);
  });

  it('classifies an endpoint-only change as vector invalidation', () => {
    const before = signature('openai', 'same-model', 'http://localhost:11434/v1');
    const after = signature('openai', 'same-model', 'http://localhost:1234/v1');
    assert.equal(classifyEmbedChange(before, after), 'model');
  });

  it('keeps equivalent effective endpoints reusable', () => {
    const before = signature('openai', 'same-model', 'http://localhost:11434/v1');
    const after = signature('openai', 'same-model', 'http://localhost:11434/v1/');
    assert.equal(classifyEmbedChange(before, after), null);
  });

  it('invalidates a legacy HTTP signature with unknown endpoint identity once', () => {
    const current = signature('openai', 'same-model', 'http://localhost:11434/v1');
    const legacy = current
      .split('|')
      .map((part) => (part.startsWith('embed:') ? `embed:openai:same-model:${CHUNK_VERSION}` : part))
      .join('|');
    assert.equal(classifyEmbedChange(legacy, current), 'model');
    assert.equal(embedIdentityAdopted(legacy, current), false);
  });

  it('keeps signature delimiters and URL credentials out of persisted endpoint identity', () => {
    const before = signature('openai', 'same-model', 'https://user:secret@example.test/a|b:c@d?x=1|2');
    const after = signature('openai', 'same-model', 'https://user:secret@example.test/a|b:c@d?x=1|3');
    const embedPart = before.split('|').find((part) => part.startsWith('embed:'));
    assert.match(embedPart ?? '', /:endpoint=[0-9a-f]{64}:chunk:v\d+/);
    assert.doesNotMatch(before, /user|secret|example\.test|a\|b/);
    assert.equal(classifyEmbedChange(before, after), 'model');
  });
});
