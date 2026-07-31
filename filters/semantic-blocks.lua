-- filters/semantic-blocks.lua
-- For LaTeX/PDF output: wraps semantic div classes in mdframed environments,
-- and transforms two whole chapters by locating them via their Header text.
-- Quarto renders the entire PDF book as ONE merged pandoc document (every
-- chapter concatenated into a single xelatex pass), so a chapter's own
-- frontmatter does NOT survive as a distinct per-chapter doc.meta the way it
-- would for a standalone single-file render — chapters can only be targeted
-- by their Header content here, not by a metadata flag set in that
-- chapter's own qmd file. HTML output is handled entirely by CSS; this
-- filter no-ops for HTML.

-- Returns the [start, end] block-index range covering the Header titled
-- `title` and everything until the next Header at the same level or
-- shallower (i.e. the chapter's full content, sub-headings included).
local function chapterRange(blocks, title)
  local start_idx, level
  for i, el in ipairs(blocks) do
    if el.t == "Header" and pandoc.utils.stringify(el.content) == title then
      start_idx, level = i, el.level
      break
    end
  end
  if not start_idx then return nil end
  local end_idx = #blocks
  for i = start_idx + 1, #blocks do
    if blocks[i].t == "Header" and blocks[i].level <= level then
      end_idx = i - 1
      break
    end
  end
  return start_idx, end_idx
end

-- REMOVE drops the chapter (heading included); any other value names a
-- LaTeX environment (defined in styles/pdf-blocks.tex) to wrap its content
-- in, heading excluded.
local REMOVE = {}
local CHAPTER_TRANSFORMS = {
  -- "Home" is index.qmd — Quarto requires it as chapters:'s first entry
  -- (book projects error without a home page), but it's the website's
  -- landing page and doesn't belong in the PDF. This title has already
  -- changed once (was "About") and broke this match silently — if it
  -- changes again, update the string here too; there's no notion-id
  -- based option in this file, since Quarto merges every PDF chapter
  -- into one pandoc document and a chapter's own frontmatter doesn't
  -- survive that merge (see file header comment).
  { title = "Home",       env = REMOVE },
  -- Hanging-indent bibliography — PDF equivalent of the HTML
  -- body.references-page CSS rule (styles/custom.css, section 15).
  { title = "Bibliography", env = "hangingrefs" },
  -- Two-column hanging-indent index — PDF equivalent of the HTML
  -- body.subject-index-page CSS rule (styles/custom.css, section 16b).
  -- twocolindex is defined in styles/pdf-blocks.tex but was never actually
  -- referenced from here, so the Index chapter fell back to LaTeX's plain
  -- first-line-indent paragraph style instead of the intended hanging
  -- indent — each entry's first line flush left, wrapped lines nested in.
  { title = "Index",        env = "twocolindex" },
  -- Flush-left, no-indent glossary entries — PDF equivalent of the HTML
  -- body.glossary-page CSS rule (styles/custom.css, section 16). Same
  -- never-wired-up gap as Index above.
  { title = "Glossary",     env = "flushparagraphs" },
  -- For AI Assistants: website-only page, not in PDF.
  { title = "For AI Assistants", env = REMOVE },
}

-- Renders a list of Pandoc inlines (e.g. a title paragraph's own content)
-- to raw LaTeX text, for passing as a tcolorbox title=#1 argument — a
-- title carries its own inline formatting (**bold** title, *italic* type
-- tag) that needs to survive as \textbf{...}/\emph{...}, not get
-- stringified down to plain text.
local function inlinesToLatex(inlines)
  local latex = pandoc.write(pandoc.Pandoc({ pandoc.Plain(inlines) }), "latex")
  return (latex:gsub("%s+$", ""))
end

-- Almost every semantic-block div (and Note callout) opens with a
-- "**Title** · *Type*" paragraph — but not all: book/rival-ultimates.qmd's
-- §5.1.7 Plantinga argument (an .argument div) opens straight into its
-- numbered premises with no title line at all, confirmed as a real,
-- legitimate content gap (not a pipeline bug) via a full scan of every
-- semantic-block div in book/*.qmd. That div's first block is an
-- OrderedList, not a Para/Plain — inlinesToLatex crashed the entire PDF
-- build on it ("Inline expected, got Blocks"), since pandoc.Plain()
-- requires actual Inlines, not a list's own Blocks. Checking the block
-- type first, and falling back to the class name itself as the title,
-- keeps a rare untitled box from taking down the whole render.
--
-- The title paragraph's own inlines also aren't safe to hand to
-- tcolorbox's title=#1 argument wholesale: most boxes put nothing but
-- "**Label** · *Type*" in that paragraph, but a few (e.g.
-- book/the-argument.qmd §2.8.3's "Fundamentality Physicalism Is False"
-- argument) run straight from the title into setup prose in the SAME
-- paragraph, no blank line — "**Title** · *Type.* Let N abbreviate...".
-- Passing that whole paragraph as the title broke xelatex outright
-- (pgfkeys choked parsing embedded math symbols inside the title arg).
-- splitTitleInlines walks the leading run of Strong/Emph/Space/SoftBreak
-- and known connector Str tokens (the "·" separators between "Label ·
-- Type" segments, dashes, colons) as the title, and stops at the first
-- Str token that isn't one of those — everything from there on is
-- spliced back in as an ordinary leading body paragraph instead of being
-- forced into the title. The connector set is an explicit whitelist
-- rather than a "does this look like a real word" pattern check — Lua's
-- %a class is locale-sensitive over raw bytes, and under some locales
-- it spuriously matched the UTF-8 bytes of "·" itself, splitting before
-- the "· *Type*" segment instead of after it.
local TITLE_CONNECTOR_TOKENS = {
  ["·"] = true, ["-"] = true, ["—"] = true, ["–"] = true, [":"] = true, [","] = true,
}

local function splitTitleInlines(inlines)
  local splitAt = #inlines + 1
  for i, inline in ipairs(inlines) do
    local t = inline.t
    if t == "Strong" or t == "Emph" or t == "Space" or t == "SoftBreak" then
      -- part of the title run, keep going
    elseif t == "Str" and TITLE_CONNECTOR_TOKENS[inline.text] then
      -- known connector token, keep going
    else
      splitAt = i
      break
    end
  end
  local titleInlines, bodyInlines = {}, {}
  for i = 1, splitAt - 1 do table.insert(titleInlines, inlines[i]) end
  for i = splitAt, #inlines do table.insert(bodyInlines, inlines[i]) end
  while #bodyInlines > 0 and bodyInlines[1].t == "Space" do table.remove(bodyInlines, 1) end
  return titleInlines, bodyInlines
end

local function titleAndBody(content)
  if #content > 0 and (content[1].t == "Para" or content[1].t == "Plain") then
    local titleInlines, bodyInlines = splitTitleInlines(content[1].content)
    if #titleInlines == 0 then
      return nil, content
    end
    local bodyBlocks = pandoc.List({})
    if #bodyInlines > 0 then
      bodyBlocks:insert(pandoc.Para(bodyInlines))
    end
    for i = 2, #content do bodyBlocks:insert(content[i]) end
    return inlinesToLatex(titleInlines), bodyBlocks
  end
  return nil, content
end

local function capitalize(s)
  return s:sub(1, 1):upper() .. s:sub(2)
end

-- Native Quarto "Note" callout restyle. Quarto represents a callout
-- (::: {.callout-note}) as a Div with NO classes at all, carrying instead
-- Quarto's own internal bookkeeping attributes (__quarto_custom=true,
-- __quarto_custom_type=Callout, __quarto_custom_id=N) — the actual
-- tcolorbox jigsaw/icon/title-band LaTeX only gets generated from this
-- later, by Quarto's own internal writer stage. Those attributes are
-- only actually visible from this file's top-level Pandoc(doc) function,
-- not from a Div() handler — confirmed empirically: this filter's Div()
-- function fires on the very same element BEFORE Quarto has attached
-- __quarto_custom_type to it (its own attributes table reads empty at
-- that point), so the restyle below runs as an extra block-list pass
-- inside Pandoc(doc) (applyNoteRestyle), not alongside the semantic-type
-- handling in Div() further down. Quarto's writer stage doesn't
-- distinguish callout TYPE (note/tip/warning/...) in any attribute
-- visible here either, so the only reliable signal for "which callout is
-- this" is the callout's own content: every semantic box and callout in
-- this book is authored as "**Title** · *Type*" (the Callout Box
-- Formatting Guide's convention), so a callout Div whose first block's
-- plain text ends in "· Note" is a Note. Only Note is handled — it's the
-- only callout type actually used in the book (style-preview.qmd;
-- Tip/Warning/Important/Caution are kept there purely for reference, not
-- live content) — everything else is left untouched, falling through to
-- Quarto's own default callout rendering.
-- The custom node's own .content is NOT the callout body directly — it's
-- always exactly two nested classless Divs: content[1] is an empty
-- placeholder (Quarto's slot for the icon/title area it would normally
-- generate itself), content[2] is a wrapper Div whose OWN .content is the
-- real body blocks (title paragraph first, confirmed empirically via a
-- block-structure dump). Any function reading the actual callout body
-- needs to drill into content[2].content, not content directly.
local function calloutBody(el)
  if el.t ~= "Div" then return nil end
  if el.attributes.__quarto_custom_type ~= "Callout" then return nil end
  if #el.content ~= 2 or el.content[2].t ~= "Div" then return nil end
  return el.content[2].content
end

local function isNoteCallout(el)
  local body = calloutBody(el)
  if not body or #body == 0 then return false end
  local firstText = pandoc.utils.stringify(body[1])
  return firstText:match("%f[%a]Note%s*$") ~= nil
end

local function applyNoteRestyle(blocks)
  local out = pandoc.List({})
  for _, b in ipairs(blocks) do
    if isNoteCallout(b) then
      local body = calloutBody(b)
      local titleLatex, bodyBlocks = titleAndBody(body)
      titleLatex = titleLatex or "Note"
      out:insert(pandoc.RawBlock("latex", "\\begin{semanticboxnote}{" .. titleLatex .. "}"))
      for _, bb in ipairs(bodyBlocks) do out:insert(bb) end
      out:insert(pandoc.RawBlock("latex", "\\end{semanticboxnote}\\suppressnextindent"))
    else
      out:insert(b)
    end
  end
  return out
end

-- Margin notes/asides (::: {.column-margin}, attach-margin-notes.js) have
-- no PDF equivalent — there's no margin column in the printed layout the
-- way the website has one — and don't belong in the PDF at all, on
-- request: "there should not be margin notes at all in this... in the
-- PDF... the core concepts or student margin notes... do not belong in
-- the PDF." Dropped outright rather than inlined into the main text,
-- since they're asides written to sit beside the argument, not part of
-- its own through-line.
local function isMarginNote(el)
  for _, class in ipairs(el.classes) do
    if class == "column-margin" then return true end
  end
  return false
end

-- EPUB shares one constraint with PDF: Quarto requires index.qmd (Home) as
-- chapters:'s first entry regardless of output format (book projects error
-- without a home page), so it can't just be dropped from _quarto.yml the
-- way render-epub.js already drops the web-only "Resources" part — it has
-- to be stripped from the rendered content instead, same mechanism as the
-- PDF branch below. Unlike PDF, EPUB needs none of the LaTeX-environment
-- wrapping (Bibliography/Index/Glossary hanging-indent, applyNoteRestyle's
-- tcolorbox output) — Quarto's EPUB writer already preserves every
-- semantic-block/.standout-line/.callout-note div's own class names
-- natively in the output HTML with no filter intervention needed, so
-- styles/epub.css can target those classes directly. Only the two
-- website-only chapters need removing here; everything else is CSS.
local EPUB_REMOVE_CHAPTERS = { "Home", "For AI Assistants" }

function Pandoc(doc)
  if FORMAT:match("latex") then
    local blocks = pandoc.List(doc.blocks)

    for _, t in ipairs(CHAPTER_TRANSFORMS) do
      local s, e = chapterRange(blocks, t.title)
      if s then
        local kept = pandoc.List({})
        if t.env == REMOVE then
          for i = 1, s - 1 do kept:insert(blocks[i]) end
          for i = e + 1, #blocks do kept:insert(blocks[i]) end
        else
          for i = 1, s do kept:insert(blocks[i]) end
          kept:insert(pandoc.RawBlock("latex", "\\begin{" .. t.env .. "}"))
          for i = s + 1, e do kept:insert(blocks[i]) end
          kept:insert(pandoc.RawBlock("latex", "\\end{" .. t.env .. "}"))
          for i = e + 1, #blocks do kept:insert(blocks[i]) end
        end
        blocks = kept
      end
    end

    blocks = applyNoteRestyle(blocks)

    doc.blocks = pandoc.Blocks(blocks)
    return doc
  elseif FORMAT:match("epub") then
    local blocks = pandoc.List(doc.blocks)
    for _, title in ipairs(EPUB_REMOVE_CHAPTERS) do
      local s, e = chapterRange(blocks, title)
      if s then
        local kept = pandoc.List({})
        for i = 1, s - 1 do kept:insert(blocks[i]) end
        for i = e + 1, #blocks do kept:insert(blocks[i]) end
        blocks = kept
      end
    end
    doc.blocks = pandoc.Blocks(blocks)
    return doc
  end
  return nil
end

-- Maps straight to the tcolorbox names defined in styles/pdf-blocks.tex —
-- each one takes its title as an environment argument (\begin{env}{title})
-- rather than as ordinary body content, per the box's own colored title
-- band + white body + full-width rule design (see that file's own
-- comment for the request this replaced).
local env_names = {
  definition          = "semanticboxdefinition",
  theorem             = "semanticboxtheorem",
  premise             = "semanticboxdefinition",
  lemma               = "semanticboxlemma",
  corollary           = "semanticboxcorollary",
  condition           = "semanticboxcondition",
  argument            = "semanticboxdefinition",
  ["quick-reference"] = "semanticboxquickreference",
  identification      = "semanticboxidentification",
  principle           = "semanticboxprinciple",
  untyped             = "semanticboxdefinition",
}

-- Standout line — the website's rhetorical-pause treatment
-- (front-introduction.qmd's closing three-line beat: restate, question,
-- reveal) ported to print, on request. Not a semantic box — no title,
-- no tcolorbox — just centered text with deliberately asymmetric
-- vertical space around it, mirroring the site's own .standout-line /
-- .standout-tight / .standout-reveal CSS classes (styles/custom.css).
-- CSS margins collapse to their max at adjacent boundaries; \vspace in
-- LaTeX is additive, not collapsing, so these before/after pairs are
-- tuned to reproduce the same tight-then-paused shape (small gap
-- between the first two lines, a real pause before the third) rather
-- than a literal rem-to-pt conversion of the CSS values.
local STANDOUT_BEFORE = { plain = "6pt", tight = "14pt", reveal = "54pt" }
local STANDOUT_AFTER  = { plain = "10pt", tight = "6pt", reveal = "16pt" }

local function standoutVariant(classes)
  for _, c in ipairs(classes) do
    if c == "standout-tight" then return "tight" end
    if c == "standout-reveal" then return "reveal" end
  end
  return "plain"
end

function Div(el)
  if not FORMAT:match("latex") then return nil end
  if isMarginNote(el) then return {} end
  for _, class in ipairs(el.classes) do
    if class == "standout-line" then
      local variant = standoutVariant(el.classes)
      local bodyLatex = pandoc.write(pandoc.Pandoc(pandoc.Blocks(el.content)), "latex")
      bodyLatex = bodyLatex:gsub("%s+$", "")
      local latex = "\\par\\vspace{" .. STANDOUT_BEFORE[variant] .. "}\\begin{center}\\parindent0pt " ..
        bodyLatex .. "\\end{center}\\vspace{" .. STANDOUT_AFTER[variant] .. "}\\par\\noindent\\ignorespaces"
      return { pandoc.RawBlock("latex", latex) }
    end
  end
  for _, class in ipairs(el.classes) do
    local env = env_names[class]
    if env then
      local titleLatex, bodyBlocks = titleAndBody(el.content)
      titleLatex = titleLatex or capitalize(class)
      local blocks = pandoc.List({ pandoc.RawBlock("latex", "\\begin{" .. env .. "}{" .. titleLatex .. "}") })
      for _, bb in ipairs(bodyBlocks) do blocks:insert(bb) end
      blocks:insert(pandoc.RawBlock("latex", "\\end{" .. env .. "}\\suppressnextindent"))
      return blocks
    end
  end
end

-- Boxed tables, matching the same chassis as the semantic boxes and the
-- restyled Note callout. Quarto/pandoc's own default LaTeX table output
-- (a bare \begin{longtable}) can't just be wrapped in a tcolorbox after
-- the fact — longtable manages its own cross-page breaking directly
-- against the page builder, which breaks (confirmed empirically) the
-- moment it's nested inside any other box (tcolorbox, minipage,
-- anything). The only way to add an enclosing border without losing
-- that page-breaking ability is to draw the border as part of the
-- table's own native rule system (outer-edge-only vertical bars in the
-- column spec, via \hline/\endfirsthead/\endhead) rather than actually
-- boxing it — so this hand-emits the whole longtable itself from the
-- Table AST, in place of letting pandoc's own writer serialize it. The
-- table's own existing header row (whatever the content's own column
-- names are) gets the gray tint directly via colortbl's \rowcolor — NOT
-- a separate "Table N" row added on top of it, which is what the first
-- pass did and was wrong: "it doesn't need to say table one... that's
-- what needs the gray behind it, not a new row on top of that." Repeated
-- before both \endfirsthead and \endhead so a continuation page's
-- repeated header row is tinted the same way. \arraystretch/\tabcolsep
-- are bumped for more cell padding, on the same request, scoped to just
-- this table via \begingroup/\endgroup (plain grouping, not a box — safe
-- around a longtable in a way an actual box wouldn't be).
--
-- Deliberately conservative: only tables with a single header row, a
-- single body, no row-head columns, and every cell a single Plain/Para
-- block (checked by cellLatex/simpleRows below) get this treatment —
-- anything else (multi-paragraph cells, row spans, or a pandoc-assigned
-- fractional column width, which signals pandoc itself decided the
-- table needs wrapped/justified columns) falls through to pandoc's own
-- default table rendering untouched. This book's own wide data tables
-- (e.g. content/empirical-predictions.qmd's multi-column, long-cell
-- tables) fall into that untouched path rather than risking a hand-
-- rolled serializer against content it was never tested on.
local function alignChar(align)
  if align == "AlignRight" then return "r"
  elseif align == "AlignCenter" then return "c"
  else return "l" end
end

local function cellLatex(cell)
  if #cell.contents ~= 1 then return nil end
  local b = cell.contents[1]
  if b.t ~= "Plain" and b.t ~= "Para" then return nil end
  return inlinesToLatex(b.content)
end

-- cellPrefix (optional) is prepended to every cell's own LaTeX — used to
-- tint the header row via colortbl's \cellcolor, one cell at a time.
-- \rowcolor{...} (the whole-row equivalent) was tried first and breaks
-- the table's own outer vertical bars: confirmed in an isolated xelatex
-- reproduction at 400dpi that \rowcolor resets the column-rule context
-- for its own row, so the left/right | bars stop dead at the header row
-- instead of running its full height, then resume below it — exactly
-- the "weird little line... not the same as everywhere else" a reader
-- flagged. Per-cell \cellcolor doesn't touch the column-rule context at
-- all, so the vertical bars run continuously top to bottom.
local function rowLatex(row, ncols, cellPrefix)
  local cells = {}
  for _, cell in ipairs(row.cells) do
    local latex = cellLatex(cell)
    if not latex then return nil end
    if cellPrefix then latex = cellPrefix .. latex end
    table.insert(cells, latex)
  end
  if #cells ~= ncols then return nil end
  return table.concat(cells, " & ") .. " \\\\"
end

function Table(el)
  if not FORMAT:match("latex") then return nil end
  local ncols = #el.colspecs
  if ncols == 0 then return nil end
  for _, cs in ipairs(el.colspecs) do
    if type(cs[2]) == "number" and cs[2] > 0 then return nil end
  end
  if #el.head.rows ~= 1 then return nil end
  if #el.bodies ~= 1 then return nil end
  local body = el.bodies[1]
  if #body.head > 0 or #body.body == 0 then return nil end

  local headLatex = rowLatex(el.head.rows[1], ncols, "\\cellcolor{sbDefinition!15!white}")
  if not headLatex then return nil end

  local bodyRows = {}
  for _, row in ipairs(body.body) do
    local r = rowLatex(row, ncols)
    if not r then return nil end
    table.insert(bodyRows, r)
  end

  -- Explicit !{\vrule width ...} rather than a plain | column separator
  -- (which just uses \arrayrulewidth, a thin ~0.4pt hairline): measured
  -- pixel-for-pixel in an isolated high-DPI render, the plain | rule was
  -- an IDENTICAL width in the gray header row and the white body rows
  -- (4px at 600dpi, both places) — the "thinner" a reader kept seeing
  -- was a genuine optical contrast illusion (the same dark line reads as
  -- thinner against the light-gray tint than against white), not an
  -- actual rendering gap. A bolder explicit rule doesn't remove the
  -- illusion's cause but makes the line heavy enough that the illusion
  -- stops being visible.
  local colspec = "!{\\vrule width 0.75pt}"
  for _, cs in ipairs(el.colspecs) do
    colspec = colspec .. alignChar(cs[1])
  end
  colspec = colspec .. "!{\\vrule width 0.75pt}"

  local out = pandoc.List({})
  out:insert(pandoc.RawBlock("latex", "\\begingroup"))
  out:insert(pandoc.RawBlock("latex", "\\renewcommand{\\arraystretch}{1.4}"))
  out:insert(pandoc.RawBlock("latex", "\\setlength{\\tabcolsep}{8pt}"))
  out:insert(pandoc.RawBlock("latex", "\\begin{longtable}{" .. colspec .. "}"))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", headLatex))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", "\\endfirsthead"))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", headLatex))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", "\\endhead"))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", "\\endfoot"))
  out:insert(pandoc.RawBlock("latex", "\\hline"))
  out:insert(pandoc.RawBlock("latex", "\\endlastfoot"))
  for _, r in ipairs(bodyRows) do
    out:insert(pandoc.RawBlock("latex", r))
  end
  out:insert(pandoc.RawBlock("latex", "\\end{longtable}"))
  out:insert(pandoc.RawBlock("latex", "\\endgroup"))
  return out
end
