import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultShelfOptions, layoutShelves, nearestOnRow } from "../app/layout-shelves.ts";
import { authorSortKey, shelfLabel, sortBooks, sortOptions, titleSortKey } from "../app/sorts.ts";

const books = JSON.parse(
  await readFile(new URL("../app/data/books.json", import.meta.url), "utf8"),
);

function inOrder(key) {
  return sortBooks(books, key).map((index) => books[index]);
}

test("every unfiltered sort is a permutation of the whole library", () => {
  for (const { key } of sortOptions) {
    const order = sortBooks(books, key);
    const expected = key === "my-rating" ? books.filter((book) => book.myRating).length : books.length;
    assert.equal(order.length, expected, key);
    assert.equal(new Set(order).size, expected, key);
  }
});

test("recently read puts the newest read-or-added date first", () => {
  const sorted = inOrder("recent");
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i - 1].recencyDate >= sorted[i].recencyDate, `recent @${i}`);
  }
  const oldest = inOrder("oldest");
  assert.equal(oldest[0].recencyDate, sorted.at(-1).recencyDate);
});

test("my rating shelves only rated books, stars first, ties by Goodreads average", () => {
  const sorted = inOrder("my-rating");
  assert.equal(sorted.length, 216);
  assert.ok(sorted.every((book) => book.myRating));
  for (let i = 1; i < sorted.length; i += 1) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    assert.ok(a.myRating >= b.myRating);
    if (a.myRating === b.myRating) assert.ok((a.avgRating ?? 0) >= (b.avgRating ?? 0));
  }
});

test("Goodreads rating and length sorts are descending", () => {
  const byAverage = inOrder("goodreads");
  for (let i = 1; i < byAverage.length; i += 1) {
    assert.ok((byAverage[i - 1].avgRating ?? 0) >= (byAverage[i].avgRating ?? 0));
  }
  const byLength = inOrder("longest").filter((book) => book.pages !== null);
  for (let i = 1; i < byLength.length; i += 1) {
    assert.ok(byLength[i - 1].pages >= byLength[i].pages);
  }
});

test("title and author sort keys ignore articles and first names", () => {
  assert.equal(titleSortKey("The Hobbit"), "Hobbit");
  assert.equal(titleSortKey("A Court of Mist and Fury"), "Court of Mist and Fury");
  assert.equal(authorSortKey("Sally Rooney"), "Rooney Sally");
  assert.equal(authorSortKey("Martin Luther King Jr."), "King Martin Luther");
});

test("shelves pack left to right, never overflow, and cover every book once", () => {
  for (const { key } of sortOptions) {
    const order = sortBooks(books, key);
    const thicknesses = order.map((index) => books[index].thickness);
    const layout = layoutShelves(thicknesses);
    const expectedRows = key === "my-rating" ? [5, 8] : [15, 25];
    assert.ok(
      layout.rows.length >= expectedRows[0] && layout.rows.length <= expectedRows[1],
      `${key}: ${layout.rows.length} shelves`,
    );
    assert.equal(layout.rows[0].start, 0);
    assert.equal(layout.rows.at(-1).end, order.length);
    layout.rows.forEach((row, index) => {
      if (index > 0) assert.equal(row.start, layout.rows[index - 1].end);
      for (let position = row.start; position < row.end; position += 1) {
        const slot = layout.slots[position];
        assert.equal(slot.shelf, row.index);
        const half = thicknesses[position] / 2;
        assert.ok(slot.x - half >= defaultShelfOptions.inset - 1e-9);
        assert.ok(slot.x + half <= defaultShelfOptions.shelfWidth - defaultShelfOptions.inset + 1e-9);
        if (position > row.start) {
          const previous = layout.slots[position - 1];
          const gap = slot.x - half - (previous.x + thicknesses[position - 1] / 2);
          const bookend = layout.bookends.find(
            (end) => end.shelf === row.index && previous.x < end.x && slot.x > end.x,
          );
          const spec = defaultShelfOptions.bookends.find((end) => end.kind === bookend?.kind);
          const expected = defaultShelfOptions.gap + (spec ? spec.width : 0);
          assert.ok(Math.abs(gap - expected) < 1e-9, `${key} gap @${position}`);
        }
      }
    });
    const label = shelfLabel(order.slice(0, layout.rows[0].end).map((i) => books[i]), key);
    assert.ok(label.length > 0, `${key} label`);
  }
});

test("bookends stand where planned, with clear space beside the books", () => {
  for (const { key } of sortOptions) {
    const order = sortBooks(books, key);
    const thicknesses = order.map((index) => books[index].thickness);
    const layout = layoutShelves(thicknesses);
    const { shelfWidth, bookends } = defaultShelfOptions;
    for (const spec of bookends) {
      const placed = layout.bookends.find((end) => end.kind === spec.kind);
      assert.ok(placed, `${key} ${spec.kind}`);
      assert.equal(placed.shelf, spec.row);
      assert.ok(
        Math.abs(placed.x - shelfWidth * spec.fraction) < 0.35,
        `${key} ${spec.kind} x=${placed.x}`,
      );
      const row = layout.rows[spec.row];
      for (let position = row.start; position < row.end; position += 1) {
        const distance = Math.abs(layout.slots[position].x - placed.x);
        assert.ok(
          distance >= spec.width / 2 + thicknesses[position] / 2 - 1e-9,
          `${key} ${spec.kind} overlaps @${position}`,
        );
      }
    }
  }
});

test("nearestOnRow finds the book under a given x", () => {
  const layout = layoutShelves(books.map((book) => book.thickness));
  const row = layout.rows[3];
  const target = row.start + 5;
  assert.equal(nearestOnRow(layout, 3, layout.slots[target].x + 0.01), target);
  assert.equal(nearestOnRow(layout, 3, -10), row.start);
  assert.equal(nearestOnRow(layout, 3, 100), row.end - 1);
});
