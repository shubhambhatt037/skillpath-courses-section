# Skillpath — courses section

A Framer code component that renders a live course catalogue.

**Live:** https://abundant-beaver-177762.framer.app
**Component:** [`CourseGrid.tsx`](./CourseGrid.tsx) — single file, default export, only `react` and `framer`.
**API:** `https://syncsphere-hiv6.onrender.com` — `GET /assignment/course-data`, `GET /assignment/country-code`.

The component owns only what comes from the API: the cards and the controls that filter them. The heading, description, hero and footer are Framer canvas layers.

Each card shows category, name, description clamped to two lines, and price. The refundable badge shows only when `refundable` is `true`.

## States

| State | Trigger | Shown |
| --- | --- | --- |
| Loading | Mount, or retry | 6 skeleton cards in the real grid |
| Error | 3 attempts failed | What went wrong + **Try again** |
| Empty catalogue | `200` with `[]` | "No courses yet" + **Refresh** |
| Empty search | Filter matched nothing | "Nothing matches …" + **Clear search** |
| Ready | ≥ 1 usable course | The grid |

The two empty states are separate on purpose: "the server has no courses" and "your search is too narrow" need different buttons.

## Decisions

**The flaky API.** 3 attempts with a 500ms/1000ms pause takes the odds of an error screen from ~33% to ~4%, so the error state stays reachable without being the normal path. Each attempt has its own 15s timeout, because the host cold-starts and a sleeping server would otherwise spin forever. Every request aborts on unmount.

**Country fails, courses work.** The two requests are independent — a failed region lookup never blocks the catalogue. It falls back to a currency set in the Framer panel, prices everything in it, and says so in a notice with a retry. Silently defaulting to USD is the option that actually hurts someone: an Indian visitor would only find out at checkout.

**Price math.** Both fields are integers in the currency's minor unit, so both divide by 100 — `199900` paise is ₹1,999, `3999` cents is $39.99. `Intl.NumberFormat` handles grouping. Decimals appear only when the minor unit isn't a whole major unit, because ₹1,999.00 reads like a mistake. Sorting uses the same field the card displays, not the hidden one.

**Responsive.** A `ResizeObserver` measures the component, not the window — a 1280px viewport says nothing about how wide this section actually is. Content `<560px` → 1 column, `<900px` → 2, else 3. Cards are `minmax(0, 1fr)` with `min-width: 0` and `overflow-wrap`, so a long unbroken word can't push the grid sideways. Card count is never assumed.

**Property controls.** Accent (colour), Fallback (which currency when the region lookup fails), Search and Sort (show/hide). Fallback is the one that matters — it turns a hardcoded guess into the page owner's decision.

## Known gaps

- No caching between mounts; every mount refetches.
- Retry refetches both endpoints even when only one failed.
- No tests. The price formatter and response parser are pure functions and the obvious first candidates.
- The skeleton always shows 6 cards while the API returns 5–10, so there's a small shift when data lands.
- Same-page anchor links (hero CTA, nav, footer) update the URL but don't scroll. Framer's link runtime prevents the default and doesn't scroll to the fragment; the scroll target is configured correctly and native hash navigation works.
