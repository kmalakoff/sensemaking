import { doneOnResume } from '../report.mjs';

const TEST_IDS = new Set(['npm-test', 'test-engines', 'live-suite']);

function allSteps(stages) {
  return stages.flatMap((stage) => stage.steps);
}

function owed(step, sitting) {
  return step.owedBy === 'always' || Object.hasOwn(sitting.owed ?? {}, step.owedBy);
}

function done(id, sitting, accepted) {
  return doneOnResume(id, sitting.steps?.[id], accepted);
}

function requireSuccessful(ids, sitting) {
  return ids.filter((id) => sitting.steps?.[id]?.status !== 'ok');
}

export function missingPrerequisites(stepId, stages, sitting, acceptedSet = new Set()) {
  const steps = allSteps(stages);
  const step = steps.find(({ id }) => id === stepId);
  if (!step && stepId !== 'compare-reversed') throw new Error(`unknown gate step "${stepId}"`);
  if (stepId === 'validate') return [];
  if (!done('validate', sitting, acceptedSet)) return ['validate'];
  if (TEST_IDS.has(stepId)) return [];

  const missing = steps.filter((candidate) => TEST_IDS.has(candidate.id) && owed(candidate, sitting) && !done(candidate.id, sitting, acceptedSet)).map(({ id }) => id);
  const ids = new Set(steps.map(({ id }) => id));
  const producers = (prefix) => steps.filter(({ id }) => id.startsWith(prefix) && !id.endsWith('-comparison')).map(({ id }) => id);
  let artifacts = [];
  if (stepId === 'native-hydration-comparison') artifacts = producers('native-hydration-');
  else if (/^portable-eval-(.+)-comparison$/.test(stepId)) artifacts = producers(`portable-eval-${stepId.match(/^portable-eval-(.+)-comparison$/)[1]}-`);
  else if (stepId === 'compare-reversed') artifacts = ['compare'];
  for (const id of artifacts) if (!ids.has(id)) throw new Error(`gate dependency "${id}" for "${stepId}" is not defined`);
  return [...missing, ...requireSuccessful(artifacts, sitting)].filter((id, index, values) => values.indexOf(id) === index);
}
