// Teste de ida e volta: cada partitura .json de scores/ -> MusicXML -> importar -> deve ser idêntica.
// Ida e volta: JSON -> MusicXML -> importar -> comparar notação compacta
import { readFileSync, readdirSync } from 'node:fs';
import { toMusicXML } from '../src/musicxml.ts';
import { importMusicXML } from '../src/importxml.ts';
import { voiceToString, normalizeScore, chordsToString } from '../src/model.ts';
import type { Score } from '../src/model.ts';
const dump = (s: Score) => s.measures.map((m, i) => [
  `m${i + 1} k=${m.key ?? ''} t=${m.time ? `${m.time.count}/${m.time.unit}` : ''} b=${m.barline ?? ''} tempo=${m.tempo?.bpm ?? ''} ch=${chordsToString(m.chords)}`,
  ...s.parts.flatMap((p) => (m.content[p.id] ?? []).flatMap((st, si) => st.map((v, vi) => `${p.id}.${si}.${vi}: ${voiceToString(v)}`))),
].join('\n')).join('\n');
const files = readdirSync('scores').filter((f) => f.endsWith('.json') && !f.startsWith('sem_titulo'));
let bad = 0;
for (const f of files) {
  const orig = normalizeScore(JSON.parse(readFileSync(`scores/${f}`, 'utf8')));
  const { score, warnings } = importMusicXML(toMusicXML(orig));
  const a = dump(orig), b = dump(score);
  const same = a === b;
  if (!same) {
    bad++;
    const al = a.split('\n'), bl = b.split('\n');
    const i = al.findIndex((l, k) => l !== bl[k]);
    console.log(`✗ ${f}\n   original: ${al[i]}\n   importado: ${bl[i]}`);
  } else console.log(`✓ ${f}${warnings.length ? ` (avisos: ${warnings.join(' | ')})` : ''}`);
}
console.log(bad ? `${bad} diferença(s)` : 'ida e volta idêntica em todos');
process.exit(0);
