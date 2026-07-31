# The Inversion of Greatness

## Git push policy

Never run `git commit` or `git push` (or anything else that publishes changes, e.g. triggering a Netlify deploy) without explicit, same-turn approval from the user. A push here triggers a full Netlify build, so this must never happen silently or by inference from earlier approvals.

## To-do tracking

The project's to-do list is **not** in this repo — it lives in Notion:

- Page: **IOG | Dashboard**
- Database: **To-Do** (inline database near the top of the page)
- Notable properties: `Task`, `Status`, `Priority`, `Area` (e.g. "Layout / CSS", "Website"), `Locus` (Internal/External), `Owner`
