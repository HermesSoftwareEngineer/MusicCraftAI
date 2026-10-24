// Workspace: vários documentos (arquivos em scores/), abas abertas, documento ativo,
// histórico por documento (desfazer/refazer), salvamento automático e notificação de mudanças.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, rmSync, watch } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Score } from './model.ts';
import { emptyMeasure, makePart, normalizeScore } from './model.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.PARTITURA_DATA ?? join(ROOT, 'data');
export const SCORES_DIR = process.env.PARTITURA_SCORES ?? join(ROOT, 'scores');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SCORES_DIR, { recursive: true });
const STATE = join(DATA_DIR, 'workspace.json');

/** Extensões: .json = partitura editável; as demais abrem só para visualização (Verovio). */
export const EDITABLE_EXT = '.json';
export const VIEW_EXTS = ['.musicxml', '.xml', '.mei'];

export type Event =
  | { type: 'doc'; doc: string; version: number; label: string; measures: string[] }
  | { type: 'workspace' };
type Listener = (e: Event) => void;

export function slug(s: string) {
  return (s || 'partitura').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'partitura';
}

export function blankScore(title = 'Sem título'): Score {
  const s: Score = { title, parts: [], measures: [] };
  s.parts.push(makePart({ instrument: 'piano' }, s.parts));
  for (let i = 0; i < 4; i++) s.measures.push(emptyMeasure());
  s.measures[0].key = 0;
  s.measures[0].time = { count: 4, unit: 4 };
  return s;
}

// ---------- backup automático: data/backups/<arquivo>/<data-hora>.json ----------

export const BACKUP_DIR = join(DATA_DIR, 'backups');
export const TRASH_DIR = join(DATA_DIR, 'lixeira');
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const BACKUP_KEEP = 50;
const lastBackup = new Map<string, number>();

function backup(name: string, score: Score) {
  const now = Date.now();
  if (now - (lastBackup.get(name) ?? 0) < BACKUP_EVERY_MS) return;
  lastBackup.set(name, now);
  try {
    const dir = join(BACKUP_DIR, name.replace(/\.json$/i, ''));
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(score));
    const old = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) rmSync(join(dir, f));
  } catch { /* backup nunca derruba a edição */ }
}

export class Doc {
  name: string; // nome do arquivo em scores/, com extensão
  kind: 'score' | 'view';
  score!: Score;
  raw = ''; // conteúdo do arquivo somente-leitura
  version = 0;
  undoStack: { label: string; json: string }[] = [];
  redoStack: { label: string; json: string }[] = [];
  ws: Workspace;

  constructor(ws: Workspace, name: string) {
    this.ws = ws;
    this.name = name;
    this.kind = extname(name).toLowerCase() === EDITABLE_EXT ? 'score' : 'view';
    this.reload();
  }

  get path() { return join(SCORES_DIR, this.name); }
  get title() { return this.kind === 'score' ? this.score.title : basename(this.name, extname(this.name)); }

  reload() {
    const text = readFileSync(this.path, 'utf8');
    if (this.kind === 'score') {
      const sc = JSON.parse(text) as Score;
      if (!Array.isArray(sc.parts) || !Array.isArray(sc.measures)) throw new Error(`${this.name} não é uma partitura deste servidor.`);
      this.score = normalizeScore(sc);
    } else {
      this.raw = text;
    }
  }

  private requireEditable() {
    if (this.kind !== 'score') throw new Error(`"${this.name}" está aberto só para visualização. Só arquivos .json são editáveis.`);
  }

  private commit(label: string, measures: string[]) {
    this.version++;
    this.ws.selfWrites.set(this.name, Date.now());
    writeFileSync(this.path, JSON.stringify(this.score, null, 1));
    backup(this.name, this.score);
    this.ws.emit({ type: 'doc', doc: this.name, version: this.version, label, measures });
  }

  /** Aplica uma mutação com snapshot para desfazer. A função devolve os ids de compassos alterados. */
  mutate<T>(label: string, fn: (s: Score) => { measures?: string[]; result: T }): T {
    this.requireEditable();
    const before = JSON.stringify(this.score);
    try {
      const { measures, result } = fn(this.score);
      this.undoStack.push({ label, json: before });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.commit(label, measures ?? []);
      return result;
    } catch (e) {
      this.score = JSON.parse(before); // nada de estado meio alterado
      throw e;
    }
  }

  replace(label: string, score: Score) {
    return this.mutate(label, (s) => {
      for (const k of Object.keys(s) as (keyof Score)[]) delete s[k];
      Object.assign(s, score);
      return { measures: score.measures.map((m) => m.id), result: undefined };
    });
  }

  undo(): string | null {
    this.requireEditable();
    const st = this.undoStack.pop();
    if (!st) return null;
    this.redoStack.push({ label: st.label, json: JSON.stringify(this.score) });
    this.score = JSON.parse(st.json);
    this.commit(`desfazer: ${st.label}`, []);
    return st.label;
  }

  redo(): string | null {
    this.requireEditable();
    const st = this.redoStack.pop();
    if (!st) return null;
    this.undoStack.push({ label: st.label, json: JSON.stringify(this.score) });
    this.score = JSON.parse(st.json);
    this.commit(`refazer: ${st.label}`, []);
    return st.label;
  }
}

export interface FileInfo { name: string; kind: 'score' | 'view'; size: number; mtime: number; open: boolean; active: boolean }

export class Workspace {
  docs = new Map<string, Doc>(); // abas abertas, em ordem
  active: string | null = null;
  listeners = new Set<Listener>();
  selfWrites = new Map<string, number>(); // arquivo -> quando nós o gravamos

  constructor() {
    this.migrateLegacy();
    try {
      const st = JSON.parse(readFileSync(STATE, 'utf8')) as { open: string[]; active: string | null };
      for (const n of st.open) { try { this.open(n, false); } catch { /* arquivo sumiu */ } }
      if (st.active && this.docs.has(st.active)) this.active = st.active;
    } catch {
      // primeiro uso: abre a primeira partitura que existir (sem criar arquivos)
      const files = this.listFiles().filter((f) => f.kind === 'score');
      if (files.length) this.open(files[0].name, false);
    }
    if (!this.active) this.active = [...this.docs.keys()][0] ?? null;
    this.saveState();
    this.watchDir();
  }

  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: Event) { for (const l of this.listeners) l(e); }

  private saveState() {
    writeFileSync(STATE, JSON.stringify({ open: [...this.docs.keys()], active: this.active }));
  }

  /** Versão antiga guardava uma única partitura em data/current.json. */
  private migrateLegacy() {
    const legacy = join(DATA_DIR, 'current.json');
    if (!existsSync(legacy)) return;
    try {
      const sc = JSON.parse(readFileSync(legacy, 'utf8')) as Score;
      const name = this.uniqueName(slug(sc.title));
      writeFileSync(join(SCORES_DIR, name), JSON.stringify(sc, null, 1));
      writeFileSync(STATE, JSON.stringify({ open: [name], active: name }));
    } catch { /* ignora */ }
    renameSync(legacy, `${legacy}.migrado`);
  }

  private watchDir() {
    let t: ReturnType<typeof setTimeout> | null = null;
    try {
      watch(SCORES_DIR, (_ev, file) => {
        const f = file ? String(file) : '';
        if (f && Date.now() - (this.selfWrites.get(f) ?? 0) < 1500) return; // escrita nossa
        const d = f ? this.docs.get(f) : undefined;
        if (d && existsSync(d.path)) {
          try { // arquivo aberto alterado fora daqui: recarrega
            d.reload();
            this.emit({ type: 'doc', doc: d.name, version: ++d.version, label: 'arquivo alterado no disco', measures: [] });
          } catch { /* gravação pela metade */ }
        }
        if (t) clearTimeout(t);
        t = setTimeout(() => this.emit({ type: 'workspace' }), 150);
      });
    } catch { /* sem watch disponível */ }
  }

  uniqueName(base: string, ext = EDITABLE_EXT) {
    const taken = new Set(readdirSync(SCORES_DIR).map((n) => n.toLowerCase()));
    let name = `${base}${ext}`;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}${ext}`;
    return name;
  }

  /** Aceita "nome", "nome.json", "nome.musicxml"… */
  resolveName(ref: string): string {
    const b = basename(ref.trim());
    if (!b || b.startsWith('.')) throw new Error('Nome de arquivo inválido');
    // sempre o nome exato do disco (Windows não diferencia maiúsculas: evita abrir o mesmo arquivo em duas abas)
    const lower = b.toLowerCase();
    const files = this.listFiles();
    const hit = files.find((f) => f.name.toLowerCase() === lower)
      ?? files.find((f) => f.kind === 'score' && basename(f.name, extname(f.name)).toLowerCase() === lower)
      ?? files.find((f) => basename(f.name, extname(f.name)).toLowerCase() === lower);
    if (hit) return hit.name;
    throw new Error(`Arquivo "${ref}" não encontrado em ${SCORES_DIR}. Use list_files.`);
  }

  listFiles(): FileInfo[] {
    return readdirSync(SCORES_DIR)
      .filter((n) => [EDITABLE_EXT, ...VIEW_EXTS].includes(extname(n).toLowerCase()))
      .map((n) => {
        const st = statSync(join(SCORES_DIR, n));
        return {
          name: n, kind: extname(n).toLowerCase() === EDITABLE_EXT ? 'score' as const : 'view' as const,
          size: st.size, mtime: st.mtimeMs, open: this.docs.has(n), active: this.active === n,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  open(ref: string, activate = true): Doc {
    const name = this.resolveName(ref);
    let d = this.docs.get(name);
    if (!d) { d = new Doc(this, name); this.docs.set(name, d); }
    if (activate) this.setActive(name);
    else this.saveState();
    return d;
  }

  create(title: string, score: Score, fileBase?: string): Doc {
    const name = this.uniqueName(slug(fileBase ?? title));
    this.selfWrites.set(name, Date.now());
    writeFileSync(join(SCORES_DIR, name), JSON.stringify(score, null, 1));
    const d = new Doc(this, name);
    this.docs.set(name, d);
    this.setActive(name);
    return d;
  }

  close(ref: string) {
    const name = this.resolveName(ref);
    if (!this.docs.delete(name)) return;
    // pode ficar sem nenhuma aba aberta (antes criava "Sem título" em loop)
    if (this.active === name) this.active = [...this.docs.keys()].at(-1) ?? null;
    this.saveState();
    this.emit({ type: 'workspace' });
  }

  /** "Exclui" movendo para data/lixeira (recuperável com restore). Devolve o nome na lixeira. */
  remove(ref: string): string {
    const name = this.resolveName(ref);
    mkdirSync(TRASH_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const trashed = `${stamp}__${name}`;
    this.docs.delete(name);
    if (this.active === name) this.active = [...this.docs.keys()].at(-1) ?? null;
    renameSync(join(SCORES_DIR, name), join(TRASH_DIR, trashed));
    this.saveState();
    this.emit({ type: 'workspace' });
    return trashed;
  }

  listTrash(): { trashed: string; name: string; when: string }[] {
    if (!existsSync(TRASH_DIR)) return [];
    return readdirSync(TRASH_DIR).filter((f) => f.includes('__')).sort().reverse().map((f) => {
      const [stamp, ...rest] = f.split('__');
      return { trashed: f, name: rest.join('__'), when: stamp.replace(/T(\d\d)-(\d\d)-(\d\d)/, ' $1:$2:$3') };
    });
  }

  /** Restaura da lixeira (o item mais recente com esse nome, ou o nome exato da lixeira). */
  restore(ref: string): string {
    const items = this.listTrash();
    const it = items.find((x) => x.trashed === ref) ?? items.find((x) => x.name.toLowerCase() === ref.toLowerCase()
      || basename(x.name, extname(x.name)).toLowerCase() === ref.toLowerCase());
    if (!it) throw new Error(`"${ref}" não está na lixeira.`);
    const ext = extname(it.name);
    const target = this.uniqueName(basename(it.name, ext), ext);
    renameSync(join(TRASH_DIR, it.trashed), join(SCORES_DIR, target));
    this.emit({ type: 'workspace' });
    return target;
  }

  rename(ref: string, newBase: string): string {
    const name = this.resolveName(ref);
    const ext = extname(name);
    const target = this.uniqueName(slug(newBase), ext);
    renameSync(join(SCORES_DIR, name), join(SCORES_DIR, target));
    const d = this.docs.get(name);
    if (d) {
      // mantém a ordem das abas
      const entries = [...this.docs.entries()].map(([k, v]) => (k === name ? [target, v] as const : [k, v] as const));
      this.docs = new Map(entries);
      d.name = target;
    }
    if (this.active === name) this.active = target;
    this.saveState();
    this.emit({ type: 'workspace' });
    return target;
  }

  setActive(name: string) {
    if (!this.docs.has(name)) throw new Error(`"${name}" não está aberto`);
    const changed = this.active !== name;
    this.active = name;
    this.saveState();
    if (changed) this.emit({ type: 'workspace' });
  }

  get current(): Doc {
    const d = this.active ? this.docs.get(this.active) : undefined;
    if (!d) throw new Error('Nenhum arquivo aberto. Use list_files e open_file, ou crie um com score_new.');
    return d;
  }

  get currentOrNull(): Doc | null { return (this.active && this.docs.get(this.active)) || null; }

  /** Documento alvo de uma ferramenta: o arquivo indicado (aberto e ativado) ou o ativo. */
  target(ref?: string): Doc { return ref ? this.open(ref, true) : this.current; }
}

export const workspace = new Workspace();
