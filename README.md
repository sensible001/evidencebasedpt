# Evidence-Based PT

The key research numbers physical therapists need, at a glance: cutoffs, change scores, what works, what doesn't, red flags and prognosis. Every number links to its source.

## Cards

Each card is one test, measure or treatment. It leads with the takeaway, shows the key numbers, and holds its studies: tap "studies" to see each study's design, size, finding and rating.

- **Rating badge:** the GRADE certainty or guideline strength, naming who rated it (for example Cochrane or a clinical practice guideline). "Not formally graded" means no review or guideline has rated it yet.
- **Studies differ:** shown when studies disagree, with a one-line explanation.
- **Updated:** shown for 30 days after a card changes. Changes are also listed under "What's new" (`changes` in `data/base.json`).

## Automation (on hold)

The daily PubMed job is switched off while the site is a proof of concept. Before turning it back on, the script must be updated to the current card format (takeaway, badge, studies) so that a new paper is added to an existing card's studies rather than creating a duplicate card.

## How new cards would arrive

1. Every morning (once switched back on), **Find new evidence** (`.github/workflows/find-evidence.yml`) searches PubMed for new systematic reviews, meta-analyses, guidelines and randomized trials on each topic in `scripts/topics.json`.
2. Claude reads each new abstract and drafts a card, using only numbers found in the abstract. Any number it cannot find word for word is flagged for review.
3. Each draft card arrives as its own pull request. **Merge** to publish it, **close** to reject it, or edit the card file first to fix a number.
4. After a merge, **Publish approved cards** (`.github/workflows/build-cards.yml`) rebuilds `data/cards.json` and the site updates within a minute or two.

Papers already reviewed are listed in `data/seen.json`, so a rejected paper is not proposed again.

## Files

- `index.html` is the whole site: search, topic tabs and cards.
- `data/base.json` holds the topics, sections, the "What's new" list and the hand-checked cards.
- `data/cards/` holds one file per approved card from the automation.
- `data/cards.json` is generated from the two above. Do not edit it by hand.
- `scripts/topics.json` holds the PubMed searches. Add a topic here and in `data/base.json`.

## Setup

- Repository secret `ANTHROPIC_API_KEY` (required). `NCBI_API_KEY` is optional and raises PubMed's rate limit.
- Settings → Actions → General → Workflow permissions: allow GitHub Actions to create and approve pull requests.
- Run **Find new evidence** by hand from the Actions tab at any time. A longer look-back (for example 30 days) fills the queue faster; the run size is capped to control cost.

## Disclaimer

A reference for clinicians, not medical advice. Confirm numbers against the linked sources before clinical decisions.
