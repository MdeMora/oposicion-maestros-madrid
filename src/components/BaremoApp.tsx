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

function dniSuffix(dni: string): string {
  return dni.replace(/\*/g, "").slice(-4);
}

function pct(n: number): string {
  return (n * 100).toFixed(1).replace(".", ",") + "%";
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
  const [selected, setSelected] = useState<Ranked | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    return fuse.search(stripAccents(query)).slice(0, 8).map((r) => r.item);
  }, [query, fuse]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
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

  const probability = useMemo((): ProbabilityResult | null => {
    if (!selected) return null;
    const empirical = empiricalPlazaRate(selected.total, repeaters);
    return estimateProbability(
      selected.total,
      meta.examScores2024,
      allBaremoTotals,
      meta.plazas2026,
      meta.plazas2024,
      meta.cutoffFinal2024,
      empirical,
    );
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
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Baremo Provisional 2026 · Maestros · Primaria
        </h1>
        <p className="text-sm text-neutral-600">
          Acceso 1 y 2 (turno libre) · {total.toLocaleString("es-ES")} participantes ·{" "}
          {meta.plazas2026} plazas · {meta.repeaters.toLocaleString("es-ES")} repetidores con datos 2024
        </p>
      </header>

      <section ref={boxRef} className="relative">
        <label className="block text-sm font-medium mb-1.5">Buscar por nombre</label>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Apellidos, Nombre"
          className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
        />
        {open && matches.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-neutral-200 bg-white shadow-lg">
            {matches.map((m) => (
                <li
                  key={m.idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSelected(m);
                    setQuery(m.nombre);
                    setOpen(false);
                  }}
                  className="cursor-pointer px-3.5 py-2 text-sm hover:bg-neutral-100"
                >
                  <span className="font-medium">{m.nombre}</span>
                  <span className="float-right text-neutral-500">
                    #{m.rank} · {formatNum(m.total, 4)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {selected && stats && (
        <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-6">
          <div className="flex items-baseline justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-neutral-500">
                Resultado seleccionado
              </div>
              <h2 className="text-xl font-semibold mt-0.5">{selected.nombre}</h2>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-neutral-500">
                Puntuación total 2026
              </div>
              <div className="text-3xl font-mono font-semibold">
                {formatNum(selected.total, 4)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
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
            <Stat label="Empatados" value={stats.tiedCount.toLocaleString("es-ES")} />
          </div>

          <div
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
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
        <section className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm space-y-5">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
              Repitió oposición
            </span>
            <h3 className="text-sm font-medium text-blue-900">Evolución 2024 → 2026</h3>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
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

      {selected && probability && (
        <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-5">
          <div>
            <h3 className="text-sm font-medium text-neutral-800">Estimación de probabilidad de plaza</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Modelo Monte Carlo usando la distribución de exámenes de los {meta.plazas2024} seleccionados
              en 2024. El examen de 2026 es desconocido; esto es una estimación, no una predicción.
            </p>
          </div>

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

          <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4">
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
              Puntos de examen necesarios (referencia corte 2024: {formatNum(meta.cutoffFinal2024, 4)})
            </div>
            <div className="grid gap-2 sm:grid-cols-3 text-sm">
              <div>
                <span className="text-neutral-500">Optimista</span>
                <div className="font-mono font-semibold">{formatNum(probability.examNeeded.optimistic, 2)} pts</div>
              </div>
              <div>
                <span className="text-neutral-500">Mediano</span>
                <div className="font-mono font-semibold">{formatNum(probability.examNeeded.median, 2)} pts</div>
              </div>
              <div>
                <span className="text-neutral-500">Exigente</span>
                <div className="font-mono font-semibold">{formatNum(probability.examNeeded.pessimistic, 2)} pts</div>
              </div>
            </div>
          </div>

          <p className="text-xs text-neutral-400">
            Baremo solo no decide la plaza: en 2024 el corte final fue {formatNum(meta.cutoffFinal2024, 4)} pts
            (baremo del puesto #150: {rank343Score ? formatNum(rank343Score, 4) : "—"}). Muchos seleccionados
            tenían baremo bajo pero examen alto.
          </p>
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
                x: { title: { display: true, text: "Puntuación total" }, ticks: { maxRotation: 0, autoSkip: true } },
                y: { title: { display: true, text: "Nº de personas" }, beginAtZero: true },
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
                        font: { size: 11 },
                        padding: 4,
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
                x: { title: { display: true, text: "Puesto" }, ticks: { maxTicksLimit: 12 } },
                y: { title: { display: true, text: "Puntuación total" }, beginAtZero: true },
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
      </footer>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
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
      className={`rounded-lg border p-3 ${highlight ? "border-emerald-200 bg-emerald-50" : "border-neutral-200 bg-white"}`}
    >
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${highlight ? "text-emerald-700" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function CategoryDelta({ label, delta }: { label: string; delta: number }) {
  const sign = delta >= 0 ? "+" : "";
  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
      <span className="text-neutral-600">{label}</span>
      <span className={`font-mono font-semibold ${delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-neutral-400"}`}>
        {sign}{formatNum(delta, 4)}
      </span>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-medium text-neutral-700">{title}</h3>
      <div className="h-80">{children}</div>
    </div>
  );
}
