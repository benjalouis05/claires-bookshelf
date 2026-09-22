/**
 * Pure bookcase layout: packs books (in display order) left→right onto
 * fixed-width shelves, top shelf first. Positions are scene units along the
 * shelf; the engine converts a shelf index into a height.
 */
export type ShelfLayoutOptions = {
  shelfWidth: number;
  gap: number;
  inset: number;
  /** Decorative bookends, each taking up room on one shelf. */
  bookends?: BookendSpec[];
};

export type BookendKind = "penguin" | "surfboard" | "lamp";

export type BookendSpec = {
  kind: BookendKind;
  /** Shelf index; negative counts from the bottom (−1 is the last shelf). */
  row: number;
  /** How far along the shelf it stands, 0–1. */
  fraction: number;
  /** Room it takes on the shelf, including breathing space. */
  width: number;
};

export type ShelfRow = {
  index: number;
  /** First display position on this shelf. */
  start: number;
  /** One past the last display position on this shelf. */
  end: number;
};

export type ShelfLayout = {
  /** Indexed by display position. */
  slots: Array<{ x: number; shelf: number }>;
  rows: ShelfRow[];
  /** Where each placed bookend stands (its center). */
  bookends: Array<{ kind: BookendKind; shelf: number; x: number }>;
};

export const defaultShelfOptions: ShelfLayoutOptions = {
  shelfWidth: 12,
  gap: 0.045,
  inset: 0.18,
  bookends: [
    { kind: "penguin", row: 2, fraction: 0.75, width: 1.15 },
    { kind: "surfboard", row: 6, fraction: 0.25, width: 1.0 },
    { kind: "lamp", row: -4, fraction: 0.6, width: 0.95 },
  ],
};

/**
 * Resolves bookends given relative to the bottom shelf. The shelf count
 * depends on where bookends go, so repack until it settles (1–2 passes).
 */
export function layoutShelves(
  thicknesses: number[],
  options: ShelfLayoutOptions = defaultShelfOptions,
): ShelfLayout {
  const specs = options.bookends ?? [];
  let layout = packShelves(thicknesses, {
    ...options,
    bookends: specs.filter((spec) => spec.row >= 0),
  });
  if (!specs.some((spec) => spec.row < 0)) return layout;
  for (let pass = 0; pass < 3; pass += 1) {
    const rows = layout.rows.length;
    const resolved = specs
      .map((spec) => (spec.row < 0 ? { ...spec, row: rows + spec.row } : spec))
      .filter((spec) => spec.row >= 0);
    layout = packShelves(thicknesses, { ...options, bookends: resolved });
    if (layout.rows.length === rows) break;
  }
  return layout;
}

function packShelves(thicknesses: number[], options: ShelfLayoutOptions): ShelfLayout {
  const slots: ShelfLayout["slots"] = [];
  const rows: ShelfRow[] = [];
  let shelf = 0;
  let cursor = options.inset;
  let start = 0;
  const bookends: ShelfLayout["bookends"] = [];
  const pending = [...(options.bookends ?? [])];

  thicknesses.forEach((thickness, position) => {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const end = pending[i];
      if (shelf === end.row && cursor >= options.shelfWidth * end.fraction - end.width / 2) {
        bookends.push({ kind: end.kind, shelf, x: cursor - options.gap + end.width / 2 });
        cursor += end.width;
        pending.splice(i, 1);
      }
    }
    const fits = cursor + thickness <= options.shelfWidth - options.inset;
    if (!fits && position > start) {
      rows.push({ index: shelf, start, end: position });
      shelf += 1;
      start = position;
      cursor = options.inset;
    }
    slots.push({ x: cursor + thickness * 0.5, shelf });
    cursor += thickness + options.gap;
  });

  if (thicknesses.length > start || rows.length === 0) {
    rows.push({ index: shelf, start, end: thicknesses.length });
  }
  return { slots, rows, bookends };
}

/** Display position on `row` whose slot x is nearest to `x`. */
export function nearestOnRow(layout: ShelfLayout, row: number, x: number) {
  const shelf = layout.rows[row];
  if (!shelf) return 0;
  let best = shelf.start;
  let bestDistance = Infinity;
  for (let position = shelf.start; position < shelf.end; position += 1) {
    const distance = Math.abs(layout.slots[position].x - x);
    if (distance < bestDistance) {
      best = position;
      bestDistance = distance;
    }
  }
  return best;
}
