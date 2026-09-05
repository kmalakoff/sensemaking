// Pure classification of one catalog row's prior/current reading. No I/O: every input is a
// plain value or a plain object, so a caller (release.mjs, a test) builds its own fixtures with
// no sitting on disk at all.
//
// Returns { verdict, reason }. verdict is one of:
//   flat      within band (or a quality metric that improved or held).
//   noise     beyond band, but a reversed re-run disagrees (sign flips, or lands inside band).
//   moved     beyond band, slower, with no reversing evidence, or a token/quality change the diff
//             never owed.
//   faster    beyond band, faster, with no reversing evidence; reported loudly, never blocks.
//   contract  a tokens-kind row whose value changed at all.
//   fell      a quality-kind row that got worse.
//   failed    the measuring command exited nonzero on the working tree; carries the stderr line.
//   no-prior  nothing to compare against; never blocks.
// moved, contract, fell and failed are BLOCK reasons; flat, noise, faster and no-prior never block.
export const BLOCK_VERDICTS = new Set(['moved', 'contract', 'fell', 'failed']);

const pct = (delta) => `${(delta * 100).toFixed(1)}%`;

// row: one benchmark/lib/rows.mjs entry. prior/current: the two readings for that row's key.
// extra:
//   reversed       { prior, current } -- the same row's reading from compare.mjs --reverse.
//   sizeDeltas     signed relative deltas for this row at other corpus sizes (13k/26k/stress),
//                  for the scale stage's consistent-growth rule.
//   useCross       true to gate on row.cross (cross-sitting) instead of row.band (same-sitting).
//   retrievalOwed  quality rows only: whether the diff owed fever or touched retrieval.
export function classify(row, prior, current, extra = {}) {
  const { reversed, sizeDeltas = [], useCross = false, retrievalOwed = true } = extra;

  if (prior === undefined || prior === null) return { verdict: 'no-prior', reason: `${row.label}: no prior recorded` };

  if (row.kind === 'tokens') {
    if (current === prior) return { verdict: 'flat', reason: null };
    return { verdict: 'contract', reason: `${row.label}: token contract moved, ${prior} -> ${current}` };
  }

  if (row.kind === 'quality') {
    if (!retrievalOwed && current !== prior) return { verdict: 'moved', reason: `${row.label}: moved (${prior} -> ${current}) though the diff owed neither fever nor a retrieval-touching gate` };
    if (current < prior) return { verdict: 'fell', reason: `${row.label} fell: ${prior} -> ${current}` };
    if (current > prior) return { verdict: 'flat', reason: `${row.label} improved: ${prior} -> ${current}` };
    return { verdict: 'flat', reason: null };
  }

  if (row.kind === 'total') return { verdict: 'flat', reason: null };

  // wall / inproc. A reason states what was measured (label, both values, band, whether the
  // reversed re-run agreed) and never a cause: a wall-clock delta localizes, it does not explain.
  const band = useCross ? row.cross : row.band;
  const delta = (current - prior) / prior;
  if (Math.abs(delta) <= band) return { verdict: 'flat', reason: null };

  if (reversed) {
    const revDelta = (reversed.current - reversed.prior) / reversed.prior;
    if (Math.sign(revDelta) !== Math.sign(delta) || Math.abs(revDelta) <= band) {
      return { verdict: 'noise', reason: `${row.label}: ${prior} -> ${current} (${pct(delta)}) exceeds the ${pct(band)} band, but the reversed re-run read ${reversed.prior} -> ${reversed.current} (${pct(revDelta)}), judged noise` };
    }
  }

  if (delta < 0) return { verdict: 'faster', reason: `${row.label}: ${prior} -> ${current} (${pct(delta)}) faster than the ${pct(band)} band; confirm it in the stage split before believing it` };

  const consistent = sizeDeltas.some((d) => Math.abs(d) > band && Math.sign(d) === Math.sign(delta));
  if (consistent) return { verdict: 'moved', reason: `${row.label}: ${prior} -> ${current} (${pct(delta)}) exceeds the ${pct(band)} band; consistent, grows with size` };

  return { verdict: 'moved', reason: `${row.label}: ${prior} -> ${current} (${pct(delta)}) exceeds the ${pct(band)} band${reversed ? `; the reversed re-run read ${reversed.prior} -> ${reversed.current} (${pct((reversed.current - reversed.prior) / reversed.prior)}), agreeing` : ''}` };
}
