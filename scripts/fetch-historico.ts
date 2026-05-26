/**
 * Builds src/data/convocatorias-historico.json from BOE plazas + baremo PDFs when available.
 * Run: bun scripts/fetch-historico.ts
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "src/data/convocatorias-historico.json");
const DOCS = resolve(ROOT, "public/documents");
const CACHE = resolve(ROOT, "scripts/.cache");

const NUM_RE = /\d+,\d+(?:\/\d+)?/g;
const HEADER_TOKENS = [
  "D.N.I.", "AÑOS", "MESES", "CUERPO", "ESPECIALIDAD", "ACCESO", "Fecha:", "Página:",
  "PROCEDIMIENTO", "MAESTROS", "FUNCIONARIOS", "RESOLUCIÓN", "LISTA", "ORDEN", "PRIMER",
  "ANEXO", "PUNTUACION", "SELECCIONADOS",
];

const SUBSCORE_KEYS_2026 = [
  "1", "1.1", "1.1.1", "1.1.2", "1.2", "1.2.1", "1.2.2", "1.3", "1.3.1", "1.3.2", "1.4",
  "1.4.1", "1.4.2", "2", "2.1", "2.2", "2.2.1", "2.2.2", "2.2.3", "2.3", "2.3.1", "2.3.2",
  "2.4", "2.4.1", "2.4.2", "2.4.3", "2.4.4", "2.4.5", "2.5", "3", "3.1", "3.2", "3.3",
  "3.3.1", "3.3.2", "3.4", "3.5",
];

const SUBSCORE_KEYS_2024 = [
  ...SUBSCORE_KEYS_2026.slice(0, SUBSCORE_KEYS_2026.indexOf("2.5")),
  ...SUBSCORE_KEYS_2026.slice(
    SUBSCORE_KEYS_2026.indexOf("3"),
    SUBSCORE_KEYS_2026.indexOf("3.4"),
  ),
  "3.4",
  "3.4.1",
  "3.4.2",
  "3.5",
];

const SLASH_IDX = new Set([2, 3, 5, 6, 8, 9, 11, 12]);

export type ConvocatoriaHistorico = {
  year: number;
  tipo: "oposicion" | "estabilizacion" | "sin_convocatoria" | "ope";
  label: string;
  plazasPrimaria: number | null;
  plazasPrimariaAmpliadas: number | null;
  plazasConResultado: number | null;
  participantes: number | null;
  baremoMedio: number | null;
  baremoMediana: number | null;
  baremoCorte: number | null;
  notaFinalCorte: number | null;
  tieneBaremoDetalle: boolean;
  baremoPdf: string | null;
  boeRef: string | null;
  notas: string | null;
};

type BaremoRow = { total: number };

type YearSeed = Omit<
  ConvocatoriaHistorico,
  "participantes" | "baremoMedio" | "baremoMediana" | "baremoCorte" | "notaFinalCorte" | "tieneBaremoDetalle" | "baremoPdf"
>;

const SEEDS: YearSeed[] = [
  {
    year: 2016,
    tipo: "sin_convocatoria",
    label: "Sin oposición Maestros",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: "BOE-A-2016-3564",
    notas: "Solo Secundaria, FP y EOI. Maestros en OPE acumulada.",
  },
  {
    year: 2017,
    tipo: "oposicion",
    label: "Oposición Maestros",
    plazasPrimaria: 200,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: "BOE-A-2017-4894",
    notas: null,
  },
  {
    year: 2018,
    tipo: "sin_convocatoria",
    label: "Sin oposición Maestros",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: null,
    notas: "Plazas acumuladas en OPE 2019 (2.424 maestros totales).",
  },
  {
    year: 2019,
    tipo: "oposicion",
    label: "Oposición Maestros",
    plazasPrimaria: 473,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: "BOE-A-2019-3447",
    notas: null,
  },
  {
    year: 2020,
    tipo: "sin_convocatoria",
    label: "Sin oposición Maestros",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: "BOE-A-2020-4236",
    notas: "Convocatoria 2.903 plazas solo Secundaria, FP, EOI y RE.",
  },
  {
    year: 2021,
    tipo: "sin_convocatoria",
    label: "Sin oposición Maestros",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: null,
    notas: "OPE 2021: 92 plazas maestros pendientes de convocar.",
  },
  {
    year: 2022,
    tipo: "oposicion",
    label: "Oposición Maestros",
    plazasPrimaria: 326,
    plazasPrimariaAmpliadas: 549,
    plazasConResultado: null,
    boeRef: "BOE-A-2022-2090",
    notas: "Además, estabilización dic. 2022: 64 plazas PRI (BOE-A-2022-23858).",
  },
  {
    year: 2023,
    tipo: "sin_convocatoria",
    label: "Sin oposición ingreso",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: null,
    notas: "OPE 2023: 457 plazas maestros. Concurso de méritos extraordinario, no baremo PRI publicado en sede.",
  },
  {
    year: 2024,
    tipo: "oposicion",
    label: "Reposición Maestros",
    plazasPrimaria: 174,
    plazasPrimariaAmpliadas: 454,
    plazasConResultado: 343,
    boeRef: "BOE-A-2024-3044",
    notas: "Ampliación BOE-A-2024-12653. Lista seleccionados publicada con 343 plazas efectivas.",
  },
  {
    year: 2025,
    tipo: "ope",
    label: "OPE 2025 (sin convocatoria)",
    plazasPrimaria: null,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: null,
    notas: "791 plazas maestros en OPE 2025; convocatoria de ingreso en 2026.",
  },
  {
    year: 2026,
    tipo: "oposicion",
    label: "Oposición Maestros",
    plazasPrimaria: 64,
    plazasPrimariaAmpliadas: null,
    plazasConResultado: null,
    boeRef: "BOE-A-2026-3765",
    notas: "Baremo provisional mayo 2026. Examen pendiente.",
  },
];

const PDF_SOURCES: Record<
  number,
  { local?: string; sedeSlug?: string; publicName: string; dniRe: RegExp; keys: string[] }
> = {
  2024: {
    local: "lista_prov_baremo_pri_2024.pdf",
    publicName: "lista-prov-baremo-pri-2024.pdf",
    dniRe: /\*{5}\d+/,
    keys: SUBSCORE_KEYS_2024,
  },
  2026: {
    local: "lista_prov_baremo_pri_2026.pdf",
    sedeSlug: "listaprovbaremopri2026pdf",
    publicName: "lista-prov-baremo-pri-2026.pdf",
    dniRe: /\*{4}\d+\*/,
    keys: SUBSCORE_KEYS_2026,
  },
};

function parseNum(s: string): number {
  return parseFloat(s.replace(",", "."));
}

function toLine(items: { x: number; s: string }[]): string {
  return items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ");
}

function isHeaderOrFooter(text: string): boolean {
  return HEADER_TOKENS.some((t) => text.includes(t));
}

async function extractLines(pdfPath: string, dniRe: RegExp) {
  const buf = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  const doc = await getDocument({ data: buf }).promise;
  const lines: { type: "start" | "cont"; text: string }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as { str?: string; transform: number[] }[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5]);
      const arr = byY.get(y) ?? [];
      arr.push({ x: it.transform[4], s: it.str });
      byY.set(y, arr);
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      const text = toLine(byY.get(y)!);
      if (isHeaderOrFooter(text)) continue;
      if (dniRe.test(text)) lines.push({ type: "start", text });
      else lines.push({ type: "cont", text });
    }
  }
  return lines;
}

async function parseBaremoPdf(
  pdfPath: string,
  dniRe: RegExp,
  subscoreKeys: string[],
): Promise<BaremoRow[]> {
  const lines = await extractLines(pdfPath, dniRe);
  const records: BaremoRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "start") continue;
    const cont: string[] = [];
    const nameOverflow: string[] = [];
    let j = i + 1;
    while (j < lines.length && cont.length < 4 && lines[j].type === "cont") {
      const lt = lines[j].text;
      if (NUM_RE.test(lt)) cont.push(lt);
      else nameOverflow.push(lt.replace(/\|/g, "").trim());
      NUM_RE.lastIndex = 0;
      j++;
    }
    if (cont.length !== 4) continue;
    const dniMatch = lines[i].text.match(dniRe);
    if (!dniMatch) continue;
    const afterDni = lines[i].text.slice(lines[i].text.indexOf(dniMatch[0]) + dniMatch[0].length);
    const nums = [...afterDni.matchAll(NUM_RE)];
    if (nums.length === 0) continue;
    const total = parseNum(nums[0][0]);
    const allNums: string[] = [];
    for (const line of cont) {
      for (const m of line.matchAll(NUM_RE)) allNums.push(m[0]);
    }
    if (allNums.length !== subscoreKeys.length) continue;
    records.push({ total });
  }
  return records;
}

function baremoStats(totals: number[], plazas: number) {
  const sorted = [...totals].sort((a, b) => b - a);
  const n = sorted.length;
  if (n === 0) return null;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = sorted[Math.floor(n / 2)];
  const cutoffIdx = Math.min(Math.max(plazas, 1), n) - 1;
  return {
    participantes: n,
    baremoMedio: round4(mean),
    baremoMediana: round4(median),
    baremoCorte: round4(sorted[cutoffIdx]),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

async function loadPdf(year: number): Promise<string | null> {
  const src = PDF_SOURCES[year];
  if (!src) return null;
  await mkdir(CACHE, { recursive: true });
  await mkdir(DOCS, { recursive: true });

  const localPath = src.local ? resolve(ROOT, src.local) : null;
  if (localPath && (await Bun.file(localPath).exists())) {
    const dest = resolve(DOCS, src.publicName);
    await copyFile(localPath, dest);
    return dest;
  }

  if (src.sedeSlug) {
    const cachePath = resolve(CACHE, `${src.sedeSlug}.pdf`);
    const res = await fetch(`https://sede.comunidad.madrid/medias/${src.sedeSlug}/download`);
    if (res.ok) {
      await Bun.write(cachePath, await res.arrayBuffer());
      const dest = resolve(DOCS, src.publicName);
      await copyFile(cachePath, dest);
      return dest;
    }
  }

  const dest = resolve(DOCS, src.publicName);
  if (await Bun.file(dest).exists()) return dest;
  return null;
}

async function loadFinal2024Cutoff(plazas: number): Promise<number | null> {
  const path = resolve(ROOT, "src/data/finalists-2024.json");
  if (!(await Bun.file(path).exists())) return null;
  const finalists = (await Bun.file(path).json()) as {
    order: number | "R";
    finalScore: number;
  }[];
  const selected = finalists.filter(
    (f): f is { order: number; finalScore: number } =>
      typeof f.order === "number" && f.order <= plazas,
  );
  const atCutoff = selected.find((f) => f.order === plazas);
  if (atCutoff) return round4(atCutoff.finalScore);
  if (selected.length === 0) return null;
  return round4(Math.min(...selected.map((f) => f.finalScore)));
}

async function main() {
  const cutoffFinal2024 = await loadFinal2024Cutoff(343);
  const out: ConvocatoriaHistorico[] = [];

  for (const seed of SEEDS) {
    const entry: ConvocatoriaHistorico = {
      ...seed,
      participantes: null,
      baremoMedio: null,
      baremoMediana: null,
      baremoCorte: null,
      notaFinalCorte: null,
      tieneBaremoDetalle: false,
      baremoPdf: null,
    };

    const pdfSrc = PDF_SOURCES[seed.year];
    if (pdfSrc) {
      const pdfPath = await loadPdf(seed.year);
      if (pdfPath) {
        console.log(`Parsing baremo ${seed.year}: ${pdfPath}`);
        const rows = await parseBaremoPdf(pdfPath, pdfSrc.dniRe, pdfSrc.keys);
        const plazas =
          seed.plazasConResultado ??
          seed.plazasPrimariaAmpliadas ??
          seed.plazasPrimaria ??
          0;
        const stats = baremoStats(
          rows.map((r) => r.total),
          plazas,
        );
        if (stats) {
          Object.assign(entry, stats);
          entry.tieneBaremoDetalle = true;
          entry.baremoPdf = `/documents/${pdfSrc.publicName}`;
        }
      }
    }

    if (seed.year === 2024 && cutoffFinal2024 != null) {
      entry.notaFinalCorte = cutoffFinal2024;
    }

    out.push(entry);
  }

  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT} (${out.length} years)`);
}

main();
