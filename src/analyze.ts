// Análise compartilhada pelos exportadores: acidentes visíveis, ligaduras e agrupamento de colchetes.

import type { Event, NoteEvent, Pitch, RestEvent, Score, TupletEvent } from './model.ts';
import { eventDur, keyAlter, measureContexts } from './model.ts';

export type AccidCode = 's' | 'f' | 'n' | 'x' | 'ff' | 'ss';

export interface Analysis {
  /** acidente a desenhar (ausente = não desenhar) */
  accid: Map<Pitch, AccidCode>;
  ties: { from: Pitch; to: Pitch; measure: number }[];
  tieStart: Set<Pitch>;
  tieStop: Set<Pitch>;
}

export const accidCode = (alter: number): AccidCode =>
  (({ 0: 'n', 1: 's', '-1': 'f', 2: 'x', '-2': 'ff' } as Record<string, AccidCode>)[String(alter)] ?? 'n');

export function flatten(events: Event[]): (NoteEvent | RestEvent)[] {
  return events.flatMap((e) => (e.kind === 'tuplet' ? e.events : [e]));
}

export function analyze(score: Score): Analysis {
  const ctx = measureContexts(score);
  const a: Analysis = { accid: new Map(), ties: [], tieStart: new Set(), tieStop: new Set() };
  const pkey = (p: Pitch) => `${p.step}${p.octave}:${p.alter}`;
  const startMeasure = new Map<Pitch, number>();

  for (const part of score.parts) {
    const pending = new Map<string, Map<string, Pitch>>(); // staff.voice -> pitch pendentes de liga
    score.measures.forEach((m, mi) => {
      part.clefs.forEach((_, s) => {
        const state = new Map<string, number>(); // "C4" -> alteração vigente no compasso
        const cur = (p: Pitch) => state.get(`${p.step}${p.octave}`) ?? keyAlter(p.step, ctx[mi].key);
        (m.content[part.id]?.[s] ?? []).forEach((voice, v) => {
          const vk = `${s}.${v}`;
          let prev = pending.get(vk) ?? new Map<string, Pitch>();
          for (const ev of flatten(voice)) {
            if (ev.kind === 'rest') { prev = new Map(); continue; }
            if (ev.grace) {
              for (const p of ev.pitches) if (p.alter !== cur(p)) a.accid.set(p, accidCode(p.alter));
              continue;
            }
            const next = new Map<string, Pitch>();
            for (const p of ev.pitches) {
              const from = prev.get(pkey(p));
              if (from) {
                a.ties.push({ from, to: p, measure: startMeasure.get(from)! });
                a.tieStop.add(p);
              } else if (p.alter !== cur(p)) {
                a.accid.set(p, accidCode(p.alter));
              }
              state.set(`${p.step}${p.octave}`, p.alter);
              if (ev.tie) { a.tieStart.add(p); next.set(pkey(p), p); startMeasure.set(p, mi); }
            }
            prev = next;
          }
          pending.set(vk, prev);
        });
      });
    });
  }
  return a;
}

// ---------- colchetes ----------

export type Seg =
  | { kind: 'ev'; ev: NoteEvent | RestEvent }
  | { kind: 'beam'; evs: NoteEvent[] }
  | { kind: 'tuplet'; t: TupletEvent; segs: Seg[] };

export function beamLength(time: { count: number; unit: number }): number {
  if (time.unit === 8 && time.count % 3 === 0) return 1.5;
  return 1;
}

export function segment(events: Event[], beamLen: number): Seg[] {
  const out: Seg[] = [];
  let run: NoteEvent[] = [];
  let runGroup = -1;
  let pos = 0;
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'beam', evs: run });
    else if (run.length === 1) out.push({ kind: 'ev', ev: run[0] });
    run = [];
  };
  for (const e of events) {
    if (e.kind === 'tuplet') {
      flush();
      out.push({ kind: 'tuplet', t: e, segs: segment(e.events, Infinity) });
      pos += eventDur(e);
      continue;
    }
    const beamable = e.kind === 'note' && e.dur >= 8 && !e.grace;
    if (!beamable) { flush(); out.push({ kind: 'ev', ev: e }); pos += eventDur(e); continue; }
    const g = Number.isFinite(beamLen) ? Math.floor((pos + 1e-6) / beamLen) : 0;
    if (run.length && g !== runGroup) flush();
    runGroup = g;
    run.push(e as NoteEvent);
    pos += eventDur(e);
  }
  flush();
  return out;
}
