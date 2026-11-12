export interface TimedEta {
  eta: string;
}

export const SAME_STOP_BUFFER_MIN = 3;
export const DEFAULT_WALK_MIN = 5;

export function bufferMinutes(sameStop: boolean, walkMinutes: number): number {
  if (sameStop) return SAME_STOP_BUFFER_MIN;
  if (!Number.isFinite(walkMinutes) || walkMinutes < 0) return DEFAULT_WALK_MIN;
  return walkMinutes;
}

export interface Connection {
  alightEta: string;
  boardEta: string;
  gapMin: number;
}

/** Earliest next-leg boarding time that is at least `bufferMin` after an alighting time. */
export function earliestConnection(
  alight: TimedEta[],
  board: TimedEta[],
  bufferMin: number,
): Connection | null {
  let best: Connection | null = null;
  for (const a of alight) {
    const at = Date.parse(a.eta);
    if (Number.isNaN(at)) continue;
    for (const b of board) {
      const bt = Date.parse(b.eta);
      if (Number.isNaN(bt)) continue;
      const gapMin = (bt - at) / 60000;
      if (gapMin + 1e-6 < bufferMin) continue;
      const better =
        !best ||
        bt < Date.parse(best.boardEta) ||
        (bt === Date.parse(best.boardEta) && gapMin > best.gapMin);
      if (better) best = { alightEta: a.eta, boardEta: b.eta, gapMin };
    }
  }
  return best;
}

export function displayGap(gapMin: number, bufferMin: number): number {
  const rounded = Math.round(gapMin);
  if (rounded < bufferMin) return Math.ceil(gapMin - 1e-9);
  return rounded;
}

/** Pair the nth boarding ETA with the nth alighting ETA only when alighting is later. */
export function sameLegPairs(board: TimedEta[], alight: TimedEta[]): { board: string; alight: string }[] {
  const n = Math.min(board.length, alight.length);
  const pairs: { board: string; alight: string }[] = [];
  for (let i = 0; i < n; i++) {
    const bt = Date.parse(board[i].eta);
    const at = Date.parse(alight[i].eta);
    if (!Number.isNaN(bt) && !Number.isNaN(at) && at > bt) {
      pairs.push({ board: board[i].eta, alight: alight[i].eta });
    }
  }
  return pairs;
}
