import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  bookFootprintsOverlap,
  browseMotionPose,
  browsePhaseDuration,
  coverWidthFor,
  createMotionLayout,
  focusedBookPose,
  layoutForBook,
  presentedBookPose,
  shelvedBookPose,
} from "../app/book-motion.ts";
import { layoutShelves } from "../app/layout-shelves.ts";
import { sortBooks } from "../app/sorts.ts";

const catalog = JSON.parse(
  await readFile(new URL("../app/data/books.json", import.meta.url), "utf8"),
).map((book) => ({ ...book, width: coverWidthFor(book.height) }));
const base = createMotionLayout(catalog);
const slotZ = 0.04;

function shelves(key) {
  const order = sortBooks(catalog, key);
  const layout = layoutShelves(order.map((index) => catalog[index].thickness));
  return layout.rows.map((row) =>
    order.slice(row.start, row.end).map((index, offset) => {
      const book = catalog[index];
      return {
        id: book.id,
        x: layout.slots[row.start + offset].x,
        width: book.width,
        thickness: book.thickness,
        layout: layoutForBook(base, book.width),
      };
    }),
  );
}

function footprint(book, pose) {
  return {
    id: book.id,
    x: book.x + pose.x,
    z: slotZ + pose.z,
    yaw: pose.yaw,
    scale: pose.scale,
    width: book.width,
    thickness: book.thickness,
  };
}

/** Moving book vs. every other book on the same shelf (still shelved). */
function assertClear(row, moving, pose, context) {
  const moved = footprint(row[moving], pose);
  row.forEach((other, index) => {
    if (index === moving) return;
    const still = footprint(other, shelvedBookPose(other.layout));
    assert.equal(
      bookFootprintsOverlap(moved, still, base.collisionMargin),
      false,
      `${context}: ${row[moving].id} overlaps ${other.id}`,
    );
  });
}

test("the rotation lane clears the widest and thickest books", () => {
  assert.ok(base.rotationLaneZ > base.presentedZ);
  assert.ok(base.rotationLaneZ < 1.4);
});

test("shelved spines are flush and neighbours never overlap at rest", () => {
  for (const row of shelves("recent")) {
    row.forEach((book, index) => {
      const pose = shelvedBookPose(book.layout);
      assert.ok(Math.abs(pose.z + book.width / 2 - 0.03) < 1e-9);
      if (index > 0) {
        const previous = row[index - 1];
        assert.equal(
          bookFootprintsOverlap(
            footprint(previous, shelvedBookPose(previous.layout)),
            footprint(book, pose),
            base.collisionMargin,
          ),
          false,
        );
      }
    });
  }
});

test("every book's browse and focus routes stay collision-free", () => {
  const phases = [
    "retreat-current",
    "turn-current",
    "shelve-current",
    "extract-next",
    "turn-next",
    "settle-next",
  ];
  for (const key of ["recent", "longest"]) {
    for (const row of shelves(key)) {
      row.forEach((book, index) => {
        for (const phase of phases) {
          const steps = Math.ceil(browsePhaseDuration[phase] * 120);
          for (let step = 0; step <= steps; step += 1) {
            assertClear(row, index, browseMotionPose(phase, step / steps, book.layout), `${key} ${phase}`);
          }
        }
        assertClear(row, index, presentedBookPose(book.layout), `${key} presented`);
        for (const focus of [
          { x: -0.58, z: 1.66, scale: 1.08 },
          { x: 0, z: 1.4, scale: 0.92 },
        ]) {
          for (let step = 0; step <= 40; step += 1) {
            assertClear(
              row,
              index,
              focusedBookPose(step / 40, book.layout, focus.x, focus.z, focus.scale),
              `${key} focus`,
            );
          }
        }
      });
    }
  }
});
