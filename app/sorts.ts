import type { Book } from "./catalog";

export type SortKey =
  | "recent"
  | "oldest"
  | "my-rating"
  | "goodreads"
  | "title"
  | "author"
  | "longest";

export const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: "recent", label: "Recently read" },
  { key: "oldest", label: "Oldest first" },
  { key: "my-rating", label: "My rating" },
  { key: "goodreads", label: "Goodreads rating" },
  { key: "title", label: "Title A–Z" },
  { key: "author", label: "Author A–Z" },
  { key: "longest", label: "Longest" },
];

type SortableBook = Pick<
  Book,
  | "title"
  | "author"
  | "pages"
  | "avgRating"
  | "ratingsCount"
  | "myRating"
  | "dateAdded"
  | "recencyDate"
>;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function titleSortKey(title: string) {
  return title.replace(/^(the|a|an)\s+/i, "").replace(/^[^\p{L}\p{N}]+/u, "");
}

const nameSuffix = /^(jr\.?|sr\.?|ii|iii|iv|phd|md)$/i;

export function authorSortKey(author: string) {
  const parts = author.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && nameSuffix.test(parts[parts.length - 1])) parts.pop();
  const last = parts.pop() ?? "";
  return `${last} ${parts.join(" ")}`.trim();
}

/** Newer ISO date first; missing dates sink to the end. */
function compareDateDesc(left: string | null, right: string | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? 1 : -1;
}

function compareNumberDesc(left: number | null, right: number | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function compareTitle(left: SortableBook, right: SortableBook) {
  return collator.compare(titleSortKey(left.title), titleSortKey(right.title));
}

const comparators: Record<SortKey, (a: SortableBook, b: SortableBook) => number> = {
  recent: (a, b) =>
    compareDateDesc(a.recencyDate, b.recencyDate) ||
    compareDateDesc(a.dateAdded, b.dateAdded) ||
    compareTitle(a, b),
  oldest: (a, b) =>
    -compareDateDesc(a.recencyDate, b.recencyDate) ||
    -compareDateDesc(a.dateAdded, b.dateAdded) ||
    compareTitle(a, b),
  "my-rating": (a, b) =>
    compareNumberDesc(a.myRating, b.myRating) ||
    compareNumberDesc(a.avgRating, b.avgRating) ||
    compareDateDesc(a.recencyDate, b.recencyDate) ||
    compareTitle(a, b),
  goodreads: (a, b) =>
    compareNumberDesc(a.avgRating, b.avgRating) ||
    compareNumberDesc(a.ratingsCount, b.ratingsCount) ||
    compareTitle(a, b),
  title: (a, b) => compareTitle(a, b) || collator.compare(a.author, b.author),
  author: (a, b) =>
    collator.compare(authorSortKey(a.author), authorSortKey(b.author)) ||
    compareDateDesc(b.recencyDate, a.recencyDate) ||
    compareTitle(a, b),
  longest: (a, b) => compareNumberDesc(a.pages, b.pages) || compareTitle(a, b),
};

/** Sorts that only shelve some books (the rest are taken off the shelves). */
const filters: Partial<Record<SortKey, (book: SortableBook) => boolean>> = {
  "my-rating": (book) => book.myRating !== null,
};

/**
 * Returns catalog indices in display order (left→right, top shelf first).
 * Filtered sorts return only the books that belong on the shelves.
 */
export function sortBooks(books: SortableBook[], key: SortKey): number[] {
  const compare = comparators[key];
  const keep = filters[key];
  return books
    .map((_, index) => index)
    .filter((index) => !keep || keep(books[index]))
    .sort((left, right) => compare(books[left], books[right]) || left - right);
}

const monthNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatMonthYear(iso: string | null) {
  if (!iso) return "Undated";
  const [year, month] = iso.split("-");
  return `${monthNames[Number(month) - 1]} ${year}`;
}

export function formatDate(iso: string | null) {
  if (!iso) return null;
  const [year, month, day] = iso.split("-");
  return `${monthNames[Number(month) - 1]} ${Number(day)}, ${year}`;
}

export function stars(rating: number | null) {
  if (!rating) return "";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

function range(first: string, last: string) {
  return first === last ? first : `${first} – ${last}`;
}

/** Short plaque text describing what a shelf holds under the current sort. */
export function shelfLabel(shelfBooks: SortableBook[], key: SortKey) {
  if (!shelfBooks.length) return "";
  const first = shelfBooks[0];
  const last = shelfBooks[shelfBooks.length - 1];
  switch (key) {
    case "recent":
    case "oldest":
      return range(formatMonthYear(first.recencyDate), formatMonthYear(last.recencyDate));
    case "my-rating": {
      const top = first.myRating;
      const bottom = last.myRating;
      if (!top) return "Not yet rated";
      if (!bottom) return `${"★".repeat(top)} · then unrated`;
      return range("★".repeat(top), "★".repeat(bottom));
    }
    case "goodreads":
      return `${range(
        (first.avgRating ?? 0).toFixed(2),
        (last.avgRating ?? 0).toFixed(2),
      )} avg`;
    case "title":
      return range(
        titleSortKey(first.title).slice(0, 2).toUpperCase(),
        titleSortKey(last.title).slice(0, 2).toUpperCase(),
      );
    case "author":
      return range(
        authorSortKey(first.author).split(" ")[0],
        authorSortKey(last.author).split(" ")[0],
      );
    case "longest":
      return `${range(
        first.pages?.toLocaleString("en-US") ?? "?",
        last.pages?.toLocaleString("en-US") ?? "?",
      )} pages`;
  }
}
