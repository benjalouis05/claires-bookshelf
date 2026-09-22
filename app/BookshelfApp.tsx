"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { catalog, type Book } from "./catalog";
import type { ShelfEngine, ShelfMode } from "./engine/ShelfEngine";
import { spineFontFaces } from "./cover-art";
import { layoutShelves } from "./layout-shelves";
import { siteConfig } from "./site-config";
import {
  formatDate,
  shelfLabel,
  sortBooks,
  sortOptions,
  stars,
  type SortKey,
} from "./sorts";
import { SearchBox } from "./ui/SearchBox";
import { SortMenu } from "./ui/SortMenu";

function ArrowIcon({ direction }: { direction: "left" | "right" | "up" | "down" }) {
  return (
    <span aria-hidden="true" className={`arrow-icon arrow-icon--${direction}`}>
      <span />
    </span>
  );
}

function pad(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function Stars({ rating, label }: { rating: number | null; label?: string }) {
  if (!rating) return null;
  return (
    <span className="stars" aria-label={label ?? `Rated ${rating} of 5`}>
      <span aria-hidden="true">{"★".repeat(rating)}</span>
      <span aria-hidden="true" className="stars__empty">
        {"★".repeat(5 - rating)}
      </span>
    </span>
  );
}

export function BookshelfApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ShelfEngine | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [activeIndex, setActiveIndex] = useState(0);
  const [shelf, setShelf] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<ShelfMode>("bookcase");
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const [status, setStatus] = useState("Preparing the bookcase");

  const order = useMemo(() => sortBooks(catalog, sortKey), [sortKey]);
  const layout = useMemo(
    () => layoutShelves(order.map((index) => catalog[index].thickness)),
    [order],
  );
  const labels = useMemo(
    () =>
      layout.rows.map((row) =>
        shelfLabel(
          order.slice(row.start, row.end).map((index) => catalog[index]),
          sortKey,
        ),
      ),
    [layout, order, sortKey],
  );
  const positionOf = useMemo(() => {
    const positions = new Array<number>(catalog.length).fill(-1);
    order.forEach((catalogIndex, position) => {
      positions[catalogIndex] = position;
    });
    return positions;
  }, [order]);

  // The engine is created once; later sort changes are pushed to it below.
  const initialOrder = useRef({ order, labels });
  const appliedOrder = useRef(order);

  const activeBook = catalog[order[activeIndex]];
  const selectedBook: Book | null =
    selectedIndex === null ? null : catalog[order[selectedIndex]];
  const isFocused = mode === "focusing" || mode === "inspect" || mode === "returning";
  const isBookcase = mode === "bookcase";
  const activeRow = layout.slots[activeIndex]?.shelf ?? 0;
  const currentRow = isBookcase ? shelf : activeRow;
  const row = layout.rows[currentRow] ?? layout.rows[0];
  const sortLabel = sortOptions.find((option) => option.key === sortKey)?.label ?? "";

  useEffect(() => {
    let cancelled = false;
    let engine: ShelfEngine | null = null;

    async function start() {
      if (!canvasRef.current) return;
      // Spines are painted into canvases, so every face must be loaded first.
      await Promise.all(spineFontFaces.map((face) => document.fonts.load(face))).catch(
        () => undefined,
      );
      await document.fonts.ready;
      const { ShelfEngine } = await import("./engine/ShelfEngine");
      if (cancelled || !canvasRef.current) return;
      engine = new ShelfEngine(
        canvasRef.current,
        catalog,
        initialOrder.current.order,
        initialOrder.current.labels,
        {
          onActiveIndex: setActiveIndex,
          onShelf: setShelf,
          onMode: (nextMode, index) => {
            setMode(nextMode);
            setSelectedIndex(index);
          },
          onStatus: setStatus,
          onProgress: setProgress,
          onReady: () => setReady(true),
          onContextLost: () => setContextLost(true),
        },
      );
      engineRef.current = engine;
    }

    void start();
    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (appliedOrder.current === order) return;
    appliedOrder.current = order;
    engineRef.current?.setOrder(order, labels, true);
  }, [order, labels]);

  const shelfOf = useCallback(
    (catalogIndex: number) => {
      const position = positionOf[catalogIndex];
      return position >= 0 ? (layout.slots[position]?.shelf ?? null) : null;
    },
    [positionOf, layout],
  );

  function chooseResult(catalogIndex: number) {
    const position = positionOf[catalogIndex];
    if (position < 0) return;
    engineRef.current?.goToBook(position);
    engineRef.current?.focusCanvas();
  }

  const detailFacts = selectedBook
    ? ([
        ["My rating", selectedBook.myRating ? stars(selectedBook.myRating) : "Not rated"],
        [
          "Goodreads",
          selectedBook.avgRating
            ? `${selectedBook.avgRating.toFixed(2)} avg · ${(selectedBook.ratingsCount ?? 0).toLocaleString("en-US")} ratings`
            : null,
        ],
        ["Date read", formatDate(selectedBook.dateRead)],
        ["Shelved", formatDate(selectedBook.dateAdded)],
        [
          "Format",
          `${selectedBook.format}${selectedBook.pages ? ` · ${selectedBook.pages.toLocaleString("en-US")} pages` : ""}`,
        ],
        [
          "First published",
          formatDate(selectedBook.originalPublished ?? selectedBook.published),
        ],
        selectedBook.timesRead > 1 ? ["Times read", String(selectedBook.timesRead)] : null,
      ].filter((fact): fact is [string, string] => Boolean(fact && fact[1])))
    : [];

  return (
    <main
      className={`press-experience ${ready ? "is-ready" : ""} ${
        isFocused ? "is-focused" : "is-browsing"
      } ${isBookcase ? "is-bookcase" : "is-shelf"} ${isBookcase && shelf > 0 ? "is-scrolled" : ""}`}
    >
      <canvas
        ref={canvasRef}
        className="shelf-canvas"
        data-testid="shelf-canvas"
        role="application"
        tabIndex={0}
        aria-label={`Interactive three-dimensional bookcase of ${order.length} books on ${layout.rows.length} shelves. Use up and down arrows to move between shelves, Enter to open a shelf, left and right arrows to browse books, Enter to inspect, and Escape to go back.`}
      />

      <header className="site-header">
        <div className="masthead">
          <button
            type="button"
            className="wordmark"
            aria-label={`${siteConfig.wordmark}: back to the bookcase`}
            tabIndex={isBookcase ? -1 : 0}
            onClick={() => {
              if (isFocused) engineRef.current?.returnToShelf();
              else engineRef.current?.exitToBookcase();
            }}
          >
            <span>{siteConfig.wordmark}</span>
            <span className="wordmark__divider" />
            <span>{siteConfig.collectionName}</span>
          </button>
          <div className="page-title" aria-hidden={!isBookcase}>
            <h1>Claire’s Bookshelf</h1>
            <p>
              {order.length.toLocaleString("en-US")} books on {layout.rows.length} shelves
              <span aria-hidden="true"> · </span>
              {sortLabel.toLowerCase()}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <SearchBox
            books={catalog}
            shelfOf={shelfOf}
            onChoose={chooseResult}
            disabled={isFocused || !ready}
            hiddenNote="unrated, so they’re off the shelves in this sort"
          />
          <SortMenu value={sortKey} onChange={setSortKey} disabled={isFocused || !ready} />
        </div>
      </header>

      {!isBookcase ? (
        <button
          type="button"
          className="back-fab"
          data-testid="back"
          onClick={() => {
            if (isFocused) engineRef.current?.returnToShelf();
            else engineRef.current?.exitToBookcase();
          }}
        >
          <ArrowIcon direction="left" />
          <span>{isFocused ? "Back to shelf" : "Back to bookcase"}</span>
        </button>
      ) : null}

      <section
        className="browse-caption"
        aria-hidden={isFocused}
        data-testid="browse-caption"
      >
        {isBookcase ? (
          <>
            <p className="eyebrow">
              <span>SHELF {pad(currentRow + 1, 2)}</span>
              <span className="eyebrow__line" />
              <span>{pad(layout.rows.length, 2)}</span>
            </p>
            <h2>{labels[currentRow]}</h2>
            <p className="browse-caption__author">
              {row.end - row.start} volumes · {sortLabel.toLowerCase()}
            </p>
            <button
              type="button"
              className="inspect-button"
              disabled={!ready}
              onClick={() => engineRef.current?.enterShelf()}
            >
              <span>Browse this shelf</span>
              <span aria-hidden="true">↗</span>
            </button>
          </>
        ) : (
          <>
            <p className="eyebrow">
              <span>{pad(activeIndex + 1, 3)}</span>
              <span className="eyebrow__line" />
              <span>{pad(order.length, 3)}</span>
              <span className="eyebrow__shelf">SHELF {pad(activeRow + 1, 2)}</span>
            </p>
            <h2>{activeBook.shortTitle}</h2>
            <p className="browse-caption__author">
              {activeBook.author}
              {activeBook.myRating ? (
                <>
                  {" "}
                  <Stars rating={activeBook.myRating} />
                </>
              ) : null}
            </p>
            <div className="caption-actions">
              <button
                type="button"
                className="inspect-button"
                data-testid="inspect-active"
                disabled={isFocused}
                onClick={() => engineRef.current?.focusBook(activeIndex)}
                aria-label={`Inspect ${activeBook.title}`}
              >
                <span>Inspect volume</span>
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </>
        )}
      </section>

      {isBookcase ? (
        <div className="shelf-stepper" aria-label="Move between shelves">
          <button
            type="button"
            className="shelf-arrow shelf-arrow--up"
            aria-label="Previous shelf"
            disabled={!ready || shelf === 0}
            onClick={() => engineRef.current?.shelfBy(-1)}
          >
            <ArrowIcon direction="up" />
          </button>
          <button
            type="button"
            className="shelf-arrow shelf-arrow--down"
            aria-label="Next shelf"
            disabled={!ready || shelf === layout.rows.length - 1}
            onClick={() => engineRef.current?.shelfBy(1)}
          >
            <ArrowIcon direction="down" />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="shelf-arrow shelf-arrow--left"
            data-testid="browse-previous"
            aria-label="Previous book"
            disabled={isFocused || activeIndex === 0}
            onClick={() => engineRef.current?.browseBy(-1)}
          >
            <ArrowIcon direction="left" />
          </button>
          <button
            type="button"
            className="shelf-arrow shelf-arrow--right"
            data-testid="browse-next"
            aria-label="Next book"
            disabled={isFocused || activeIndex === order.length - 1}
            onClick={() => engineRef.current?.browseBy(1)}
          >
            <ArrowIcon direction="right" />
          </button>
        </>
      )}

      <nav className="shelf-rail" aria-label="Shelves" aria-hidden={!isBookcase}>
        {layout.rows.map((entry) => (
          <button
            key={entry.index}
            type="button"
            className={entry.index === currentRow ? "is-active" : ""}
            aria-current={entry.index === currentRow ? "true" : undefined}
            aria-label={`Shelf ${entry.index + 1}: ${labels[entry.index]}`}
            tabIndex={isBookcase ? 0 : -1}
            onClick={() => engineRef.current?.shelfTo(entry.index)}
          >
            <span className="shelf-rail__label">
              <b>{pad(entry.index + 1, 2)}</b> {labels[entry.index]}
            </span>
            <span className="shelf-rail__tick" />
          </button>
        ))}
      </nav>

      <nav
        className="shelf-index"
        aria-label="Books on this shelf"
        aria-hidden={isBookcase}
      >
        <div
          className="shelf-index__ticks"
          style={{ gridTemplateColumns: `repeat(${row.end - row.start}, 1fr)` }}
        >
          {isBookcase
            ? null
            : order.slice(row.start, row.end).map((catalogIndex, offset) => {
                const position = row.start + offset;
                const book = catalog[catalogIndex];
                return (
                  <button
                    key={book.id}
                    type="button"
                    className={position === activeIndex ? "is-active" : ""}
                    aria-label={`Browse to ${book.title}`}
                    aria-current={position === activeIndex ? "true" : undefined}
                    disabled={isFocused}
                    onClick={() => engineRef.current?.browseTo(position)}
                  >
                    <span />
                  </button>
                );
              })}
        </div>
        <div className="input-hint" aria-hidden="true">
          {isBookcase ? (
            <>
              <span>SCROLL SHELVES</span>
              <i />
              <span>CLICK A BOOK</span>
            </>
          ) : (
            <>
              <span>DRAG</span>
              <i />
              <span>← → BOOKS</span>
              <i />
              <span>↑ ↓ SHELVES</span>
              <i />
              <span>ESC BOOKCASE</span>
            </>
          )}
        </div>
      </nav>

      <aside
        className="book-details"
        aria-hidden={!isFocused}
        aria-label={selectedBook ? `Details for ${selectedBook.title}` : "Book details"}
        data-testid="book-details"
      >
        {selectedBook && selectedIndex !== null ? (
          <div className="book-details__inner">
            <button
              type="button"
              className="back-button"
              data-testid="return-to-shelf"
              onClick={() => engineRef.current?.returnToShelf()}
            >
              <ArrowIcon direction="left" />
              <span>Return to shelf</span>
            </button>
            <div className="book-details__position">
              <span>{pad(selectedIndex + 1, 3)}</span>
              <span>{pad(order.length, 3)}</span>
            </div>
            <div className="book-details__copy">
              <p className="eyebrow">
                {selectedBook.series ?? `Shelf ${pad(activeRow + 1, 2)} · ${sortLabel}`}
              </p>
              <h2>{selectedBook.title}</h2>
              <p className="book-details__author">{selectedBook.author}</p>
              {selectedBook.myRating ? (
                <p className="book-details__rating">
                  <Stars rating={selectedBook.myRating} label={`Claire rated it ${selectedBook.myRating} of 5`} />
                </p>
              ) : null}
              <dl>
                {detailFacts.map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <a
                className="official-link"
                data-testid="official-link"
                href={selectedBook.url}
                target="_blank"
                rel="noreferrer"
              >
                <span>{siteConfig.bookLinkLabel}</span>
                <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="focus-controls" aria-label="Inspection controls">
              <span>Drag to orbit</span>
              <span>Pinch or scroll to zoom</span>
              <button
                type="button"
                data-testid="reset-view"
                onClick={() => engineRef.current?.resetFocusView()}
              >
                Reset view
              </button>
            </div>
          </div>
        ) : null}
      </aside>

      <div
        className="experience-status"
        role="status"
        aria-live="polite"
        data-testid="experience-status"
      >
        <span className="experience-status__dot" />
        <span>{status}</span>
      </div>

      <div className="loading-screen" aria-hidden={ready}>
        <div className="loading-screen__mark">
          <span />
          <span />
          <span />
        </div>
        <p>Shelving {catalog.length} volumes</p>
        <div className="loading-screen__bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>

      {contextLost ? (
        <div className="context-lost" role="alert">
          <p>The 3D view was interrupted by the browser.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the bookcase
          </button>
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {isFocused && selectedBook
          ? `Inspecting ${selectedBook.title} by ${selectedBook.author}.`
          : isBookcase
            ? `Shelf ${currentRow + 1} of ${layout.rows.length}: ${labels[currentRow]}.`
            : `Selected ${activeBook.title} by ${activeBook.author}.`}
      </div>
    </main>
  );
}
