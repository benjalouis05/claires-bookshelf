# Claire's Bookshelf

A tactile 3D bookcase of every book on Claire's Goodreads shelves: 765
volumes on 20 walnut shelves. Scroll the bookcase, click a shelf to browse it
book by book, and pull any volume forward to orbit, zoom, and read its details.
Sort by when it was read, Claire's rating, the Goodreads average, title,
author, or length.

Adapted from Mint's [Complete Shelf](https://github.com/mintdotgg/mint-playground/tree/d1eee7e69bcf357c6647cf5114e773c5ae3be4c5/experiences/complete-shelf)
(MIT). The motion system (`app/book-motion.ts`), procedural covers, and
inspection view come from there. What's new is the multi-shelf bookcase, the
instanced renderer that makes hundreds of books cheap, sorting, and search.

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:5203
```

Static build (outputs `dist/`, which can be hosted anywhere):

```bash
npm run build
npx serve dist
```

Checks:

```bash
npm run lint && npm run type-check && npm test
```

## Updating the books

1. Replace `data/goodreads.csv` with a new scrape of the Goodreads shelf.
   It uses the same generic `value`, `value 2`, … headers. The column map is
   at the top of `mapRow` in `scripts/build-catalog.mjs`.
2. Run `npm run catalog`. The script:
   - writes `app/data/books.json`;
   - downloads any covers it doesn't have yet into `public/covers/`, as
     320×480 WebP (Goodreads full-size first, then Open Library by ISBN);
   - picks each book's spine color from the most vivid region of its cover
     (never a near-black background), lightened into a cloth-like range.

   Existing covers are reused. `npm run catalog -- --offline` skips the
   network entirely.

A few notes on the data:

- **Recency** means the date read, falling back to the date added.
- **"My rating"** comes from the star words Goodreads prints ("liked it" is
  3★ and so on). That sort shelves only the 216 rated books; the others fly
  off the shelves until you pick another sort.
- **Book thickness** comes from the page count, and **height** from the
  format (hardcover, paperback or mass-market).

## How 765 books stay fast

The reference renders each book as about 12 meshes with three canvas textures
(about 5 MB of GPU memory per book). At 765 books that would be about 9,000
draw calls and about 3.8 GB of textures. This version renders in tiers:

| Tier | What | Cost |
| --- | --- | --- |
| Instanced library (`engine/InstancedLibrary.ts`) | Every book is one instance of a box. The spine comes from a shared atlas; board and page colors are per instance. | 1 draw call (+1 shadow) |
| Spine atlas (`engine/SpineAtlas.ts`) | Two 2048² "far" pages hold all spines at 32×320. A 32-cell "near" page streams 128×1024 spines for books near the camera, patched one cell at a time. | about 70 MB total, fixed |
| Hero books (`engine/HeroBook.ts`) | The fully modelled hardcover from the reference, created only for books that leave the shelf (usually 1–2). | about 10 draw calls each |
| Cover cache (`engine/TextureCache.ts`) | An LRU of 40 cover textures. Evicted covers are disposed. | Bounded |
| Bookcase (`engine/Bookcase.ts`) | Boards, lips, sides and shelf plaques are merged per material. | 4 draw calls |

A typical frame is 10 draw calls in the bookcase view and about 17 while
inspecting. Diagnostics are available in the browser console:

```js
__BOOKSHELF__.diagnostics()   // draw calls, textures, fps, mode, collisions…
__BOOKSHELF__.focus(120)      // pull out the book at display position 120
__BOOKSHELF__.tick(60)        // advance one simulated second (for scripted tests)
```

## Files

- `app/BookshelfApp.tsx`: UI (header, sort, search, captions, shelf rail,
  details panel)
- `app/engine/ShelfEngine.ts`: renderer, camera modes (bookcase → shelf →
  inspect), input, and the reference's browse and focus state machine
- `app/sorts.ts`, `app/layout-shelves.ts`: pure sort and shelf-packing logic
  (unit tested)
- `app/book-motion.ts`: collision-safe pose math. `tests/motion.test.mjs`
  checks every book's routes against its real shelf neighbours.
- `app/cover-art.ts`: procedural fronts, spines, back covers and shelf labels
- `app/site-config.ts`: names and copy. Set `useCoverImages: false` to show
  procedural covers only, for example if you publish the site and don't want
  to redistribute publisher cover art.

Cover images belong to their publishers and are used here for a personal,
non-commercial catalog.
