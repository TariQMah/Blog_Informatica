// Cartelera de la Facultad de Informática UNLP.
// Fuente oficial: https://gestiondocente.info.unlp.edu.ar/cartelera/
// API pública sin auth: GET /cartelera/data/{from}/{count}
//
// Este módulo:
// 1. Fetchea los últimos N mensajes con ISR.
// 2. Sanitiza el HTML del cuerpo.
// 3. Aplica filtros (search, materia, carrera, fecha, adjuntos, anulados).
// 4. Provee helpers para fechas relativas y mapeo materia -> carreras.

import sanitizeHtml from "sanitize-html";
import { type Carrera, carreras } from "@/lib/carreras";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface AdjuntoRaw {
  nombre: string;
  public_path: string;
}

export interface MensajeRaw {
  materia: string;
  titulo: string;
  cuerpo: string;
  fecha: string; // "DD/MM/YYYY HH:mm"
  autor: string;
  is_anulado: boolean;
  fecha_anulacion: string | null;
  adjuntos: AdjuntoRaw[];
}

export interface ApiResponse {
  total: number;
  from: number;
  count: number;
  mensajes: MensajeRaw[];
}

export interface Mensaje {
  materia: string;
  titulo: string;
  /** HTML ya sanitizado, listo para dangerouslySetInnerHTML. */
  cuerpoHtml: string;
  fecha: Date;
  /** "07/05/2026 07:41" tal como viene del origen, para tooltips. */
  fechaRaw: string;
  autor: string;
  isAnulado: boolean;
  fechaAnulacion: Date | null;
  adjuntos: AdjuntoRaw[];
  /** Carreras donde aparece esta materia (mapeo desde nuestro plan). */
  carreras: Carrera[];
}

// ---------------------------------------------------------------------------
// Fetch con ISR
// ---------------------------------------------------------------------------

const API_BASE = "https://gestiondocente.info.unlp.edu.ar";
const FETCH_COUNT = 500; // últimos ~6-12 meses, suficiente para 99% de búsquedas
const REVALIDATE_SECONDS = 300;

export async function fetchCartelera(): Promise<Mensaje[]> {
  const url = `${API_BASE}/cartelera/data/0/${FETCH_COUNT}`;
  const res = await fetch(url, {
    next: { revalidate: REVALIDATE_SECONDS },
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`Cartelera fetch failed: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as ApiResponse;
  return data.mensajes.map(transformMensaje);
}

function transformMensaje(raw: MensajeRaw): Mensaje {
  return {
    materia: raw.materia,
    titulo: raw.titulo,
    cuerpoHtml: sanitizeCuerpo(raw.cuerpo),
    fecha: parseFecha(raw.fecha),
    fechaRaw: raw.fecha,
    autor: raw.autor,
    isAnulado: raw.is_anulado,
    fechaAnulacion: raw.fecha_anulacion
      ? parseFecha(raw.fecha_anulacion)
      : null,
    adjuntos: raw.adjuntos,
    carreras: carrerasDeMateria(raw.materia),
  };
}

// ---------------------------------------------------------------------------
// Sanitización del HTML del cuerpo
// ---------------------------------------------------------------------------

function sanitizeCuerpo(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "del",
      "span",
      "a",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "code",
      "pre",
      "hr",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "div",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      "*": ["style"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    transformTags: {
      // Forzar que todos los <a> abran en otra pestaña con noopener.
      a: (_tag, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    },
    // Permitir colors/font-size básicos, cortar absolute positioning.
    allowedStyles: {
      "*": {
        color: [
          /^#(0x)?[0-9a-f]+$/i,
          /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
        ],
        "background-color": [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/i],
        "font-size": [/^\d+(?:px|em|rem|%)$/],
        "font-weight": [/^\d+$/, /^(bold|normal)$/],
        "text-decoration": [/.*/],
        "text-align": [/^(left|right|center|justify)$/],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Parsing de fechas
// ---------------------------------------------------------------------------

/** "07/05/2026 07:41" -> Date local. */
export function parseFecha(s: string): Date {
  const [datePart, timePart = "00:00"] = s.trim().split(/\s+/);
  const [d, m, y] = datePart.split("/").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

const MESES_ES_CORTO = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** "hace 2 horas", "ayer", "hace 3 días", "12 mar" si > 30 días. */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "hace instantes";
  if (diffMin < 60) return `hace ${diffMin} min`;
  if (diffHr < 24) return `hace ${diffHr} ${diffHr === 1 ? "hora" : "horas"}`;
  if (diffDay === 1) return "ayer";
  if (diffDay < 7) return `hace ${diffDay} días`;
  if (diffDay < 30) return `hace ${Math.floor(diffDay / 7)} sem`;

  // > 30 días: fecha absoluta
  const day = date.getDate();
  const mes = MESES_ES_CORTO[date.getMonth()];
  const sameYear = now.getFullYear() === date.getFullYear();
  return sameYear ? `${day} ${mes}` : `${day} ${mes} ${date.getFullYear()}`;
}

export function formatFechaCompleta(date: Date): string {
  const day = date.getDate();
  const mes = MESES_ES_CORTO[date.getMonth()];
  const anio = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${mes} ${anio} - ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Identificador estable por anuncio
// ---------------------------------------------------------------------------

/**
 * Devuelve un identificador determinístico para un mensaje, URL-safe,
 * que se puede usar como query param para deep-linkear al anuncio
 * (`/cartelera?a=<id>`). La cartelera oficial no expone un id propio,
 * así que componemos uno con fecha-ISO + slug del título.
 */
export function mensajeId(m: Mensaje): string {
  const fecha = m.fecha.toISOString().slice(0, 16); // 2026-05-07T07:41
  const slug = m.titulo
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `${fecha}-${slug}` : fecha;
}

// ---------------------------------------------------------------------------
// Mapeo materia (string) -> carreras del plan
// ---------------------------------------------------------------------------

/**
 * Indexa materias por nombre exacto. La cartelera UNLP usa el mismo nombre
 * literal que el plan, así que el match es directo en la mayoría de los
 * casos. Materias fuera de plan (postgrado, optativas viejas) devuelven
 * array vacío y siguen siendo buscables, pero no se filtran por carrera.
 */
const materiasIndex: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const c of carreras) {
    for (const row of c.plan) {
const set = map.get(row.nombre) ?? new Set<string>();
      map.set(row.nombre, set);
      set.add(c.slug);
    }
  }
  return map;
})();

export function carrerasDeMateria(nombreMateria: string): Carrera[] {
  const slugs = materiasIndex.get(nombreMateria);
  if (!slugs) return [];
  return carreras.filter((c) => slugs.has(c.slug));
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

export interface FiltrosCartelera {
  q?: string;
  materia?: string;
  carrera?: string;
  /** "7" | "30" | "90" | "todo" */
  rango?: string;
  conAdjuntos?: boolean;
  ocultarAnulados?: boolean;
}

export function aplicarFiltros(
  mensajes: Mensaje[],
  f: FiltrosCartelera,
  now: Date = new Date(),
): Mensaje[] {
  const q = f.q?.trim().toLowerCase();
  const dias = parseRango(f.rango);

  return mensajes.filter((m) => {
    if (f.ocultarAnulados !== false && m.isAnulado) return false;

    if (f.conAdjuntos && m.adjuntos.length === 0) return false;

    if (f.materia && m.materia !== f.materia) return false;

    if (f.carrera && !m.carreras.some((c) => c.slug === f.carrera))
      return false;

    if (dias !== null) {
      const diff = (now.getTime() - m.fecha.getTime()) / 86_400_000;
      if (diff > dias) return false;
    }

    if (q) {
      const haystack =
        `${m.titulo} ${m.materia} ${m.autor} ${stripHtml(m.cuerpoHtml)}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

function parseRango(rango?: string): number | null {
  if (!rango || rango === "todo") return null;
  const n = parseInt(rango, 10);
  return Number.isFinite(n) ? n : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Lista única ordenada de materias presentes en el set. */
export function listarMaterias(mensajes: Mensaje[]): string[] {
  const set = new Set<string>();
  for (const m of mensajes) set.add(m.materia);
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

// ---------------------------------------------------------------------------
// Adjuntos
// ---------------------------------------------------------------------------

export function adjuntoEsPdf(adjunto: AdjuntoRaw): boolean {
  return /\.pdf$/i.test(adjunto.public_path) || /\.pdf$/i.test(adjunto.nombre);
}
