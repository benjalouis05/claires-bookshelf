"use client";

import { useEffect, useId, useRef, useState } from "react";
import { sortOptions, type SortKey } from "../sorts";

const hints: Record<SortKey, string> = {
  recent: "Date read, newest first",
  oldest: "Date read, oldest first",
  "my-rating": "Only books Claire rated",
  goodreads: "Community average",
  title: "Ignoring “The” and “A”",
  author: "By last name",
  longest: "Most pages first",
};

function SortIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A styled, keyboard-accessible replacement for the native sort <select>. */
export function SortMenu({
  value,
  onChange,
  disabled,
}: {
  value: SortKey;
  onChange: (key: SortKey) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const selected = sortOptions.find((option) => option.key === value) ?? sortOptions[0];

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setActive(Math.max(0, sortOptions.findIndex((option) => option.key === value)));
    setOpen(true);
  }

  function choose(key: SortKey) {
    setOpen(false);
    buttonRef.current?.focus();
    if (key !== value) onChange(key);
  }

  return (
    <div className={`sort-menu ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="control-pill sort-menu__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Sort books: ${selected.label}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <SortIcon />
        <span className="sort-menu__value">{selected.label}</span>
        <span className="sort-menu__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={`${id}-list`}
          className="control-panel sort-menu__list"
          role="listbox"
          tabIndex={-1}
          aria-label="Sort books by"
          aria-activedescendant={`${id}-${sortOptions[active].key}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(sortOptions.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Home") {
              event.preventDefault();
              setActive(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActive(sortOptions.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              choose(sortOptions[active].key);
            } else if (event.key === "Escape" || event.key === "Tab") {
              event.preventDefault();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
        >
          <li className="control-panel__heading" role="presentation">
            Arrange the shelves by
          </li>
          {sortOptions.map((option, index) => (
            <li
              key={option.key}
              id={`${id}-${option.key}`}
              role="option"
              aria-selected={option.key === value}
              className={`sort-menu__option ${index === active ? "is-active" : ""}`}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option.key)}
            >
              <span className="sort-menu__text">
                <span>{option.label}</span>
                <small>{hints[option.key]}</small>
              </span>
              <span className="sort-menu__check" aria-hidden="true">
                {option.key === value ? "✓" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
