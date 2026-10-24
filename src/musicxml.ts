// Score -> MusicXML 3.0 (partwise), compatível com Sibelius, MuseScore, Finale, Dorico.

import type { Clef, NoteEvent, Pitch, RestEvent, Score, Voice } from './model.ts';
import { baseDur, measureContexts } from './model.ts';
import type { Seg } from './analyze.ts';
import { analyze, beamLength, segment } from './analyze.ts';
import { esc } from './mei.ts';

const DIV = 480; // divisões por semínima
const TYPE: Record<number, string> = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th' };
const ACC: Record<string, string> = { s: 'sharp', f: 'flat', n: 'natural', x: 'double-sharp', ff: 'flat-flat', ss: 'sharp-sharp' };
const ARTIC: Record<string, string> = { stacc: 'staccato', acc: 'accent', ten: 'tenuto', marc: 'strong-accent', stacciss: 'staccatissimo' };
const CLEF: Record<Clef, string> = {
  treble: '<sign>G</sign><line>2</line>',
  treble8vb: '<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>',
  treble8va: '<sign>G</sign><line>2</line><clef-octave-change>1</clef-octave-change>',
  bass: '<sign>F</sign><line>4</line>',
  bass8vb: '<sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change>',
  alto: '<sign>C</sign><line>3</line>',
  tenor: '<sign>C</sign><line>4</line>',
  percussion: '<sign>percussion</sign>',
};
const BAR: Record<string, string> = { double: 'light-light', final: 'light-heavy', 'repeat-end': 'light-heavy', 'repeat-both': 'light-heavy' };

export function toMusicXML(score: Score): string {
  const ctx = measureContexts(score);
  const an = analyze(score);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.0">');
  out.push(`<work><work-title>${esc(score.title ?? '')}</work-title></work>`);
  if (score.subtitle) out.push(`<movement-title>${esc(score.subtitle)}</movement-title>`);
  out.push('<identification>');
  if (score.composer) out.push(`<creator type="composer">${esc(score.composer)}</creator>`);
  if (score.lyricist) out.push(`<creator type="lyricist">${esc(score.lyricist)}</creator>`);
  out.push('<encoding><software>partitura-mcp</software></encoding></identification>');

  out.push('<part-list>');
  score.parts.forEach((p, i) => {
    out.push(`<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name>${p.abbr ? `<part-abbreviation>${esc(p.abbr)}</part-abbreviation>` : ''}`
      + `<score-instrument id="${p.id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument>`
      + `<midi-instrument id="${p.id}-I1"><midi-channel>${(i % 15) + (i >= 9 ? 2 : 1)}</midi-channel><midi-program>${p.program + 1}</midi-program></midi-instrument></score-part>`);
  });
  out.push('</part-list>');

  for (const [pi, part] of score.parts.entries()) {
    out.push(`<part id="${part.id}">`);
    const hyph = new Map<string, boolean>();
    score.measures.forEach((m, mi) => {
      const c = ctx[mi];
      const cap = c.capacity * DIV;
      out.push(`<measure number="${mi + 1}">`);
      if (m.barline === 'repeat-start' || m.barline === 'repeat-both') {
        out.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
      }
      // atributos
      const attrs: string[] = [];
      if (mi === 0) attrs.push(`<divisions>${DIV}</divisions>`);
      if (mi === 0 || (m.key !== undefined && m.key !== ctx[mi - 1].key)) attrs.push(`<key><fifths>${c.key}</fifths></key>`);
      if (mi === 0 || m.time) attrs.push(`<time><beats>${c.time.count}</beats><beat-type>${c.time.unit}</beat-type></time>`);
      if (mi === 0) {
        if (part.clefs.length > 1) attrs.push(`<staves>${part.clefs.length}</staves>`);
        part.clefs.forEach((cl, s) => attrs.push(`<clef${part.clefs.length > 1 ? ` number="${s + 1}"` : ''}>${CLEF[cl]}</clef>`));
      }
      if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);
      if (pi === 0 && m.tempo && (m.tempo.bpm || m.tempo.text)) {
        const dt = [m.tempo.text ? `<direction-type><words font-weight="bold">${esc(m.tempo.text)}</words></direction-type>` : '',
          m.tempo.bpm ? `<direction-type><metronome parentheses="${m.tempo.text ? 'yes' : 'no'}"><beat-unit>quarter</beat-unit><per-minute>${m.tempo.bpm}</per-minute></metronome></direction-type>` : ''].join('');
        out.push(`<direction placement="above">${dt}${m.tempo.bpm ? `<sound tempo="${m.tempo.bpm}"/>` : ''}</direction>`);
      }

      // pautas / vozes
      const chunks: { staff: number; voice: number; v: Voice | null }[] = [];
      part.clefs.forEach((_, s) => {
        const voices = (m.content[part.id]?.[s] ?? []).map((v, vi) => ({ v, vi })).filter((x) => x.v.length);
        if (!voices.length) chunks.push({ staff: s, voice: s * 4 + 1, v: null });
        else voices.forEach(({ v, vi }) => chunks.push({ staff: s, voice: s * 4 + vi + 1, v }));
      });
      chunks.forEach((ch, ci) => {
        const staffTag = part.clefs.length > 1 ? `<staff>${ch.staff + 1}</staff>` : '';
        let written = 0;
        if (!ch.v) {
          out.push(`<note><rest measure="yes"/><duration>${cap}</duration><voice>${ch.voice}</voice>${staffTag}</note>`);
          written = cap;
        } else {
          const vk = `${ch.staff}.${ch.voice}`;
          const emit = (e: NoteEvent | RestEvent, beam: string | null, tup: { num: number; numbase: number; pos: 'start' | 'mid' | 'stop' | 'only' } | null) => {
            const dirs: string[] = [];
            const below = (inner: string) => `<direction placement="below"><direction-type>${inner}</direction-type>${staffTag}</direction>`;
            if (e.dynam) dirs.push(below(`<dynamics><${e.dynam}/></dynamics>`));
            if (e.text) dirs.push(`<direction placement="above"><direction-type><words font-style="italic">${esc(e.text)}</words></direction-type>${staffTag}</direction>`);
            if (e.kind === 'note') for (const h of e.hairpin ?? []) {
              dirs.push(below(h === 'end' ? '<wedge type="stop"/>' : `<wedge type="${h === 'cresc' ? 'crescendo' : 'diminuendo'}"/>`));
            }
            out.push(...dirs);
            let dur = Math.round(baseDur(e.dur, e.dots) * DIV * (tup ? tup.numbase / tup.num : 1));
            const isGrace = e.kind === 'note' && e.grace;
            if (isGrace) dur = 0;
            const pitches: (Pitch | null)[] = e.kind === 'rest' ? [null] : e.pitches;
            pitches.forEach((p, k) => {
              const parts: string[] = ['<note>'];
              if (isGrace) parts.push('<grace slash="yes"/>');
              if (k > 0) parts.push('<chord/>');
              if (!p) parts.push('<rest/>');
              else parts.push(`<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>`);
              if (!isGrace) parts.push(`<duration>${dur}</duration>`);
              if (p && an.tieStop.has(p)) parts.push('<tie type="stop"/>');
              if (p && an.tieStart.has(p)) parts.push('<tie type="start"/>');
              parts.push(`<voice>${ch.voice}</voice><type>${TYPE[e.dur]}</type>${'<dot/>'.repeat(e.dots)}`);
              const shown = p ? an.accid.get(p) : undefined;
              if (shown) parts.push(`<accidental>${ACC[shown]}</accidental>`);
              if (tup) parts.push(`<time-modification><actual-notes>${tup.num}</actual-notes><normal-notes>${tup.numbase}</normal-notes></time-modification>`);
              parts.push(staffTag);
              if (beam) parts.push(`<beam number="1">${beam}</beam>`);
              const nots: string[] = [];
              if (p && an.tieStop.has(p)) nots.push('<tied type="stop"/>');
              if (p && an.tieStart.has(p)) nots.push('<tied type="start"/>');
              if (k === 0) {
                if (tup && (tup.pos === 'start' || tup.pos === 'only')) nots.push('<tuplet type="start" bracket="no"/>');
                if (tup && (tup.pos === 'stop' || tup.pos === 'only')) nots.push('<tuplet type="stop"/>');
                if (e.kind === 'note') {
                  for (const sl of e.slur ?? []) nots.push(`<slur type="${sl === 'start' ? 'start' : 'stop'}" number="1"/>`);
                  if (e.artic?.length) nots.push(`<articulations>${e.artic.map((a) => `<${ARTIC[a]}/>`).join('')}</articulations>`);
                }
                if (e.fermata) nots.push('<fermata type="upright"/>');
              }
              if (nots.length) parts.push(`<notations>${nots.join('')}</notations>`);
              if (k === 0 && e.kind === 'note' && e.lyric !== undefined) {
                const prev = hyph.get(vk) ?? false;
                const cont = e.lyric.endsWith('-');
                const syl = prev ? (cont ? 'middle' : 'end') : cont ? 'begin' : 'single';
                hyph.set(vk, cont);
                parts.push(`<lyric number="1"><syllabic>${syl}</syllabic><text>${esc(cont ? e.lyric.slice(0, -1) : e.lyric)}</text></lyric>`);
              }
              parts.push('</note>');
              out.push(parts.join(''));
            });
            written += dur;
          };
          const walk = (segs: Seg[], tup: { num: number; numbase: number } | null) => {
            const flat: { e: NoteEvent | RestEvent; beam: string | null }[] = [];
            for (const s of segs) {
              if (s.kind === 'ev') flat.push({ e: s.ev, beam: null });
              else if (s.kind === 'beam') s.evs.forEach((e, i) => flat.push({ e, beam: i === 0 ? 'begin' : i === s.evs.length - 1 ? 'end' : 'continue' }));
              else { walk(s.segs, { num: s.t.num, numbase: s.t.numbase }); }
              if (s.kind !== 'tuplet' && !tup) { flat.forEach((x) => emit(x.e, x.beam, null)); flat.length = 0; }
            }
            if (tup) flat.forEach((x, i) => emit(x.e, x.beam, {
              ...tup, pos: flat.length === 1 ? 'only' : i === 0 ? 'start' : i === flat.length - 1 ? 'stop' : 'mid',
            }));
          };
          walk(segment(ch.v, beamLength(c.time)), null);
        }
        // completa vozes curtas com pausa invisível e volta para a próxima voz
        if (ch.v && written < cap) out.push(`<forward><duration>${cap - written}</duration><voice>${ch.voice}</voice>${staffTag}</forward>`);
        if (ci < chunks.length - 1) out.push(`<backup><duration>${Math.max(cap, written)}</duration></backup>`);
      });

      const b = m.barline ?? (mi === score.measures.length - 1 ? 'final' : 'single');
      if (BAR[b]) {
        out.push(`<barline location="right"><bar-style>${BAR[b]}</bar-style>${b === 'repeat-end' || b === 'repeat-both' ? '<repeat direction="backward"/>' : ''}</barline>`);
      }
      out.push('</measure>');
    });
    out.push('</part>');
  }
  out.push('</score-partwise>');
  return out.join('\n');
}

