import { addPropertyControls, ControlType } from "framer"
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from "react"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://syncsphere-hiv6.onrender.com"
const COURSES_URL = `${API_BASE}/assignment/course-data`
const COUNTRY_URL = `${API_BASE}/assignment/country-code`

// The API fails on purpose roughly 1 in 3 requests. Three attempts takes the
// odds of showing an error screen from ~33% to ~4%, which is low enough that
// the retry button is a genuine last resort rather than the normal path.
const MAX_ATTEMPTS = 3

// This API is on a free host that can cold-start. Without a per-attempt
// deadline a sleeping server leaves the section spinning forever, so each
// attempt gets its own timeout and the retry hits an already-warm server.
const ATTEMPT_TIMEOUT_MS = 15000

// Linear backoff (500ms, then 1000ms). The failures here are injected rather
// than load-related, so there is nothing to back off *from* — this only avoids
// hammering the host three times in the same tick.
const RETRY_DELAY_STEP_MS = 500

// Card grid breakpoints, measured on the component itself rather than the
// viewport. See useElementWidth below for why. These are compared against the
// space available *inside* the padding, not the component's outer width.
const TWO_COLUMN_MIN_WIDTH = 560
const THREE_COLUMN_MIN_WIDTH = 900

// Below this outer width the section drops to phone gutters.
const NARROW_LAYOUT_MAX_WIDTH = 640
const GUTTER_NARROW = 20
const GUTTER_WIDE = 40

const SKELETON_COUNT = 6

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Course {
    courseName: string
    courseCode: string
    description: string
    mainCategory: string
    shortCourse: string
    courseType: string
    pricePaise: number
    priceUsdCents: number
    mangoId: string
    refundable: boolean
}

type CountryCode = "IN" | "US"

type LoadPhase = "loading" | "ready" | "error"

type SortOrder = "featured" | "price-asc" | "price-desc"

interface CourseGridProps {
    title: string
    subtitle: string
    accentColor: string
    fallbackCountry: CountryCode
    showSearch: boolean
    showSort: boolean
    style?: CSSProperties
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Carries the HTTP status so the UI can say something specific about it. */
class HttpError extends Error {
    status: number

    constructor(status: number) {
        super(`Request failed with status ${status}`)
        this.name = "HttpError"
        this.status = status
    }
}

/** A cancellable delay, so a retry pause does not outlive the component. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("Aborted"))
            return
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", handleAbort)
            resolve()
        }, ms)
        function handleAbort() {
            clearTimeout(timer)
            reject(new Error("Aborted"))
        }
        signal.addEventListener("abort", handleAbort)
    })
}

/**
 * One GET, with its own timeout.
 *
 * No custom headers are set on purpose: that keeps this a CORS "simple
 * request", so the browser never sends a preflight OPTIONS. The API is GET
 * only (everything else answers 405), and reading data needs nothing more.
 */
async function fetchJsonOnce(url: string, outerSignal: AbortSignal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
    const forwardAbort = () => controller.abort()
    outerSignal.addEventListener("abort", forwardAbort)

    try {
        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
        })
        if (!response.ok) throw new HttpError(response.status)
        return await response.json()
    } finally {
        clearTimeout(timer)
        outerSignal.removeEventListener("abort", forwardAbort)
    }
}

/** Retries the injected 404s and 500s, but gives up once the caller aborts. */
async function fetchJsonWithRetry(url: string, outerSignal: AbortSignal) {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await fetchJsonOnce(url, outerSignal)
        } catch (error) {
            if (outerSignal.aborted) throw error
            lastError = error
            if (attempt < MAX_ATTEMPTS) {
                await sleep(RETRY_DELAY_STEP_MS * attempt, outerSignal)
            }
        }
    }

    throw lastError
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The response is trusted to be *shaped* like courses, but not to be perfect.
 * Anything without a name and two numeric prices cannot be rendered honestly,
 * so it is dropped rather than shown as "undefined" or "₹NaN".
 */
function isRenderableCourse(value: unknown): value is Course {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Partial<Course>
    return (
        typeof candidate.courseName === "string" &&
        candidate.courseName.length > 0 &&
        typeof candidate.pricePaise === "number" &&
        Number.isFinite(candidate.pricePaise) &&
        typeof candidate.priceUsdCents === "number" &&
        Number.isFinite(candidate.priceUsdCents)
    )
}

function parseCourses(data: unknown): Course[] {
    if (!Array.isArray(data)) return []
    return data.filter(isRenderableCourse)
}

/**
 * The Enum control passes the option value ("IN" / "US"), but Framer's own
 * DSL reports the option's display label back. Rather than depend on which
 * one arrives, accept both. Getting this wrong would silently price an Indian
 * visitor in dollars, which is the one failure worth spending two lines on.
 */
function normalizeCountry(value: string): CountryCode {
    return value === "IN" || value === "Indian rupees" ? "IN" : "US"
}

function parseCountryCode(data: unknown): CountryCode | null {
    if (typeof data !== "object" || data === null) return null
    const code = (data as { country_code?: unknown }).country_code
    return code === "IN" || code === "US" ? code : null
}

function describeError(error: unknown): string {
    if (error instanceof HttpError) {
        if (error.status >= 500) {
            return "The courses service hit a server error."
        }
        if (error.status === 404) {
            return "The courses service could not find the data."
        }
        return `The courses service replied with ${error.status}.`
    }
    if ((error as Error | undefined)?.name === "AbortError") {
        return "The courses service took too long to respond."
    }
    return "We could not reach the courses service."
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Both prices arrive as integers in the currency's minor unit, so both divide
 * by 100. 199900 paise is ₹1,999 — not ₹1,99,900. 3999 cents is $39.99.
 *
 * Fraction digits are decided per value: ₹1,999.00 reads like a mistake in
 * rupees, while $39.99 needs both decimals. So decimals are shown only when
 * the minor unit is not a round major unit.
 */
function formatMoney(minorUnits: number, locale: string, currency: string) {
    const amount = minorUnits / 100
    const hasFraction = Math.round(minorUnits) % 100 !== 0

    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: hasFraction ? 2 : 0,
        maximumFractionDigits: 2,
    }).format(amount)
}

function formatCoursePrice(course: Course, country: CountryCode): string {
    return country === "IN"
        ? formatMoney(course.pricePaise, "en-IN", "INR")
        : formatMoney(course.priceUsdCents, "en-US", "USD")
}

/**
 * Sorting uses the same field the card displays. The two price lists happen to
 * rank identically today, but sorting by a number the visitor cannot see would
 * be a bug waiting to happen the first time they diverge.
 */
function sortablePrice(course: Course, country: CountryCode): number {
    return country === "IN" ? course.pricePaise : course.priceUsdCents
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Measures the component, not the window.
 *
 * The brief asks for 3 / 2 / 1 columns. Viewport media queries would get that
 * wrong the moment someone drops this component into a narrower container,
 * because a 1280px window says nothing about how much room this section
 * actually has. A ResizeObserver on the root always matches reality.
 *
 * This reads the *border box*, not `contentRect`. The component changes its
 * own horizontal padding at narrow widths, so measuring the content box would
 * make the measurement depend on the padding that measurement feeds. Between
 * roughly 600px and 640px that loop oscillates: the padding shrinks, which
 * widens the content box past the threshold, which grows the padding back.
 * The border box cannot be changed by padding, so it is a stable input.
 */
function useElementWidth(ref: { current: HTMLElement | null }): number {
    const [width, setWidth] = useState(0)

    useEffect(() => {
        const element = ref.current
        if (!element) return

        // Seed synchronously so the first committed paint already has a real
        // width, instead of waiting for the observer's first delivery.
        setWidth(element.offsetWidth)

        if (typeof ResizeObserver === "undefined") return
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0]
            if (!entry) return
            const borderBox = entry.borderBoxSize && entry.borderBoxSize[0]
            setWidth(borderBox ? borderBox.inlineSize : element.offsetWidth)
        })
        observer.observe(element)
        return () => observer.disconnect()
    }, [ref])

    return width
}

/** Phone gutters on narrow embeds, roomier ones otherwise. */
function gutterForWidth(outerWidth: number): number {
    return outerWidth > 0 && outerWidth < NARROW_LAYOUT_MAX_WIDTH
        ? GUTTER_NARROW
        : GUTTER_WIDE
}

/** Space actually available to the cards, derived from one stable input. */
function contentWidthFor(outerWidth: number): number {
    if (outerWidth === 0) return 0
    return Math.max(0, outerWidth - gutterForWidth(outerWidth) * 2)
}

/** Content width 0 means "not measured yet" (server render): assume desktop. */
function columnsForContentWidth(contentWidth: number): number {
    if (contentWidth === 0) return 3
    if (contentWidth < TWO_COLUMN_MIN_WIDTH) return 1
    if (contentWidth < THREE_COLUMN_MIN_WIDTH) return 2
    return 3
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Skillpath Courses
 *
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 720
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function CourseGrid(props: CourseGridProps) {
    const {
        title,
        subtitle,
        accentColor,
        fallbackCountry,
        showSearch,
        showSort,
        style,
    } = props

    const rootRef = useRef<HTMLDivElement>(null)
    const outerWidth = useElementWidth(rootRef)
    const gutter = gutterForWidth(outerWidth)
    const columns = columnsForContentWidth(contentWidthFor(outerWidth))

    // Bumping this re-runs both effects below, which is what the retry button does.
    const [reloadToken, setReloadToken] = useState(0)
    const reload = useCallback(() => setReloadToken((token) => token + 1), [])

    const [courses, setCourses] = useState<Course[]>([])
    const [coursesPhase, setCoursesPhase] = useState<LoadPhase>("loading")
    const [coursesError, setCoursesError] = useState("")

    // Deliberately separate from the courses request. A failed region lookup is
    // not a reason to hide a working catalogue.
    const [country, setCountry] = useState<CountryCode | null>(null)
    const [countryFailed, setCountryFailed] = useState(false)

    const [query, setQuery] = useState("")
    const [sortOrder, setSortOrder] = useState<SortOrder>("featured")

    useEffect(() => {
        const controller = new AbortController()
        setCoursesPhase("loading")
        setCoursesError("")

        fetchJsonWithRetry(COURSES_URL, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return
                setCourses(parseCourses(data))
                setCoursesPhase("ready")
            })
            .catch((error) => {
                if (controller.signal.aborted) return
                setCoursesError(describeError(error))
                setCoursesPhase("error")
            })

        return () => controller.abort()
    }, [reloadToken])

    useEffect(() => {
        const controller = new AbortController()
        setCountryFailed(false)

        fetchJsonWithRetry(COUNTRY_URL, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return
                const parsed = parseCountryCode(data)
                if (parsed) {
                    setCountry(parsed)
                } else {
                    // A 200 with a country we do not price in is still a miss.
                    setCountryFailed(true)
                }
            })
            .catch(() => {
                if (controller.signal.aborted) return
                setCountryFailed(true)
            })

        return () => controller.abort()
    }, [reloadToken])

    // Prices must render even when the region is unknown. Showing nothing, or a
    // spinner over a loaded catalogue, would be worse than showing a clearly
    // labelled default — so we fall back and say so in the notice below.
    const safeFallback = normalizeCountry(String(fallbackCountry))
    const activeCountry: CountryCode = country ?? safeFallback
    const usingFallbackCurrency = country === null && countryFailed

    const visibleCourses = useMemo(() => {
        const trimmedQuery = query.trim().toLowerCase()

        const matching = trimmedQuery
            ? courses.filter((course) =>
                  [
                      course.courseName,
                      course.mainCategory,
                      course.shortCourse,
                  ].some((field) =>
                      String(field ?? "")
                          .toLowerCase()
                          .includes(trimmedQuery)
                  )
              )
            : courses

        if (sortOrder === "featured") return matching

        // Copy before sorting: Array.prototype.sort mutates, and `matching` can
        // be the same array instance held in state when there is no query.
        return [...matching].sort((a, b) => {
            const difference =
                sortablePrice(a, activeCountry) -
                sortablePrice(b, activeCountry)
            return sortOrder === "price-asc" ? difference : -difference
        })
    }, [courses, query, sortOrder, activeCountry])

    const isLoading = coursesPhase === "loading"
    const isError = coursesPhase === "error"
    const isEmptyCatalogue = coursesPhase === "ready" && courses.length === 0
    const isEmptySearch =
        coursesPhase === "ready" &&
        courses.length > 0 &&
        visibleCourses.length === 0

    return (
        <div
            ref={rootRef}
            style={{
                ...style,
                position: "relative",
                boxSizing: "border-box",
                width: "100%",
                fontFamily: FONT_STACK,
                color: INK,
                padding:
                    gutter === GUTTER_NARROW ? "56px 20px" : "96px 40px",
            }}
        >
            <style>{SCOPED_CSS}</style>

            <div style={{ maxWidth: 1120, margin: "0 auto" }}>
                <header
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "flex-end",
                        justifyContent: "space-between",
                        gap: 24,
                        marginBottom: 40,
                    }}
                >
                    <div style={{ maxWidth: 560 }}>
                        <h2
                            style={{
                                margin: 0,
                                fontSize: columns === 1 ? 32 : 44,
                                lineHeight: 1.08,
                                letterSpacing: "-0.035em",
                                fontWeight: 700,
                            }}
                        >
                            {title}
                        </h2>
                        <p
                            style={{
                                margin: "14px 0 0",
                                fontSize: 17,
                                lineHeight: 1.5,
                                color: MUTED,
                            }}
                            className="sp-lede"
                        >
                            {subtitle}
                        </p>
                    </div>

                    {(showSearch || showSort) && (
                        <div
                            style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 10,
                                width: columns === 1 ? "100%" : "auto",
                            }}
                        >
                            {showSearch && (
                                <input
                                    className="sp-field"
                                    type="search"
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder="Search courses"
                                    aria-label="Search courses by name or category"
                                    style={{
                                        flex: columns === 1 ? "1 1 100%" : "0 1 auto",
                                        minWidth: 0,
                                        width: columns === 1 ? "100%" : 220,
                                    }}
                                />
                            )}
                            {showSort && (
                                <select
                                    className="sp-field"
                                    value={sortOrder}
                                    onChange={(event) =>
                                        setSortOrder(
                                            event.target.value as SortOrder
                                        )
                                    }
                                    aria-label="Sort courses"
                                    style={{
                                        flex: columns === 1 ? "1 1 100%" : "0 0 auto",
                                        cursor: "pointer",
                                    }}
                                >
                                    <option value="featured">Featured</option>
                                    <option value="price-asc">
                                        Price: low to high
                                    </option>
                                    <option value="price-desc">
                                        Price: high to low
                                    </option>
                                </select>
                            )}
                        </div>
                    )}
                </header>

                {usingFallbackCurrency && coursesPhase === "ready" && (
                    <p className="sp-notice" role="status">
                        We could not confirm your region, so prices are shown
                        in{" "}
                        <strong>
                            {safeFallback === "IN"
                                ? "Indian rupees"
                                : "US dollars"}
                        </strong>{". "}
                        <button
                            type="button"
                            className="sp-inline-button"
                            onClick={reload}
                        >
                            Retry
                        </button>
                    </p>
                )}

                {isLoading && (
                    <div
                        role="status"
                        aria-label="Loading courses"
                        style={gridStyle(columns)}
                    >
                        {Array.from({ length: SKELETON_COUNT }).map(
                            (_, index) => (
                                <SkeletonCard key={index} />
                            )
                        )}
                    </div>
                )}

                {isError && (
                    <div className="sp-panel" role="alert">
                        <h3 style={panelTitleStyle}>Courses did not load</h3>
                        <p style={panelBodyStyle}>
                            {coursesError} We tried {MAX_ATTEMPTS} times before
                            giving up.
                        </p>
                        <button
                            type="button"
                            className="sp-button"
                            style={{ background: accentColor }}
                            onClick={reload}
                        >
                            Try again
                        </button>
                    </div>
                )}

                {isEmptyCatalogue && (
                    <div className="sp-panel">
                        <h3 style={panelTitleStyle}>No courses yet</h3>
                        <p style={panelBodyStyle}>
                            The catalogue loaded, but it is empty right now.
                            Check back shortly.
                        </p>
                        <button
                            type="button"
                            className="sp-button"
                            style={{ background: accentColor }}
                            onClick={reload}
                        >
                            Refresh
                        </button>
                    </div>
                )}

                {isEmptySearch && (
                    <div className="sp-panel">
                        <h3 style={panelTitleStyle}>
                            Nothing matches “{query.trim()}”
                        </h3>
                        <p style={panelBodyStyle}>
                            Try a different word, or clear the search to see all{" "}
                            {courses.length} courses.
                        </p>
                        <button
                            type="button"
                            className="sp-button"
                            style={{ background: accentColor }}
                            onClick={() => setQuery("")}
                        >
                            Clear search
                        </button>
                    </div>
                )}

                {coursesPhase === "ready" && visibleCourses.length > 0 && (
                    <div style={gridStyle(columns)}>
                        {visibleCourses.map((course) => (
                            <CourseCard
                                key={course.mangoId || course.courseCode}
                                course={course}
                                country={activeCountry}
                                accentColor={accentColor}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CourseCard(props: {
    course: Course
    country: CountryCode
    accentColor: string
}) {
    const { course, country, accentColor } = props

    return (
        <article className="sp-card">
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 16,
                }}
            >
                {/* The extra field. A learner scanning a catalogue sorts by
                    subject first, so mainCategory earns the space over
                    courseCode or mangoId, which mean nothing to them. */}
                <span
                    className="sp-chip"
                    style={{
                        color: accentColor,
                        borderColor: mixIntoWhite(accentColor, 30),
                        background: mixIntoWhite(accentColor, 9),
                    }}
                >
                    {course.mainCategory || "Course"}
                </span>
                {course.refundable === true && (
                    <span className="sp-chip sp-chip-quiet">Refundable</span>
                )}
            </div>

            <h3
                style={{
                    margin: 0,
                    fontSize: 19,
                    lineHeight: 1.28,
                    letterSpacing: "-0.02em",
                    fontWeight: 600,
                }}
            >
                {course.courseName}
            </h3>

            {/* Two lines, ellipsised. The clamp lives in CSS because inline
                styles cannot express -webkit-line-clamp reliably. */}
            <p className="sp-clamp-2">{course.description}</p>

            <div
                style={{
                    marginTop: "auto",
                    paddingTop: 20,
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                }}
            >
                <span
                    style={{
                        fontSize: 22,
                        fontWeight: 600,
                        letterSpacing: "-0.02em",
                        fontVariantNumeric: "tabular-nums",
                    }}
                >
                    {formatCoursePrice(course, country)}
                </span>
                <span style={{ fontSize: 13, color: MUTED }}>
                    {course.courseType}
                </span>
            </div>
        </article>
    )
}

function SkeletonCard() {
    return (
        <div className="sp-card sp-card-skeleton" aria-hidden="true">
            <div className="sp-shimmer" style={{ width: 96, height: 24, borderRadius: 999 }} />
            <div className="sp-shimmer" style={{ width: "72%", height: 20, marginTop: 18 }} />
            <div className="sp-shimmer" style={{ width: "100%", height: 13, marginTop: 16 }} />
            <div className="sp-shimmer" style={{ width: "88%", height: 13, marginTop: 8 }} />
            <div className="sp-shimmer" style={{ width: 84, height: 26, marginTop: "auto" }} />
        </div>
    )
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

const INK = "#0A0A0B"
const MUTED = "#6E6E78"
const LINE = "#E6E6EB"
const SURFACE = "#FFFFFF"
const FONT_STACK =
    'Inter, "Inter Placeholder", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

function gridStyle(columns: number): CSSProperties {
    return {
        display: "grid",
        // minmax(0, 1fr) rather than 1fr: without the 0 floor, a long unbroken
        // word in a description can force a column wider than its share and
        // push the grid out of its container.
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 20,
        alignItems: "stretch",
    }
}

const panelTitleStyle: CSSProperties = {
    margin: 0,
    fontSize: 19,
    fontWeight: 600,
    letterSpacing: "-0.02em",
}

const panelBodyStyle: CSSProperties = {
    margin: "10px 0 20px",
    fontSize: 15,
    lineHeight: 1.55,
    color: MUTED,
    maxWidth: 460,
}

/**
 * Blends the accent into white without parsing it.
 *
 * The Color control can hand back hex, rgb() or hsla() depending on what the
 * designer picked, so an earlier hex-only parser silently returned the colour
 * unchanged and painted an opaque chip with same-colour text on it. color-mix
 * takes any CSS colour, and the .sp-chip rule below carries a neutral
 * background so an unsupported browser drops this line and still stays legible.
 */
function mixIntoWhite(color: string, percent: number): string {
    return `color-mix(in srgb, ${color} ${percent}%, white)`
}

// Hover, focus rings, the line clamp and the shimmer keyframes cannot be
// expressed as inline styles, so they live here.
const SCOPED_CSS = `
.sp-card {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
    /* Grid and flex items default to min-width:auto, which is the real cause
       of horizontal blowout: minmax(0, 1fr) constrains the track, but the card
       inside it will still refuse to shrink below its longest word. */
    min-width: 0;
    padding: 24px;
    background: ${SURFACE};
    border: 1px solid ${LINE};
    border-radius: 16px;
    transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
.sp-card:hover {
    transform: translateY(-2px);
    border-color: #D6D6DE;
    box-shadow: 0 12px 28px -18px rgba(10, 10, 11, 0.35);
}
.sp-card-skeleton:hover {
    transform: none;
    box-shadow: none;
    border-color: ${LINE};
}
.sp-card h3,
.sp-clamp-2 {
    /* A single unbroken token (long URL, compound word) would otherwise push
       past the card and scroll the whole page sideways. */
    overflow-wrap: anywhere;
}
.sp-clamp-2 {
    margin: 10px 0 0;
    font-size: 14.5px;
    line-height: 1.55;
    color: ${MUTED};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.sp-lede { text-wrap: balance; }
.sp-chip {
    display: inline-flex;
    background: #F3F3F8;
    border-color: ${LINE};
    align-items: center;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 550;
    letter-spacing: -0.01em;
    border-radius: 999px;
    border: 1px solid transparent;
    white-space: nowrap;
}
.sp-chip-quiet {
    color: ${MUTED};
    border-color: ${LINE};
    background: #F7F7F9;
}
.sp-field {
    box-sizing: border-box;
    height: 42px;
    padding: 0 14px;
    font-family: inherit;
    font-size: 14px;
    color: ${INK};
    background: ${SURFACE};
    border: 1px solid ${LINE};
    border-radius: 10px;
    outline: none;
    transition: border-color 160ms ease, box-shadow 160ms ease;
}
.sp-field:focus-visible {
    border-color: #B9B9C4;
    box-shadow: 0 0 0 3px rgba(10, 10, 11, 0.08);
}
.sp-button {
    appearance: none;
    border: 0;
    cursor: pointer;
    padding: 11px 20px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    color: #FFFFFF;
    border-radius: 10px;
    transition: opacity 160ms ease;
}
.sp-button:hover { opacity: 0.9; }
.sp-button:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
.sp-inline-button {
    appearance: none;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-weight: 600;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
}
.sp-panel {
    box-sizing: border-box;
    padding: 40px;
    border: 1px solid ${LINE};
    border-radius: 16px;
    background: ${SURFACE};
}
.sp-notice {
    display: block;
    margin: 0 0 24px;
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.5;
    color: #6A5A2A;
    background: #FDF7E7;
    border: 1px solid #F0E3BC;
    border-radius: 10px;
}
.sp-shimmer {
    border-radius: 6px;
    background: linear-gradient(90deg, #EFEFF3 25%, #E4E4EA 37%, #EFEFF3 63%);
    background-size: 400% 100%;
    animation: sp-shimmer-move 1.4s ease infinite;
}
@keyframes sp-shimmer-move {
    0% { background-position: 100% 50%; }
    100% { background-position: 0 50%; }
}
@media (prefers-reduced-motion: reduce) {
    .sp-shimmer { animation: none; }
    .sp-card { transition: none; }
    .sp-card:hover { transform: none; }
}
`

// ---------------------------------------------------------------------------
// Property controls
// ---------------------------------------------------------------------------

addPropertyControls(CourseGrid, {
    title: {
        type: ControlType.String,
        title: "Title",
        defaultValue: "Courses built to be finished",
    },
    subtitle: {
        type: ControlType.String,
        title: "Subtitle",
        defaultValue:
            "Short, practical programmes with real projects. Prices update automatically for your region.",
        displayTextArea: true,
    },
    accentColor: {
        type: ControlType.Color,
        title: "Accent",
        defaultValue: "#4F46E5",
    },
    fallbackCountry: {
        type: ControlType.Enum,
        title: "Fallback",
        description:
            "Currency to show when the region lookup fails. Visitors see a notice when this is used.",
        options: ["US", "IN"],
        optionTitles: ["US dollars", "Indian rupees"],
        defaultValue: "US",
        displaySegmentedControl: true,
    },
    showSearch: {
        type: ControlType.Boolean,
        title: "Search",
        defaultValue: true,
    },
    showSort: {
        type: ControlType.Boolean,
        title: "Sort",
        defaultValue: true,
    },
})
