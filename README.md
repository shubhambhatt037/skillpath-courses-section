# Skillpath — courses section

A Framer code component that renders a live course catalogue, built for the junior developer assignment.

- **Component:** [`CourseGrid.tsx`](./CourseGrid.tsx) — single file, default export, no dependencies beyond `react` and `framer`.
- **API:** `https://syncsphere-hiv6.onrender.com` — `GET /assignment/course-data` and `GET /assignment/country-code`.

The rest of the page (nav, hero, footer) is built on the Framer canvas. Only this section is code.

---

## The four states

| State | What triggers it | What the visitor sees |
| --- | --- | --- |
| Loading | Initial mount, or the retry button | Six skeleton cards in the real grid layout |
| Error | All 3 attempts failed | A panel naming what went wrong, plus **Try again** |
| Empty catalogue | API returned `200` with `[]` | "No courses yet" plus **Refresh** |
| Empty search | Catalogue has items, filter matched none | "Nothing matches …" plus **Clear search** |
| Ready | At least one renderable course | The grid |

The last two are deliberately separate. "The server has no courses" and "your search is too narrow" are different problems and need different buttons. Collapsing them into one "no results" message is the kind of thing that reads fine in code review and confuses a real user.

## The flaky API

The API fails roughly one request in three, on both endpoints. Two things handle that:

1. **Retry, up to 3 attempts** with a 500ms then 1000ms pause. That takes the chance of showing an error screen from about 33% to about 4%. The error state still exists and is still reachable, it just stops being the common case.
2. **A per-attempt timeout of 15s.** The API is on a free host that cold-starts. Without a deadline, a sleeping server leaves the section spinning forever. With one, the attempt is abandoned and the retry usually lands on a warmed-up server.

Every request is tied to an `AbortController` that fires on unmount, so navigating away mid-flight does not leave a `setState` running against a dead component.

## When the country call fails but the courses call works

This is the interesting one, and the brief is right that there is no single correct answer.

**What this does:** the two requests are completely independent. A failed region lookup never blocks the catalogue. When it fails, the section falls back to a currency chosen by the designer in the Framer panel, renders every price in it, and shows a notice above the grid saying the region could not be confirmed and offering a retry.

**Why not the alternatives:**

- *Hide prices until the region is known* — the catalogue becomes useless roughly a third of the time, to avoid an error that costs the visitor nothing.
- *Show a spinner over the whole section* — same cost, and it blames the visitor's connection for our problem.
- *Silently default to USD* — this is the one that actually causes harm. An Indian visitor sees `$39.99`, assumes that is the price, and finds out otherwise at checkout. Guessing silently is worse than guessing loudly.

So: guess, but say that you are guessing, and give them a way to fix it.

## The price math

Both prices arrive as integers in the currency's **minor unit**, so both divide by 100.

```
199900 paise → ₹1,999      (not ₹1,99,900)
  3999 cents → $39.99
```

Formatting goes through `Intl.NumberFormat` with `en-IN`/`INR` and `en-US`/`USD`, so grouping is locale-correct (₹1,29,999 uses Indian lakh grouping, $1,299.99 does not).

Decimals are decided per value rather than fixed: `₹1,999.00` reads like a mistake, `$39.99` needs both digits. So the fraction digits appear only when the minor unit is not a whole major unit.

**Sorting uses the same field the card displays.** The two price lists happen to rank identically today, but sorting by a number the visitor cannot see is a bug waiting for the first time they diverge.

## Responsive: 3 / 2 / 1

The grid measures **the component**, not the window, via a `ResizeObserver` on the root.

A viewport media query gets this wrong the moment the component is dropped into a narrower container — a 1280px window tells you nothing about how much room this particular section has. Measuring the element itself is always right, and it means the component behaves correctly anywhere on the canvas.

- `< 560px` → 1 column
- `560–899px` → 2 columns
- `≥ 900px` → 3 columns

Before the first measurement (server render, first paint) it assumes 3 columns rather than flashing a single-column layout.

Columns are `minmax(0, 1fr)` rather than `1fr`. Without the zero floor, one long unbroken word in a description can force a column wider than its share and push the whole grid out of its container.

Card count is never assumed. The grid takes whatever length the array has, cards stretch to equal height via `align-items: stretch` and `height: 100%`, and the price row is pinned to the bottom with `margin-top: auto` so cards line up regardless of how long each description is.

## Property controls

Six, all things a designer would actually ask for:

| Control | Type | Why |
| --- | --- | --- |
| Title | String | Section heading |
| Subtitle | String | Supporting line |
| Accent | Color | Chips, buttons |
| Fallback | Enum (US / IN) | Which currency to use when the region lookup fails |
| Search | Boolean | Show or hide the search box |
| Sort | Boolean | Show or hide the sort dropdown |

**Fallback** is the one worth pointing at. It turns a hardcoded engineering guess into a decision the person who owns the page can make, which is the whole argument for property controls.

## Other decisions worth knowing

- **No custom request headers.** Adding any would turn these into CORS preflighted requests and make the browser send an `OPTIONS` the API does not need to serve. A bare `GET` stays a "simple request". Everything except GET returns 405, and reading data needs nothing more.
- **Malformed rows are dropped, not rendered.** Anything without a name and two numeric prices cannot be displayed honestly, so it is filtered out rather than shown as `undefined` or `₹NaN`.
- **`color-mix()` instead of parsing the accent colour.** The Framer Color control hands back hex, `rgb()` or `hsla()` depending on what was picked. An earlier version parsed hex only and silently returned the colour unchanged for the others, which painted an opaque chip with same-colour text on it. `color-mix` takes any CSS colour, and the CSS rule carries a neutral fallback so an unsupported browser still gets legible text.
- **No `startTransition` on the search filter.** It is in Framer's recommended patterns, but with at most ten items the filter is not a bottleneck and adding it would be cargo cult.
- **Accessibility:** `role="status"` on the loading and notice regions, `role="alert"` on the error, `aria-label` on both inputs, real `<button>` elements, semantic `<section>`/`<article>`, and `prefers-reduced-motion` disabling the shimmer and hover lift.

## Known gaps

- No caching between mounts. Every mount refetches, including the region lookup.
- The retry button refetches both endpoints even when only one failed. Correct, but wasteful.
- No test coverage. The price formatter and the response parser are pure functions and are the obvious first candidates.
- The skeleton always shows six cards; the real response returns five to ten, so the layout shifts slightly once data lands.
