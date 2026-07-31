// wrap-premises.js (v11)
// Auto-wraps derivation-step paragraphs AND argument lists in semantic-class
// fenced div blocks.
//
// v11 changes vs v10: NEW reclassifyLabeledSubtypes() pre-pass (see
// SUBTYPE_RULES below) — splits Identification out of .definition (a real,
// existing distinction: 16 instances in Chapter 8) and detects Principle
// wherever it lands (.definition or .argument), forward-compatible for
// when Notion content starts using that label. Companion to the
// box-header script rewrite in _quarto.yml (Label · handle · Tag format)
// and the new .identification/.principle/.premise/.condition-{time,
// space,substance} colors in custom.css.
//
// v10 changes vs v9: see the FAMILY_RULES and reclassifyMisclassifiedBlocks
// comments below — abbreviated T#/L#/R# labels weren't matched at all, and
// Result (renamed from Corollary) now reclassifies out of .callout-note as
// well as .premise.
//
// v8 changes vs v7:
//   - NEW reclassifyMisclassifiedBlocks() pre-pass: walks existing
//     ::: {.premise} openers, inspects the first non-empty body line, and
//     rewrites the opener to the correct semantic class if it matches a
//     non-premise FAMILY_RULES regex (theorem / lemma / corollary /
//     definition). Catches mis-classifications produced upstream by
//     export-pages.js, which routes ALL Notion callouts as ::: {.premise}
//     regardless of icon. Idempotent.
//
// v7 changes vs v6:
//   - FAMILY_RULES regexes use \b instead of \s+\d so they match labels
//     ending in a paren or period right after the keyword, e.g.
//     "**Theorem 4 (Triconditionality)" and "**Definition 12 (*Nature*, N)".
//     v6 required a digit immediately after a single space and missed
//     parenthesized labels.
//
// Single-paragraph wraps (one ::: {.family} per paragraph):
//   **P / **(P / **∴ P / **∴ (P                → ::: {.premise}
//   **T / **(T / **∴ T / **Theorem ...         → ::: {.theorem}
//   **L / **(L / **Lemma ...                   → ::: {.lemma}
//   **C / **(C / **Corollary ...               → ::: {.corollary}
//   **D / **(D / **Definition ...              → ::: {.definition}
//
// Numbered-list wraps (::: {.argument} around the whole list):
//   Case B: every list item starts with **(P|T|L|C|D label
//           (optionally with a ∴ before the **)
//   Case A: list preceded by a "**Some Words.** ..." paragraph AND at least
//           one list item contains a formal-logic symbol
//   Case C: every list item contains at least one formal-logic symbol
//           (no bold lead-in required)
//
// Idempotent: skips paragraphs/lists already inside a semantic-class block.
// Skips fenced code blocks, YAML frontmatter, headings, blockquotes,
// column-margin divs, callouts, and HTML annotation comments.

const fs = require("fs")
const path = require("path")

const BOOK_DIR = path.join(__dirname, "book")

// v10: the book's actual trailing-label convention abbreviates the type as
// a letter+digit — "**Name** (T1)." / "(L2)." / "(R1)." — not the spelled-out
// word the v9 comment above assumed ("**Name** (Theorem)."). None of the
// v9 trailing-label alternatives matched that, so every T/L/R-labeled block
// was silently left as .premise (or, for "Result", worse: an EARLIER rule
// below routed spelled-out "**Result" lead-ins to a plain callout-note
// instead of a colored box). Added a `\(T\d`/`\(L\d`/`\(R\d` alternative to
// each, and folded "Result" into the corollary family (same box treatment,
// not a plain callout) instead of its own callout-note family.
const FAMILY_RULES = [
	{ name: "theorem",    regex: /^\*\*(?:∴\s*)?(?:\(?T\d|Theorem\b)|^\*\*[^*\n]+\*\*\s*\((?:T\d|Theorem\b)/u },
	{ name: "lemma",      regex: /^\*\*(?:∴\s*)?(?:\(?L\d|Lemma\b)|^\*\*[^*\n]+\*\*\s*\((?:L\d|Lemma\b)/u },
	{ name: "corollary",  regex: /^\*\*(?:∴\s*)?(?:\(?C\d|Corollary\b)|^\*\*[^*\n]+\*\*\s*\((?:C\d|Corollary\b)/u },
	{ name: "corollary",  regex: /^\*\*(?:∴\s*)?Result\b|^\*\*[^*\n]+\*\*\s*\((?:R\d|Result\b)/u },
	{ name: "definition", regex: /^\*\*(?:\(?D\d|Definition\b)|^\*\*[^*\n]+\*\*\s*\(Definition\b/u },
	// (?!-) excludes hyphenated compound terms like "**Condition-Individuation**"
	// (a real term used in flowing prose, not a box-opening label) from
	// false-matching the bare "Condition" keyword — hit this in
	// content/conditions-as-nature.qmd, whose whole paragraph (incl. its
	// \href cross-refs) got swallowed into a single tcolorbox title and
	// broke xelatex.
	{ name: "condition",  regex: /^\*\*Condition\b(?!-)|^\*\*[^*\n]+\*\*\s*\(Condition\b(?!-)/u },
	{ name: "premise",    regex: /^\*\*(?:∴\s*)?\(?P\d/u },
]

// Identification and Principle are real semantic types (see the box-header
// spec: Identification is a first-person/phenomenal term's definition,
// distinct from an ordinary Definition; Principle is its own type) but
// neither has a dedicated Notion icon of its own — export-pages.js routes
// them under whatever icon their author picked (almost always 📐/.definition
// for Identification, either 📐/.definition or ⚖️/.argument for Principle),
// same as the pre-v10 Result-under-callout-note problem. Detected here by
// their label text and split out via reclassifyLabeledSubtypes() below,
// checked ONLY against .definition/.argument blocks (not the full
// FAMILY_RULES set) since those two are real target classes, not a generic
// miscategorization bucket like .premise/.callout-note — running every
// family regex against them risks a false match on unrelated content.
const SUBTYPE_RULES = [
	{ name: "identification", from: ["definition"], regex: /^\*\*[^*\n]+\*\*\s*\(Identification\b/u },
	{ name: "principle",      from: ["definition", "argument"], regex: /^\*\*(?:∴\s*)?Principle\b|^\*\*[^*\n]+\*\*\s*\(Principle\b/u },
]

const FORMAL_SYMBOLS_REGEX = /[∴→¬◇□∀∃∧∨↔]/u
const ARGUMENT_LABEL_ITEM_REGEX = /^\d+\.\s+(?:∴\s*)?\*\*\(?[PTLCD]\d/u
const BOLD_LEADIN_REGEX = /^\*\*[^\s*][^*\n]{1,150}\.\*\*(\s|$)/u

const SEMANTIC_CLASSES = ["theorem", "premise", "lemma", "corollary", "definition", "identification", "principle", "condition", "argument", "untyped", "quick-reference"]
// Condition entries carry a second, letter-specific class alongside the
// base one (e.g. `{.condition .condition-time}` — see ICON_CLASS_MAP in
// export-pages.js), so this has to tolerate trailing " .className" segments,
// not just the single bare class the pre-v12 form always was.
const SEMANTIC_OPEN_REGEX = new RegExp(
	`^:::\\s*\\{\\.(?:${SEMANTIC_CLASSES.join("|")})(?:\\s+\\.[\\w-]+)*\\}\\s*$`
)
const SEMANTIC_CLOSE_REGEX = /^:::\s*$/
const COLUMN_MARGIN_OPEN_REGEX = /^:::\s*\{\.column-margin\}/
const CALLOUT_OPEN_REGEX = /^:::\s*\{\.callout-/
// v10: also walk existing ::: {.callout-note} blocks, not just .premise —
// content exported under the old ICON_CLASS_MAP (🟢 -> callout-note,
// before it was corrected to corollary) stays a plain callout otherwise,
// since a fresh Notion re-sync isn't what regenerates it; this pre-pass
// self-corrects it on every build regardless of when it was exported.
//
// v12: .untyped replaced .premise as export-pages.js's default for an
// unmapped icon (see the fallback comment there) — .premise is now a real,
// icon-driven type (🪨) in its own right, not a generic bucket, so this has
// to walk .untyped instead of/alongside .premise to still self-correct
// whatever falls through without a mapped icon.
const RECLASSIFY_OPEN_REGEX = /^:::\s*\{\.(?:premise|untyped|callout-note)\}\s*$/

// v8: walk ::: {.premise}/{.untyped} (and, as of v10, ::: {.callout-note})
// blocks and rewrite the opener if the body's first non-empty line matches
// a FAMILY_RULES regex for a different type. Fixes mis-classifications from
// export-pages.js routing every icon-less callout to the default bucket,
// and from the (now-corrected) icon mapping that used to route 🟢 to
// callout-note. Idempotent.
function reclassifyMisclassifiedBlocks(content) {
	const lines = content.split(/\r?\n/)
	const out = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (RECLASSIFY_OPEN_REGEX.test(line)) {
			let j = i + 1
			while (j < lines.length && lines[j] === "") j++
			if (j < lines.length && !SEMANTIC_CLOSE_REGEX.test(lines[j])) {
				const body = lines[j]
				let newFamily = null
				for (const rule of FAMILY_RULES) {
					if (rule.regex.test(body)) { newFamily = rule.name; break }
				}
				if (newFamily) {
					out.push(`::: {.${newFamily}}`)
					i++
					continue
				}
			}
		}
		out.push(line)
		i++
	}
	return out.join("\n")
}

// Splits Identification and Principle out of whichever class they landed in
// (see SUBTYPE_RULES above). Separate pass from reclassifyMisclassifiedBlocks
// since it only ever checks a block against the ONE regex for the subtype
// it's eligible for (based on its current class), never the full
// FAMILY_RULES set. Idempotent.
function reclassifyLabeledSubtypes(content) {
	const lines = content.split(/\r?\n/)
	const out = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		const openMatch = line.match(/^:::\s*\{\.(definition|argument)\}\s*$/)
		if (openMatch) {
			const currentClass = openMatch[1]
			let j = i + 1
			while (j < lines.length && lines[j] === "") j++
			if (j < lines.length && !SEMANTIC_CLOSE_REGEX.test(lines[j])) {
				const body = lines[j]
				const rule = SUBTYPE_RULES.find(
					(r) => r.from.includes(currentClass) && r.regex.test(body)
				)
				if (rule) {
					out.push(`::: {.${rule.name}}`)
					i++
					continue
				}
			}
		}
		out.push(line)
		i++
	}
	return out.join("\n")
}

function processFile(filePath) {
	const original = fs.readFileSync(filePath, "utf8")
	const content = reclassifyLabeledSubtypes(reclassifyMisclassifiedBlocks(original))
	const lines = content.split(/\r?\n/)
	const output = []

	let i = 0
	let inCodeFence = false
	let inYamlFrontmatter = false
	let inWrappedBlock = false

	while (i < lines.length) {
		const line = lines[i]

		if (i === 0 && line === "---") {
			inYamlFrontmatter = true
			output.push(line)
			i++
			continue
		}
		if (inYamlFrontmatter) {
			output.push(line)
			if (line === "---") inYamlFrontmatter = false
			i++
			continue
		}

		if (/^```/.test(line)) {
			inCodeFence = !inCodeFence
			output.push(line)
			i++
			continue
		}
		if (inCodeFence) {
			output.push(line)
			i++
			continue
		}

		if (SEMANTIC_OPEN_REGEX.test(line) ||
			COLUMN_MARGIN_OPEN_REGEX.test(line) ||
			CALLOUT_OPEN_REGEX.test(line)) {
			inWrappedBlock = true
			output.push(line)
			i++
			continue
		}
		if (inWrappedBlock) {
			output.push(line)
			if (SEMANTIC_CLOSE_REGEX.test(line)) inWrappedBlock = false
			i++
			continue
		}

		if (/^#/.test(line) || /^>/.test(line)) {
			output.push(line)
			i++
			continue
		}

		if (/^\d+\.\s+/.test(line)) {
			const r = tryWrapArgumentList(lines, i, output)
			if (r.wrapped) {
				i = r.nextIndex
				continue
			}
			output.push(line)
			i++
			continue
		}

		const family = matchFamily(line)
		if (family) {
			const end = findParagraphEnd(lines, i)
			ensureBlankLine(output)
			output.push(`::: {.${family}}`)
			for (let j = i; j < end; j++) output.push(lines[j])
			ensureBlankLine(output)
			output.push(":::")
			i = end
			continue
		}

		output.push(line)
		i++
	}

	const newContent = output.join("\n")
	if (newContent !== original) {
		fs.writeFileSync(filePath, newContent, "utf8")
		return true
	}
	return false
}

function ensureBlankLine(output) {
	if (output.length > 0 && output[output.length - 1] !== "") output.push("")
}

function matchFamily(line) {
	for (const rule of FAMILY_RULES) {
		if (rule.regex.test(line)) return rule.name
	}
	return null
}

function findParagraphEnd(lines, startIndex) {
	let i = startIndex + 1
	while (i < lines.length) {
		const line = lines[i]
		if (line === "" ||
			/^#/.test(line) ||
			/^>/.test(line) ||
			/^\d+\.\s+/.test(line) ||
			/^-\s+/.test(line) ||
			/^:::/.test(line) ||
			/^```/.test(line) ||
			/^<!--/.test(line)) {
			return i
		}
		i++
	}
	return i
}

function tryWrapArgumentList(lines, startIndex, output) {
	let listEnd = startIndex
	let itemCount = 0
	let allItemsAreLabeled = true
	let anyFormalSymbol = false
	let currentItemHasSymbol = false
	let allItemsHaveFormalSymbol = true

	while (listEnd < lines.length) {
		const line = lines[listEnd]
		if (/^\d+\.\s+/.test(line)) {
			if (itemCount > 0 && !currentItemHasSymbol) allItemsHaveFormalSymbol = false
			currentItemHasSymbol = false
			itemCount++
			if (FORMAL_SYMBOLS_REGEX.test(line)) {
				anyFormalSymbol = true
				currentItemHasSymbol = true
			}
			if (!ARGUMENT_LABEL_ITEM_REGEX.test(line)) allItemsAreLabeled = false
			listEnd++
			continue
		}
		if (/^\s{2,}\S/.test(line) && listEnd > startIndex) {
			if (FORMAL_SYMBOLS_REGEX.test(line)) {
				anyFormalSymbol = true
				currentItemHasSymbol = true
			}
			listEnd++
			continue
		}
		if (line === "") {
			const next = lines.slice(listEnd + 1).find(l => l !== "")
			if (next && /^\d+\.\s+/.test(next)) {
				listEnd++
				continue
			}
			break
		}
		break
	}
	if (itemCount > 0 && !currentItemHasSymbol) allItemsHaveFormalSymbol = false

	if (itemCount < 2) return { wrapped: false, nextIndex: startIndex }

	if (allItemsAreLabeled) {
		ensureBlankLine(output)
		output.push("::: {.argument}")
		for (let j = startIndex; j < listEnd; j++) output.push(lines[j])
		ensureBlankLine(output)
		output.push(":::")
		return { wrapped: true, nextIndex: listEnd }
	}

	if (anyFormalSymbol) {
		const leadIn = findBoldLeadIn(output)
		if (leadIn) {
			output.length = leadIn.startIndex
			ensureBlankLine(output)
			output.push("::: {.argument}")
			for (const ln of leadIn.lines) output.push(ln)
			output.push("")
			for (let j = startIndex; j < listEnd; j++) output.push(lines[j])
			ensureBlankLine(output)
			output.push(":::")
			return { wrapped: true, nextIndex: listEnd }
		}
	}

	if (allItemsHaveFormalSymbol) {
		ensureBlankLine(output)
		output.push("::: {.argument}")
		for (let j = startIndex; j < listEnd; j++) output.push(lines[j])
		ensureBlankLine(output)
		output.push(":::")
		return { wrapped: true, nextIndex: listEnd }
	}

	return { wrapped: false, nextIndex: startIndex }
}

function findBoldLeadIn(output) {
	let k = output.length - 1
	while (k >= 0 && output[k] === "") k--
	if (k < 0) return null
	const paragraphEnd = k
	while (k >= 0 && output[k] !== "") {
		if (/^#/.test(output[k]) ||
			/^:::/.test(output[k]) ||
			/^```/.test(output[k]) ||
			/^>/.test(output[k]) ||
			/^<!--/.test(output[k])) break
		k--
	}
	const paragraphStart = k + 1
	if (paragraphStart > paragraphEnd) return null
	if (!BOLD_LEADIN_REGEX.test(output[paragraphStart])) return null
	return {
		startIndex: paragraphStart,
		lines: output.slice(paragraphStart, paragraphEnd + 1),
	}
}

const files = fs.readdirSync(BOOK_DIR).filter(f => f.endsWith(".qmd"))
let changedCount = 0
for (const file of files) {
	if (processFile(path.join(BOOK_DIR, file))) {
		changedCount++
		console.log(`wrapped: ${file}`)
	}
}
console.log(`\nwrap-premises (v11) complete. ${changedCount}/${files.length} files updated.`)