import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Title,
  Filler,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import { Bar, Line } from "react-chartjs-2";
import {
  rankRows,
  formatNum,
  normName,
  estimateProbability,
  empiricalPlazaRate,
  type ProbabilityResult,
} from "../lib/stats";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Title,
  Filler,
  annotationPlugin,
);

type Row = { dni: string; nombre: string; total: number };
type Ranked = Row & { rank: number; idx: number };

type Repeater = {
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
  categoryDelta: { servicios: number; meritos: number; formacion: number };
};

type Meta = {
  plazas2024: number;
  plazas2026: number;
  cutoffFinal2024: number;
  examScores2024: number[];
  participants2024: number;
  participants2026: number;
  repeaters: number;
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function nameMatchScore(name: string, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (name.startsWith(token)) score += 100;
    else if (name.includes(`, ${token}`)) score += 80;
    else if (name.includes(` ${token}`)) score += 60;
    else if (name.includes(token)) score += 20;
  }
  return score;
}

function searchByName(ranked: Ranked[], query: string, fuse: Fuse<Ranked>): Ranked[] {
  const normalized = stripAccents(query.trim());
  if (!normalized) return [];

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const substringMatches = ranked.filter((r) => {
    const name = stripAccents(r.nombre);
    return tokens.every((token) => name.includes(token));
  });

  if (substringMatches.length > 0) {
    return substringMatches.sort((a, b) => {
      const scoreDiff =
        nameMatchScore(stripAccents(b.nombre), tokens) -
        nameMatchScore(stripAccents(a.nombre), tokens);
      if (scoreDiff !== 0) return scoreDiff;
      return a.nombre.localeCompare(b.nombre, "es");
    });
  }

  return fuse.search(normalized).map((r) => r.item);
}

function HighlightName({ name, query }: { name: string; query: string }) {
  const tokens = stripAccents(query.trim())
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return <>{name}</>;

  const pattern = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const parts = name.split(new RegExp(`(${pattern})`, "gi"));

  return (
    <>
      {parts.map((part, i) =>
        tokens.some((t) => stripAccents(part) === t) ? (
          <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-inherit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function dniSuffix(dni: string): string {
  return dni.replace(/\*/g, "").slice(-4);
}

function pct(n: number): string {
  return (n * 100).toFixed(1).replace(".", ",") + "%";
}

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}

function ProbBar({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-neutral-600">{label}</span>
        <span className="font-mono font-semibold">{pct(value)}</span>
      </div>
      <div className="h-2.5 rounded-full bg-neutral-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-600 transition-all duration-500"
          style={{ width: `${Math.min(value * 100, 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function BaremoApp({
  rows,
  repeaters,
  meta,
}: {
  rows: Row[];
  repeaters: Repeater[];
  meta: Meta;
}) {
  const ranked = useMemo(() => rankRows(rows), [rows]);
  const total = ranked.length;
  const allBaremoTotals = useMemo(() => rows.map((r) => r.total), [rows]);

  const repeaterByDni = useMemo(
    () => new Map(repeaters.map((r) => [dniSuffix(r.dni), r])),
    [repeaters],
  );
  const repeaterByName = useMemo(
    () => new Map(repeaters.map((r) => [normName(r.nombre), r])),
    [repeaters],
  );

  const fuse = useMemo(
    () =>
      new Fuse(ranked, {
        keys: ["nombre"],
        threshold: 0.3,
        ignoreLocation: true,
        getFn: (obj, path) => {
          const key = Array.isArray(path) ? path[0] : (path as string);
          const v = (obj as Record<string, unknown>)[key];
          return typeof v === "string" ? stripAccents(v) : v;
        },
      }),
    [ranked],
  );

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 1000);
  const [selected, setSelected] = useState<Ranked | null>(null);
  const [open, setOpen] = useState(false);
  const [probability, setProbability] = useState<ProbabilityResult | null>(null);
  const [probLoading, setProbLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const isSearching = query.trim() !== debouncedQuery.trim() && query.trim().length > 0;

  const matches = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    return searchByName(ranked, debouncedQuery, fuse);
  }, [debouncedQuery, fuse, ranked]);

  useEffect(() => {
    const h = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, []);

  const selectedRepeater = useMemo(() => {
    if (!selected) return null;
    return repeaterByDni.get(dniSuffix(selected.dni)) ?? repeaterByName.get(normName(selected.nombre)) ?? null;
  }, [selected, repeaterByDni, repeaterByName]);

  const stats = useMemo(() => {
    if (!selected) return null;
    let betterCount = 0;
    let worseCount = 0;
    let tiedCount = 0;
    for (const r of ranked) {
      if (r.idx === selected.idx) continue;
      if (r.total > selected.total) worseCount++;
      else if (r.total < selected.total) betterCount++;
      else tiedCount++;
    }
    const percentile = (betterCount / (total - 1 || 1)) * 100;
    return { betterCount, worseCount, tiedCount, percentile };
  }, [selected, ranked, total]);

  useEffect(() => {
    if (!selected) {
      setProbability(null);
      setProbLoading(false);
      return;
    }

    let cancelled = false;
    setProbability(null);
    setProbLoading(true);

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const empirical = empiricalPlazaRate(selected.total, repeaters);
      const result = estimateProbability(
        selected.total,
        meta.examScores2024,
        allBaremoTotals,
        meta.plazas2026,
        meta.plazas2024,
        empirical,
      );
      if (!cancelled) {
        setProbability(result);
        setProbLoading(false);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, repeaters, meta, allBaremoTotals]);

  const histogram = useMemo(() => {
    const min = 0;
    const max = Math.max(...ranked.map((r) => r.total));
    const binSize = 0.5;
    const nBins = Math.ceil((max - min) / binSize) + 1;
    const bins = new Array(nBins).fill(0);
    for (const r of ranked) {
      const i = Math.floor((r.total - min) / binSize);
      bins[i]++;
    }
    const labels = bins.map((_, i) => formatNum(min + i * binSize, 1));
    let selectedBinIdx = -1;
    if (selected) selectedBinIdx = Math.floor((selected.total - min) / binSize);
    return { bins, labels, selectedBinIdx };
  }, [ranked, selected]);

  const rank343Score = ranked[Math.min(meta.plazas2024 - 1, ranked.length - 1)]?.total;

  return (
    <div className="mx-auto max-w-6xl px-3 py-5 sm:px-4 sm:py-8 space-y-6 sm:space-y-8">
      <header className="space-y-1.5 sm:space-y-2">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight">
          Baremo Provisional 2026 · Maestros · Primaria
        </h1>
        <p className="text-xs sm:text-sm text-neutral-600 leading-relaxed">
          Acceso 1 y 2 (turno libre) · {total.toLocaleString("es-ES")} participantes ·{" "}
          {meta.plazas2026} plazas · {meta.repeaters.toLocaleString("es-ES")} repetidores con datos 2024
        </p>
      </header>

      <section ref={boxRef} className="relative">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <label className="block text-sm font-medium">Buscar por nombre</label>
          {isSearching && (
            <span className="text-xs text-neutral-400 animate-pulse">Buscando…</span>
          )}
          {!isSearching && debouncedQuery.trim() && open && (
            <span className="text-xs text-neutral-500 tabular-nums">
              {matches.length === 0
                ? "Sin resultados"
                : `${matches.length.toLocaleString("es-ES")} resultado${matches.length === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Apellidos, nombre… (p. ej. bellido cristina)"
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base sm:text-sm shadow-sm focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
          aria-autocomplete="list"
          aria-expanded={open && (isSearching || matches.length > 0)}
        />
        {open && debouncedQuery.trim() && !isSearching && matches.length > 0 && (
          <ul
            className="absolute z-10 mt-1 max-h-96 w-full overflow-auto rounded-lg border border-neutral-200 bg-white shadow-lg"
            role="listbox"
          >
            {matches.map((m) => (
              <li
                key={m.idx}
                role="option"
                onPointerDown={(e) => {
                  e.preventDefault();
                  setSelected(m);
                  setQuery(m.nombre);
                  setOpen(false);
                }}
                className="cursor-pointer px-3 py-2.5 text-sm hover:bg-neutral-100 active:bg-neutral-100 border-b border-neutral-50 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium min-w-0 flex-1 leading-snug">
                    <HighlightName name={m.nombre} query={debouncedQuery} />
                  </span>
                  <span className="shrink-0 text-xs sm:text-sm text-neutral-500 tabular-nums">
                    #{m.rank} · {formatNum(m.total, 4)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {open && debouncedQuery.trim() && !isSearching && matches.length === 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-4 text-sm text-neutral-500 shadow-lg">
            No hay coincidencias para «{debouncedQuery.trim()}». Prueba con apellidos o menos palabras.
          </div>
        )}
      </section>

      {selected && stats && (
        <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-6 shadow-sm space-y-5 sm:space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-neutral-500">
                Resultado seleccionado
              </div>
              <h2 className="text-lg sm:text-xl font-semibold mt-0.5 break-words">{selected.nombre}</h2>
            </div>
            <div className="sm:text-right shrink-0">
              <div className="text-xs uppercase tracking-wider text-neutral-500">
                Puntuación total 2026
              </div>
              <div className="text-2xl sm:text-3xl font-mono font-semibold tabular-nums">
                {formatNum(selected.total, 4)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
            <Stat label="Puesto 2026" value={`#${selected.rank}`} />
            <Stat label="Percentil" value={stats.percentile.toFixed(1).replace(".", ",") + "%"} />
            <Stat
              label="Mejor que"
              value={stats.betterCount.toLocaleString("es-ES")}
              sub={`${((stats.betterCount / (total - 1 || 1)) * 100).toFixed(1).replace(".", ",")}%`}
            />
            <Stat
              label="Peor que"
              value={stats.worseCount.toLocaleString("es-ES")}
              sub={`${((stats.worseCount / (total - 1 || 1)) * 100).toFixed(1).replace(".", ",")}%`}
            />
            <Stat label="Empatados" value={stats.tiedCount.toLocaleString("es-ES")} className="col-span-2 sm:col-span-1" />
          </div>

          <div
            className={`inline-flex items-start sm:items-center gap-2 rounded-full px-3 py-1.5 text-xs sm:text-sm leading-snug ${
              selected.rank <= meta.plazas2026
                ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
            }`}
          >
            <span className="size-2 rounded-full bg-current" />
            {selected.rank <= meta.plazas2026
              ? `Dentro del corte baremo (#${selected.rank} ≤ ${meta.plazas2026})`
              : `Fuera del corte baremo (faltan ${selected.rank - meta.plazas2026} puestos)`}
          </div>
        </section>
      )}

      {selected && selectedRepeater && (
        <section className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:p-6 shadow-sm space-y-4 sm:space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
              Repitió oposición
            </span>
            <h3 className="text-sm font-medium text-blue-900">Evolución 2024 → 2026</h3>
          </div>

          <div className="grid gap-3 sm:gap-4 sm:grid-cols-3">
            <CompareStat
              label="Baremo 2024"
              value={formatNum(selectedRepeater.baremo2024, 4)}
              sub={`Puesto #${selectedRepeater.rank2024}`}
            />
            <CompareStat
              label="Baremo 2026"
              value={formatNum(selectedRepeater.baremo2026, 4)}
              sub={`Puesto #${selectedRepeater.rank2026}`}
            />
            <CompareStat
              label="Mejora"
              value={`+${formatNum(selectedRepeater.deltaBaremo, 4)}`}
              sub={`${selectedRepeater.rank2024 - selectedRepeater.rank2026 > 0 ? "▲" : "▼"} ${Math.abs(selectedRepeater.rank2024 - selectedRepeater.rank2026)} puestos`}
              highlight
            />
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
              Desglose de mejora por categoría
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <CategoryDelta label="Servicios (antigüedad)" delta={selectedRepeater.categoryDelta.servicios} />
              <CategoryDelta label="Méritos" delta={selectedRepeater.categoryDelta.meritos} />
              <CategoryDelta label="Formación" delta={selectedRepeater.categoryDelta.formacion} />
            </div>
          </div>

          <div className="rounded-lg border border-blue-100 bg-white p-4 text-sm">
            {selectedRepeater.gotPlaza2024 ? (
              <p className="text-emerald-700">
                Obtuvo plaza en 2024 con puntuación final de{" "}
                <strong>{formatNum(selectedRepeater.finalScore2024!, 4)}</strong>
                {selectedRepeater.examScore2024 != null && (
                  <> (examen: {formatNum(selectedRepeater.examScore2024, 4)} pts)</>
                )}
              </p>
            ) : (
              <p className="text-neutral-700">
                No obtuvo plaza en 2024 (baremo {formatNum(selectedRepeater.baremo2024, 4)}, puesto #
                {selectedRepeater.rank2024})
              </p>
            )}
          </div>
        </section>
      )}

      {selected && (probability || probLoading) && (
        <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-6 shadow-sm space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-sm font-medium text-neutral-800">Estimación de probabilidad de plaza</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Modelo Monte Carlo usando la distribución de exámenes de los {meta.plazas2024} seleccionados
              en 2024. El examen de 2026 es desconocido; esto es una estimación, no una predicción.
            </p>
          </div>

          {probLoading || !probability ? (
            <ProbLoadingSkeleton plazas2026={meta.plazas2026} plazas2024={meta.plazas2024} />
          ) : (
            <>
              <div className="space-y-3">
                <ProbBar value={probability.p150} label={`Con ${meta.plazas2026} plazas (2026)`} />
                <ProbBar value={probability.p343} label={`Con ${meta.plazas2024} plazas (como 2024)`} />
                {probability.empirical != null && (
                  <ProbBar
                    value={probability.empirical}
                    label="Referencia empírica (repetidores con baremo similar en 2024)"
                  />
                )}
              </div>

              <p className="text-xs text-neutral-400">
                Baremo solo no decide la plaza: en 2024 el corte final fue {formatNum(meta.cutoffFinal2024, 4)} pts
                (baremo del puesto #150: {rank343Score ? formatNum(rank343Score, 4) : "—"}). Muchos seleccionados
                tenían baremo bajo pero examen alto.
              </p>
            </>
          )}
        </section>
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Distribución de puntuaciones">
          <Bar
            data={{
              labels: histogram.labels,
              datasets: [
                {
                  label: "Nº participantes",
                  data: histogram.bins,
                  backgroundColor: histogram.bins.map((_, i) =>
                    i === histogram.selectedBinIdx ? "#dc2626" : "#0f172a",
                  ),
                  borderWidth: 0,
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: {
                  title: { display: true, text: "Puntuación total", font: { size: isMobile ? 10 : 12 } },
                  ticks: { maxRotation: isMobile ? 45 : 0, autoSkip: true, font: { size: isMobile ? 9 : 11 } },
                },
                y: {
                  title: { display: true, text: "Nº de personas", font: { size: isMobile ? 10 : 12 } },
                  beginAtZero: true,
                  ticks: { font: { size: isMobile ? 9 : 11 } },
                },
              },
            }}
          />
        </ChartCard>

        <ChartCard title="Curva de ranking">
          <Line
            data={{
              labels: ranked.map((_, i) => i + 1),
              datasets: [
                {
                  label: "Puntuación",
                  data: ranked.map((r) => r.total),
                  borderColor: "#0f172a",
                  borderWidth: 1.5,
                  pointRadius: 0,
                  fill: false,
                  tension: 0.55,
                  cubicInterpolationMode: "monotone",
                },
                ...(selected
                  ? [
                      {
                        label: "Seleccionado",
                        data: ranked.map((r, i) =>
                          i + 1 === selected.idx + 1 ? selected.total : null,
                        ),
                        borderColor: "#dc2626",
                        backgroundColor: "#dc2626",
                        pointRadius: 6,
                        pointHoverRadius: 8,
                        showLine: false,
                      },
                    ]
                  : []),
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { display: false },
                annotation: {
                  annotations: {
                    cutoff150: {
                      type: "line",
                      xMin: meta.plazas2026,
                      xMax: meta.plazas2026,
                      borderColor: "#059669",
                      borderWidth: 2,
                      borderDash: [6, 4],
                      label: {
                        display: true,
                        content: `${meta.plazas2026} plazas`,
                        position: "start",
                        backgroundColor: "#059669",
                        color: "#fff",
                        font: { size: isMobile ? 9 : 11 },
                        padding: isMobile ? 2 : 4,
                      },
                    },
                  },
                },
                tooltip: {
                  callbacks: {
                    title: (ctx) => `Puesto #${ctx[0].label}`,
                    label: (ctx) => `Puntuación: ${formatNum(ctx.parsed.y, 4)}`,
                  },
                },
              },
              scales: {
                x: {
                  title: { display: true, text: "Puesto", font: { size: isMobile ? 10 : 12 } },
                  ticks: { maxTicksLimit: isMobile ? 6 : 12, font: { size: isMobile ? 9 : 11 } },
                },
                y: {
                  title: { display: true, text: "Puntuación total", font: { size: isMobile ? 10 : 12 } },
                  beginAtZero: true,
                  ticks: { font: { size: isMobile ? 9 : 11 } },
                },
              },
              animation: false,
            }}
          />
        </ChartCard>
      </section>

      <footer className="text-xs text-neutral-500 space-y-1">
        <p>
          Datos: baremo provisional 2026 (25/05/2026) y baremo provisional 2024 (22/05/2024).
          Finalistas 2024: resolución 23/07/2024 ({meta.plazas2024} plazas).
        </p>
        <p>
          La probabilidad estimada usa simulación Monte Carlo con exámenes de 2024.
          No sustituye al baremo definitivo ni al resultado del examen de 2026.
        </p>
        <p>
          Made with &lt;3 by{" "}
          <a
            href="https://x.com/mdemora_dev"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-neutral-700"
          >
            @mdemora_dev
          </a>
        </p>
      </footer>
    </div>
  );
}

function ProbLoadingSkeleton({
  plazas2026,
  plazas2024,
}: {
  plazas2026: number;
  plazas2024: number;
}) {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Calculando probabilidades">
      <div className="space-y-3">
        {[`Con ${plazas2026} plazas (2026)`, `Con ${plazas2024} plazas (como 2024)`].map((label) => (
          <div key={label}>
            <div className="flex justify-between mb-1">
              <span className="text-sm text-neutral-400">{label}</span>
              <span className="h-4 w-10 rounded bg-neutral-200" />
            </div>
            <div className="h-2.5 rounded-full bg-neutral-200" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4 space-y-3">
        <div className="h-3 w-2/3 rounded bg-neutral-200" />
        <div className="grid gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1">
              <div className="h-3 w-16 rounded bg-neutral-200" />
              <div className="h-5 w-20 rounded bg-neutral-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className={`rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 sm:p-3 ${className ?? ""}`}>
      <div className="text-[10px] sm:text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-0.5 sm:mt-1 font-mono text-base sm:text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] sm:text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function CompareStat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 sm:p-3 ${highlight ? "border-emerald-200 bg-emerald-50" : "border-neutral-200 bg-white"}`}
    >
      <div className="text-[10px] sm:text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`mt-0.5 sm:mt-1 font-mono text-base sm:text-lg font-semibold tabular-nums ${highlight ? "text-emerald-700" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function CategoryDelta({ label, delta }: { label: string; delta: number }) {
  const sign = delta >= 0 ? "+" : "";
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs sm:text-sm">
      <span className="text-neutral-600 min-w-0 leading-snug">{label}</span>
      <span className={`shrink-0 font-mono font-semibold tabular-nums ${delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-neutral-400"}`}>
        {sign}{formatNum(delta, 4)}
      </span>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5 shadow-sm">
      <h3 className="mb-2 sm:mb-3 text-sm font-medium text-neutral-700">{title}</h3>
      <div className="h-52 sm:h-64 lg:h-80">{children}</div>
    </div>
  );
}
