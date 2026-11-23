// Combines data/base.json with every approved card in data/cards/ into data/cards.json,
// the one file the website reads. Runs automatically after a card is merged.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const base = JSON.parse(readFileSync("data/base.json", "utf8"));
const files = readdirSync("data/cards").filter(f => f.endsWith(".json")).sort();
const added = files.map(f => JSON.parse(readFileSync(`data/cards/${f}`, "utf8")));

const hubIds = new Set(base.hubs.map(h => h.id));
const catIds = new Set(base.cats.map(c => c.id));
const good = added.filter(c => hubIds.has(c.hub) && catIds.has(c.cat) && c.title && c.takeaway && c.badge && Array.isArray(c.studies));
const skipped = added.length - good.length;

// Newest approved cards first within each section; the page groups by topic and category.
good.sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")));

const out = {
  checked: base.checked,
  hubs: base.hubs,
  cats: base.cats,
  changes: base.changes || [],
  cards: [...good, ...base.cards],
};

writeFileSync("data/cards.json", JSON.stringify(out, null, 1) + "\n");
console.log(`Built data/cards.json: ${base.cards.length} base + ${good.length} added cards${skipped ? `, ${skipped} skipped (wrong topic, section or card format)` : ""}.`);
