// Modelo de partitura + notação compacta (texto) usada pelas ferramentas MCP.

import { randomUUID } from 'node:crypto';

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type Clef = 'treble' | 'bass' | 'alto' | 'tenor' | 'treble8vb' | 'treble8va' | 'bass8vb' | 'percussion';
export type Barline = 'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end' | 'repeat-both';

export interface Pitch { step: Step; alter: number; octave: number }

export interface NoteEvent {
  kind: 'note';
  pitches: Pitch[]; // >1 = acorde
  dur: number; // 1,2,4,8,16,32,64
  dots: number;
  tie?: boolean; // liga de prolongamento para o próximo evento
  grace?: boolean;
  artic?: string[]; // stacc, acc, ten, marc, stacciss
  fermata?: boolean;
  dynam?: string;
  slur?: ('start' | 'end')[];
  hairpin?: ('cresc' | 'dim' | 'end')[];
  /** letra por estrofe: [0] = 1ª estrofe; sílaba terminada em "-" continua na próxima nota */
  lyrics?: (string | null)[];
  /** formato antigo (só 1ª estrofe) — convertido por normalizeScore */
  lyric?: string;
  text?: string;
}

export interface RestEvent {
  kind: 'rest';
  dur: number;
  dots: number;
  fermata?: boolean;
  dynam?: string;
  text?: string;
}

export interface TupletEvent {
  kind: 'tuplet';
  num: number;
  numbase: number;
  events: (NoteEvent | RestEvent)[];
}

export type Event = NoteEvent | RestEvent | TupletEvent;
export type Voice = Event[];

export interface Part {
  id: string;
  name: string;
  abbr?: string;
  clefs: Clef[]; // uma clave por pauta
  program: number; // General MIDI 0-127
}

export interface Measure {
  id: string;
  key?: number; // armadura (quintas: -7..7) — mudança a partir deste compasso
  time?: { count: number; unit: number };
  tempo?: { bpm?: number; text?: string };
  barline?: Barline;
  /** cifras: posição em tempos (1 = início do compasso), texto ("C7/F") e parte onde aparecem */
  chords?: ChordSymbol[];
  // partId -> pautas -> vozes -> eventos
  content: Record<string, Voice[][]>;
}

export interface ChordSymbol { beat: number; text: string; part?: string }

export interface Score {
  title: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  parts: Part[];
  measures: Measure[];
}

export const staffCount = (s: Score) => s.parts.reduce((n, p) => n + p.clefs.length, 0);

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 8);

// ---------- letra (várias estrofes) ----------

export function getLyrics(e: NoteEvent): (string | null)[] {
  return e.lyrics ?? (e.lyric !== undefined ? [e.lyric] : []);
}

export function setLyric(e: NoteEvent, verse: number, text: string | null) {
  const l = getLyrics(e).slice();
  while (l.length < verse) l.push(null);
  l[verse - 1] = text;
  while (l.length && l[l.length - 1] == null) l.pop();
  delete e.lyric;
  if (l.length) e.lyrics = l; else delete e.lyrics;
}

/** Converte formatos antigos (lyric -> lyrics). */
export function normalizeScore(s: Score): Score {
  const fix = (evs: Event[]) => evs.forEach((e) => {
    if (e.kind === 'tuplet') fix(e.events);
    else if (e.kind === 'note' && e.lyric !== undefined) setLyric(e, 1, e.lyric);
  });
  for (const m of s.measures) for (const staves of Object.values(m.content)) for (const st of staves) for (const v of st) fix(v);
  return s;
}

/** Quantas estrofes a partitura usa. */
export function verseCount(s: Score): number {
  let n = 0;
  const walk = (evs: Event[]) => evs.forEach((e) => {
    if (e.kind === 'tuplet') walk(e.events);
    else if (e.kind === 'note') n = Math.max(n, getLyrics(e).length);
  });
  for (const m of s.measures) for (const staves of Object.values(m.content)) for (const st of staves) for (const v of st) walk(v);
  return n;
}

// ---------- cifras ----------

/** Texto de exibição: "Bb7/F" -> "B♭7/F", "F#m" -> "F♯m". */
export function chordDisplay(t: string): string {
  return t.replace(/([A-G])b/g, '$1♭').replace(/([A-G])#/g, '$1♯');
}

const CHORD_RE = /^[A-G](#|b)?[^\s@/]*(\/[A-G](#|b)?)?$/;

/**
 * Uma linha de cifras por compasso: "F C7/F@3 F@4". "@n" = tempo (1 = início; aceita 2.5).
 * Sem "@", as cifras se espalham igualmente pelo compasso (1 cifra = tempo 1; 2 em 4/4 = tempos 1 e 3…).
 */
export function parseChordMeasure(src: string, beats: number): ChordSymbol[] {
  const toks = src.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 1 && toks[0] === '-') return [];
  const out = toks.map((tok, k) => {
    const [sym, at] = tok.split('@');
    if (!CHORD_RE.test(sym)) throw new Error(`Cifra inválida "${sym}" (ex.: C, F#m, Bb7, C7/E, Dm7b5, Gsus4)`);
    const beat = at !== undefined ? Number(at) : 1 + (k * beats) / toks.length;
    if (!(beat >= 1 && beat < beats + 1)) throw new Error(`Tempo inválido em "${tok}" (o compasso tem ${beats} tempos)`);
    return { beat: Math.round(beat * 1000) / 1000, text: sym };
  });
  return out.sort((a, b) => a.beat - b.beat);
}

export function chordsToString(cs: ChordSymbol[] | undefined): string {
  return (cs ?? []).map((c) => (c.beat === 1 ? c.text : `${c.text}@${c.beat}`)).join(' ');
}

// ---------- instrumentos ----------

export const INSTRUMENTS: Record<string, { name: string; abbr: string; clefs: Clef[]; program: number }> = {
  piano: { name: 'Piano', abbr: 'Pno.', clefs: ['treble', 'bass'], program: 0 },
  organ: { name: 'Órgão', abbr: 'Org.', clefs: ['treble', 'bass'], program: 19 },
  harp: { name: 'Harpa', abbr: 'Hp.', clefs: ['treble', 'bass'], program: 46 },
  violin: { name: 'Violino', abbr: 'Vln.', clefs: ['treble'], program: 40 },
  viola: { name: 'Viola', abbr: 'Vla.', clefs: ['alto'], program: 41 },
  cello: { name: 'Violoncelo', abbr: 'Vc.', clefs: ['bass'], program: 42 },
  contrabass: { name: 'Contrabaixo', abbr: 'Cb.', clefs: ['bass8vb'], program: 43 },
  flute: { name: 'Flauta', abbr: 'Fl.', clefs: ['treble'], program: 73 },
  piccolo: { name: 'Flautim', abbr: 'Picc.', clefs: ['treble'], program: 72 },
  oboe: { name: 'Oboé', abbr: 'Ob.', clefs: ['treble'], program: 68 },
  clarinet: { name: 'Clarinete', abbr: 'Cl.', clefs: ['treble'], program: 71 },
  bassoon: { name: 'Fagote', abbr: 'Fg.', clefs: ['bass'], program: 70 },
  'alto-sax': { name: 'Sax Alto', abbr: 'A. Sax', clefs: ['treble'], program: 65 },
  'tenor-sax': { name: 'Sax Tenor', abbr: 'T. Sax', clefs: ['treble'], program: 66 },
  horn: { name: 'Trompa', abbr: 'Tpa.', clefs: ['treble'], program: 60 },
  trumpet: { name: 'Trompete', abbr: 'Tpt.', clefs: ['treble'], program: 56 },
  trombone: { name: 'Trombone', abbr: 'Tbn.', clefs: ['bass'], program: 57 },
  tuba: { name: 'Tuba', abbr: 'Tba.', clefs: ['bass'], program: 58 },
  guitar: { name: 'Violão', abbr: 'Vl.', clefs: ['treble8vb'], program: 24 },
  'electric-bass': { name: 'Baixo', abbr: 'Bx.', clefs: ['bass8vb'], program: 33 },
  soprano: { name: 'Soprano', abbr: 'S.', clefs: ['treble'], program: 52 },
  alto: { name: 'Contralto', abbr: 'A.', clefs: ['treble'], program: 52 },
  tenor: { name: 'Tenor', abbr: 'T.', clefs: ['treble8vb'], program: 52 },
  bass: { name: 'Baixo (voz)', abbr: 'B.', clefs: ['bass'], program: 52 },
  voice: { name: 'Voz', abbr: 'V.', clefs: ['treble'], program: 52 },
};

// ---------- durações / contexto ----------

export function baseDur(dur: number, dots: number): number {
  let v = 4 / dur;
  let add = v;
  for (let i = 0; i < dots; i++) { add /= 2; v += add; }
  return v; // em semínimas
}

export function eventDur(e: Event): number {
  if (e.kind === 'tuplet') return e.events.reduce((s, x) => s + eventDur(x), 0) * e.numbase / e.num;
  if (e.kind === 'note' && e.grace) return 0;
  return baseDur(e.dur, e.dots);
}

export const voiceDur = (v: Voice) => v.reduce((s, e) => s + eventDur(e), 0);

export interface MeasureCtx { key: number; time: { count: number; unit: number }; capacity: number }

export function measureContexts(score: Score): MeasureCtx[] {
  let key = 0;
  let time = { count: 4, unit: 4 };
  return score.measures.map((m) => {
    if (m.key !== undefined) key = m.key;
    if (m.time) time = m.time;
    return { key, time, capacity: time.count * 4 / time.unit };
  });
}

export function staffVoices(m: Measure, partId: string, staff: number): Voice[] {
  return m.content[partId]?.[staff] ?? [];
}

// ---------- pitches ----------

const STEPS: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMI: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

export function keyAlter(step: Step, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return SHARP_ORDER.slice().reverse().indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

export const midiOf = (p: Pitch) => (p.octave + 1) * 12 + STEP_SEMI[p.step] + p.alter;

export function pitchToString(p: Pitch): string {
  const acc = p.alter === 0 ? '' : p.alter === 1 ? '#' : p.alter === 2 ? '##' : p.alter === -1 ? 'b' : 'bb';
  return `${p.step}${acc}${p.octave}`;
}

/** Transpõe por intervalo diatônico ("M3", "-P5", "+m2", "P8", "A4"…). */
export function parseInterval(s: string): { steps: number; semis: number } {
  const m = /^([+-]?)(P|M|m|A|d)(\d+)$/.exec(s.trim());
  if (!m) throw new Error(`Intervalo inválido: "${s}". Use ex.: M2, -m3, +P5, P8, A4, d5.`);
  const sign = m[1] === '-' ? -1 : 1;
  const qual = m[2];
  const num = parseInt(m[3], 10);
  if (num < 1) throw new Error(`Intervalo inválido: ${s}`);
  const simple = ((num - 1) % 7) + 1;
  const octaves = Math.floor((num - 1) / 7);
  const majorOrPerfect = [0, 0, 2, 4, 5, 7, 9, 11][simple];
  const perfectClass = [1, 4, 5].includes(simple);
  let semis = majorOrPerfect;
  if (perfectClass) {
    if (qual === 'A') semis += 1; else if (qual === 'd') semis -= 1; else if (qual !== 'P') throw new Error(`${s}: use P, A ou d para uníssono/4ª/5ª/8ª`);
  } else {
    if (qual === 'm') semis -= 1; else if (qual === 'A') semis += 1; else if (qual === 'd') semis -= 2; else if (qual !== 'M') throw new Error(`${s}: use M, m, A ou d para 2ª/3ª/6ª/7ª`);
  }
  return { steps: sign * (simple - 1 + 7 * octaves), semis: sign * (semis + 12 * octaves) };
}

export function transposePitch(p: Pitch, iv: { steps: number; semis: number }): Pitch {
  const idx = STEPS.indexOf(p.step) + p.octave * 7 + iv.steps;
  const step = STEPS[((idx % 7) + 7) % 7];
  const octave = Math.floor(idx / 7);
  const target = midiOf(p) + iv.semis;
  const natural = (octave + 1) * 12 + STEP_SEMI[step];
  return { step, octave, alter: target - natural };
}

const FIFTHS_OF: Record<Step, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
export function intervalFifths(iv: { steps: number; semis: number }): number {
  const p = transposePitch({ step: 'C', alter: 0, octave: 4 }, iv);
  return FIFTHS_OF[p.step] + 7 * p.alter;
}

// ---------- notação compacta ----------
//
//   C4/4         semínima Dó4          F#5/8.   colcheia pontuada
//   r/2          pausa de mínima       (C4 E4 G4)/2   acorde
//   C4/4~        liga para a próxima   D4  (sem /dur) herda a duração anterior
//   C4/8[stacc,acc,mf,slur(,cresc(,lyr:la,txt:"dolce"]   modificadores
//   3:2{C5/8 D5 E5}   quiáltera (tercina)        Bb4/16[grace]  apojatura
//   Compassos separados por "|".

export const ARTICS = ['stacc', 'acc', 'ten', 'marc', 'stacciss'];
export const DYNAMS = ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'sffz', 'fp', 'sfp', 'rfz', 'fz'];
const VALID_DURS = [1, 2, 4, 8, 16, 32, 64];

class Lexer {
  s: string;
  i = 0;
  constructor(s: string) { this.s = s; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  peek() { return this.s[this.i]; }
  eof() { this.ws(); return this.i >= this.s.length; }
  err(msg: string): never {
    const ctx = this.s.slice(Math.max(0, this.i - 12), this.i + 12);
    throw new Error(`${msg} (posição ${this.i}, perto de "${ctx}")`);
  }
}

function parsePitch(lx: Lexer): Pitch {
  lx.ws();
  const m = /^([A-Ga-g])(##|bb|#|b|x|n)?(-?\d)/.exec(lx.s.slice(lx.i));
  if (!m) lx.err('Altura inválida — esperado algo como C4, F#5, Bb3');
  lx.i += m[0].length;
  const acc = m[2] ?? '';
  const alter = { '': 0, n: 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[acc]!;
  return { step: m[1].toUpperCase() as Step, alter, octave: parseInt(m[3], 10) };
}

function parseMods(lx: Lexer, ev: NoteEvent | RestEvent) {
  // depois de "[": lista separada por vírgulas até "]"
  while (true) {
    lx.ws();
    if (lx.peek() === ']') { lx.i++; return; }
    let raw = '';
    const kv = /^(lyr\d*|txt):/.exec(lx.s.slice(lx.i));
    if (kv) {
      lx.i += kv[0].length;
      let val = '';
      if (lx.peek() === '"') {
        const end = lx.s.indexOf('"', lx.i + 1);
        if (end < 0) lx.err('Aspas não fechadas');
        val = lx.s.slice(lx.i + 1, end);
        lx.i = end + 1;
      } else {
        while (lx.i < lx.s.length && !/[,\]]/.test(lx.s[lx.i])) val += lx.s[lx.i++];
        val = val.trim();
      }
      if (kv[1].startsWith('lyr')) {
        if (ev.kind !== 'note') lx.err('Letra só pode ir em nota');
        const verse = kv[1] === 'lyr' ? 1 : parseInt(kv[1].slice(3), 10);
        if (!(verse >= 1 && verse <= 12)) lx.err('Estrofe inválida (use lyr, lyr2 … lyr12)');
        setLyric(ev, verse, val);
      } else ev.text = val;
    } else {
      while (lx.i < lx.s.length && !/[,\]]/.test(lx.s[lx.i])) raw += lx.s[lx.i++];
      const mod = raw.trim();
      if (mod === 'ferm') ev.fermata = true;
      else if (DYNAMS.includes(mod)) ev.dynam = mod;
      else if (ev.kind === 'note') {
        if (ARTICS.includes(mod)) (ev.artic ??= []).push(mod);
        else if (mod === 'grace') ev.grace = true;
        else if (mod === 'slur(') (ev.slur ??= []).push('start');
        else if (mod === 'slur)') (ev.slur ??= []).push('end');
        else if (mod === 'cresc(') (ev.hairpin ??= []).push('cresc');
        else if (mod === 'dim(') (ev.hairpin ??= []).push('dim');
        else if (mod === 'cresc)' || mod === 'dim)') (ev.hairpin ??= []).push('end');
        else lx.err(`Modificador desconhecido "${mod}"`);
      } else lx.err(`Modificador "${mod}" não vale para pausa`);
    }
    lx.ws();
    if (lx.peek() === ',') lx.i++;
    else if (lx.peek() !== ']') lx.err('Esperado "," ou "]"');
  }
}

function parseSimple(lx: Lexer, last: { dur: number; dots: number }): NoteEvent | RestEvent {
  lx.ws();
  let ev: NoteEvent | RestEvent;
  const c = lx.peek();
  if (c === 'r' || c === 'R') {
    lx.i++;
    ev = { kind: 'rest', dur: last.dur, dots: last.dots };
  } else if (c === '(') {
    lx.i++;
    const pitches: Pitch[] = [];
    while (true) {
      lx.ws();
      if (lx.peek() === ')') { lx.i++; break; }
      if (lx.i >= lx.s.length) lx.err('Acorde não fechado');
      pitches.push(parsePitch(lx));
    }
    if (!pitches.length) lx.err('Acorde vazio');
    ev = { kind: 'note', pitches, dur: last.dur, dots: last.dots };
  } else {
    ev = { kind: 'note', pitches: [parsePitch(lx)], dur: last.dur, dots: last.dots };
  }
  if (lx.peek() === '/') {
    lx.i++;
    const m = /^(\d+)(\.*)/.exec(lx.s.slice(lx.i));
    if (!m || !VALID_DURS.includes(parseInt(m[1], 10))) lx.err('Duração inválida — use 1,2,4,8,16,32,64 (+ pontos)');
    lx.i += m[0].length;
    ev.dur = parseInt(m[1], 10);
    ev.dots = m[2].length;
    last.dur = ev.dur;
    last.dots = ev.dots;
  }
  while (true) {
    const p = lx.peek();
    if (p === '~') { if (ev.kind !== 'note') lx.err('Pausa não pode ter liga'); ev.tie = true; lx.i++; }
    else if (p === '[') { lx.i++; parseMods(lx, ev); }
    else break;
  }
  if (lx.i < lx.s.length && !/[\s|}]/.test(lx.peek())) lx.err('Caractere inesperado');
  return ev;
}

/** Converte a notação de UM compasso (uma voz) em eventos. */
export function parseVoice(src: string, last = { dur: 4, dots: 0 }): Voice {
  const lx = new Lexer(src);
  const out: Voice = [];
  while (!lx.eof()) {
    const tup = /^(\d+):(\d+)\{/.exec(lx.s.slice(lx.i));
    if (tup) {
      lx.i += tup[0].length;
      const events: (NoteEvent | RestEvent)[] = [];
      while (true) {
        lx.ws();
        if (lx.peek() === '}') { lx.i++; break; }
        if (lx.i >= lx.s.length) lx.err('Quiáltera não fechada com "}"');
        events.push(parseSimple(lx, last));
      }
      if (!events.length) lx.err('Quiáltera vazia');
      out.push({ kind: 'tuplet', num: +tup[1], numbase: +tup[2], events });
    } else {
      out.push(parseSimple(lx, last));
    }
  }
  return out;
}

/** "C4/4 D4 | E4/2 F4" -> uma Voice por compasso. */
export function parseMeasures(src: string): Voice[] {
  const last = { dur: 4, dots: 0 };
  return src.split('|').map((chunk) => parseVoice(chunk, last));
}

function simpleToString(e: NoteEvent | RestEvent): string {
  let s = e.kind === 'rest' ? 'r'
    : e.pitches.length === 1 ? pitchToString(e.pitches[0]) : `(${e.pitches.map(pitchToString).join(' ')})`;
  s += `/${e.dur}${'.'.repeat(e.dots)}`;
  if (e.kind === 'note' && e.tie) s += '~';
  const mods: string[] = [];
  if (e.kind === 'note') {
    if (e.grace) mods.push('grace');
    mods.push(...(e.artic ?? []));
    for (const x of e.slur ?? []) mods.push(x === 'start' ? 'slur(' : 'slur)');
    for (const x of e.hairpin ?? []) mods.push(x === 'end' ? 'cresc)' : `${x}(`);
  }
  if (e.fermata) mods.push('ferm');
  if (e.dynam) mods.push(e.dynam);
  if (e.kind === 'note') {
    getLyrics(e).forEach((l, i) => {
      if (l == null) return;
      const key = i === 0 ? 'lyr' : `lyr${i + 1}`;
      mods.push(/[,\]\s"]/.test(l) ? `${key}:"${l}"` : `${key}:${l}`);
    });
  }
  if (e.text !== undefined) mods.push(`txt:"${e.text}"`);
  if (mods.length) s += `[${mods.join(',')}]`;
  return s;
}

export function voiceToString(v: Voice): string {
  return v.map((e) => e.kind === 'tuplet'
    ? `${e.num}:${e.numbase}{${e.events.map(simpleToString).join(' ')}}`
    : simpleToString(e)).join(' ');
}

// ---------- fábrica ----------

export function makePart(opts: { instrument?: string; name?: string; abbr?: string; clefs?: Clef[]; program?: number }, existing: Part[]): Part {
  const preset = opts.instrument ? INSTRUMENTS[opts.instrument] : undefined;
  if (opts.instrument && !preset) throw new Error(`Instrumento desconhecido "${opts.instrument}". Opções: ${Object.keys(INSTRUMENTS).join(', ')}`);
  let n = existing.length + 1;
  while (existing.some((p) => p.id === `P${n}`)) n++;
  return {
    id: `P${n}`,
    name: opts.name ?? preset?.name ?? `Parte ${n}`,
    abbr: opts.abbr ?? preset?.abbr,
    clefs: opts.clefs ?? preset?.clefs ?? ['treble'],
    program: opts.program ?? preset?.program ?? 0,
  };
}

export function emptyMeasure(): Measure {
  return { id: newId(), content: {} };
}
