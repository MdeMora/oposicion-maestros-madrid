import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLAZAS_2024 = 343;
const PLAZAS_2026 = 64;
const PDF_2024_SRC = "lista_prov_baremo_pri_2024.pdf";
const PDF_2026_SRC = "lista_prov_baremo_pri_2026.pdf";
const PDF_2024_PUBLIC = "/documents/lista-prov-baremo-pri-2024.pdf";
const PDF_2026_PUBLIC = "/documents/lista-prov-baremo-pri-2026.pdf";

function selectedFinalists(finalists: FinalistRecord[]): FinalistRecord[] {
  return finalists.filter((f): f is FinalistRecord & { order: number } =>
    typeof f.order === "number" && f.order <= PLAZAS_2024,
  );
}

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

/** 2024 PDF: no column 2.5; formación splits 3.4 into 3.4 / 3.4.1 / 3.4.2. */
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

type SlashVal = { score: number; count: number };
type Subscore = number | SlashVal;

export type BaremoRecord = {
  id: string;
  dni: string;
  nombre: string;
  total: number;
  pdfPage: number;
  subscores: Record<string, Subscore>;
};

export type FinalistRecord = {
  id: string;
  order: number | "R";
  dni: string;
  nombre: string;
  finalScore: number;
};

export type RepeaterRecord = {
  id: string;
  dni: string;
  nombre: string;
  baremo2024: number;
  baremo2026: number;
  deltaBaremo: number;
  rank2024: number;
  rank2026: number;
  gotPlaza2024: boolean;
  finalScore2024: number | null;
  examScore2024: number | null;
  pdfPage2024: number;
  categories2024: { servicios: number; meritos: number; formacion: number };
  categories2026: { servicios: number; meritos: number; formacion: number };
  categoryDelta: { servicios: number; meritos: number; formacion: number };
};

export type MetaRecord = {
  plazas2024: number;
  plazas2026: number;
  cutoffFinal2024: number;
  examScores2024: number[];
  participants2024: number;
  participants2026: number;
  repeaters: number;
  baremoPdf2024: string;
  baremoPdf2026: string;
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

export function normName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

export function dniSuffix(dni: string): string {
  return dni.replace(/\*/g, "").slice(-4);
}

function subscoreValue(v: Subscore): number {
  return typeof v === "number" ? v : v.score;
}

function categoryTotals(subscores: Record<string, Subscore>): { servicios: number; meritos: number; formacion: number } {
  return {
    servicios: subscoreValue(subscores["1"]),
    meritos: subscoreValue(subscores["2"]),
    formacion: subscoreValue(subscores["3"]),
  };
}

function rankByTotal(records: BaremoRecord[]): Map<string, number> {
  const sorted = [...records].sort((a, b) => b.total - a.total);
  const ranks = new Map<string, number>();
  let curRank = 1;
  let prevTotal = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].total < prevTotal) {
      curRank = i + 1;
      prevTotal = sorted[i].total;
    }
    ranks.set(sorted[i].dni, curRank);
  }
  return ranks;
}

type BaremoConfig = {
  pdf: string;
  dniRe: RegExp;
  subscoreKeys: string[];
};

type ExtractedLine = { type: "start" | "cont"; text: string; page: number };

async function extractLines(pdfPath: string, dniRe: RegExp): Promise<ExtractedLine[]> {
  const buf = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  const doc = await getDocument({ data: buf }).promise;
  console.log(`${pdfPath.split("/").pop()}: ${doc.numPages} pages`);

  const lines: ExtractedLine[] = [];
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
      if (dniRe.test(text)) lines.push({ type: "start", text, page: p });
      else lines.push({ type: "cont", text, page: p });
    }
  }
  return lines;
}

async function parseBaremo(config: BaremoConfig): Promise<BaremoRecord[]> {
  const lines = await extractLines(config.pdf, config.dniRe);
  const records: BaremoRecord[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "start") continue;
    const startText = lines[i].text;
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
    if (cont.length !== 4) { skipped++; continue; }

    const dniMatch = startText.match(config.dniRe);
    if (!dniMatch) { skipped++; continue; }
    const dni = dniMatch[0];
    const afterDni = startText.slice(startText.indexOf(dni) + dni.length);
    const nums = [...afterDni.matchAll(NUM_RE)];
    if (nums.length === 0) { skipped++; continue; }

    const total = parseNum(nums[0][0]);
    let nombre = afterDni.slice(0, nums[0].index!).replace(/\|/g, "").trim();
    if (nameOverflow.length) nombre += " " + nameOverflow.join(" ");
    nombre = nombre.replace(/\s+/g, " ");

    const allNums: string[] = [];
    for (const line of cont) {
      for (const m of line.matchAll(NUM_RE)) allNums.push(m[0]);
    }
    if (allNums.length !== config.subscoreKeys.length) {
      skipped++;
      continue;
    }

    const subscores: Record<string, Subscore> = {};
    for (let k = 0; k < config.subscoreKeys.length; k++) {
      const raw = allNums[k];
      if (SLASH_IDX.has(k)) {
        const [a, b] = raw.split("/");
        subscores[config.subscoreKeys[k]] = { score: parseNum(a), count: parseInt(b, 10) };
      } else {
        subscores[config.subscoreKeys[k]] = parseNum(raw);
      }
    }

    records.push({
      id: `r${records.length}`,
      dni,
      nombre,
      total,
      pdfPage: lines[i].page,
      subscores,
    });
  }

  console.log(`  parsed ${records.length}, skipped ${skipped}`);
  return records;
}

async function parseFinalists(pdfPath: string): Promise<FinalistRecord[]> {
  const dniRe = /\*{5}\d+/;
  const lines = await extractLines(pdfPath, dniRe);
  const people: FinalistRecord[] = [];

  for (const line of lines) {
    if (line.type !== "start") continue;
    const text = line.text;
    const orderMatch = text.match(/^([R]|\d+)\s/);
    const dniMatch = text.match(dniRe);
    if (!dniMatch) continue;

    const dni = dniMatch[0];
    const afterDni = text.slice(text.indexOf(dni) + dni.length).trim();
    const scoreMatch = afterDni.match(/(\d+,\d+)\s*$/);
    if (!scoreMatch) continue;

    const finalScore = parseNum(scoreMatch[1]);
    const namePart = afterDni.slice(0, scoreMatch.index!).trim();
    const orderRaw = orderMatch?.[1] ?? "?";
    const order: number | "R" = orderRaw === "R" ? "R" : parseInt(orderRaw, 10);

    people.push({ id: `f${people.length}`, order, dni, nombre: namePart, finalScore });
  }

  console.log(`  finalists: ${people.length}`);
  return people;
}

function buildRepeaters(
  baremo2024: BaremoRecord[],
  baremo2026: BaremoRecord[],
  finalists: FinalistRecord[],
): RepeaterRecord[] {
  const finMap = new Map(finalists.map((f) => [dniSuffix(f.dni), f]));
  const map2026ByDni = new Map(baremo2026.map((r) => [dniSuffix(r.dni), r]));
  const map2026ByName = new Map(baremo2026.map((r) => [normName(r.nombre), r]));
  const ranks2024 = rankByTotal(baremo2024);
  const ranks2026 = rankByTotal(baremo2026);

  const repeaters: RepeaterRecord[] = [];
  for (const b24 of baremo2024) {
    const b26 = map2026ByDni.get(dniSuffix(b24.dni)) ?? map2026ByName.get(normName(b24.nombre));
    if (!b26) continue;

    const fin = finMap.get(dniSuffix(b24.dni));
    const gotPlaza =
      !!fin && typeof fin.order === "number" && fin.order <= PLAZAS_2024;
    const cat24 = categoryTotals(b24.subscores);
    const cat26 = categoryTotals(b26.subscores);

    repeaters.push({
      id: `rep${repeaters.length}`,
      dni: b24.dni,
      nombre: b24.nombre,
      baremo2024: b24.total,
      baremo2026: b26.total,
      deltaBaremo: b26.total - b24.total,
      rank2024: ranks2024.get(b24.dni) ?? 0,
      rank2026: ranks2026.get(b26.dni) ?? 0,
      gotPlaza2024: gotPlaza,
      finalScore2024: fin?.finalScore ?? null,
      examScore2024: fin ? fin.finalScore - b24.total : null,
      pdfPage2024: b24.pdfPage,
      categories2024: cat24,
      categories2026: cat26,
      categoryDelta: {
        servicios: cat26.servicios - cat24.servicios,
        meritos: cat26.meritos - cat24.meritos,
        formacion: cat26.formacion - cat24.formacion,
      },
    });
  }

  repeaters.sort((a, b) => b.deltaBaremo - a.deltaBaremo);
  console.log(`  repeaters: ${repeaters.length}`);
  return repeaters;
}

async function publishBaremoPdfs() {
  const outDir = resolve(ROOT, "public/documents");
  await mkdir(outDir, { recursive: true });
  await copyFile(resolve(ROOT, PDF_2024_SRC), resolve(outDir, PDF_2024_PUBLIC.slice("/documents/".length)));
  await copyFile(resolve(ROOT, PDF_2026_SRC), resolve(outDir, PDF_2026_PUBLIC.slice("/documents/".length)));
}

async function main() {
  await publishBaremoPdfs();

  const baremo2026 = await parseBaremo({
    pdf: resolve(ROOT, PDF_2026_SRC),
    dniRe: /\*{4}\d+\*/,
    subscoreKeys: SUBSCORE_KEYS_2026,
  });

  const baremo2024 = await parseBaremo({
    pdf: resolve(ROOT, PDF_2024_SRC),
    dniRe: /\*{5}\d+/,
    subscoreKeys: SUBSCORE_KEYS_2024,
  });

  const finalists = await parseFinalists(resolve(ROOT, "result_2024.pdf"));
  const repeaters = buildRepeaters(baremo2024, baremo2026, finalists);

  const selected = selectedFinalists(finalists);
  const cutoffByOrder = selected.find((f) => f.order === PLAZAS_2024);

  const examScores2024 = selected
    .map((f) => {
      const b = baremo2024.find((x) => dniSuffix(x.dni) === dniSuffix(f.dni));
      return b ? f.finalScore - b.total : null;
    })
    .filter((x): x is number => x !== null);

  const meta: MetaRecord = {
    plazas2024: PLAZAS_2024,
    plazas2026: PLAZAS_2026,
    cutoffFinal2024:
      cutoffByOrder?.finalScore ??
      Math.min(...selected.map((f) => f.finalScore), Number.POSITIVE_INFINITY),
    examScores2024,
    participants2024: baremo2024.length,
    participants2026: baremo2026.length,
    repeaters: repeaters.length,
    baremoPdf2024: PDF_2024_PUBLIC,
    baremoPdf2026: PDF_2026_PUBLIC,
  };

  const outDir = resolve(ROOT, "src/data");
  await mkdir(outDir, { recursive: true });

  await writeFile(resolve(outDir, "baremo.json"), JSON.stringify(baremo2026));
  await writeFile(resolve(outDir, "baremo-2024.json"), JSON.stringify(baremo2024));
  await writeFile(resolve(outDir, "finalists-2024.json"), JSON.stringify(finalists));
  await writeFile(resolve(outDir, "repeaters.json"), JSON.stringify(repeaters));
  await writeFile(resolve(outDir, "meta.json"), JSON.stringify(meta));

  console.log("wrote src/data/{baremo,baremo-2024,finalists-2024,repeaters,meta}.json");
}

main();
