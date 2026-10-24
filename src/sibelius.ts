// Abre a partitura no Sibelius instalado (para ouvir com o NotePerformer, diagramar e imprimir).

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Doc } from './store.ts';
import { SCORES_DIR } from './store.ts';
import { toMusicXML } from './musicxml.ts';

const CANDIDATES = [
  process.env.SIBELIUS_EXE,
  'C:\\Program Files\\Avid\\Sibelius\\Sibelius.exe',
  'C:\\Program Files\\Avid\\Sibelius 7.5\\Sibelius.exe',
  'C:\\Program Files (x86)\\Avid\\Sibelius 7.5\\Sibelius.exe',
  'C:\\Program Files\\Avid\\Sibelius 7\\Sibelius.exe',
  '/Applications/Sibelius.app',
].filter(Boolean) as string[];

export function sibeliusPath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Exporta o documento como MusicXML em scores/ e abre no Sibelius. Devolve o caminho do arquivo. */
export function openInSibelius(doc: Doc): string {
  if (doc.kind !== 'score' && !/\.(musicxml|xml)$/i.test(doc.name)) {
    throw new Error('Só partituras .json ou arquivos MusicXML podem ser abertos no Sibelius.');
  }
  const exe = sibeliusPath();
  if (!exe) throw new Error('Sibelius não encontrado. Defina a variável SIBELIUS_EXE com o caminho do Sibelius.exe.');
  let path = doc.path;
  if (doc.kind === 'score') {
    path = join(SCORES_DIR, `${doc.name.replace(/\.json$/i, '')}.musicxml`);
    writeFileSync(path, toMusicXML(doc.score));
  }
  const [cmd, args] = exe.endsWith('.app') ? ['open', ['-a', exe, path]] : [exe, [path]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return path;
}
