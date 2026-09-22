// Builds app/data/books.json and public/covers/<id>.webp from the scraped
// Goodreads shelf export in data/goodreads.csv. Safe to rerun: covers that
// already exist on disk are reused, so only new books hit the network.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = path.join(root, "data/goodreads.csv");
const outJson = path.join(root, "app/data/books.json");
const coverDir = path.join(root, "public/covers");
const offline = process.argv.includes("--offline");

const motifs = [
  "lattice", "corrosion", "efficiency", "network", "boom", "organization",
  "schematic", "flight", "circuit", "orbit", "branches", "wave", "runner",
  "gather", "maze", "fracture", "continuum", "windows", "steps",
];

const ratingWords = {
  "did not like it": 1,
  "it was ok": 2,
  "liked it": 3,
  "really liked it": 4,
  "it was amazing": 5,
};

const months = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Goodreads prints "Jun 30, 2026", "Jun 2026" or "2026". Returns ISO date.
export function parseGoodreadsDate(value) {
  const text = (value ?? "").trim();
  if (!text || /not set|unknown/i.test(text)) return null;
  let match = text.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = months[match[1].toLowerCase()];
    return month ? iso(Number(match[3]), month, Number(match[2])) : null;
  }
  match = text.match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (match) {
    const month = months[match[1].toLowerCase()];
    return month ? iso(Number(match[2]), month, 1) : null;
  }
  match = text.match(/^(\d{4})$/);
  if (match) return iso(Number(match[1]), 1, 1);
  return null;
}

function iso(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function hash(text) {
  let state = 2166136261;
  for (const char of text) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
}

export function flipAuthor(name) {
  const text = (name ?? "").trim().replace(/\s+/g, " ");
  const parts = text.split(",");
  if (parts.length !== 2) return text;
  return `${parts[1].trim()} ${parts[0].trim()}`.trim();
}

export function shortTitleFor(title) {
  const base = title
    .replace(/\s*\([^)]*#[^)]*\)\s*$/, "")
    .split(/:\s/)[0]
    .trim();
  return base.length > 42 ? `${base.slice(0, 40).trimEnd()}…` : base;
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && String(value ?? "").trim() !== "" ? parsed : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unit(seed) {
  return (hash(seed) % 10000) / 10000;
}

export function heightForFormat(format, id) {
  const f = format.toLowerCase();
  const base = f.includes("mass market")
    ? 1.72
    : f.includes("hardcover") || f.includes("library")
      ? 2.1
      : 1.94;
  // A wide, uneven spread like a real shelf: most books near their format's
  // size, with the occasional oversized or pocket-sized volume.
  const jitter = (unit(`${id}-h`) - 0.5) * 0.28;
  const oddity = unit(`${id}-odd`);
  const extra = oddity > 0.93 ? 0.16 : oddity < 0.06 ? -0.18 : 0;
  return Number(clamp(base + jitter + extra, 1.56, 2.32).toFixed(3));
}

/** Board corner radius: some books crisp, some soft and well-worn. */
export function cornerRadiusFor(format, id) {
  const soft = format.toLowerCase().includes("hardcover") ? 0.012 : 0;
  return Number((0.01 + unit(`${id}-r`) ** 1.6 * 0.07 + soft).toFixed(4));
}

export function thicknessForPages(pages) {
  if (!pages) return 0.2;
  return Number(clamp(0.12 + pages * 0.00035, 0.12, 0.42).toFixed(3));
}

export function mapRow(row) {
  const url = row["value href"];
  const id = url.match(/\/show\/(\d+)/)?.[1];
  if (!id) throw new Error(`No Goodreads id in ${url}`);
  const title = row["value"].trim();
  const pages = row["greyText"] === "unknown" ? null : number(row["value 7"]);
  const format = row["value 16"].trim() || "Unknown binding";
  const dateRead = parseGoodreadsDate(row["date_read_value"]);
  const dateAdded = parseGoodreadsDate(row["value 15"]);
  const series = row["darkGreyText"].trim().replace(/^\(|\)$/g, "") || null;

  return {
    id,
    title,
    shortTitle: shortTitleFor(title),
    author: flipAuthor(row["value 2"]),
    series,
    isbn: row["value 4"].trim() || null,
    isbn13: row["value 5"].trim() || null,
    pages,
    format,
    avgRating: number(row["value 8"]),
    ratingsCount: number(row["value 9"]),
    published: parseGoodreadsDate(row["value 10"]),
    originalPublished: parseGoodreadsDate(row["value 11"]),
    myRating: ratingWords[row["staticStar"].trim().toLowerCase()] ?? null,
    timesRead: number(row["value 14"]) ?? 1,
    dateAdded,
    dateRead,
    recencyDate: dateRead ?? dateAdded,
    url,
    motif: motifs[hash(id) % motifs.length],
    height: heightForFormat(format, id),
    cornerRadius: cornerRadiusFor(format, id),
    thickness: thicknessForPages(pages),
    sourceCover: row["value src"].trim() || null,
  };
}

// ---- colors --------------------------------------------------------------

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

// Spines should read as bright, cheerful cloth in the cover's own colors:
// never muddy near-black, never blown-out white.
export function paletteFromRgb(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  const neutral = s < 0.12;
  const coverS = neutral ? clamp(s, 0.04, 0.1) : clamp(s * 0.95, 0.3, 0.68);
  const coverL = neutral ? clamp(l, 0.52, 0.76) : clamp(l, 0.42, 0.68);
  const cover = hslToRgb([h, coverS, coverL]);
  const ink = coverL > 0.56 ? "#23201c" : "#fbf5ea";
  const accent = hslToRgb([
    (h + 0.08) % 1,
    clamp(coverS + 0.1, 0.25, 0.75),
    coverL > 0.56 ? 0.3 : 0.82,
  ]);
  return { cover: toHex(cover), accent: toHex(accent), ink };
}

export function paletteFromHash(id) {
  const value = hash(`${id}-palette`);
  const h = (value % 360) / 360;
  const s = 0.25 + ((value >>> 9) % 30) / 100;
  const l = 0.24 + ((value >>> 17) % 26) / 100;
  return paletteFromRgb(hslToRgb([h, s, l]));
}

// ---- covers --------------------------------------------------------------

function fullSizeCoverUrl(src) {
  return src.replace(/\._S[XY]\d+(_S[XY]\d+)?_\./, ".");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffer(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "claires-bookshelf/0.1 (personal catalog build)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1200) throw new Error("placeholder image");
      return buffer;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function coverCandidates(book) {
  const urls = [];
  if (book.sourceCover) {
    urls.push(fullSizeCoverUrl(book.sourceCover), book.sourceCover);
  }
  for (const isbn of [book.isbn13, book.isbn]) {
    if (isbn) urls.push(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`);
  }
  return urls;
}

async function ensureCover(book) {
  const file = path.join(coverDir, `${book.id}.webp`);
  if (await exists(file)) return { file, fetched: false };
  if (offline) return null;
  for (const url of await coverCandidates(book)) {
    try {
      const buffer = await fetchBuffer(url);
      await sharp(buffer)
        .resize(320, 480, { fit: "cover", position: "attention" })
        .webp({ quality: 80 })
        .toFile(file);
      return { file, fetched: true };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The cover color a reader would name: buckets a small thumbnail by hue and
 * lightness and favors large, saturated, mid-light regions over the dark or
 * paper-white backgrounds that dominate many covers.
 */
export async function vividRgb(file) {
  const { data, info } = await sharp(file)
    .resize(40, 60, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  let total = [0, 0, 0];
  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    const rgb = [data[i], data[i + 1], data[i + 2]];
    total = total.map((sum, c) => sum + rgb[c]);
    const [h, sat, light] = rgbToHsl(rgb);
    const key = sat < 0.12 ? `n${Math.round(light * 6)}` : `${Math.round(h * 18) % 18}-${Math.round(light * 5)}`;
    const bucket = buckets.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bucket.count += 1;
    bucket.sum = bucket.sum.map((sum, c) => sum + rgb[c]);
    buckets.set(key, bucket);
  }
  let best = null;
  let bestScore = -1;
  for (const bucket of buckets.values()) {
    const share = bucket.count / pixels;
    if (share < 0.03) continue;
    const mean = bucket.sum.map((sum) => sum / bucket.count);
    const [, sat, light] = rgbToHsl(mean);
    const lightFit = 1 - Math.min(1, Math.abs(light - 0.55) / 0.45);
    const score = Math.sqrt(share) * (0.15 + sat) * (0.2 + lightFit);
    if (score > bestScore) {
      bestScore = score;
      best = mean;
    }
  }
  return best ?? total.map((sum) => sum / pixels);
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
      done += 1;
      if (done % 50 === 0 || done === items.length) {
        process.stdout.write(`\r  covers ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  process.stdout.write("\n");
  return results;
}

async function main() {
  const text = await readFile(csvPath, "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true });
  const books = [];
  const seen = new Set();
  const problems = [];
  for (const row of rows) {
    try {
      const book = mapRow(row);
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      books.push(book);
    } catch (error) {
      problems.push(String(error));
    }
  }

  await mkdir(coverDir, { recursive: true });
  let fetched = 0;
  const missing = [];
  await mapLimit(books, 6, async (book) => {
    const result = await ensureCover(book);
    if (result) {
      if (result.fetched) fetched += 1;
      book.coverImage = `/covers/${book.id}.webp`;
      Object.assign(book, paletteFromRgb(await vividRgb(result.file)));
    } else {
      missing.push(book.title);
      Object.assign(book, paletteFromHash(book.id));
    }
  });

  const output = books.map((book) => {
    const copy = { ...book };
    delete copy.sourceCover;
    return copy;
  });
  await mkdir(path.dirname(outJson), { recursive: true });
  await writeFile(outJson, `${JSON.stringify(output, null, 1)}\n`);

  const count = (predicate) => output.filter(predicate).length;
  console.log(`Parsed ${rows.length} rows → ${output.length} books`);
  console.log(`  covers: ${count((b) => b.coverImage)} available (${fetched} fetched now), ${missing.length} procedural`);
  console.log(`  my rating: ${count((b) => b.myRating)} · date read: ${count((b) => b.dateRead)} · pages: ${count((b) => b.pages)}`);
  if (missing.length) console.log(`  no cover: ${missing.slice(0, 12).join(" | ")}${missing.length > 12 ? " …" : ""}`);
  if (problems.length) console.log(`  problems:\n    ${problems.join("\n    ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
