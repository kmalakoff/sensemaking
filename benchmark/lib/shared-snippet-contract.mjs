import { FIXED_HYDRATION_CANDIDATES, FIXED_HYDRATION_CASES, FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_FILES, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_LINES, FIXED_HYDRATION_TERMS } from './fixed-hydration-workload.mjs';
import { validateFixedWorkArtifact } from './fixed-work-measurement.mjs';
import { identityHash } from './workload-identity.mjs';

export const SHARED_SNIPPET_SCHEMA = 'shared-snippet-v2';
export const SHARED_SNIPPET_REPETITIONS = 5;
export const SHARED_SNIPPET_HARNESS_FILES = [
  'benchmark/lib/canonical-json.mjs',
  'benchmark/lib/fixed-work-measurement.mjs',
  'benchmark/lib/fixed-hydration-workload.mjs',
  'benchmark/lib/measure.mjs',
  'benchmark/lib/native-capability.mjs',
  'benchmark/lib/out.mjs',
  'benchmark/lib/quiet-machine.mjs',
  'benchmark/lib/require-build.mjs',
  'benchmark/lib/shared-snippet-contract.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/tools/shared-snippet.mjs',
];
export const SHARED_SNIPPET_INPUTS = { ...FIXED_HYDRATION_INPUTS, operation: 'computeSnippets + lineNumberAt once per fixed file and caller budget' };
export const SHARED_SNIPPET_EXPECTED = Object.fromEntries(FIXED_HYDRATION_CASES.map(({ id }) => [id, Object.fromEntries(FIXED_HYDRATION_CANDIDATES.map((path) => [path, { snippets: FIXED_HYDRATION_EXPECTED[id][path].snippets, line: FIXED_HYDRATION_LINES[path] }]))]));

export { FIXED_HYDRATION_CANDIDATES as SHARED_SNIPPET_CANDIDATES, FIXED_HYDRATION_CASES as SHARED_SNIPPET_CASES, FIXED_HYDRATION_FILES as SHARED_SNIPPET_FILES, FIXED_HYDRATION_TERMS as SHARED_SNIPPET_TERMS };

export function validateSharedSnippetArtifact(artifact) {
  validateFixedWorkArtifact(artifact, { schema: SHARED_SNIPPET_SCHEMA, repetitions: SHARED_SNIPPET_REPETITIONS, harnessFiles: SHARED_SNIPPET_HARNESS_FILES });
  if (identityHash(artifact.workload.inputs) !== identityHash(SHARED_SNIPPET_INPUTS)) throw new Error('shared snippet workload mismatch');
  if (identityHash(artifact.expected) !== identityHash(SHARED_SNIPPET_EXPECTED)) throw new Error('shared snippet expected output mismatch');
  for (const sample of artifact.samples) if (identityHash(sample.observed) !== identityHash(SHARED_SNIPPET_EXPECTED)) throw new Error(`shared snippet repetition ${sample.repetition} output mismatch`);
  return artifact;
}
