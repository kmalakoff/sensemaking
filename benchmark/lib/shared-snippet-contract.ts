import { FIXED_HYDRATION_CANDIDATES, FIXED_HYDRATION_CASES, FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_FILES, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_LINES, FIXED_HYDRATION_TERMS } from './fixed-hydration-workload.ts';
import type { FixedWorkArtifactInput } from './fixed-work-measurement.ts';
import { validateFixedWorkArtifact } from './fixed-work-measurement.ts';
import { identityHash } from './workload-identity.ts';

type FixedWorkInput = FixedWorkArtifactInput;
interface SnippetSample {
  repetition?: unknown;
  error?: unknown;
  ms?: unknown;
  observed?: unknown;
}
interface SnippetInput extends FixedWorkInput {
  samples?: SnippetSample[];
  expected?: unknown;
}
export const SHARED_SNIPPET_SCHEMA = 'shared-snippet-v2';
export const SHARED_SNIPPET_REPETITIONS = 5;
export const SHARED_SNIPPET_HARNESS_FILES = [
  'benchmark/lib/canonical-json.ts',
  'benchmark/lib/fixed-work-measurement.ts',
  'benchmark/lib/fixed-hydration-workload.ts',
  'benchmark/lib/measure.ts',
  'benchmark/lib/native-capability.ts',
  'benchmark/lib/out.ts',
  'benchmark/lib/quiet-machine.ts',
  'benchmark/lib/require-build.ts',
  'benchmark/lib/shared-snippet-contract.ts',
  'benchmark/lib/workload-identity.ts',
  'benchmark/tools/shared-snippet.ts',
];
export const SHARED_SNIPPET_INPUTS = { ...FIXED_HYDRATION_INPUTS, operation: 'computeSnippets + lineNumberAt once per fixed file and caller budget' };
export const SHARED_SNIPPET_EXPECTED = Object.fromEntries(
  FIXED_HYDRATION_CASES.map(
    ({ id }) => [id, Object.fromEntries(FIXED_HYDRATION_CANDIDATES.map((path) => [path, { snippets: FIXED_HYDRATION_EXPECTED[id as keyof typeof FIXED_HYDRATION_EXPECTED][path as keyof typeof FIXED_HYDRATION_LINES].snippets, line: FIXED_HYDRATION_LINES[path as keyof typeof FIXED_HYDRATION_LINES] }] as const))] as const
  )
);

export { FIXED_HYDRATION_CANDIDATES as SHARED_SNIPPET_CANDIDATES, FIXED_HYDRATION_CASES as SHARED_SNIPPET_CASES, FIXED_HYDRATION_FILES as SHARED_SNIPPET_FILES, FIXED_HYDRATION_TERMS as SHARED_SNIPPET_TERMS };

export function validateSharedSnippetArtifact(artifact: SnippetInput) {
  validateFixedWorkArtifact(artifact, { schema: SHARED_SNIPPET_SCHEMA, repetitions: SHARED_SNIPPET_REPETITIONS, harnessFiles: SHARED_SNIPPET_HARNESS_FILES });
  if (identityHash((artifact.workload as NonNullable<SnippetInput['workload']>).inputs) !== identityHash(SHARED_SNIPPET_INPUTS)) throw new Error('shared snippet workload mismatch');
  if (identityHash(artifact.expected) !== identityHash(SHARED_SNIPPET_EXPECTED)) throw new Error('shared snippet expected output mismatch');
  for (const sample of artifact.samples as SnippetSample[]) if (identityHash(sample.observed) !== identityHash(SHARED_SNIPPET_EXPECTED)) throw new Error(`shared snippet repetition ${sample.repetition} output mismatch`);
  return artifact;
}
