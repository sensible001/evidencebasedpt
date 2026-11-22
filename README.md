# Evidence-Based PT

The key research numbers physical therapists need, at a glance: cutoffs, change scores, what works, what doesn't, red flags and prognosis. Every number links to its source.

## Structure

- `index.html` is the whole site: search, topic tabs and cards.
- `data/cards.json` holds all content. Add a card by adding an entry to `cards`; no code changes are needed.

Card fields: `hub`, `cat`, `title`, `nums` (label/value pairs), optional `table`, `note`, `tags` (extra search words) and `src` (title/URL pairs).

## Hosting

Served by GitHub Pages from the repository root. The `CNAME` file points the site at evidencebasedpt.com.

## Disclaimer

A reference for clinicians, not medical advice. Confirm numbers against the linked sources before clinical decisions.
