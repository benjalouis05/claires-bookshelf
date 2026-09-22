import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "csv-parse/sync";
import {
  flipAuthor,
  mapRow,
  parseGoodreadsDate,
  shortTitleFor,
  thicknessForPages,
} from "../scripts/build-catalog.mjs";

const csv = parse(await readFile(new URL("../data/goodreads.csv", import.meta.url), "utf8"), {
  columns: true,
  skip_empty_lines: true,
  bom: true,
});
const books = JSON.parse(
  await readFile(new URL("../app/data/books.json", import.meta.url), "utf8"),
);

test("parses Goodreads date formats", () => {
  assert.equal(parseGoodreadsDate("Jun 30, 2026"), "2026-06-30");
  assert.equal(parseGoodreadsDate("Sep 04, 2026"), "2026-09-04");
  assert.equal(parseGoodreadsDate("Jan 2011"), "2011-01-01");
  assert.equal(parseGoodreadsDate("1998"), "1998-01-01");
  assert.equal(parseGoodreadsDate("not set"), null);
  assert.equal(parseGoodreadsDate(""), null);
});

test("normalizes authors and titles", () => {
  assert.equal(flipAuthor("Rawle, Aisling"), "Aisling Rawle");
  assert.equal(flipAuthor("Volkova, Anna Maria"), "Anna Maria Volkova");
  assert.equal(flipAuthor("Plato"), "Plato");
  assert.equal(shortTitleFor("Games: A Love Story"), "Games");
  assert.equal(shortTitleFor("The Dark Secret (Wings of Fire, #4)"), "The Dark Secret");
});

test("maps page counts to plausible thicknesses", () => {
  assert.equal(thicknessForPages(null), 0.2);
  assert.ok(thicknessForPages(100) >= 0.12);
  assert.equal(thicknessForPages(5000), 0.42);
  assert.ok(thicknessForPages(600) > thicknessForPages(300));
});

test("maps every CSV row, with star words and the recency fallback", () => {
  const mapped = csv.map(mapRow);
  assert.equal(mapped.length, csv.length);
  assert.equal(new Set(mapped.map((book) => book.id)).size, csv.length);

  const liked = mapped.find((book) => book.title === "Games: A Love Story");
  assert.equal(liked.myRating, 3);
  assert.equal(liked.dateRead, null);
  assert.equal(liked.recencyDate, liked.dateAdded);
  assert.equal(liked.dateAdded, "2026-09-04");

  for (const book of mapped) {
    assert.ok(book.myRating === null || (book.myRating >= 1 && book.myRating <= 5));
    assert.equal(book.recencyDate, book.dateRead ?? book.dateAdded);
    assert.ok(book.recencyDate, `${book.title} has a recency date`);
  }
  assert.equal(mapped.filter((book) => book.myRating).length, 216);
});

test("generated catalog matches the CSV and has a palette for every book", () => {
  assert.equal(books.length, csv.length);
  for (const book of books) {
    assert.match(book.cover, /^#[0-9a-f]{6}$/);
    assert.match(book.accent, /^#[0-9a-f]{6}$/);
    assert.ok(book.height >= 1.56 && book.height <= 2.32);
    assert.ok(book.cornerRadius >= 0.01 && book.cornerRadius <= 0.1);
    assert.ok(!("sourceCover" in book));
  }
});
