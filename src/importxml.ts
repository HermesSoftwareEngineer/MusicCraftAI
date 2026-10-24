// MusicXML (partwise) -> Score editável.
// Cobre: partes, claves, armaduras, fórmulas, andamento, barras/ritornelos, notas, acordes, vozes,
// quiálteras, ligaduras, apojaturas, articulações, fermatas, dinâmicas, crescendos, textos,
// letra (várias estrofes), cifras e instrumentos transpositores (convertidos para som real).

import { XMLParser } from 'fast-xml-parser';
import type { Barline, ChordSymbol, Clef, Event, Measure, NoteEvent, Part, Pitch, RestEvent, Score, Step, TupletEvent } from './model.ts';
import { DYNAMS, baseDur, emptyMeasure, intervalFifths, setLyric, transposePitch } from './model.ts';

type El = Record<string, unknown>;

const tagOf = (el: El) => Object.keys(el).find((k) => k !== ':@')!;
const kids = (el: El): El[] => (el[tagOf(el)] as El[]) ?? [];
const attrs = (el: El): Record<string, string> => (el[':@'] as Record<string, string>) ?? {};
const all = (els: El[], tag: string) => els.filter((e) => tagOf(e) === tag);
const first = (els: El[], tag: string) => els.find((e) => tagOf(e) === tag);
const textOf = (el: El | undefined): string => (el ? kids(el).map((k) => (k['#text'] !== undefined ? String(k['#text']) : '')).join('') : '');
const childText = (els: El[], tag: string) => textOf(first(els, tag)).trim();
const num = (s: string | undefined, d = 0) => (s === undefined || s === '' || Number.isNaN(Number(s)) ? d : Number(s));

const TYPE_DUR: Record<string, number> = { breve: 1, whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32, '64th': 64, '128th': 64 };
const ARTIC: Record<string, string> = { staccato: 'stacc', accent: 'acc', tenuto: 'ten', 'strong-accent': 'marc', staccatissimo: 'stacciss' };
const KIND_SUFFIX: Record<string, string> = {
  major: '', minor: 'm', augmented: '+', diminished: 'dim', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
  'diminished-seventh': 'dim7', 'augmented-seventh': '+7', 'half-diminished': 'm7b5', 'major-minor': 'mMaj7', 'major-sixth': '6',
  'minor-sixth': 'm6', 'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9', 'dominant-11th': '11', 'dominant-13th': '13',
  'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5',
};

function clefOf(sign: string, line: number, oct: number): Clef | null {
  if (sign === 'G') return oct < 0 ? 'treble8vb' : oct > 0 ? 'treble8va' : 'treble';
  if (sign === 'F') return oct < 0 ? 'bass8vb' : 'bass';
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto';
  if (sign === 'percussion') return 'percussion';
  return null;
}

/** Transpõe o texto de uma cifra ("Bb7/D") por um intervalo. */
function transposeChordText(t: string, iv: { steps: number; semis: number }): string {
  const tp = (root: string) => {
    const p = transposePitch({ step: root[0] as Step, alter: root[1] === '#' ? 1 : root[1] === 'b' ? -1 : 0, octave: 4 }, iv);
    return p.step + (p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter));
  };
  return t.replace(/^([A-G][#b]?)/, (r) => tp(r)).replace(/\/([A-G][#b]?)$/, (_, b) => `/${tp(b)}`);
}

/** semínimas -> duração/pontos (se for representável). */
function durFromQuarters(q: number): { dur: number; dots: number } | null {
  for (const dur of [1, 2, 4, 8, 16, 32, 64]) for (let dots = 0; dots <= 3; dots++) if (Math.abs(baseDur(dur, dots) - q) < 1e-6) return { dur, dots };
  return null;
}

/** Decompõe um intervalo em pausas representáveis. */
function restsFor(q: number): RestEvent[] {
  const out: RestEvent[] = [];
  let left = q;
  for (const dur of [1, 2, 4, 8, 16, 32, 64]) {
    const v = 4 / dur;
    while (left >= v - 1e-6) { out.push({ kind: 'rest', dur, dots: 0 }); left -= v; }
  }
  return out;
}

export interface ImportResult { score: Score; warnings: string[] }

export function importMusicXML(xml: string): ImportResult {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, processEntities: true });
  const doc = parser.parse(xml) as El[];
  if (doc.find((e) => tagOf(e) === 'score-timewise')) throw new Error('MusicXML "timewise" não é suportado (exporte como partwise).');
  const root = doc.find((e) => tagOf(e) === 'score-partwise');
  if (!root) throw new Error('Não parece um arquivo MusicXML (score-partwise não encontrado). Arquivos .mxl compactados precisam ser exportados como .musicxml.');
  const R = kids(root);
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };

  // ---- cabeçalho ----
  const work = first(R, 'work');
  const workTitle = work ? childText(kids(work), 'work-title') : '';
  const movTitle = childText(R, 'movement-title');
  const ident = first(R, 'identification');
  const creators = ident ? all(kids(ident), 'creator') : [];
  const creator = (t: string) => textOf(creators.find((c) => attrs(c).type === t)).trim() || undefined;
  const score: Score = {
    title: workTitle || movTitle || 'Importado',
    subtitle: workTitle && movTitle ? movTitle : undefined,
    composer: creator('composer'), lyricist: creator('lyricist') ?? creator('poet'),
    parts: [], measures: [],
  };

  // ---- partes ----
  const plist = first(R, 'part-list');
  const scoreParts = plist ? all(kids(plist), 'score-part') : [];
  const xmlParts = all(R, 'part');
  const partInfo = new Map<string, { name: string; abbr?: string; program: number }>();
  for (const sp of scoreParts) {
    const k = kids(sp);
    const mi = first(k, 'midi-instrument');
    const prog = mi ? num(childText(kids(mi), 'midi-program'), 1) - 1 : 0;
    partInfo.set(attrs(sp).id, { name: childText(k, 'part-name') || attrs(sp).id, abbr: childText(k, 'part-abbreviation') || undefined, program: Math.max(0, Math.min(127, prog)) });
  }

  const nMeasures = Math.max(0, ...xmlParts.map((p) => all(kids(p), 'measure').length));
  for (let i = 0; i < nMeasures; i++) score.measures.push(emptyMeasure());

  xmlParts.forEach((xp, pi) => {
    const info = partInfo.get(attrs(xp).id) ?? { name: `Parte ${pi + 1}`, program: 0 };
    const part: Part = { id: `P${pi + 1}`, name: info.name, abbr: info.abbr, clefs: ['treble'], program: info.program };
    score.parts.push(part);
    const isFirst = pi === 0;

    let divisions = 1;
    let staves = 1;
    let time = { count: 4, unit: 4 };
    let key = 0;
    let transpose: { steps: number; semis: number } | null = null;
    const clefsSet = new Map<number, Clef>();
    const lastNote = new Map<number, NoteEvent>(); // por pauta (para fim de crescendo)
    const openTuplet = new Map<string, TupletEvent & { explicit: boolean }>();
    let clefChangeWarned = false;

    all(kids(xp), 'measure').forEach((xm, mi) => {
      const m: Measure = score.measures[mi];
      // pauta -> voz MusicXML -> { eventos, fim }
      const voices = new Map<number, Map<string, { events: Event[]; end: number; last?: NoteEvent | RestEvent }>>();
      const pendDyn = new Map<number, string>();
      const pendText = new Map<number, string>();
      const pendHp = new Map<number, 'cresc' | 'dim'>();
      let pos = 0;

      const voiceOf = (staff: number, v: string) => {
        let st = voices.get(staff);
        if (!st) { st = new Map(); voices.set(staff, st); }
        let vv = st.get(v);
        if (!vv) { vv = { events: [], end: 0 }; st.set(v, vv); }
        return vv;
      };

      for (const el of kids(xm)) {
        const tag = tagOf(el);
        const k = kids(el);
        if (tag === 'attributes') {
          if (first(k, 'divisions')) divisions = num(childText(k, 'divisions'), divisions);
          const tr = first(k, 'transpose');
          if (tr) {
            const tk = kids(tr);
            const oct = num(childText(tk, 'octave-change'));
            const steps = num(childText(tk, 'diatonic')) + 7 * oct;
            const semis = num(childText(tk, 'chromatic')) + 12 * oct;
            transpose = steps || semis ? { steps, semis } : null;
            if (transpose) warn(`${part.name}: instrumento transpositor convertido para som real.`);
          }
          const ke = first(k, 'key');
          if (ke && first(kids(ke), 'fifths')) {
            let f = num(childText(kids(ke), 'fifths'));
            if (transpose) { // armadura escrita -> armadura real
              f += intervalFifths(transpose);
              while (f > 7) f -= 12;
              while (f < -7) f += 12;
            }
            if (isFirst && (mi === 0 || f !== key)) m.key = f;
            key = f;
          }
          const te = first(k, 'time');
          if (te && first(kids(te), 'beats')) {
            const beats = childText(kids(te), 'beats').split('+').reduce((a, b) => a + Number(b), 0);
            const t = { count: beats > 0 ? beats : 4, unit: num(childText(kids(te), 'beat-type'), 4) };
            if (isFirst && (mi === 0 || t.count !== time.count || t.unit !== time.unit)) m.time = t;
            time = t;
          }
          if (first(k, 'staves')) staves = num(childText(k, 'staves'), 1);
          for (const c of all(k, 'clef')) {
            const ck = kids(c);
            const n = num(attrs(c).number, 1);
            const cl = clefOf(childText(ck, 'sign'), num(childText(ck, 'line'), 2), num(childText(ck, 'clef-octave-change'), 0));
            if (!cl) { warn(`Clave não suportada (${childText(ck, 'sign')}) — usei clave de sol.`); continue; }
            if (mi === 0 || !clefsSet.has(n)) clefsSet.set(n, cl);
            else if (clefsSet.get(n) !== cl && !clefChangeWarned) {
              clefChangeWarned = true;
              warn(`${part.name}: mudança de clave no compasso ${mi + 1} ignorada (ainda não suportada; as notas ficam corretas).`);
            }
          }
        } else if (tag === 'direction') {
          const staff = num(childText(k, 'staff'), 1);
          const snd = first(k, 'sound');
          if (snd && attrs(snd).tempo && isFirst) m.tempo = { ...m.tempo, bpm: Math.round(num(attrs(snd).tempo)) };
          for (const dt of all(k, 'direction-type')) {
            for (const d of kids(dt)) {
              const t = tagOf(d);
              if (t === 'dynamics') {
                const dyn = kids(d).map(tagOf).find((x) => DYNAMS.includes(x));
                if (dyn) pendDyn.set(staff, dyn);
              } else if (t === 'wedge') {
                const type = attrs(d).type;
                if (type === 'crescendo' || type === 'diminuendo') pendHp.set(staff, type === 'crescendo' ? 'cresc' : 'dim');
                else if (type === 'stop') {
                  const ln = lastNote.get(staff);
                  if (ln) (ln.hairpin ??= []).push('end');
                }
              } else if (t === 'metronome') {
                const pm = num(childText(kids(d), 'per-minute'));
                if (pm && isFirst) m.tempo = { ...m.tempo, bpm: Math.round(pm) };
              } else if (t === 'words') {
                const w = textOf(d).trim();
                if (!w) continue;
                if (snd && attrs(snd).tempo && isFirst) m.tempo = { ...m.tempo, text: w };
                else pendText.set(staff, w);
              }
            }
          }
        } else if (tag === 'harmony') {
          const rt = first(k, 'root');
          if (!rt) continue;
          const rk = kids(rt);
          const alt = num(childText(rk, 'root-alter'));
          let txt = childText(rk, 'root-step') + (alt > 0 ? '#' : alt < 0 ? 'b' : '');
          const kind = first(k, 'kind');
          const kindText = kind ? attrs(kind).text : undefined;
          txt += kindText !== undefined ? kindText : KIND_SUFFIX[textOf(kind).trim()] ?? '';
          const bs = first(k, 'bass');
          if (bs) {
            const ba = num(childText(kids(bs), 'bass-alter'));
            txt += `/${childText(kids(bs), 'bass-step')}${ba > 0 ? '#' : ba < 0 ? 'b' : ''}`;
          }
          if (transpose) txt = transposeChordText(txt, transpose);
          const at = pos + num(childText(k, 'offset'));
          const beat = Math.round((at / (divisions * 4 / time.unit) + 1) * 1000) / 1000;
          const cs: ChordSymbol = { beat, text: txt, part: part.id };
          if (!(m.chords ?? []).some((c) => c.beat === beat && c.part === part.id)) (m.chords ??= []).push(cs);
        } else if (tag === 'backup') {
          pos = Math.max(0, pos - num(childText(k, 'duration')));
        } else if (tag === 'forward') {
          pos += num(childText(k, 'duration'));
        } else if (tag === 'barline') {
          const loc = attrs(el).location ?? 'right';
          const style = childText(k, 'bar-style');
          const rep = first(k, 'repeat');
          const dir = rep ? attrs(rep).direction : undefined;
          if (!isFirst) continue;
          let b: Barline | undefined;
          if (loc === 'left' && dir === 'forward') b = m.barline === 'repeat-end' ? 'repeat-both' : 'repeat-start';
          else if (loc === 'right' && dir === 'backward') b = m.barline === 'repeat-start' ? 'repeat-both' : 'repeat-end';
          else if (loc === 'right' && style === 'light-light') b = 'double';
          else if (loc === 'right' && style === 'light-heavy') b = 'final';
          if (b) m.barline = b;
          if (rep && first(k, 'ending')) warn('Casas de 1ª/2ª vez ainda não são suportadas (ignoradas).');
        } else if (tag === 'note') {
          const staff = num(childText(k, 'staff'), 1);
          const vname = childText(k, 'voice') || '1';
          const isChord = !!first(k, 'chord');
          const grace = !!first(k, 'grace');
          const restEl = first(k, 'rest');
          const duration = num(childText(k, 'duration'));
          const vv = voiceOf(staff, vname);

          // altura
          let pitch: Pitch | null = null;
          const pe = first(k, 'pitch');
          if (pe) {
            const pk = kids(pe);
            pitch = { step: childText(pk, 'step') as Step, alter: Math.round(num(childText(pk, 'alter'))), octave: num(childText(pk, 'octave'), 4) };
            if (transpose) pitch = transposePitch(pitch, transpose);
          } else if (!restEl) {
            warn('Notas sem altura (percussão/unpitched) foram ignoradas.');
            if (!isChord && !grace) pos += duration;
            continue;
          }

          const nots = all(k, 'notations').flatMap(kids);
          if (isChord && pitch && vv.last && vv.last.kind === 'note') {
            vv.last.pitches.push(pitch);
            if (all(k, 'tie').some((t) => attrs(t).type === 'start')) vv.last.tie = true;
            continue;
          }

          // duração
          let dd: { dur: number; dots: number } | null = null;
          const type = childText(k, 'type');
          if (type && TYPE_DUR[type]) dd = { dur: TYPE_DUR[type], dots: all(k, 'dot').length };
          const tm = first(k, 'time-modification');
          const actual = tm ? num(childText(kids(tm), 'actual-notes'), 1) : 1;
          const normal = tm ? num(childText(kids(tm), 'normal-notes'), 1) : 1;
          if (!dd) {
            if (restEl && (attrs(restEl).measure === 'yes' || !type)) { // pausa de compasso inteiro
              if (!isChord && !grace) { pos += duration; vv.end = pos; }
              continue;
            }
            dd = durFromQuarters((duration / divisions) * (actual / normal)) ?? { dur: 4, dots: 0 };
            warn('Algumas durações sem <type> foram aproximadas.');
          }

          // completa buracos da voz com pausas
          if (!grace && pos > vv.end + 1) vv.events.push(...restsFor((pos - vv.end) / divisions));

          let ev: NoteEvent | RestEvent;
          if (restEl || !pitch) ev = { kind: 'rest', dur: dd.dur, dots: dd.dots };
          else {
            const ne: NoteEvent = { kind: 'note', pitches: [pitch], dur: dd.dur, dots: dd.dots };
            if (grace) ne.grace = true;
            if (all(k, 'tie').some((t) => attrs(t).type === 'start') || nots.some((n) => tagOf(n) === 'tied' && attrs(n).type === 'start')) ne.tie = true;
            for (const n of nots) {
              const nt = tagOf(n);
              if (nt === 'slur') {
                if (attrs(n).type === 'start') (ne.slur ??= []).push('start');
                else if (attrs(n).type === 'stop') (ne.slur ??= []).push('end');
              } else if (nt === 'articulations') {
                for (const a of kids(n)) { const ar = ARTIC[tagOf(a)]; if (ar) (ne.artic ??= []).push(ar); }
              } else if (nt === 'fermata') ne.fermata = true;
            }
            for (const ly of all(k, 'lyric')) {
              const lk = kids(ly);
              const verse = Math.max(1, Math.min(12, num(attrs(ly).number, 1) || 1));
              const texts = all(lk, 'text').map((t) => textOf(t));
              if (!texts.length) continue;
              const syl = all(lk, 'syllabic').map((s) => textOf(s).trim());
              const lastSyl = syl.at(-1) ?? 'single';
              const word = texts.join(' ').trim();
              setLyric(ne, verse, lastSyl === 'begin' || lastSyl === 'middle' ? `${word}-` : word);
            }
            const hp = grace ? undefined : pendHp.get(staff);
            if (hp) { (ne.hairpin ??= []).push(hp); pendHp.delete(staff); }
            if (!grace) lastNote.set(staff, ne);
            ev = ne;
          }
          if (nots.some((n) => tagOf(n) === 'fermata')) ev.fermata = true;
          const dyn = grace ? undefined : pendDyn.get(staff);
          if (dyn) { ev.dynam = dyn; pendDyn.delete(staff); }
          const txt = grace ? undefined : pendText.get(staff);
          if (txt) { ev.text = txt; pendText.delete(staff); }

          // quiálteras
          const tupStart = nots.some((n) => tagOf(n) === 'tuplet' && attrs(n).type === 'start');
          const tupStop = nots.some((n) => tagOf(n) === 'tuplet' && attrs(n).type === 'stop');
          const tkey = `${staff}/${vname}`;
          if (tm && actual !== normal) {
            let open = openTuplet.get(tkey);
            if (!open || tupStart) {
              open = { kind: 'tuplet', num: actual, numbase: normal, events: [], explicit: tupStart };
              openTuplet.set(tkey, open);
              vv.events.push(open);
            }
            open.events.push(ev);
            if (tupStop || (!open.explicit && open.events.length >= actual)) {
              openTuplet.delete(tkey);
              delete (open as Partial<{ explicit: boolean }>).explicit;
            }
          } else {
            vv.events.push(ev);
          }
          vv.last = ev;
          if (!grace) { pos += duration; vv.end = pos; }
        }
      }

      // grava pautas/vozes desta parte neste compasso
      const staffArr: Event[][][] = [];
      for (let s = 1; s <= staves; s++) {
        const st = voices.get(s);
        const vs = st ? [...st.entries()].sort((a, b) => num(a[0]) - num(b[0])).map(([, v]) => v.events).filter((e) => e.length) : [];
        if (vs.length > 4) warn(`${part.name}: mais de 4 vozes numa pauta (excedentes ignoradas).`);
        staffArr.push(vs.slice(0, 4));
      }
      if (staffArr.some((s) => s.length)) m.content[part.id] = staffArr;
    });

    part.clefs = Array.from({ length: staves }, (_, i) => clefsSet.get(i + 1) ?? (i === 1 ? 'bass' : 'treble'));
    for (const t of openTuplet.values()) delete (t as Partial<{ explicit: boolean }>).explicit;
  });

  if (!score.parts.length) throw new Error('O MusicXML não tem partes.');
  if (!score.measures.length) score.measures.push(emptyMeasure());
  score.measures[0].key ??= 0;
  score.measures[0].time ??= { count: 4, unit: 4 };
  for (const m of score.measures) if (m.chords) m.chords.sort((a, b) => a.beat - b.beat);
  const last = score.measures.at(-1)!;
  if (last.barline === 'final') delete last.barline; // barra final já é o padrão no último compasso
  return { score, warnings };
}
