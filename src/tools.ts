// Ferramentas MCP de edição de partitura.

import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Barline, Clef, Event, Measure, Part, Score } from './model.ts';
import {
  INSTRUMENTS, emptyMeasure, intervalFifths, makePart, measureContexts, parseInterval, parseMeasures,
  transposePitch, voiceDur, voiceToString,
} from './model.ts';
import { toMEI } from './mei.ts';
import { toMusicXML } from './musicxml.ts';
import { renderMidi, renderPng, pagedSvgs } from './render.ts';
import { workspace, SCORES_DIR, slug } from './store.ts';
import type { Doc } from './store.ts';

export const INSTRUCTIONS = `Editor de partituras com visualização ao vivo (Verovio). Cada alteração aparece na hora no navegador do usuário.

NOTAÇÃO COMPACTA (usada em write_measures e devolvida por read_measures):
- Nota: <altura><oitava>/<duração>  ex.: C4/4 (semínima Dó central), F#5/8 (colcheia), Bb3/2. (mínima), Ebb4/16
  Acidentes: # ## b bb n (bequadro). Oitava 4 = oitava do Dó central.
  Durações: 1 semibreve, 2 mínima, 4 semínima, 8 colcheia, 16, 32, 64; pontos com "." (4. = semínima pontuada).
  Se a duração for omitida, repete a última: "C4/8 D4 E4 F4" = 4 colcheias.
- Pausa: r/4   Acorde: (C4 E4 G4)/2   Liga de prolongamento: C4/2~ C4/4
- Quiáltera: 3:2{C5/8 D5 E5} (tercina de colcheias), 5:4{...}, etc.
- Modificadores entre colchetes, separados por vírgula: C4/4[stacc,acc,mf,slur(]
  articulações: stacc, acc, ten, marc, stacciss | ferm (fermata) | grace (apojatura, não conta tempo)
  dinâmicas: pppp..ffff, sf, sfz, sffz, fp, sfp, rfz, fz
  ligadura de expressão: slur( no início e slur) no fim | crescendo: cresc( … cresc)  | diminuendo: dim( … dim)
  letra: lyr:pa- (hífen no fim = sílaba continua na próxima nota), lyr:"duas palavras" | texto técnico: txt:"dolce"
- Compassos separados por "|". Cada chamada de write_measures sobrescreve UMA voz (part/staff/voice) nos compassos indicados.
- Um compasso sem nenhuma nota numa pauta mostra pausa de compasso inteiro automaticamente.

ARQUIVOS: cada partitura é um arquivo .json na pasta de partituras; o visualizador tem barra lateral e abas.
- Sem o parâmetro "file", as ferramentas atuam no ARQUIVO ATIVO — o que o usuário selecionou na barra lateral. Quando o usuário falar
  "este arquivo"/"a partitura aberta", é o ativo (veja com score_info ou list_files).
- Se o usuário pedir para alterar um arquivo pelo nome, passe file="<nome>" (isso também o abre e o torna ativo).
- score_new cria um arquivo NOVO (nunca sobrescreve outro). duplicate_file faz uma cópia para experimentar versões.
- .musicxml/.xml/.mei abrem só para visualização (snapshot funciona; edição não).

FLUXO RECOMENDADO: score_info -> read_measures -> write_measures/outras edições -> snapshot (para conferir visualmente).
As alturas são escritas em som real (sem instrumentos transpositores). Pautas de piano: staff 1 = clave de sol, staff 2 = clave de fá.
Use undo para desfazer. Exporte para o Sibelius com export_score format=musicxml.`;

type Ctx = { viewerUrl: string; openViewer: () => void };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const KEY_NAMES: Record<number, string> = {
  [-7]: 'Dób maior / Láb menor', [-6]: 'Solb maior / Mib menor', [-5]: 'Réb maior / Sib menor', [-4]: 'Láb maior / Fá menor',
  [-3]: 'Mib maior / Dó menor', [-2]: 'Sib maior / Sol menor', [-1]: 'Fá maior / Ré menor', 0: 'Dó maior / Lá menor',
  1: 'Sol maior / Mi menor', 2: 'Ré maior / Si menor', 3: 'Lá maior / Fá# menor', 4: 'Mi maior / Dó# menor',
  5: 'Si maior / Sol# menor', 6: 'Fá# maior / Ré# menor', 7: 'Dó# maior / Lá# menor',
};
const keyLabel = (k: number) => `${k === 0 ? 'sem acidentes' : k > 0 ? `${k}♯` : `${-k}♭`} (${KEY_NAMES[k]})`;

function findPart(score: Score, ref: string | number): Part {
  const s = String(ref).trim();
  const p = score.parts.find((x) => x.id.toLowerCase() === s.toLowerCase())
    ?? score.parts.find((x) => x.name.toLowerCase() === s.toLowerCase())
    ?? (/^\d+$/.test(s) ? score.parts[parseInt(s, 10) - 1] : undefined);
  if (!p) throw new Error(`Parte "${ref}" não encontrada. Partes: ${score.parts.map((x) => `${x.id} (${x.name})`).join(', ')}`);
  return p;
}

function checkRange(score: Score, from: number, to: number) {
  if (from < 1 || to > score.measures.length || from > to) {
    throw new Error(`Intervalo de compassos inválido ${from}-${to}; a partitura tem ${score.measures.length} compassos.`);
  }
}

function parseTime(t: string) {
  const m = /^(\d+)\/(\d+)$/.exec(t.trim());
  if (!m || ![1, 2, 4, 8, 16, 32].includes(+m[2]) || +m[1] < 1) throw new Error(`Fórmula de compasso inválida "${t}" (ex.: 3/4, 6/8)`);
  return { count: +m[1], unit: +m[2] };
}

function slots(m: Measure, part: Part) {
  const staves = (m.content[part.id] ??= part.clefs.map(() => []));
  while (staves.length < part.clefs.length) staves.push([]);
  return staves;
}

function fmtQ(q: number) { return Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, ''); }

/** Avisos de compassos incompletos/excedidos. */
function durationWarnings(score: Score, from = 1, to = score.measures.length): string[] {
  const ctx = measureContexts(score);
  const out: string[] = [];
  for (let i = from - 1; i < to; i++) {
    for (const p of score.parts) {
      (score.measures[i].content[p.id] ?? []).forEach((staff, s) => staff.forEach((v, vi) => {
        if (!v.length) return;
        const d = voiceDur(v);
        if (Math.abs(d - ctx[i].capacity) > 1e-6) {
          out.push(`compasso ${i + 1}, ${p.id} pauta ${s + 1} voz ${vi + 1}: ${fmtQ(d)} de ${fmtQ(ctx[i].capacity)} semínimas (${d > ctx[i].capacity ? 'EXCEDE' : 'incompleto'})`);
        }
      }));
    }
  }
  return out;
}

function describeMeasure(score: Score, i: number, partFilter?: Part): string {
  const m = score.measures[i];
  const ctx = measureContexts(score)[i];
  const tags: string[] = [];
  if (i === 0 || m.key !== undefined) tags.push(`armadura ${ctx.key === 0 ? '0' : ctx.key > 0 ? `${ctx.key}♯` : `${-ctx.key}♭`}`);
  if (i === 0 || m.time) tags.push(`${ctx.time.count}/${ctx.time.unit}`);
  if (m.tempo) tags.push(`tempo ${[m.tempo.text, m.tempo.bpm && `♩=${m.tempo.bpm}`].filter(Boolean).join(' ')}`);
  if (m.barline && m.barline !== 'single') tags.push(`barra ${m.barline}`);
  const lines = [`Compasso ${i + 1}${tags.length ? ` [${tags.join(', ')}]` : ''}`];
  for (const p of score.parts) {
    if (partFilter && p !== partFilter) continue;
    p.clefs.forEach((_, s) => {
      const voices = (m.content[p.id]?.[s] ?? []).map((v, vi) => ({ v, vi })).filter((x) => x.v.length);
      if (!voices.length) { lines.push(`  ${p.id}.s${s + 1}: (vazio)`); return; }
      for (const { v, vi } of voices) lines.push(`  ${p.id}.s${s + 1}.v${vi + 1}: ${voiceToString(v)}`);
    });
  }
  return lines.join('\n');
}

function safeFile(name: string, ext: string) {
  const b = basename(name).replace(/\.[^.]+$/, '');
  if (!b || b.startsWith('.')) throw new Error('Nome de arquivo inválido');
  return join(SCORES_DIR, `${b}.${ext}`);
}

const clefEnum = z.enum(['treble', 'bass', 'alto', 'tenor', 'treble8vb', 'treble8va', 'bass8vb', 'percussion']);
const partRef = z.union([z.string(), z.number()]).describe('Id da parte (ex.: "P1"), nome ("Violino") ou número (1 = primeira)');

export function registerTools(server: McpServer, ctx: Ctx) {
  // documento alvo da ferramenta em execução (as ferramentas são síncronas)
  let doc!: Doc;
  const fileParam = z.string().optional()
    .describe('Arquivo alvo (ex.: "hino" ou "hino.json"). Omitido = arquivo ativo, o selecionado na barra lateral do visualizador. Indicar um arquivo também o torna o ativo.');

  /** Ferramenta que atua num documento (ganha o parâmetro "file"). */
  const reg = (name: string, description: string, inputSchema: z.ZodRawShape, handler: (a: any) => any, readOnly = false, viewOk = false) =>
    server.registerTool(name, { description, inputSchema: { ...inputSchema, file: fileParam }, annotations: { readOnlyHint: readOnly, destructiveHint: false } }, (a: any) => {
      doc = workspace.target(a.file);
      if (doc.kind !== 'score' && !viewOk) {
        throw new Error(`"${doc.name}" está aberto só para visualização (não é uma partitura .json deste servidor). Abra ou crie um arquivo .json para editar.`);
      }
      return handler(a);
    });

  /** Ferramenta de workspace (arquivos/abas). */
  const regWs = (name: string, description: string, inputSchema: z.ZodRawShape, handler: (a: any) => any, readOnly = false) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false } }, handler);

  // ---------------- leitura ----------------

  reg('score_info', 'Resumo da partitura atual: título, partes (ids, pautas, claves), número de compassos, armaduras/fórmulas, avisos de compassos incompletos e endereço do visualizador.', {}, () => {
    const s = doc.score;
    const c = measureContexts(s);
    const changes = s.measures.map((m, i) => ({ m, i })).filter(({ m, i }) => i === 0 || m.key !== undefined || m.time || m.tempo)
      .map(({ m, i }) => `  c.${i + 1}: armadura ${keyLabel(c[i].key)}, ${c[i].time.count}/${c[i].time.unit}${m.tempo ? `, tempo ${[m.tempo.text, m.tempo.bpm && `♩=${m.tempo.bpm}`].filter(Boolean).join(' ')}` : ''}`);
    const w = durationWarnings(s);
    return text([
      `Arquivo: ${doc.name} (ativo)`,
      `Título: ${s.title}${s.subtitle ? ` — ${s.subtitle}` : ''}${s.composer ? ` | Compositor: ${s.composer}` : ''}${s.lyricist ? ` | Letra: ${s.lyricist}` : ''}`,
      `Compassos: ${s.measures.length}`,
      'Partes:',
      ...s.parts.map((p) => `  ${p.id}: ${p.name}${p.abbr ? ` (${p.abbr})` : ''} — ${p.clefs.length} pauta(s): ${p.clefs.join(', ')} — MIDI ${p.program}`),
      'Armadura/compasso/tempo:',
      ...changes,
      w.length ? `Avisos (${w.length}):\n  ${w.slice(0, 30).join('\n  ')}` : 'Sem avisos de duração.',
      `Visualizador: ${ctx.viewerUrl}`,
    ].join('\n'));
  }, true);

  reg('read_measures', 'Lê o conteúdo de um intervalo de compassos na notação compacta. Linhas no formato "P1.s1.v1: …" = parte.pauta.voz.', {
    from: z.number().int().min(1).optional().describe('Primeiro compasso (padrão 1)'),
    to: z.number().int().min(1).optional().describe('Último compasso (padrão: from+15 ou o fim)'),
    part: partRef.optional().describe('Filtrar uma parte'),
  }, ({ from = 1, to, part }) => {
    const s = doc.score;
    const end = Math.min(to ?? from + 15, s.measures.length);
    checkRange(s, from, end);
    const pf = part !== undefined ? findPart(s, part) : undefined;
    const out: string[] = [];
    for (let i = from - 1; i < end; i++) out.push(describeMeasure(s, i, pf));
    if (end < s.measures.length && to === undefined) out.push(`… (mais ${s.measures.length - end} compassos)`);
    return text(out.join('\n'));
  }, true);

  reg('snapshot', 'Renderiza a partitura (ou um trecho) como imagem PNG para conferir visualmente o resultado.', {
    from: z.number().int().min(1).optional(),
    to: z.number().int().min(1).optional(),
  }, ({ from, to }) => {
    const png = doc.kind === 'view' ? renderPng(doc.raw, from, to) : (() => {
      const s = doc.score;
      if (from || to) checkRange(s, from ?? 1, to ?? s.measures.length);
      return renderPng(toMEI(s), from, to);
    })();
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
  }, true, true);

  // ---------------- criação / estrutura ----------------

  regWs('score_new', `Cria uma partitura nova num ARQUIVO NOVO (abre numa aba e vira o arquivo ativo; os outros arquivos não mudam). Instrumentos disponíveis: ${Object.keys(INSTRUMENTS).join(', ')}.`, {
    title: z.string(),
    filename: z.string().optional().describe('Nome do arquivo sem extensão (padrão: derivado do título)'),
    subtitle: z.string().optional(),
    composer: z.string().optional(),
    lyricist: z.string().optional(),
    parts: z.array(z.object({
      instrument: z.string().optional().describe('Preset (ex.: piano, violin, flute, soprano)'),
      name: z.string().optional().describe('Nome exibido (sobrescreve o do preset)'),
      abbr: z.string().optional(),
      clefs: z.array(clefEnum).optional().describe('Uma clave por pauta, ex.: ["treble","bass"]'),
      program: z.number().int().min(0).max(127).optional().describe('Programa General MIDI (0-127)'),
    })).min(1),
    time: z.string().default('4/4').describe('Fórmula de compasso, ex.: 4/4, 3/4, 6/8'),
    key: z.number().int().min(-7).max(7).default(0).describe('Armadura em quintas: 0 = Dó, 2 = Ré maior, -3 = Mib maior, etc.'),
    tempo_bpm: z.number().int().min(10).max(400).optional(),
    tempo_text: z.string().optional().describe('Ex.: "Allegro"'),
    measures: z.number().int().min(1).max(2000).default(8),
  }, (a) => {
    const sc: Score = { title: a.title, subtitle: a.subtitle, composer: a.composer, lyricist: a.lyricist, parts: [], measures: [] };
    for (const p of a.parts) sc.parts.push(makePart(p, sc.parts));
    for (let i = 0; i < a.measures; i++) sc.measures.push(emptyMeasure());
    sc.measures[0].key = a.key;
    sc.measures[0].time = parseTime(a.time);
    if (a.tempo_bpm || a.tempo_text) sc.measures[0].tempo = { bpm: a.tempo_bpm, text: a.tempo_text };
    const d = workspace.create(a.title, sc, a.filename);
    return text(`Arquivo ${d.name} criado e ativo. Partitura "${a.title}": ${sc.parts.map((p) => `${p.id}=${p.name}`).join(', ')}; ${a.measures} compassos em ${a.time}. Visualizador: ${ctx.viewerUrl}`);
  });

  reg('set_metadata', 'Altera título, subtítulo, compositor ou letrista.', {
    title: z.string().optional(), subtitle: z.string().optional(), composer: z.string().optional(), lyricist: z.string().optional(),
  }, (a) => doc.mutate('metadados', (s) => {
    for (const k of ['title', 'subtitle', 'composer', 'lyricist'] as const) if (a[k] !== undefined) s[k] = a[k] || undefined as any;
    return { result: text('Metadados atualizados.') };
  }));

  reg('add_part', `Adiciona uma parte/instrumento. Presets: ${Object.keys(INSTRUMENTS).join(', ')}.`, {
    instrument: z.string().optional(), name: z.string().optional(), abbr: z.string().optional(),
    clefs: z.array(clefEnum).optional(), program: z.number().int().min(0).max(127).optional(),
    position: z.number().int().min(1).optional().describe('Posição na grade (1 = topo). Padrão: embaixo.'),
  }, (a) => doc.mutate('adicionar parte', (s) => {
    const p = makePart(a, s.parts);
    const pos = Math.min((a.position ?? s.parts.length + 1) - 1, s.parts.length);
    s.parts.splice(pos, 0, p);
    return { measures: s.measures.map((m) => m.id), result: text(`Parte ${p.id} (${p.name}) adicionada na posição ${pos + 1}.`) };
  }));

  reg('remove_part', 'Remove uma parte e todo o seu conteúdo.', { part: partRef }, ({ part }) => doc.mutate('remover parte', (s) => {
    const p = findPart(s, part);
    s.parts = s.parts.filter((x) => x !== p);
    if (!s.parts.length) throw new Error('A partitura precisa de ao menos uma parte.');
    for (const m of s.measures) delete m.content[p.id];
    return { result: text(`Parte ${p.id} (${p.name}) removida.`) };
  }));

  reg('update_part', 'Altera nome, abreviação, claves, som MIDI ou posição de uma parte. Mudar o número de claves adiciona/remove pautas.', {
    part: partRef, name: z.string().optional(), abbr: z.string().optional(),
    clefs: z.array(clefEnum).optional(), program: z.number().int().min(0).max(127).optional(),
    position: z.number().int().min(1).optional(),
  }, (a) => doc.mutate('editar parte', (s) => {
    const p = findPart(s, a.part);
    if (a.name !== undefined) p.name = a.name;
    if (a.abbr !== undefined) p.abbr = a.abbr || undefined;
    if (a.program !== undefined) p.program = a.program;
    if (a.clefs) {
      p.clefs = a.clefs as Clef[];
      for (const m of s.measures) if (m.content[p.id]) m.content[p.id] = m.content[p.id].slice(0, p.clefs.length);
    }
    if (a.position) {
      s.parts = s.parts.filter((x) => x !== p);
      s.parts.splice(Math.min(a.position - 1, s.parts.length), 0, p);
    }
    return { measures: s.measures.map((m) => m.id), result: text(`Parte ${p.id} atualizada.`) };
  }));

  reg('insert_measures', 'Insere compassos vazios.', {
    count: z.number().int().min(1).max(500).default(1),
    before: z.number().int().min(1).optional().describe('Inserir antes deste compasso. Padrão: no fim.'),
  }, ({ count, before }) => doc.mutate('inserir compassos', (s) => {
    const at = before ? Math.min(before - 1, s.measures.length) : s.measures.length;
    const fresh = Array.from({ length: count }, emptyMeasure);
    if (at === 0) {
      const first = s.measures[0];
      Object.assign(fresh[0], { key: first.key, time: first.time, tempo: first.tempo });
      delete first.key;
      delete first.time;
      delete first.tempo;
    }
    s.measures.splice(at, 0, ...fresh);
    return { measures: fresh.map((m) => m.id), result: text(`${count} compasso(s) inserido(s) a partir do compasso ${at + 1}. Total: ${s.measures.length}.`) };
  }));

  reg('delete_measures', 'Apaga compassos (removendo-os da partitura).', {
    from: z.number().int().min(1), to: z.number().int().min(1).optional(),
  }, ({ from, to }) => doc.mutate('apagar compassos', (s) => {
    const end = to ?? from;
    checkRange(s, from, end);
    if (end - from + 1 >= s.measures.length) throw new Error('Não é possível apagar todos os compassos.');
    const before = measureContexts(s);
    s.measures.splice(from - 1, end - from + 1);
    const next = s.measures[from - 1];
    if (next) {
      const c = before[end];
      const prevC = from >= 2 ? before[from - 2] : null;
      if (!prevC || c.key !== prevC.key) next.key = c.key;
      if (!prevC || c.time.count !== prevC.time.count || c.time.unit !== prevC.time.unit) next.time = c.time;
    }
    return { result: text(`Compassos ${from}-${end} apagados. Total: ${s.measures.length}.`) };
  }));

  reg('clear_measures', 'Esvazia o conteúdo de compassos (ficam pausas), opcionalmente só de uma parte/pauta/voz.', {
    from: z.number().int().min(1), to: z.number().int().min(1).optional(),
    part: partRef.optional(), staff: z.number().int().min(1).optional(), voice: z.number().int().min(1).optional(),
  }, (a) => doc.mutate('limpar compassos', (s) => {
    const end = a.to ?? a.from;
    checkRange(s, a.from, end);
    const parts = a.part !== undefined ? [findPart(s, a.part)] : s.parts;
    const ids: string[] = [];
    for (let i = a.from - 1; i < end; i++) {
      const m = s.measures[i];
      ids.push(m.id);
      for (const p of parts) {
        const st = m.content[p.id];
        if (!st) continue;
        st.forEach((voices, si) => {
          if (a.staff && a.staff - 1 !== si) return;
          voices.forEach((_, vi) => { if (!a.voice || a.voice - 1 === vi) voices[vi] = []; });
        });
      }
    }
    return { measures: ids, result: text(`Compassos ${a.from}-${end} limpos.`) };
  }));

  reg('set_measure_attributes', 'Define armadura, fórmula de compasso, tempo ou barra final a partir de um compasso.', {
    measure: z.number().int().min(1),
    key: z.number().int().min(-7).max(7).optional().describe('Nova armadura em quintas'),
    time: z.string().optional().describe('Nova fórmula, ex.: 3/4'),
    tempo_bpm: z.number().int().min(0).max(400).optional().describe('0 remove a indicação de tempo'),
    tempo_text: z.string().optional(),
    barline: z.enum(['single', 'double', 'final', 'repeat-start', 'repeat-end', 'repeat-both']).optional().describe('Barra no fim do compasso (repeat-start = início)'),
  }, (a) => doc.mutate('atributos do compasso', (s) => {
    checkRange(s, a.measure, a.measure);
    const m = s.measures[a.measure - 1];
    if (a.key !== undefined) m.key = a.key;
    if (a.time) m.time = parseTime(a.time);
    if (a.tempo_bpm === 0) delete m.tempo;
    else if (a.tempo_bpm || a.tempo_text) m.tempo = { bpm: a.tempo_bpm ?? m.tempo?.bpm, text: a.tempo_text ?? m.tempo?.text };
    if (a.barline) m.barline = a.barline as Barline;
    const w = durationWarnings(s, a.measure, s.measures.length);
    return { measures: [m.id], result: text(`Compasso ${a.measure} atualizado.${w.length ? `\nAvisos:\n  ${w.slice(0, 15).join('\n  ')}` : ''}`) };
  }));

  // ---------------- escrita de notas ----------------

  reg('write_measures', 'Escreve música em notação compacta (veja as instruções do servidor) numa voz de uma parte, a partir de um compasso. Compassos separados por "|". Sobrescreve aquela voz nesses compassos; acrescenta compassos no fim se necessário. Ex.: music="C4/4 D4 E4 F4 | G4/2 r/2".', {
    part: partRef,
    start: z.number().int().min(1).describe('Compasso inicial'),
    music: z.string().describe('Notação compacta; "|" separa compassos'),
    staff: z.number().int().min(1).default(1).describe('Pauta dentro da parte (piano: 1 = mão direita, 2 = esquerda)'),
    voice: z.number().int().min(1).max(4).default(1).describe('Voz (1 = hastes para cima, 2 = para baixo)'),
  }, (a) => {
    const voices = parseMeasures(a.music);
    return doc.mutate('escrever compassos', (s) => {
      const p = findPart(s, a.part);
      if (a.staff > p.clefs.length) throw new Error(`A parte ${p.id} tem ${p.clefs.length} pauta(s).`);
      if (a.start > s.measures.length + 1) throw new Error(`Compasso inicial ${a.start} além do fim (${s.measures.length}).`);
      const ids: string[] = [];
      voices.forEach((v, k) => {
        const idx = a.start - 1 + k;
        while (idx >= s.measures.length) s.measures.push(emptyMeasure());
        const m = s.measures[idx];
        const staff = slots(m, p)[a.staff - 1];
        while (staff.length < a.voice) staff.push([]);
        staff[a.voice - 1] = v as Event[];
        ids.push(m.id);
      });
      const end = a.start + voices.length - 1;
      const w = durationWarnings(s, a.start, end).filter((x) => x.includes(`${p.id} pauta ${a.staff} voz ${a.voice}`));
      return {
        measures: ids,
        result: text(`Escritos compassos ${a.start}-${end} em ${p.id} (${p.name}) pauta ${a.staff} voz ${a.voice}.${w.length ? `\nAtenção:\n  ${w.join('\n  ')}` : ' Durações conferem.'}`),
      };
    });
  });

  reg('transpose', 'Transpõe por intervalo diatônico (ex.: "M2" sobe 2ª maior, "-m3" desce 3ª menor, "P8" sobe oitava). Sem parte/intervalo de compassos, transpõe tudo e ajusta as armaduras.', {
    interval: z.string(),
    from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional(),
    part: partRef.optional(),
  }, (a) => doc.mutate(`transpor ${a.interval}`, (s) => {
    const iv = parseInterval(a.interval);
    const from = a.from ?? 1;
    const to = a.to ?? s.measures.length;
    checkRange(s, from, to);
    const parts = a.part !== undefined ? [findPart(s, a.part)] : s.parts;
    const whole = a.part === undefined && from === 1 && to === s.measures.length;
    const ids: string[] = [];
    const walk = (evs: Event[]) => evs.forEach((e) => {
      if (e.kind === 'tuplet') walk(e.events);
      else if (e.kind === 'note') e.pitches = e.pitches.map((p) => transposePitch(p, iv));
    });
    for (let i = from - 1; i < to; i++) {
      ids.push(s.measures[i].id);
      for (const p of parts) for (const st of s.measures[i].content[p.id] ?? []) for (const v of st) walk(v);
    }
    let note = '';
    if (whole) {
      const df = intervalFifths(iv);
      for (const m of s.measures) {
        if (m.key === undefined) continue;
        let k = m.key + df;
        while (k > 7) k -= 12;
        while (k < -7) k += 12;
        m.key = k;
      }
      note = ' Armaduras ajustadas.';
    }
    return { measures: ids, result: text(`Transposto ${a.interval} nos compassos ${from}-${to}${a.part !== undefined ? ` (${parts[0].id})` : ''}.${note}`) };
  }));

  // ---------------- histórico ----------------

  reg('undo', 'Desfaz a última alteração.', {}, () => {
    const l = doc.undo();
    return text(l ? `Desfeito: ${l}` : 'Nada para desfazer.');
  });
  reg('redo', 'Refaz a última alteração desfeita.', {}, () => {
    const l = doc.redo();
    return text(l ? `Refeito: ${l}` : 'Nada para refazer.');
  });

  // ---------------- arquivos ----------------

  reg('export_score', `Exporta o arquivo ativo (ou "file") para ${SCORES_DIR}. musicxml abre no Sibelius/MuseScore/Finale/Dorico.`, {
    format: z.enum(['musicxml', 'mei', 'midi', 'svg']),
    filename: z.string().optional().describe('Nome do arquivo sem extensão (padrão: o nome do documento)'),
  }, ({ format, filename }) => {
    const s = doc.score;
    const name = filename ?? doc.name.replace(/\.json$/i, '');
    if (format === 'svg') {
      const pages = pagedSvgs(toMEI(s));
      const paths = pages.map((svg, i) => { const p = safeFile(`${name}-${i + 1}`, 'svg'); writeFileSync(p, svg); return p; });
      return text(`Exportado em ${paths.length} página(s):\n${paths.join('\n')}`);
    }
    const ext = { musicxml: 'musicxml', mei: 'mei', midi: 'mid' }[format];
    const path = safeFile(name, ext);
    if (format === 'musicxml') writeFileSync(path, toMusicXML(s));
    if (format === 'mei') writeFileSync(path, toMEI(s));
    if (format === 'midi') writeFileSync(path, renderMidi(toMEI(s)));
    return text(`Exportado: ${path}`);
  }, true);

  // ---------------- arquivos / abas ----------------

  regWs('list_files', `Lista os arquivos em ${SCORES_DIR}: .json = partitura editável; .musicxml/.xml/.mei = só visualização. Marca os abertos e o ativo.`, {}, () => {
    const files = workspace.listFiles();
    if (!files.length) return text('(pasta vazia)');
    return text(files.map((f) => `${f.active ? '▶' : f.open ? '•' : ' '} ${f.name}  [${f.kind === 'score' ? 'editável' : 'visualização'}, ${(f.size / 1024).toFixed(1)} KB, ${new Date(f.mtime).toLocaleString('pt-BR')}]`).join('\n')
      + '\n\n▶ = ativo (alvo padrão das edições) • = aberto em aba');
  }, true);

  regWs('open_file', 'Abre um arquivo numa aba do visualizador e o torna o ativo (alvo padrão das próximas edições).', {
    file: z.string().describe('Nome do arquivo, com ou sem extensão'),
  }, ({ file }) => {
    const d = workspace.open(file, true);
    return text(`Aberto e ativo: ${d.name} — "${d.title}"${d.kind === 'view' ? ' (só visualização)' : ''}.`);
  });

  regWs('close_file', 'Fecha a aba de um arquivo (o arquivo continua salvo no disco).', {
    file: z.string(),
  }, ({ file }) => {
    workspace.close(file);
    return text(`Aba fechada. Ativo agora: ${workspace.active}.`);
  });

  regWs('rename_file', 'Renomeia um arquivo da pasta de partituras.', {
    file: z.string(), new_name: z.string().describe('Novo nome, sem extensão'),
  }, ({ file, new_name }) => text(`Renomeado para ${workspace.rename(file, new_name)}.`));

  regWs('duplicate_file', 'Cria uma cópia editável de um arquivo .json (ex.: para experimentar uma versão alternativa) e a torna ativa.', {
    file: z.string().optional().describe('Arquivo de origem (padrão: o ativo)'),
    new_name: z.string().optional(),
  }, ({ file, new_name }) => {
    const src = file ? workspace.open(file, false) : workspace.current;
    if (src.kind !== 'score') throw new Error('Só arquivos .json podem ser duplicados.');
    const d = workspace.create(src.score.title, JSON.parse(JSON.stringify(src.score)), new_name ?? `${src.name.replace(/\.json$/i, '')}-copia`);
    return text(`Cópia criada e ativa: ${d.name}.`);
  });

  regWs('open_viewer', 'Abre o visualizador ao vivo no navegador do usuário.', {}, () => {
    ctx.openViewer();
    return text(`Visualizador: ${ctx.viewerUrl}`);
  }, true);
}
