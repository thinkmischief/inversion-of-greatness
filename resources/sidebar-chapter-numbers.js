// Sidebar chapter numbers ("1. Groundwork", "2. The Argument" …) are one
// text node — split the leading "N." into its own span so styles/custom.css
// can style it independently (dimmed opacity, its own font-size, the TOC
// leader line) without touching the title text itself. Also matches a
// single-letter label ("P. Preface", "I. Introduction", "C. Conclusion",
// "E. Excursus") the same way, so front/back matter gets the identical
// left-label/right-title treatment as the numbered chapters the moment the
// source titles are authored that way — no separate styling path needed for
// letters vs. digits.
//
// Pulled into its own file (previously inline inside _quarto.yml's much
// larger include-after-body script) specifically because this is the one
// piece of sidebar behavior that keeps getting hand-tuned — having it as a
// real .js file with its own syntax highlighting beats hunting for it
// inside a multi-hundred-line YAML string block.
//
// Runs immediately, no DOMContentLoaded wrapper needed: script tags loaded
// via include-after-body execute after the document body is already
// parsed, so the sidebar elements below already exist by the time this runs.
(function () {
  var chapterTitles = document.querySelectorAll('#quarto-sidebar li.sidebar-item span.chapter-title');
  for (var k = 0; k < chapterTitles.length; k++) {
    var titleSpan = chapterTitles[k];
    var m = titleSpan.textContent.match(/^(\d+\.|[A-Za-z]\.)(\s+)(.+)$/);
    if (m) {
      // Explicit class, not just structure for styles/custom.css's own
      // :has(.sidebar-chapter-num) selector to key off — :has() isn't
      // supported in every browser still in real use (older Firefox/
      // Safari), and where it's unsupported the whole selector silently
      // fails to match, so the row falls back to plain unstyled block
      // flow instead of the flex/right-align treatment (confirmed as
      // the actual cause of a reader's chapter rows reading as
      // left-aligned instead of flush to the shared right edge, while
      // the title/search/TOC — none of which use :has() — kept working).
      titleSpan.classList.add('has-chapter-num');
      titleSpan.textContent = '';
      // Both the single-letter label (P./I./C./E.) and the dotted
      // leader-line were tried removed for lettered rows at different
      // points and both reverted — every row (lettered or numbered)
      // gets the identical letter/number + leader + title treatment.
      var numSpan = document.createElement('span');
      numSpan.className = 'sidebar-chapter-num';
      numSpan.textContent = m[1];
      titleSpan.appendChild(numSpan);
      // Classic table-of-contents leader — an empty flex-grow span whose
      // own border-bottom draws the connecting line, filling exactly
      // whatever gap is left between the number and the title rather than
      // a fixed-width rule that would either overshoot short titles or
      // fall short of long ones.
      var leaderSpan = document.createElement('span');
      leaderSpan.className = 'sidebar-chapter-leader';
      leaderSpan.setAttribute('aria-hidden', 'true');
      titleSpan.appendChild(leaderSpan);
      // Own span (not a bare text node) so styles/custom.css can push it
      // to the row's right edge independently of the number — a bare
      // text node can't be a flex item.
      var titleTextSpan = document.createElement('span');
      titleTextSpan.className = 'sidebar-chapter-title-text';
      titleTextSpan.textContent = m[3];
      titleSpan.appendChild(titleTextSpan);
    }
  }
})();
