"use client";

import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Carrera,
  type Cuatrimestre,
  getMateriaSlug,
  hasMateriaSlug,
  type PlanRow,
} from "@/lib/carreras";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout y routing de aristas
// ---------------------------------------------------------------------------
//
// Cada cuatrimestre del plan = una columna. Dentro de cada columna el
// orden vertical lo decide un sweep de barycenter (6 pasadas) que
// minimiza cruces.
//
// ROUTING - usamos un edge custom (CorrelativaEdge) que dibuja la
// flecha con segmentos rectos. Las decisiones clave:
//
// 1) Segmentos verticales SIEMPRE caen en el "gap" entre columnas, no
//    pegados al card. Como el gap es ancho (260 px de COL_GAP), hay
//    espacio para distribuir varias flechas en paralelo.
//
// 2) Track assignment por gap: dentro de cada gap, las flechas que
//    cruzan se reparten en tracks X distintos para que sus verticales
//    no se superpongan. Algoritmo greedy.
//
// 3) Flechas multi-hop (saltan varias columnas) van por una "calle"
//    horizontal arriba (sobre el header) o abajo (debajo del último
//    card). Dentro de cada calle, otro track assignment Y.

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const COL_GAP = 260;
const ROW_GAP = 80;
const HEADER_HEIGHT = 56;
const X_PADDING = 40;

const HANDLE_COUNT = 6;
const HANDLE_POSITIONS = [12, 28, 44, 60, 76, 92];

const TRACK_SPACING = 16;
const LANE_BASE_GAP = 40;

const DIM_OPACITY = 0.5;
const HOVER_DEBOUNCE_MS = 80;

interface MateriaNodeData extends Record<string, unknown> {
  row: PlanRow;
  /** Tiene slug y abre `/materia/<slug>` cuando se clickea. */
  esInternal: boolean;
  /** Tiene `externalUrl` (típicamente optativas LI/LS) y abre afuera. */
  esExternal: boolean;
}

interface ColumnHeaderData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
}

/** Datos del edge custom: segmentos a dibujar. */
interface EdgeData extends Record<string, unknown> {
  /** X de cada segmento vertical (1 para single-hop, 2 para multi-hop). */
  verticals: number[];
  /** Y de la calle horizontal, solo si hay 2 verticals. */
  laneY?: number;
}

function colIndex(row: PlanRow): number {
  if (row.cuatrimestre === "intro") return 0;
  return (row.anio - 1) * 2 + (row.cuatrimestre === 1 ? 1 : 2);
}

interface ColumnSpec {
  index: number;
  label: string;
  subtitle?: string;
}

function buildColumnSpecs(plan: PlanRow[]): ColumnSpec[] {
  const seen = new Set<number>();
  for (const row of plan) seen.add(colIndex(row));

  const specs: ColumnSpec[] = [];
  for (const idx of [...seen].sort((a, b) => a - b)) {
    if (idx === 0) {
      specs.push({ index: 0, label: "Curso de ingreso" });
    } else {
      const anio = Math.ceil(idx / 2);
      const cuat: Cuatrimestre = idx % 2 === 1 ? 1 : 2;
      specs.push({
        index: idx,
        label: `${cuat === 1 ? "1°" : "2°"} cuat`,
        subtitle: `Año ${anio}`,
      });
    }
  }
  return specs;
}

interface OrderingState {
  rowOf: Map<string, number>;
  colOf: Map<string, number>;
  byCol: Map<number, string[]>;
}

function initialOrdering(plan: PlanRow[]): OrderingState {
  const colOf = new Map<string, number>();
  const byCol = new Map<number, string[]>();
  const rowOf = new Map<string, number>();

  for (const row of plan) {
    const c = colIndex(row);
    colOf.set(row.codigo, c);
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c)?.push(row.codigo);
  }
  for (const codigos of byCol.values()) {
    codigos.forEach((codigo, i) => {
      rowOf.set(codigo, i);
    });
  }
  return { rowOf, colOf, byCol };
}

function barycenterSweep(
  plan: PlanRow[],
  state: OrderingState,
  direction: "forward" | "backward",
) {
  const { rowOf, colOf, byCol } = state;
  const codigosEnPlan = new Set(plan.map((r) => r.codigo));

  const sucesores = new Map<string, string[]>();
  for (const row of plan) {
    for (const corr of row.correlativas) {
      if (!codigosEnPlan.has(corr)) continue;
      if (!sucesores.has(corr)) sucesores.set(corr, []);
      sucesores.get(corr)?.push(row.codigo);
    }
  }

  const cols = [...byCol.keys()].sort((a, b) =>
    direction === "forward" ? a - b : b - a,
  );

  for (const col of cols) {
    const codigos = byCol.get(col);
    if (!codigos) continue;
    const planByCodigo = new Map(plan.map((r) => [r.codigo, r]));

    const conBary = codigos.map((codigo) => {
      const row = planByCodigo.get(codigo);
      let vecinos: string[] = [];
      if (direction === "forward") {
        vecinos = (row?.correlativas ?? []).filter(
          (c) => codigosEnPlan.has(c) && (colOf.get(c) ?? -1) < col,
        );
      } else {
        vecinos = (sucesores.get(codigo) ?? []).filter(
          (c) => (colOf.get(c) ?? -1) > col,
        );
      }
      const bary = vecinos.length
        ? vecinos.reduce((s, c) => s + (rowOf.get(c) ?? 0), 0) / vecinos.length
        : (rowOf.get(codigo) ?? 0);
      return { codigo, bary };
    });

    conBary.sort((a, b) => {
      if (a.bary !== b.bary) return a.bary - b.bary;
      return (rowOf.get(a.codigo) ?? 0) - (rowOf.get(b.codigo) ?? 0);
    });

    const nuevoOrden = conBary.map((x) => x.codigo);
    byCol.set(col, nuevoOrden);
    nuevoOrden.forEach((codigo, i) => {
      rowOf.set(codigo, i);
    });
  }
}

function distributeHandles(n: number, indexInSorted: number): number {
  if (n <= 1) return Math.floor(HANDLE_COUNT / 2);
  const t = indexInSorted / (n - 1);
  return Math.round(t * (HANDLE_COUNT - 1));
}

/** X del centro del gap entre columna `col` y `col+1`. */
function gapCenterX(col: number): number {
  return X_PADDING + col * (NODE_WIDTH + COL_GAP) + NODE_WIDTH + COL_GAP / 2;
}

/**
 * Track assignment greedy: dada una lista de intervalos [a, b],
 * agrupa en tracks tal que dentro de cada track los intervalos no se
 * solapen. Devuelve el track idx asignado a cada intervalo.
 */
function greedyTrackAssign(
  intervals: Array<{ a: number; b: number }>,
): number[] {
  const tracks: Array<Array<[number, number]>> = [];
  const assignment: number[] = [];
  const padding = 4;
  for (const { a, b } of intervals) {
    let placed = -1;
    for (let i = 0; i < tracks.length; i++) {
      const conflict = tracks[i].some(
        ([s, e]) => !(b < s - padding || a > e + padding),
      );
      if (!conflict) {
        tracks[i].push([a, b]);
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      tracks.push([[a, b]]);
      placed = tracks.length - 1;
    }
    assignment.push(placed);
  }
  return assignment;
}

interface EdgeWork {
  id: string;
  source: string;
  target: string;
  sourceHandle: number;
  targetHandle: number;
  sourceCol: number;
  targetCol: number;
  sY: number;
  tY: number;
  /** sourceX al borde derecho del card. */
  sX: number;
  /** targetX al borde izquierdo del card. */
  tX: number;
  colDist: number;
  /** Si es multi-hop: 'top' o 'bottom'; sino undefined. */
  lane?: "top" | "bottom";
  /** Resultado del track assignment. */
  verticalXs: number[];
  laneY?: number;
}

function buildGraph(plan: PlanRow[]) {
  const codigosEnPlan = new Set(plan.map((r) => r.codigo));
  const state = initialOrdering(plan);

  for (let i = 0; i < 6; i++) {
    barycenterSweep(plan, state, i % 2 === 0 ? "forward" : "backward");
  }

  const cols = buildColumnSpecs(plan);
  const planByCodigo = new Map(plan.map((r) => [r.codigo, r]));

  const edgesIn = new Map<string, string[]>();
  const edgesOut = new Map<string, string[]>();
  for (const row of plan) {
    for (const corr of row.correlativas) {
      if (!codigosEnPlan.has(corr)) continue;
      if (!edgesIn.has(row.codigo)) edgesIn.set(row.codigo, []);
      edgesIn.get(row.codigo)?.push(corr);
      if (!edgesOut.has(corr)) edgesOut.set(corr, []);
      edgesOut.get(corr)?.push(row.codigo);
    }
  }

  const targetHandleOf = new Map<string, number>();
  const sourceHandleOf = new Map<string, number>();

  for (const [target, sources] of edgesIn) {
    const sorted = [...sources].sort(
      (a, b) => (state.rowOf.get(a) ?? 0) - (state.rowOf.get(b) ?? 0),
    );
    sorted.forEach((source, i) => {
      const handle = distributeHandles(sorted.length, i);
      targetHandleOf.set(`${source}->${target}`, handle);
    });
  }

  for (const [source, targets] of edgesOut) {
    const sorted = [...targets].sort(
      (a, b) => (state.rowOf.get(a) ?? 0) - (state.rowOf.get(b) ?? 0),
    );
    sorted.forEach((target, i) => {
      const handle = distributeHandles(sorted.length, i);
      sourceHandleOf.set(`${source}->${target}`, handle);
    });
  }

  const positionOf = new Map<string, { x: number; y: number }>();
  for (const row of plan) {
    const c = state.colOf.get(row.codigo) ?? 0;
    const r = state.rowOf.get(row.codigo) ?? 0;
    positionOf.set(row.codigo, {
      x: X_PADDING + c * (NODE_WIDTH + COL_GAP),
      y: HEADER_HEIGHT + r * (NODE_HEIGHT + ROW_GAP),
    });
  }

  let maxRow = 0;
  for (const r of state.rowOf.values()) if (r > maxRow) maxRow = r;
  const yTopBound = 0;
  const yBottomBound = HEADER_HEIGHT + (maxRow + 1) * (NODE_HEIGHT + ROW_GAP);

  function handleY(codigo: string, handleIdx: number): number {
    const pos = positionOf.get(codigo);
    if (!pos) return 0;
    return pos.y + NODE_HEIGHT * (HANDLE_POSITIONS[handleIdx] / 100);
  }

  // Pasada 1: armar los EdgeWork con la info que ya conocemos.
  const works: EdgeWork[] = [];
  for (const row of plan) {
    for (const corr of row.correlativas) {
      if (!codigosEnPlan.has(corr)) continue;
      if (!planByCodigo.has(corr)) continue;
      const id = `${corr}->${row.codigo}`;
      const sourceCol = state.colOf.get(corr) ?? 0;
      const targetCol = state.colOf.get(row.codigo) ?? 0;
      const sHandle = sourceHandleOf.get(id) ?? Math.floor(HANDLE_COUNT / 2);
      const tHandle = targetHandleOf.get(id) ?? Math.floor(HANDLE_COUNT / 2);
      const sPos = positionOf.get(corr);
      const tPos = positionOf.get(row.codigo);
      if (!sPos || !tPos) continue;
      const sY = handleY(corr, sHandle);
      const tY = handleY(row.codigo, tHandle);
      const colDist = targetCol - sourceCol;

      const work: EdgeWork = {
        id,
        source: corr,
        target: row.codigo,
        sourceHandle: sHandle,
        targetHandle: tHandle,
        sourceCol,
        targetCol,
        sY,
        tY,
        sX: sPos.x + NODE_WIDTH,
        tX: tPos.x,
        colDist,
        verticalXs: [],
      };
      // Decidir lane para multi-hop según posición Y promedio
      if (colDist >= 2) {
        const midY = (sY + tY) / 2;
        const midGrafo = (yTopBound + yBottomBound) / 2;
        work.lane = midY < midGrafo ? "top" : "bottom";
      }
      works.push(work);
    }
  }

  // Pasada 2: track assignment de verticales por gap.
  // gapIdx = sourceCol del segmento (el gap entre col `gapIdx` y `gapIdx+1`).
  // Cada gap acumula intervalos verticales y les asigna track X.
  interface VerticalEntry {
    work: EdgeWork;
    /** 0 = es el primer vertical del edge, 1 = el segundo (multi-hop). */
    which: 0 | 1;
    yMin: number;
    yMax: number;
  }

  const byGap = new Map<number, VerticalEntry[]>();
  function pushVertical(gap: number, entry: VerticalEntry) {
    if (!byGap.has(gap)) byGap.set(gap, []);
    byGap.get(gap)?.push(entry);
  }

  // Tentative laneY base. Se ajusta después con el track horizontal.
  const TOP_LANE_BASE = yTopBound - LANE_BASE_GAP;
  const BOTTOM_LANE_BASE = yBottomBound + LANE_BASE_GAP;

  for (const w of works) {
    if (w.colDist === 1) {
      // 1 solo vertical en el gap entre sourceCol y sourceCol+1
      const yMin = Math.min(w.sY, w.tY);
      const yMax = Math.max(w.sY, w.tY);
      pushVertical(w.sourceCol, { work: w, which: 0, yMin, yMax });
    } else {
      // Multi-hop: 2 verticales (uno saliendo, otro entrando)
      const laneY = w.lane === "top" ? TOP_LANE_BASE : BOTTOM_LANE_BASE; // tentativo
      // Vertical 1: source → laneY, en gap sourceCol
      pushVertical(w.sourceCol, {
        work: w,
        which: 0,
        yMin: Math.min(w.sY, laneY),
        yMax: Math.max(w.sY, laneY),
      });
      // Vertical 2: laneY → target, en gap targetCol-1
      pushVertical(w.targetCol - 1, {
        work: w,
        which: 1,
        yMin: Math.min(w.tY, laneY),
        yMax: Math.max(w.tY, laneY),
      });
    }
  }

  // Asignar tracks por gap. Resultado: X de cada vertical, distribuido
  // en torno al gapCenterX(gapIdx).
  for (const [gapIdx, entries] of byGap) {
    const tracks = greedyTrackAssign(
      entries.map((e) => ({ a: e.yMin, b: e.yMax })),
    );
    const numTracks = Math.max(...tracks, 0) + 1;
    const center = gapCenterX(gapIdx);
    entries.forEach((entry, i) => {
      const trackIdx = tracks[i];
      const xOffset = (trackIdx - (numTracks - 1) / 2) * TRACK_SPACING;
      const x = center + xOffset;
      entry.work.verticalXs[entry.which] = x;
    });
  }

  // Pasada 3: track assignment de horizontales en lanes. Cada
  // multi-hop ocupa un segmento horizontal en su lane desde el primer
  // hasta el segundo vertical (con su laneY a asignar).
  interface HorizontalEntry {
    work: EdgeWork;
    xMin: number;
    xMax: number;
  }

  const topHor: HorizontalEntry[] = [];
  const botHor: HorizontalEntry[] = [];
  for (const w of works) {
    if (w.colDist < 2) continue;
    const x1 = w.verticalXs[0];
    const x2 = w.verticalXs[1];
    const xMin = Math.min(x1, x2);
    const xMax = Math.max(x1, x2);
    if (w.lane === "top") topHor.push({ work: w, xMin, xMax });
    else botHor.push({ work: w, xMin, xMax });
  }

  function assignLane(
    entries: HorizontalEntry[],
    base: number,
    direction: 1 | -1,
  ) {
    const tracks = greedyTrackAssign(
      entries.map((e) => ({ a: e.xMin, b: e.xMax })),
    );
    entries.forEach((entry, i) => {
      const trackIdx = tracks[i];
      entry.work.laneY = base + direction * (trackIdx + 1) * TRACK_SPACING;
    });
  }

  // Top: tracks van hacia ARRIBA del header (Y cada vez menor)
  assignLane(topHor, yTopBound, -1);
  // Bottom: tracks van hacia ABAJO del último card (Y cada vez mayor)
  assignLane(botHor, yBottomBound, +1);

  // Ahora que tenemos laneY ajustado, recalculamos los Y ranges de los
  // verticales y reasignamos tracks por gap (la primera vez usamos
  // laneY tentativo). Esto es una segunda iteración del track assignment.
  byGap.clear();
  for (const w of works) {
    if (w.colDist === 1) {
      pushVertical(w.sourceCol, {
        work: w,
        which: 0,
        yMin: Math.min(w.sY, w.tY),
        yMax: Math.max(w.sY, w.tY),
      });
    } else {
      const laneY = w.laneY ?? 0;
      pushVertical(w.sourceCol, {
        work: w,
        which: 0,
        yMin: Math.min(w.sY, laneY),
        yMax: Math.max(w.sY, laneY),
      });
      pushVertical(w.targetCol - 1, {
        work: w,
        which: 1,
        yMin: Math.min(w.tY, laneY),
        yMax: Math.max(w.tY, laneY),
      });
    }
  }
  for (const [gapIdx, entries] of byGap) {
    const tracks = greedyTrackAssign(
      entries.map((e) => ({ a: e.yMin, b: e.yMax })),
    );
    const numTracks = Math.max(...tracks, 0) + 1;
    const center = gapCenterX(gapIdx);
    entries.forEach((entry, i) => {
      const trackIdx = tracks[i];
      const xOffset = (trackIdx - (numTracks - 1) / 2) * TRACK_SPACING;
      entry.work.verticalXs[entry.which] = center + xOffset;
    });
  }

  // Construcción de nodes y edges finales
  const nodes: Node<MateriaNodeData | ColumnHeaderData>[] = [];

  for (const row of plan) {
    const c = state.colOf.get(row.codigo) ?? 0;
    const r = state.rowOf.get(row.codigo) ?? 0;
    nodes.push({
      id: row.codigo,
      type: "materia",
      data: {
        row,
        esInternal: hasMateriaSlug(row.codigo),
        esExternal: Boolean(row.externalUrl),
      },
      position: {
        x: X_PADDING + c * (NODE_WIDTH + COL_GAP),
        y: HEADER_HEIGHT + r * (NODE_HEIGHT + ROW_GAP),
      },
      draggable: false,
    });
  }

  for (const col of cols) {
    nodes.push({
      id: `header-${col.index}`,
      type: "columnHeader",
      data: { label: col.label, subtitle: col.subtitle },
      position: {
        x: X_PADDING + col.index * (NODE_WIDTH + COL_GAP),
        y: 0,
      },
      draggable: false,
      selectable: false,
      style: { width: NODE_WIDTH },
    });
  }

  const edges: Edge[] = works.map((w) => ({
    id: w.id,
    source: w.source,
    target: w.target,
    sourceHandle: `s-${w.sourceHandle}`,
    targetHandle: `t-${w.targetHandle}`,
    type: "correlativa",
    data: {
      verticals: w.verticalXs,
      laneY: w.laneY,
    } satisfies EdgeData,
    animated: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: "var(--muted-foreground)",
    },
    style: {
      stroke: "var(--muted-foreground)",
      strokeOpacity: 0.35,
      strokeWidth: 1.4,
    },
  }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Custom edge: dibuja el path según los segmentos pre-calculados
// ---------------------------------------------------------------------------

function CorrelativaEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const ed = (data ?? {}) as Partial<EdgeData>;
  const verticals = ed.verticals ?? [];
  const laneY = ed.laneY;

  let d: string;
  if (verticals.length === 1) {
    // Single hop: source → V → target
    const vx = verticals[0];
    d = [
      `M ${sourceX} ${sourceY}`,
      `L ${vx} ${sourceY}`,
      `L ${vx} ${targetY}`,
      `L ${targetX} ${targetY}`,
    ].join(" ");
  } else if (verticals.length === 2 && laneY !== undefined) {
    // Multi hop: source → V1 → lane → V2 → target
    const [vx1, vx2] = verticals;
    d = [
      `M ${sourceX} ${sourceY}`,
      `L ${vx1} ${sourceY}`,
      `L ${vx1} ${laneY}`,
      `L ${vx2} ${laneY}`,
      `L ${vx2} ${targetY}`,
      `L ${targetX} ${targetY}`,
    ].join(" ");
  } else {
    // Fallback: línea recta (no debería pasar si buildGraph hizo su trabajo)
    d = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  return <BaseEdge id={id} path={d} style={style} markerEnd={markerEnd} />;
}

// ---------------------------------------------------------------------------
// Custom nodes
// ---------------------------------------------------------------------------

function MateriaNode({ data }: NodeProps<Node<MateriaNodeData>>) {
  const { row, esInternal, esExternal } = data;
  const tipoChip =
    row.tipo && row.tipo !== "obligatoria" && row.tipo !== "introductoria"
      ? row.tipo
      : null;
  // El `title` HTML genera un tooltip nativo al pasar el mouse. Útil
  // para tesinas (requisitos) y optativas-ATIC (orientaciones), donde
  // el card del grafo no puede mostrar el detalle completo. Para
  // materias con detalle interno, indicamos que se puede clickear.
  const tooltip = [
    row.nota,
    esInternal && "Click para ver el detalle de la materia",
    esExternal && "Click para ver el listado oficial de optativas",
  ]
    .filter(Boolean)
  .join(" - ");

  return (
    <div
      title={tooltip || undefined}
      className={cn(
        "group relative flex h-full w-full flex-col justify-center gap-1 rounded-xl border px-3 py-2 text-left",
        "border-border bg-card transition-colors duration-200",
        esInternal || esExternal
          ? "cursor-pointer hover:border-primary/60 hover:bg-pastel-blue dark:hover:bg-primary/15"
          : "cursor-default",
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      {HANDLE_POSITIONS.map((top, i) => (
        <Handle
          key={`t-${i}`}
          id={`t-${i}`}
          type="target"
          position={Position.Left}
          style={{ top: `${top}%`, opacity: 0, pointerEvents: "none" }}
        />
      ))}
      {HANDLE_POSITIONS.map((top, i) => (
        <Handle
          key={`s-${i}`}
          id={`s-${i}`}
          type="source"
          position={Position.Right}
          style={{ top: `${top}%`, opacity: 0, pointerEvents: "none" }}
        />
      ))}

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-primary">
          {row.codigo}
        </span>
        {tipoChip && (
          <span className="rounded-full bg-pastel-amber px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground/70">
            {tipoChip}
          </span>
        )}
        {esExternal && (
          <ArrowUpRight
            className="ml-auto h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
      </div>
      <p className="line-clamp-2 text-[12px] font-semibold leading-tight text-foreground transition-colors group-hover:text-primary">
        {row.nombre}
      </p>
    </div>
  );
}

function ColumnHeaderNode({ data }: NodeProps<Node<ColumnHeaderData>>) {
  return (
    <div className="pointer-events-none flex flex-col items-center text-center">
      {data.subtitle && (
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {data.subtitle}
        </p>
      )}
      <p className="text-sm font-bold text-primary">{data.label}</p>
    </div>
  );
}

const nodeTypes = {
  materia: MateriaNode,
  columnHeader: ColumnHeaderNode,
};

const edgeTypes = {
  correlativa: CorrelativaEdge,
};

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

interface CorrelativasGraphProps {
  carrera: Carrera;
}

export function CorrelativasGraph({ carrera }: CorrelativasGraphProps) {
  const router = useRouter();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const { nodes: rawNodes, edges: rawEdges } = useMemo(
    () => buildGraph(carrera.plan),
    [carrera.plan],
  );

  const relevantNodeIds = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set<string>([hoveredId]);
    for (const e of rawEdges) {
      if (e.source === hoveredId) set.add(e.target);
      if (e.target === hoveredId) set.add(e.source);
    }
    return set;
  }, [hoveredId, rawEdges]);

  const nodes = useMemo(() => {
    if (!relevantNodeIds) return rawNodes;
    return rawNodes.map((n) => {
      if (n.type === "columnHeader") return n;
      const dim = !relevantNodeIds.has(n.id);
      return {
        ...n,
        style: {
          ...n.style,
          opacity: dim ? DIM_OPACITY : 1,
        },
      };
    });
  }, [rawNodes, relevantNodeIds]);

  const edges = useMemo(() => {
    if (!hoveredId) return rawEdges;
    return rawEdges.map((e) => {
      const isRelevant = e.source === hoveredId || e.target === hoveredId;
      const color = isRelevant ? "var(--primary)" : "var(--muted-foreground)";
      return {
        ...e,
        markerEnd: {
          ...(typeof e.markerEnd === "object" ? e.markerEnd : {}),
          type: MarkerType.ArrowClosed,
          color,
        },
        style: {
          ...e.style,
          stroke: color,
          strokeOpacity: isRelevant ? 0.95 : 0.06,
          strokeWidth: isRelevant ? 2 : 1.4,
        },
      };
    });
  }, [rawEdges, hoveredId]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== "materia") return;
      const data = node.data as MateriaNodeData;
      // externalUrl gana: típicamente las optativas LI/LS abren la
      // página oficial del listado de optativas del año en otra pestaña.
      if (data.esExternal && data.row.externalUrl) {
        window.open(data.row.externalUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (!data.esInternal) return;
      const slug = getMateriaSlug(data.row.codigo);
      if (slug) router.push(`/materia/${slug}`);
    },
    [router],
  );

  const onNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== "materia") return;
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = setTimeout(() => {
        setHoveredId(node.id);
      }, HOVER_DEBOUNCE_MS);
    },
    [],
  );

  const onNodeMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredId(null);
    }, HOVER_DEBOUNCE_MS);
  }, []);

  return (
    <div className="correlativas-graph h-full w-full bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
