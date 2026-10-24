// Score -> MEI 5 para renderização no Verovio.

import type { Clef, Event, NoteEvent, Pitch, RestEvent, Score } from './model.ts';
import { measureContexts } from './model.ts';
import type { Analysis, Seg } from './analyze.ts';
import { analyze, beamLength, segment } from './analyze.ts';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CLEF_MEI: Record<Clef, string> = {
  treble: 'shape="G" line="2"',
  treble8vb: 'shape="G" line="2" dis="8" dis.place="below"',
  treble8va: 'shape="G" line="2" dis="8" dis.place="above"',
  bass: 'shape="F" line="4"',
  bass8vb: 'shape="F" line="4" dis="8" dis.place="below"',
  alto: 'shape="C" line="3"',
  tenor: 'shape="C" line="4"',
  percussion: 'shape="perc" line="3"',
};

const keySig = (fifths: number) => (fifths === 0 ? '0' : fifths > 0 ? `${fifths}s` : `${-fifths}f`);
const GES: Record<number, string> = { 1: 's', [-1]: 'f', 2: 'ss', [-2]: 'ff' };

export function measureXmlId(id: string) { return `m_${id}`; }

/** Info por nota (id do SVG) para o player do navegador. */
export interface NoteMeta { program: number; tieFrom?: string }

export function toMEI(score: Score, meta?: Map<string, NoteMeta>): string {
  const ctx = measureContexts(score);
  const an: Analysis = analyze(score);
  const ids = new WeakMap<object, string>();
  let counter = 0;
  const idOf = (o: object) => { let v = ids.get(o); if (!v) { v = `e${++counter}`; ids.set(o, v); } return v; };
  const evId = (e: NoteEvent | RestEvent) => (e.kind === 'note' && e.pitches.length === 1 ? idOf(e.pitches[0]) : idOf(e));

  // numeração global de pautas
  const staffN = new Map<string, number>();
  const staffProgram = new Map<number, number>();
  let n = 0;
  for (const p of score.parts) p.clefs.forEach((_, s) => { staffN.set(`${p.id}.${s}`, ++n); staffProgram.set(n, p.program); });
  const tieFrom = new Map<Pitch, Pitch>(an.ties.map((t) => [t.to, t.from]));

  const controls: string[][] = score.measures.map(() => []);
  const open = new Map<string, { slur: { mi: number; ev: NoteEvent }[]; hp: { mi: number; ev: NoteEvent; form: string } | null }>();
  const hyph = new Map<string, boolean>();

  function pitchXml(p: Pitch, ev: NoteEvent, chordChild: boolean, extra: string, staff: number): string {
    const tf = tieFrom.get(p);
    meta?.set(idOf(p), { program: staffProgram.get(staff) ?? 0, tieFrom: tf ? idOf(tf) : undefined });
    let a = `xml:id="${idOf(p)}" pname="${p.step.toLowerCase()}" oct="${p.octave}"`;
    if (!chordChild) {
      a += ` dur="${ev.dur}"`;
      if (ev.dots) a += ` dots="${ev.dots}"`;
      if (ev.grace) a += ' grace="unacc" stem.mod="1slash"';
    }
    const shown = an.accid.get(p);
    if (shown) a += ` accid="${shown}"`;
    else if (p.alter !== 0) a += ` accid.ges="${GES[p.alter]}"`;
    return `<note ${a}>${extra}</note>`;
  }

  function eventXml(e: NoteEvent | RestEvent, mi: number, staff: number, vk: string): string {
    // controles anexados ao evento
    const sid = `#${evId(e)}`;
    if (e.dynam) controls[mi].push(`<dynam staff="${staff}" startid="${sid}">${esc(e.dynam)}</dynam>`);
    if (e.text) controls[mi].push(`<dir staff="${staff}" place="above" startid="${sid}"><rend fontstyle="italic">${esc(e.text)}</rend></dir>`);
    if (e.fermata) controls[mi].push(`<fermata staff="${staff}" startid="${sid}"/>`);

    if (e.kind === 'rest') return `<rest xml:id="${idOf(e)}" dur="${e.dur}"${e.dots ? ` dots="${e.dots}"` : ''}/>`;

    let st = open.get(vk);
    if (!st) { st = { slur: [], hp: null }; open.set(vk, st); }
    for (const s of e.slur ?? []) {
      if (s === 'end') {
        const o = st.slur.pop();
        if (o && o.ev !== e) controls[o.mi].push(`<slur staff="${staff}" startid="#${evId(o.ev)}" endid="${sid}"/>`);
      }
    }
    for (const h of e.hairpin ?? []) {
      if (h === 'end' && st.hp) {
        if (st.hp.ev !== e) controls[st.hp.mi].push(`<hairpin staff="${staff}" form="${st.hp.form}" startid="#${evId(st.hp.ev)}" endid="${sid}"/>`);
        st.hp = null;
      }
    }
    for (const s of e.slur ?? []) if (s === 'start') st.slur.push({ mi, ev: e });
    for (const h of e.hairpin ?? []) if (h !== 'end') st.hp = { mi, ev: e, form: h === 'cresc' ? 'cres' : 'dim' };

    let inner = (e.artic ?? []).map((x) => `<artic artic="${x}"/>`).join('');
    if (e.lyric !== undefined) {
      const prev = hyph.get(vk) ?? false;
      const cont = e.lyric.endsWith('-');
      const txt = cont ? e.lyric.slice(0, -1) : e.lyric;
      const wordpos = prev ? (cont ? 'm' : 't') : cont ? 'i' : '';
      hyph.set(vk, cont);
      inner += `<verse n="1"><syl${wordpos ? ` wordpos="${wordpos}"` : ''}${cont ? ' con="d"' : ''}>${esc(txt)}</syl></verse>`;
    }
    if (e.pitches.length === 1) return pitchXml(e.pitches[0], e, false, inner, staff);
    let a = `xml:id="${idOf(e)}" dur="${e.dur}"`;
    if (e.dots) a += ` dots="${e.dots}"`;
    if (e.grace) a += ' grace="unacc"';
    return `<chord ${a}>${e.pitches.map((p) => pitchXml(p, e, true, '', staff)).join('')}${inner}</chord>`;
  }

  function segsXml(segs: Seg[], mi: number, staff: number, vk: string): string {
    return segs.map((s) => {
      if (s.kind === 'ev') return eventXml(s.ev, mi, staff, vk);
      if (s.kind === 'beam') return `<beam>${s.evs.map((e) => eventXml(e, mi, staff, vk)).join('')}</beam>`;
      return `<tuplet num="${s.t.num}" numbase="${s.t.numbase}" num.visible="true" bracket.visible="${s.t.events.every((e) => e.kind === 'note' && e.dur >= 8) ? 'false' : 'true'}">${segsXml(s.segs, mi, staff, vk)}</tuplet>`;
    }).join('');
  }

  // ---- scoreDef ----
  const c0 = ctx[0] ?? { key: 0, time: { count: 4, unit: 4 } };
  let staffGrp = '';
  for (const p of score.parts) {
    const label = `<label>${esc(p.name)}</label>${p.abbr ? `<labelAbbr>${esc(p.abbr)}</labelAbbr>` : ''}`;
    const defs = p.clefs.map((c, s) =>
      `<staffDef n="${staffN.get(`${p.id}.${s}`)}" lines="${c === 'percussion' ? 1 : 5}">${p.clefs.length === 1 ? label : ''}<clef ${CLEF_MEI[c]}/><instrDef midi.instrnum="${p.program}"/></staffDef>`).join('');
    staffGrp += p.clefs.length > 1 ? `<staffGrp symbol="brace" bar.thru="true">${label}${defs}</staffGrp>` : defs;
  }
  // cabeçalho: o Verovio (header: 'auto') monta título/compositor a partir do titleStmt
  const resp = [
    score.composer ? `<persName role="composer">${esc(score.composer)}</persName>` : '',
    score.lyricist ? `<persName role="lyricist">${esc(score.lyricist)}</persName>` : '',
  ].join('');
  const titleStmt = `<titleStmt><title>${esc(score.title ?? '')}</title>${score.subtitle ? `<title type="subtitle">${esc(score.subtitle)}</title>` : ''}${resp ? `<respStmt>${resp}</respStmt>` : ''}</titleStmt>`;

  // ---- compassos ----
  const body: string[] = [];
  score.measures.forEach((m, mi) => {
    const c = ctx[mi];
    if (mi > 0 && (m.key !== undefined || m.time)) {
      const prev = ctx[mi - 1];
      const k = m.key !== undefined && m.key !== prev.key ? `<keySig sig="${keySig(c.key)}"/>` : '';
      const t = m.time ? `<meterSig count="${c.time.count}" unit="${c.time.unit}"/>` : '';
      if (k || t) body.push(`<scoreDef>${k}${t}</scoreDef>`);
    }
    const bl = beamLength(c.time);
    let staves = '';
    for (const p of score.parts) {
      p.clefs.forEach((_, s) => {
        const sn = staffN.get(`${p.id}.${s}`)!;
        const voices = m.content[p.id]?.[s] ?? [];
        const layers = voices.map((v, vi) => (v.length
          ? `<layer n="${vi + 1}">${segsXml(segment(v as Event[], bl), mi, sn, `${p.id}.${s}.${vi}`)}</layer>` : '')).join('');
        staves += `<staff n="${sn}">${layers || '<layer n="1"><mRest/></layer>'}</staff>`;
      });
    }
    if (m.tempo && (m.tempo.bpm || m.tempo.text)) {
      const metr = m.tempo.bpm ? `<rend glyph.auth="smufl">&#xE1D5;</rend> = ${m.tempo.bpm}` : '';
      const txt = m.tempo.text ? (metr ? `${esc(m.tempo.text)} (${metr})` : esc(m.tempo.text)) : metr;
      controls[mi].unshift(`<tempo staff="1" tstamp="1" place="above"${m.tempo.bpm ? ` midi.bpm="${m.tempo.bpm}"` : ''}>${txt}</tempo>`);
    }
    let attrs = `xml:id="${measureXmlId(m.id)}" n="${mi + 1}"`;
    const b = m.barline ?? (mi === score.measures.length - 1 ? 'final' : 'single');
    if (b === 'double') attrs += ' right="dbl"';
    if (b === 'final') attrs += ' right="end"';
    if (b === 'repeat-end' || b === 'repeat-both') attrs += ' right="rptend"';
    if (b === 'repeat-start' || b === 'repeat-both') attrs += ' left="rptstart"';
    body.push(`<measure ${attrs}>${staves}@@CONTROLS${mi}@@</measure>`);
  });

  // ligaduras de prolongamento
  for (const t of an.ties) controls[t.measure]?.push(`<tie startid="#${idOf(t.from)}" endid="#${idOf(t.to)}"/>`);

  const section = body.join('').replace(/@@CONTROLS(\d+)@@/g, (_, i) => controls[+i].join(''));
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1"><meiHead><fileDesc>${titleStmt}<pubStmt/></fileDesc></meiHead><music><body><mdiv><score><scoreDef><keySig sig="${keySig(c0.key)}"/><meterSig count="${c0.time.count}" unit="${c0.time.unit}"/><staffGrp${score.parts.length > 1 ? ' symbol="bracket"' : ''} bar.thru="false">${staffGrp}</staffGrp></scoreDef><section>${section}</section></score></mdiv></body></music></mei>`;
}
