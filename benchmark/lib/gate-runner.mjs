import { readFileSync } from 'node:fs';

// Artifact parsing is evidence collection, not a reason to abandon unrelated steps. A missing
// or malformed promised output must remain a failed step rather than a resumable success.
export function stepOutputEvidence(outPath) {
  try {
    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    return Array.isArray(out?.versions) ? { column_order: out.versions } : {};
  } catch (error) {
    return { status: 'failed', detail: `invalid step output ${outPath}: ${error.message}` };
  }
}

export async function runStageSteps(steps, { isOwed, resume, run, recordNotOwed, recordResume, recordResult, collectIndependent = false, blockedBy = (_step) => /** @type {string[]} */ ([]), recordBlocked = (_step, _prerequisites) => {} }) {
  const failures = [];
  for (const step of steps) {
    if (!isOwed(step)) {
      await recordNotOwed(step);
      continue;
    }
    const recorded = resume(step);
    if (recorded) {
      await recordResume(step, recorded);
      continue;
    }
    const prerequisites = blockedBy?.(step) ?? [];
    if (prerequisites.length > 0) {
      await recordBlocked?.(step, prerequisites);
      failures.push({ step, status: 'not-run', prerequisites });
      continue;
    }
    const result = await run(step);
    const status = await recordResult(step, result);
    if (status !== 'ok' && status !== 'owed-unmet') {
      if (!collectIndependent) return { failed: true, step, status };
      failures.push({ step, status });
    }
  }
  return failures.length > 0 ? { failed: true, failures } : { failed: false };
}
