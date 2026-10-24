// Demonstração ao vivo na instância real (porta 4700): abre o navegador e escreve em etapas.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'demo', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', 'src/bridge.ts'] }));
const call = async (name: string, args: any) => {
  const r: any = await c.callTool({ name, arguments: args });
  console.log(`${name}: ${r.isError ? 'ERRO ' : ''}${r.content[0].text?.split('\n')[0] ?? ''}`);
  await new Promise((res) => setTimeout(res, 1800));
};
await call('score_new', { title: 'Ode à Alegria', subtitle: 'Demonstração do partitura-mcp', composer: 'L. v. Beethoven', parts: [{ instrument: 'violin' }, { instrument: 'piano' }], key: 2, tempo_bpm: 100, tempo_text: 'Allegro assai', measures: 8 });
await new Promise((res) => setTimeout(res, 2500));
await call('write_measures', { part: 'P1', start: 1, music: 'F#5/4[mf,slur(] F#5 G5 A5 | A5 G5 F#5 E5[slur)] | D5[slur(] D5 E5 F#5 | F#5/4. E5/8 E5/2[slur)]' });
await call('write_measures', { part: 'P1', start: 5, music: 'F#5/4[slur(] F#5 G5 A5 | A5 G5 F#5 E5[slur)] | D5[slur(,cresc(] D5 E5 F#5[cresc)] | E5/4.[f] D5/8 D5/2[slur),ferm]' });
await call('write_measures', { part: 'P2', staff: 2, start: 1, music: '(D3 A3)/2 (D3 A3) | (A2 E3) (D3 A3) | (B2 F#3) (G2 D3) | (A2 E3)/1 | (D3 A3)/2 (D3 A3) | (A2 E3) (D3 A3) | (B2 F#3) (G2 D3) | (A2 E3)/2 (D2 A2)/2[ferm]' });
await call('write_measures', { part: 'P2', staff: 1, start: 1, music: 'r/4 (F#4 A4) r (F#4 A4) | r (E4 A4) r (D4 F#4) | r (D4 F#4) r (D4 G4) | (C#4 E4 A4)/1 | r/4 (F#4 A4) r (F#4 A4) | r (E4 A4) r (D4 F#4) | r (D4 F#4) r (D4 G4) | (C#4 E4 G4)/2 (D4 F#4 A4)/2[ferm]' });
await c.close();
