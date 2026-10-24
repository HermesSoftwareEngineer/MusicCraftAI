// Renderização com Verovio (SVG, MIDI, timemap) e prévia PNG via resvg.

import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { Resvg } from '@resvg/resvg-js';
import type { NoteMeta } from './mei.ts';

const VerovioModule = await createVerovioModule();
const tk = new VerovioToolkit(VerovioModule);
tk.setOptions({ xmlIdSeed: 1 });

const BASE = {
  footer: 'none',
  header: 'auto',
  svgViewBox: true,
  adjustPageHeight: true,
  breaks: 'auto',
  pageMarginLeft: 60,
  pageMarginRight: 60,
  pageMarginTop: 60,
  pageMarginBottom: 60,
  font: 'Leipzig',
  condense: 'none',
};

export interface PlayNote {
  t: number; d: number; p: number; prog: number; ids: string[];
  part: string; dynam?: string; hairpin?: ('cresc' | 'dim' | 'end')[]; accent?: boolean;
}
export interface Rendered { svg: string; midi: string; notes: PlayNote[]; measures: { t: number; id: string }[]; log: string }

/** Página contínua para o visualizador no navegador, com a lista de notas para o player. */
export function renderLive(mei: string, meta: Map<string, NoteMeta> = new Map(), width = 2100): Rendered {
  tk.setOptions({ ...BASE, pageWidth: width, pageHeight: 60000, scale: 40 });
  if (!tk.loadData(mei)) throw new Error(`Verovio não conseguiu ler a partitura:\n${tk.getLog()}`);
  const log = tk.getLog();
  const pages = tk.getPageCount();
  let svg = '';
  for (let i = 1; i <= pages; i++) svg += tk.renderToSVG(i);
  const midi = tk.renderToMIDI();
  const timemap = tk.renderToTimemap({ includeMeasures: true }) as { tstamp: number; on?: string[]; measureOn?: string }[];
  const notes: PlayNote[] = [];
  const measures: { t: number; id: string }[] = [];
  const byId = new Map<string, PlayNote>();
  for (const e of timemap) {
    if (e.measureOn) measures.push({ t: e.tstamp, id: e.measureOn });
    for (const id of e.on ?? []) {
      const v = tk.getMIDIValuesForElement(id) as { time: number; duration: number; pitch: number };
      if (!v || typeof v.pitch !== 'number') continue;
      const m = meta.get(id);
      const root = m?.tieFrom ? byId.get(m.tieFrom) : undefined;
      if (root) { // nota ligada: estende a anterior em vez de atacar de novo
        root.d = Math.max(root.d, v.time + v.duration - root.t);
        root.ids.push(id);
        byId.set(id, root);
        continue;
      }
      const n: PlayNote = {
        t: v.time, d: v.duration, p: v.pitch, prog: m?.program ?? 0, ids: [id],
        part: m?.part ?? '', dynam: m?.dynam, hairpin: m?.hairpin, accent: m?.accent,
      };
      notes.push(n);
      byId.set(id, n);
    }
  }
  return { svg, midi, notes, measures, log };
}

// glifos SMuFL usados em textos (metrônomo, acidentes de cifras) -> Unicode comum
const SMUFL_TEXT: Record<string, string> = {
  '\uE1D5': '♩', '\uE1D7': '♪', '\uEA64': '♭', '\uEA66': '♯', '\uEA65': '♮', '\uE260': '♭', '\uE262': '♯', '\uE261': '♮',
};

/** PNG de um trecho (para a IA "ver" o resultado). */
export function renderPng(mei: string, from?: number, to?: number): Buffer {
  tk.setOptions({ ...BASE, pageWidth: 2100, pageHeight: 60000, scale: 45 });
  if (!tk.loadData(mei)) throw new Error(`Verovio não conseguiu ler a partitura:\n${tk.getLog()}`);
  if (from || to) {
    tk.select({ measureRange: `${from ?? 1}-${to ?? 'end'}` });
    tk.redoLayout();
  }
  // o resvg não lê a fonte SMuFL embutida via @font-face: troca as figuras de metrônomo por Unicode
  const svg = tk.renderToSVG(1).replace(
    /<tspan font-family="Leipzig" font-size="(\d+)px">([^<]+)<\/tspan>/g,
    (m, size, g: string) => [...g].every((ch) => SMUFL_TEXT[ch])
      ? `<tspan font-family="Segoe UI Symbol" font-size="${Math.round(+size * 0.6)}px">${[...g].map((ch) => SMUFL_TEXT[ch]).join('')}</tspan>`
      : m,
  );
  const r = new Resvg(svg, {
    background: 'white',
    fitTo: { mode: 'width', value: 1400 },
    font: { loadSystemFonts: true, defaultFontFamily: 'Times New Roman' },
  });
  return r.render().asPng();
}

export function renderMidi(mei: string): Buffer {
  tk.setOptions({ ...BASE, pageWidth: 2100 });
  tk.loadData(mei);
  return Buffer.from(tk.renderToMIDI(), 'base64');
}

/** Valida/renderiza MusicXML (usado no teste de ida e volta). */
export function loadAny(data: string): { ok: boolean; log: string; pages: number } {
  tk.setOptions({ ...BASE, pageWidth: 2100, pageHeight: 2970 });
  const ok = tk.loadData(data);
  return { ok, log: tk.getLog(), pages: ok ? tk.getPageCount() : 0 };
}

export function pagedSvgs(mei: string): string[] {
  tk.setOptions({ ...BASE, pageWidth: 2100, pageHeight: 2970, adjustPageHeight: false, scale: 40 });
  tk.loadData(mei);
  const out: string[] = [];
  for (let i = 1; i <= tk.getPageCount(); i++) out.push(tk.renderToSVG(i));
  return out;
}
