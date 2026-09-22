/**
 * Pure bookcase layout: packs books (in display order) left→right onto
 * fixed-width shelves, top shelf first. Positions are scene units along the
 * shelf; the engine converts a shelf index into a height.
 */
export type ShelfLayoutOptions = {
  shelfWidth: number;
  gap: number;
  inset: number;
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
};

export const defaultShelfOptions: ShelfLayoutOptions = {
  shelfWidth: 12,
  gap: 0.045,
  inset: 0.18,
};

export function layoutShelves(
  thicknesses: number[],
  options: ShelfLayoutOptions = defaultShelfOptions,
): ShelfLayout {
  const slots: ShelfLayout["slots"] = [];
  const rows: ShelfRow[] = [];
  let shelf = 0;
  let cursor = options.inset;
  let start = 0;

  thicknesses.forEach((thickness, position) => {
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
  return { slots, rows };
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
