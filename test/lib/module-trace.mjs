import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// `--import` preload for tracing real ESM specifier resolution around a child `node` process.
// Runs synchronously on the main thread (module.registerHooks, not the deprecated worker-thread
// module.register), so it needs no separate hook file. Matches on the RESOLVED url rather than
// the raw specifier text, because the same module is reached through relative specifiers of
// different depth depending on the importer (e.g. '../embed/registry.js' vs './registry.js').
//
// Watches the modules that make the semantic path heavy: the two npm dependencies
// (src/embed/static.ts, src/embed/langfit.ts) plus the embed provider subtree that pulls them
// in (registry/static/query/langfit/cohere/openai) -- never the light embed helpers
// (distribution/identity/languages/http/store) that status/download legitimately import.
// See test/integration/lazy-embed-deps.test.ts and BENCHMARKING.md's "heavy import" note.
const traceFile = process.env.SENSE_TEST_TRACE_FILE;
const WATCHED_PACKAGES = ['@huggingface/tokenizers', 'franc-min'];
const WATCHED_EMBED_MODULES = /\/embed\/(static|registry|query|langfit|cohere|openai)\.(js|ts)$/;

function isWatched(specifier, url) {
  if (WATCHED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) return true;
  return typeof url === 'string' && WATCHED_EMBED_MODULES.test(url);
}

if (traceFile) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (isWatched(specifier, result?.url)) appendFileSync(traceFile, `${specifier}\n`);
      return result;
    },
  });
}
