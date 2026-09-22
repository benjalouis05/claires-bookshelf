"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "../catalog";

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15">
      <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Title/author search over the books currently on the shelves. `shelfOf`
 * returns the shelf number for a catalog index, or null when the current
 * sort has taken that book off the shelves.
 */
export function SearchBox({
  books,
  shelfOf,
  onChoose,
  disabled,
  hiddenNote,
}: {
  books: Book[];
  shelfOf: (catalogIndex: number) => number | null;
  onChoose: (catalogIndex: number) => void;
  disabled?: boolean;
  hiddenNote?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const index = useMemo(
    () => books.map((book) => normalize(`${book.title} ${book.author} ${book.series ?? ""}`)),
    [books],
  );

  const { results, hiddenMatches } = useMemo(() => {
    const needle = normalize(query.trim());
    if (needle.length < 2) return { results: [] as number[], hiddenMatches: 0 };
    const matches: number[] = [];
    let hidden = 0;
    for (let i = 0; i < books.length; i += 1) {
      if (!index[i].includes(needle)) continue;
      if (shelfOf(i) === null) hidden += 1;
      else if (matches.length < 7) matches.push(i);
    }
    return { results: matches, hiddenMatches: hidden };
  }, [query, books, index, shelfOf]);

  // "/" jumps to search from anywhere, like many reading sites.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, select")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function choose(catalogIndex: number) {
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
    onChoose(catalogIndex);
  }

  const showPanel = open && query.trim().length >= 2;

  return (
    <div className={`search ${showPanel ? "is-open" : ""}`}>
      <label className="control-pill search__field">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Search ${books.length.toLocaleString("en-US")} books`}
          aria-label="Find a book by title or author"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlighted(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((value) => Math.min(results.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter" && results[highlighted] !== undefined) {
              event.preventDefault();
              choose(results[highlighted]);
            } else if (event.key === "Escape") {
              setQuery("");
              event.currentTarget.blur();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="search__clear"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        ) : (
          <kbd className="search__kbd" aria-hidden="true">
            /
          </kbd>
        )}
      </label>
      {showPanel ? (
        <div className="control-panel search__panel">
          {results.length ? (
            <ul role="listbox" aria-label="Matching books">
              {results.map((catalogIndex, position) => {
                const book = books[catalogIndex];
                const shelf = shelfOf(catalogIndex);
                return (
                  <li
                    key={book.id}
                    role="option"
                    aria-selected={position === highlighted}
                    className={position === highlighted ? "is-highlighted" : ""}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(catalogIndex);
                    }}
                    onMouseEnter={() => setHighlighted(position)}
                  >
                    <span
                      className="search__cover"
                      style={{ backgroundColor: book.cover }}
                      aria-hidden="true"
                    >
                      {book.coverImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={book.coverImage} alt="" loading="lazy" />
                      ) : null}
                    </span>
                    <span className="search__text">
                      <span className="search__title">{book.title}</span>
                      <span className="search__meta">
                        {book.author}
                        {shelf !== null ? ` · Shelf ${String(shelf + 1).padStart(2, "0")}` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="search__empty">No books on the shelves match “{query.trim()}”.</p>
          )}
          {hiddenMatches > 0 && hiddenNote ? (
            <p className="search__note">
              {hiddenMatches} more {hiddenMatches === 1 ? "match is" : "matches are"} {hiddenNote}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
