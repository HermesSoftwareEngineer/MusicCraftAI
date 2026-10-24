// PDF vetorial: páginas A4 do Verovio impressas por um navegador Chromium em modo headless
// (Chrome ou Edge, que já vem no Windows). Fontes musicais e texto saem como vetores.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './store.ts';

const CANDIDATES = [
  process.env.PDF_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean) as string[];

export function pdfBrowser(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export function pagesHtml(pages: string[], title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>
@page { size: A4; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.pg { width: 210mm; height: 297mm; overflow: hidden; page-break-after: always; break-after: page }
.pg:last-child { page-break-after: auto; break-after: auto }
.pg svg { display: block; width: 210mm; height: 297mm }
</style></head><body>${pages.map((s) => `<div class="pg">${s}</div>`).join('')}</body></html>`;
}

/** Gera o PDF e devolve os bytes. */
export function svgPagesToPdf(pages: string[], title: string): Promise<Buffer> {
  const browser = pdfBrowser();
  if (!browser) return Promise.reject(new Error('Nenhum Chrome/Edge encontrado para gerar o PDF. Defina PDF_BROWSER.'));
  const work = join(DATA_DIR, 'pdf');
  mkdirSync(work, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const html = join(work, `${id}.html`);
  const out = join(work, `${id}.pdf`);
  writeFileSync(html, pagesHtml(pages, title));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--no-pdf-header-footer', `--user-data-dir=${join(work, 'perfil')}`, `--print-to-pdf=${out}`, pathToFileURL(html).href,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(browser, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => proc.kill(), 90_000);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      rmSync(html, { force: true });
      if (!existsSync(out)) return reject(new Error('O navegador não gerou o PDF.'));
      const buf = readFileSync(out);
      rmSync(out, { force: true });
      resolve(buf);
    });
  });
}
