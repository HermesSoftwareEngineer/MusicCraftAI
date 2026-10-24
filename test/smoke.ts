// Teste ponta a ponta: daemon + ponte stdio + cliente MCP + WebSocket do visualizador.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const PORT = '4799';
const dir = mkdtempSync(join(tmpdir(), 'partitura-'));
const env = { ...process.env, PARTITURA_PORT: PORT, PARTITURA_DATA: dir, PARTITURA_SCORES: join(dir, 'scores'), PARTITURA_NO_BROWSER: '1' } as Record<string, string>;
const flags = ['--disable-warning=ExperimentalWarning'];
const daemon = spawn(process.execPath, [...flags, 'src/server.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise((r) => setTimeout(r, 1500));

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const frames: any[] = [];
ws.on('message', (d) => frames.push(JSON.parse(String(d))));

const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [...flags, 'src/bridge.ts'], env }));
const tools = await client.listTools();
console.log('ferramentas:', tools.tools.map((t) => t.name).join(', '));

let fails = 0;
async function call(name: string, args: any = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type} ${c.data?.length ?? 0} bytes]`)).join('\n');
  console.log(`\n> ${name}${r.isError ? ' (ERRO)' : ''}\n${t}`);
  return r;
}
const expectOk = (r: any, what: string) => { if (r.isError) { fails++; console.log('FALHOU:', what); } };
const expectErr = (r: any, what: string) => { if (!r.isError) { fails++; console.log('DEVIA FALHAR:', what); } };

expectOk(await call('score_new', { title: 'Ode à Alegria', composer: 'L. v. Beethoven', parts: [{ instrument: 'flute' }, { instrument: 'piano' }], key: 2, time: '4/4', tempo_bpm: 108, tempo_text: 'Allegro assai', measures: 4 }), 'score_new');
expectOk(await call('write_measures', { part: 'Flauta', start: 1, music: 'F#5/4[mf,slur(] F#5 G5 A5 | A5 G5 F#5 E5[slur)] | D5[slur(] D5 E5 F#5 | F#5/4. E5/8 E5/2[slur),ferm]' }), 'melodia');
expectOk(await call('write_measures', { part: 'P2', staff: 2, start: 1, music: '(D3 A3)/2 (D3 A3)/2 | (A2 E3)/2 (D3 A3)/2 | (B2 F#3)/2 (A2 E3)/2 | (A2 E3)/1' }), 'piano mão esquerda');
expectOk(await call('write_measures', { part: 'P2', staff: 1, start: 1, music: 'r/4 (F#4 A4)/4 r/4 (F#4 A4)/4 | r/4 (E4 A4) r (D4 F#4) | 3:2{D4/8 F#4 A4} r/4 r/2 | (C#4 E4 A4)/1' }), 'piano mão direita');
expectErr(await call('write_measures', { part: 'P1', start: 1, music: 'H4/4' }), 'altura inválida');
expectOk(await call('write_measures', { part: 'P1', start: 5, music: 'D5/4 E5' }), 'compasso incompleto (aviso)');
expectOk(await call('read_measures', { from: 1, to: 5 }), 'read');
expectOk(await call('transpose', { interval: 'M2' }), 'transpose');
expectOk(await call('score_info'), 'info');
expectOk(await call('undo'), 'undo');
expectOk(await call('set_measure_attributes', { measure: 3, time: '3/4' }), 'attrs');
expectOk(await call('undo'), 'undo2');
expectOk(await call('delete_measures', { from: 5 }), 'delete');
const snap = await call('snapshot', { from: 1, to: 4 });
expectOk(snap, 'snapshot');
const img = snap.content.find((c: any) => c.type === 'image');
if (img) writeFileSync(join(dir, 'snap.png'), Buffer.from(img.data, 'base64'));
for (const f of ['musicxml', 'midi', 'mei']) expectOk(await call('export_score', { format: f, filename: 'ode' }), `export ${f}`);
expectErr(await call('export_score', { format: 'musicxml', filename: '../../hack' }).then(() => (existsSync(join(dir, '..', 'hack.musicxml')) ? { isError: false } : { isError: true })), 'path traversal');

// ---- vários arquivos ----
expectOk(await call('score_new', { title: 'Segunda peça', parts: [{ instrument: 'cello' }], measures: 2 }), 'segundo arquivo');
expectOk(await call('write_measures', { part: 1, start: 1, music: 'C3/1 | G2/1' }), 'escreve no ativo (segunda)');
expectOk(await call('write_measures', { file: 'ode_a_alegria', part: 'P1', start: 1, music: 'A5/1' }), 'escreve por nome');
expectOk(await call('duplicate_file', { new_name: 'ode-versao-b' }), 'duplicar');
expectOk(await call('open_file', { file: 'ode.musicxml' }), 'abrir musicxml');
expectErr(await call('write_measures', { part: 1, start: 1, music: 'C4/1' }), 'editar arquivo só-visualização');
expectOk(await call('snapshot', {}), 'snapshot de musicxml');
expectOk(await call('close_file', { file: 'ode.musicxml' }), 'fechar aba');
const lf = await call('list_files', {});
expectOk(lf, 'list_files');
const listing = lf.content[0].text as string;
for (const n of ['ode_a_alegria.json', 'segunda_peca.json', 'ode-versao-b.json', 'ode.musicxml']) if (!listing.includes(n)) { fails++; console.log('FALTA NA LISTA:', n); }
const info = await call('score_info', { file: 'segunda_peca' });
if (!info.content[0].text.includes('segunda_peca.json')) { fails++; console.log('score_info sem arquivo'); }

await new Promise((r) => setTimeout(r, 300));
const scores = frames.filter((f) => f.type === 'score');
const wsMsgs = frames.filter((f) => f.type === 'workspace');
console.log(`workspace: ${wsMsgs.length} mensagens, abas finais: ${wsMsgs.at(-1)?.tabs.map((t: any) => t.name).join(', ')}, ativo: ${wsMsgs.at(-1)?.active}`);
console.log(`\nWebSocket: ${frames.length} quadros, último v${scores.at(-1)?.version}, svg ${scores.at(-1)?.svg.length} bytes, midi ${scores.at(-1)?.midi.length}, notas ${scores.at(-1)?.notes.length}, alterados no 1º write: ${scores[1]?.changed?.length}`);
if (!scores.length || frames.some((f) => f.type === 'error')) fails++;
console.log(`\nPNG: ${join(dir, 'snap.png')}\n${fails ? `❌ ${fails} falha(s)` : '✅ tudo certo'}`);
await client.close();
ws.close();
daemon.kill();
process.exit(fails ? 1 : 0);
