const express = require("express");
const xml2js = require("xml2js");

const app = express();
const PORT = process.env.PORT || 10000;

const JSTAGE_API_URL = "https://api.jstage.jst.go.jp/searchapi/do";

const SEARCH_FIELDS = [
  { name: "article", weight: 3 },
  { name: "keyword", weight: 2 }
];

const MAX_TERMS = 8;
const RESULTS_PER_SEARCH = 10;
const TOP_N = 20;

const EN_STOPWORDS = new Set([
  "a", "an", "and", "or", "of", "the", "to", "in", "on", "for", "with", "by"
]);

app.get("/", (req, res) => {
  res.send("J-STAGE proxy is running.");
});

app.get("/answer", async (req, res) => {
  const query = String(req.query.query || "").trim();
  const userQuery = String(req.query.user_query || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Missing required query parameter: query"
    });
  }

  const terms = buildTerms(query);

  if (terms.length === 0) {
    return res.status(200).json({
      query,
      user_query: userQuery,
      candidates: []
    });
  }

  const aggregate = new Map();
  let successCalls = 0;
  const errors = [];

  for (const term of terms) {
    for (const field of SEARCH_FIELDS) {
      try {
        const xml = await searchJstage(field.name, term);
        const parsed = await xml2js.parseStringPromise(xml, {
          explicitArray: false,
          mergeAttrs: true,
          trim: true
        });

        const feed = parsed.feed || {};
        const result = feed.result || {};
        const status = pickText(result.status) || "0";
        const message = pickText(result.message) || "";

        if (status === "ERR_001") {
          continue;
        }

        if (status !== "0") {
          errors.push(`${field.name}:${term}:${status}:${message}`);
          continue;
        }

        successCalls += 1;

        const entries = normalizeToArray(feed.entry);
        for (const entry of entries) {
          const candidate = mapEntryToCandidate(entry);
          if (!candidate.title && !candidate.link && !candidate.doi) {
            continue;
          }
          mergeCandidate(aggregate, candidate, term, field.name, field.weight);
        }
      } catch (error) {
        console.error(`Search failed [${field.name}] ${term}:`, error);
        errors.push(`${field.name}:${term}:${error.message}`);
      }
    }
  }

  if (aggregate.size === 0 && successCalls === 0 && errors.length > 0) {
    return res.status(502).json({
      error: "Failed to fetch results from J-STAGE",
      detail: errors
    });
  }

  const candidates = Array.from(aggregate.values())
    .map(finalizeCandidate)
    .sort(compareCandidates)
    .slice(0, TOP_N);

  return res.json({
    query,
    user_query: userQuery,
    candidates
  });
});

async function searchJstage(fieldName, term) {
  const params = new URLSearchParams({
    service: "3",
    [fieldName]: term,
    count: String(RESULTS_PER_SEARCH),
    start: "1",
    sortflg: "1"
  });

  const url = `${JSTAGE_API_URL}?${params.toString()}`;
  console.log(`[J-STAGE] ${fieldName}: ${term} -> ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "corpus-v2-jstage-proxy/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`J-STAGE HTTP ${response.status}`);
  }

  return await response.text();
}

function buildTerms(query) {
  const rawTerms = query
    .split(/[\s,，、;；|／/]+/)
    .map(x => x.trim())
    .filter(Boolean);

  const terms = [];
  const seen = new Set();

  for (const term of rawTerms) {
    const normalized = normalizeTerm(term);
    if (!normalized) continue;

    const lower = normalized.toLowerCase();
    if (EN_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;

    seen.add(lower);
    terms.push(normalized);

    if (terms.length >= MAX_TERMS) break;
  }

  return terms;
}

function normalizeTerm(term) {
  const cleaned = term.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!cleaned) return "";

  const isAsciiWord = /^[A-Za-z]+$/.test(cleaned);
  if (isAsciiWord && cleaned.length === 1) return "";

  return cleaned;
}

function mapEntryToCandidate(entry) {
  const title =
    pickLangValue(entry?.article_title) ||
    pickText(entry?.title) ||
    "";

  const journal =
    pickLangValue(entry?.material_title) ||
    pickText(entry?.["prism:publicationName"]) ||
    "";

  const authors = getAuthors(entry);

  const doi =
    pickText(entry?.["prism:doi"]) ||
    "";

  const link =
    pickLangValue(entry?.article_link) ||
    pickHref(entry?.link) ||
    pickText(entry?.id) ||
    "";

  const year =
    pickText(entry?.pubyear) ||
    extractYear(pickText(entry?.updated)) ||
    "";

  return {
    title,
    authors,
    journal,
    year,
    doi,
    link,
    abstract: ""
  };
}

function getAuthors(entry) {
  const author = entry?.author;
  if (!author) return [];

  const ja = extractNames(author.ja);
  if (ja.length) return ja;

  const en = extractNames(author.en);
  if (en.length) return en;

  return extractNames(author);
}

function extractNames(value) {
  if (!value) return [];

  const source = value.name ?? value;
  return normalizeToArray(source)
    .map(pickText)
    .filter(Boolean);
}

function mergeCandidate(map, candidate, term, fieldName, weight) {
  const key = buildCandidateKey(candidate);

  if (!map.has(key)) {
    map.set(key, {
      title: candidate.title,
      authors: candidate.authors,
      journal: candidate.journal,
      year: candidate.year,
      doi: candidate.doi,
      link: candidate.link,
      abstract: candidate.abstract,
      baseScore: 0,
      matchedTerms: new Set(),
      articleTerms: new Set(),
      keywordTerms: new Set()
    });
  }

  const row = map.get(key);

  if (fieldName === "article" && !row.articleTerms.has(term)) {
    row.articleTerms.add(term);
    row.baseScore += weight;
  }

  if (fieldName === "keyword" && !row.keywordTerms.has(term)) {
    row.keywordTerms.add(term);
    row.baseScore += weight;
  }

  row.matchedTerms.add(term);

  if (!row.title && candidate.title) row.title = candidate.title;
  if ((!row.authors || row.authors.length === 0) && candidate.authors.length) row.authors = candidate.authors;
  if (!row.journal && candidate.journal) row.journal = candidate.journal;
  if (!row.year && candidate.year) row.year = candidate.year;
  if (!row.doi && candidate.doi) row.doi = candidate.doi;
  if (!row.link && candidate.link) row.link = candidate.link;
}

function finalizeCandidate(row) {
  const distinctTermBonus = Math.max(0, row.matchedTerms.size - 1);
  const bothFieldBonus = intersectionSize(row.articleTerms, row.keywordTerms) * 0.5;
  const score = Number((row.baseScore + distinctTermBonus + bothFieldBonus).toFixed(4));

  return {
    title: row.title,
    authors: row.authors,
    journal: row.journal,
    year: row.year,
    doi: row.doi,
    link: row.link,
    abstract: row.abstract,
    score
  };
}

function compareCandidates(a, b) {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  const by = parseInt(b.year, 10);
  const ay = parseInt(a.year, 10);

  if (!Number.isNaN(by) && !Number.isNaN(ay) && by !== ay) {
    return by - ay;
  }

  return a.title.localeCompare(b.title, "ja");
}

function buildCandidateKey(candidate) {
  const doi = normalizeKey(candidate.doi);
  if (doi) return `doi:${doi}`;

  const link = normalizeKey(candidate.link);
  if (link) return `link:${link}`;

  const title = normalizeKey(candidate.title);
  const year = normalizeKey(candidate.year);

  return `title:${title}|year:${year}`;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‐-–—―ー]/g, "-");
}

function normalizeToArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function pickText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (typeof value._ === "string") return value._.trim();
  }
  return "";
}

function pickHref(value) {
  if (!value) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const href = pickHref(item);
      if (href) return href;
    }
    return "";
  }

  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && typeof value.href === "string") {
    return value.href.trim();
  }

  return "";
}

function pickLangValue(value) {
  if (!value) return "";

  const ja = pickText(value.ja);
  if (ja) return ja;

  const en = pickText(value.en);
  if (en) return en;

  return pickText(value);
}

function extractYear(text) {
  const m = String(text || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function intersectionSize(setA, setB) {
  let count = 0;
  for (const v of setA) {
    if (setB.has(v)) count += 1;
  }
  return count;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
