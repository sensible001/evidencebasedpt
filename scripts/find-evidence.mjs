// Daily evidence finder.
// 1. Searches PubMed for new systematic reviews, guidelines and trials on each topic.
// 2. Asks Claude to turn each useful abstract into a draft card (numbers only from the abstract).
// 3. Opens one pull request per card: merge to approve, close to reject.
// Papers already looked at are listed in data/seen.json so they are never proposed twice.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const MODEL = env.MODEL || "claude-sonnet-5-5";
const LOOKBACK_DAYS = Number(env.LOOKBACK_DAYS || 2);
const MAX_PER_TOPIC = Number(env.MAX_PER_TOPIC || 3);
const MAX_PAPERS = Number(env.MAX_PAPERS || 8);
const DRY_RUN = env.DRY_RUN === "1";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

const base = JSON.parse(readFileSync("data/base.json", "utf8"));
const { filter, topics } = JSON.parse(readFileSync("scripts/topics.json", "utf8"));
const seen = JSON.parse(readFileSync("data/seen.json", "utf8"));
const seenSet = new Set(seen.pmids.map(String));
const hubName = Object.fromEntries(base.hubs.map(h => [h.id, h.name]));
const catName = Object.fromEntries(base.cats.map(c => [c.id, c.name]));
const today = new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- PubMed ----------

async function eutils(path, params) {
  if (env.NCBI_API_KEY) params.api_key = env.NCBI_API_KEY;
  params.tool = "evidencebasedpt";
  const url = `${EUTILS}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.text();
    await sleep(1500 * attempt);
  }
  throw new Error(`PubMed request failed: ${path}`);
}

async function search(query) {
  if (env.MOCK_PUBMED_XML) return [...readFileSync(env.MOCK_PUBMED_XML, "utf8").matchAll(/<PMID[^>]*>(\d+)<\/PMID>/g)].map(m => m[1]);
  const text = await eutils("esearch.fcgi", {
    db: "pubmed", term: `(${query}) AND ${filter}`, datetype: "edat",
    reldate: String(LOOKBACK_DAYS), retmax: "20", retmode: "json",
  });
  return JSON.parse(text).esearchresult?.idlist || [];
}

const decode = s => s
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

const pick = (xml, re) => { const m = xml.match(re); return m ? decode(m[1]) : ""; };

async function fetchPapers(ids) {
  if (!ids.length) return [];
  const xml = env.MOCK_PUBMED_XML
    ? readFileSync(env.MOCK_PUBMED_XML, "utf8")
    : await eutils("efetch.fcgi", { db: "pubmed", id: ids.join(","), retmode: "xml" });
  return xml.split(/<PubmedArticle>/).slice(1).map(a => {
    const sections = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(m => {
      const label = (m[1].match(/Label="([^"]+)"/) || [])[1];
      return (label ? `${label}: ` : "") + decode(m[2]);
    });
    return {
      pmid: pick(a, /<PMID[^>]*>(\d+)<\/PMID>/),
      title: pick(a, /<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/),
      abstract: sections.join("\n"),
      journal: pick(a, /<ISOAbbreviation>([\s\S]*?)<\/ISOAbbreviation>/) || pick(a, /<Title>([\s\S]*?)<\/Title>/),
      year: pick(a, /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || pick(a, /<MedlineDate>(\d{4})/),
      author: pick(a, /<Author[^>]*>[\s\S]*?<LastName>([\s\S]*?)<\/LastName>/),
      doi: pick(a, /<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/),
      types: [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map(m => decode(m[1])),
    };
  }).filter(p => p.pmid && p.abstract);
}

function design(types) {
  const order = ["Practice Guideline", "Guideline", "Meta-Analysis", "Systematic Review", "Randomized Controlled Trial"];
  return order.find(t => types.includes(t)) || types[0] || "Study";
}

// ---------- Claude ----------

const TOOL = {
  name: "propose_card",
  description: "Propose one quick-reference card for physical therapists from this abstract, or say it is not useful.",
  input_schema: {
    type: "object",
    properties: {
      useful: { type: "boolean", description: "True only if the abstract reports at least one concrete number (cutoff, change score, effect size, likelihood ratio, sensitivity, dose, recovery timeline) or a graded recommendation that a practicing PT could act on." },
      reason: { type: "string", description: "One sentence: why this is or is not useful to a PT." },
      cat: { type: "string", enum: base.cats.map(c => c.id), description: "dx = diagnosis/special tests; measures = outcome measures, cutoffs, change scores; works = effective treatment; dose = how much/how often; guide = guideline grades; not = treatments shown not to work; flags = red flags/referral; prog = prognosis/risk." },
      title: { type: "string", description: "Short card title, under 45 characters, e.g. 'Tai chi for knee OA'." },
      nums: {
        type: "array", maxItems: 5,
        description: "Key numbers as [label, value] pairs. Labels under 30 characters, values under 22 characters. Every value must be copied from the abstract, never calculated or recalled.",
        items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
      },
      note: { type: "string", description: "One or two plain sentences, under 45 words: who was studied and what the PT should take from it. Do not copy sentences from the abstract." },
      tags: { type: "string", description: "Extra search words, lower case, space separated: test names, abbreviations, synonyms." },
    },
    required: ["useful", "reason"],
  },
};

const SYSTEM = `You help a physical therapist keep a quick-reference website of research numbers.
You read one PubMed abstract and either propose a single card or reject it.
Rules:
- Use only numbers that appear in the abstract. Never calculate, convert or add numbers from memory.
- Prefer numbers a clinician uses at the point of care: cutoffs, MCID/MDC, likelihood ratios, effect sizes with certainty, doses, recovery timelines, recommendation grades.
- Reject protocols, small pilot studies, studies without usable numbers, and topics outside physical therapy practice.
- Write plainly and briefly, in your own words.`;

async function askClaude(paper, hub) {
  if (env.MOCK_CLAUDE) {
    const all = JSON.parse(readFileSync(env.MOCK_CLAUDE, "utf8"));
    return all[paper.pmid] || { useful: false, reason: "No mock answer." };
  }
  const user = `Topic page: ${hubName[hub]}
Study design: ${design(paper.types)}
Title: ${paper.title}
Journal: ${paper.journal} ${paper.year}

Abstract:
${paper.abstract}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1200, system: SYSTEM,
        tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: user }],
      }),
    });
    if (r.ok) {
      const data = await r.json();
      const use = (data.content || []).find(b => b.type === "tool_use");
      if (use) return use.input;
      throw new Error("Claude returned no card.");
    }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * attempt); continue; }
    throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error("Claude API kept failing.");
}

// ---------- Checks ----------

// Flags any number in the card that does not appear in the abstract, so a reviewer looks twice.
function checkNumbers(card, abstract) {
  const text = abstract.replace(/−/g, "-").replace(/,(?=\d{3})/g, "");
  const flags = [];
  for (const [label, value] of card.nums || []) {
    const numbers = String(value).replace(/−/g, "-").replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) || [];
    const missing = numbers.filter(n => !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(text));
    if (missing.length) flags.push(`"${label}: ${value}" has ${missing.join(", ")}, which is not in the abstract word for word.`);
  }
  if (!(card.nums || []).length) flags.push("No numbers on this card.");
  return flags;
}

// ---------- Pull requests ----------

const git = (...args) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const gh = (...args) => execFileSync("gh", args, { stdio: "pipe" }).toString().trim();

function prBody(card, paper, flags) {
  const rows = (card.nums || []).map(([k, v]) => `| ${k} | **${v}** |`).join("\n");
  return `## ${card.title}

**Topic:** ${hubName[card.hub]} · **Section:** ${catName[card.cat]} · **Study:** ${card.design}

${rows ? `| | |\n|---|---|\n${rows}\n` : ""}
${card.note}

**Source:** [${card.src[0][0]}](${card.src[0][1]})${paper.doi ? ` · [Full text via DOI](https://doi.org/${paper.doi})` : ""}

${flags.length ? `### ⚠️ Check before approving\n${flags.map(f => `- ${f}`).join("\n")}\n` : "✅ Every number on this card appears in the abstract.\n"}
**Why it was proposed:** ${card.reason}

---
**Merge** to publish this card. **Close** to reject it.
To fix a number first, open **Files changed**, choose **Edit file** from the ⋯ menu, save to this branch, then merge.`;
}

function openPullRequest(card, paper, flags) {
  const file = `data/cards/pmid-${paper.pmid}.json`;
  const branch = `card/pmid-${paper.pmid}`;
  const { reason, check, ...stored } = card;
  git("switch", "-c", branch, "main");
  writeFileSync(file, JSON.stringify(stored, null, 1) + "\n");
  git("add", file);
  git("commit", "-m", `Proposed card: ${card.title}`);
  git("push", "-u", "origin", branch);
  const bodyFile = join(mkdtempSync(join(tmpdir(), "card-")), "body.md");
  writeFileSync(bodyFile, prBody(card, paper, flags));
  gh("pr", "create", "--base", "main", "--head", branch, "--title", `${hubName[card.hub]}: ${card.title}`, "--body-file", bodyFile);
  git("switch", "main");
}

// ---------- Main ----------

const queue = [];
const queued = new Set();
for (const t of topics) {
  // A paper matching two topics goes to the first topic only.
  const ids = (await search(t.query)).filter(id => !seenSet.has(id) && !queued.has(id));
  ids.forEach(id => queued.add(id));
  const papers = await fetchPapers(ids.slice(0, 20));
  papers.slice(0, MAX_PER_TOPIC).forEach(p => queue.push({ hub: t.hub, paper: p }));
  await sleep(400);
}
const batch = queue.slice(0, MAX_PAPERS);
console.log(`Found ${queue.length} new paper(s); reviewing ${batch.length}.`);

let proposed = 0;
for (const { hub, paper } of batch) {
  try {
    const answer = await askClaude(paper, hub);
    seenSet.add(paper.pmid);
    if (!answer.useful || !answer.title || !answer.cat) { console.log(`Skip ${paper.pmid}: ${answer.reason}`); continue; }
    const label = `${paper.author || "Anon"} ${paper.year}, ${paper.journal}`.trim();
    const card = {
      hub, cat: answer.cat, title: answer.title, nums: answer.nums || [], note: answer.note || "",
      tags: answer.tags || "", src: [[label, `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`]],
      pmid: paper.pmid, design: design(paper.types), added: today, reason: answer.reason,
    };
    const flags = checkNumbers(card, paper.abstract);
    if (flags.length) card.check = flags;
    if (DRY_RUN) {
      console.log(`\n--- Would open PR for ${paper.pmid} ---\n${prBody(card, paper, flags)}\n`);
    } else {
      openPullRequest(card, paper, flags);
    }
    proposed++;
  } catch (e) {
    console.log(`Error on ${paper.pmid}: ${e.message}`);
  }
}

seen.pmids = [...seenSet];
writeFileSync("data/seen.json", JSON.stringify(seen) + "\n");
if (!DRY_RUN && git("status", "--porcelain", "data/seen.json")) {
  git("add", "data/seen.json");
  git("commit", "-m", `Reviewed ${batch.length} paper(s)`);
  git("push", "origin", "main");
}
console.log(`Done: ${proposed} card(s) proposed.`);
