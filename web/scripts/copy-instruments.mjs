// Copies the deployable instrument JSON files into public/instruments and writes
// an index.json registry the app reads at runtime. No questionnaire content lives in code.
// buildRegistry() is also imported by the tests, which never write to disk.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '..');

export function buildRegistry() {
  const deploy = JSON.parse(readFileSync(join(webDir, 'instruments.deploy.json'), 'utf8'));
  const index = [];
  const files = {};
  for (const rel of deploy.instruments) {
    const inst = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
    if (inst.format !== 'beginners.instrument/1') throw new Error(`${rel}: unknown format ${inst.format}`);
    if (inst.status === 'RETIRED' || inst.status === 'DRAFT') throw new Error(`${rel}: status ${inst.status} is not deployable`);
    const file = `${inst.instrument_version_id}.json`;
    const systemFill = (deploy.system_fill ?? {})[inst.instrument_version_id] ?? {};
    const ids = new Set(inst.sections.flatMap((s) => s.questions.map((q) => q.id)));
    for (const [qid, source] of Object.entries(systemFill)) {
      if (!ids.has(qid)) throw new Error(`system_fill: ${inst.instrument_version_id} has no question ${qid}`);
      if (source !== 'school_code') throw new Error(`system_fill: unknown source ${source}`);
    }
    files[file] = inst;
    index.push({
      instrument_version_id: inst.instrument_version_id,
      instrument_id: inst.instrument_id,
      title: inst.title,
      respondent_type: inst.respondent_type,
      class_range: inst.class_range ?? [],
      status: inst.status,
      system_fill: systemFill,
      file,
    });
  }
  return { index, files };
}

function main() {
  const outDir = join(webDir, 'public', 'instruments');
  const { index, files } = buildRegistry();
  mkdirSync(outDir, { recursive: true });
  // Remove versions no longer deployed, without deleting the folder (dev servers watch it).
  for (const f of readdirSync(outDir)) if (f.endsWith('.json') && f !== 'index.json' && !(f in files)) unlinkSync(join(outDir, f));
  for (const [f, inst] of Object.entries(files)) writeFileSync(join(outDir, f), JSON.stringify(inst));
  writeFileSync(join(outDir, 'index.json'), JSON.stringify({ instruments: index }, null, 2));
  console.log(`Copied ${index.length} instruments to public/instruments`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
