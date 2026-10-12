#!/usr/bin/env node

const ERROR_CODE = 4;

// exitCode (not exit()) lets Node flush queued stdout writes from the streaming sql path before
// exiting; the unref'd timer only force-exits if a stray handle would otherwise hang the process.
function handleError(err) {
  console.error(err);
  process.exitCode = ERROR_CODE;
  setTimeout(() => process.exit(ERROR_CODE), 2000).unref();
}

// biome-ignore lint/security/noGlobalEval: dual esm and cjs
if (typeof require === 'undefined') eval("import('../dist/esm/cli.js').then((cli) => cli.default(process.argv.slice(2), 'sense')).catch(handleError);");
else {
  try {
    require('../dist/cjs/cli.js')(process.argv.slice(2), 'sense').catch(handleError);
  } catch (err) {
    handleError(err);
  }
}
