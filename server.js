const express = require("express");
const xml2js = require("xml2js");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 10000;

const JSTAGE_API_URL = "https://api.jstage.jst.go.jp/searchapi/do";

const SEARCH_FIELDS = [
  { name: "article", bonus: 1.2 },
  { name: "keyword", bonus: 0.8 }
];

const MAX_TERMS = 8;
const RESULTS_PER_SEARCH = 10;
const TOP_N = 20;
const ABSTRACT_FETCH_CONCURRENCY = 3;

const LOW_SIGNAL_QUERY_TERM_WEIGHTS = new Map([
  ["関連", 0.3],
  ["関係", 0.3],
  ["相関", 0.3],
  ["影響", 0.3],
  ["関連性", 0.3],
  ["連関", 0.3],
  ["関連する", 0.3],
  ["関係する", 0.3],
  ["規定", 0.3],
  ["規定因", 0.3],
  ["規定要因", 0.3],
  ["予測", 0.3],
  ["予測因", 0.3],
  ["予測要因", 0.3],
  ["説明", 0.3],
  ["検討", 0.3],
  ["分析", 0.3],
  ["研究", 0.3],
  ["実証", 0.3],
  ["比較", 0.3],
  ["目的", 0.3],
  ["方法", 0.3],
  ["結果", 0.3],
  ["考察", 0.3],
  ["効果", 0.5],
  ["有効性", 0.5],
  ["association", 0.3],
  ["associations", 0.3],
  ["relationship", 0.3],
  ["relationships", 0.3],
  ["correlation", 0.3],
  ["correlations", 0.3],
  ["impact", 0.3],
  ["impacts", 0.3],
  ["predict", 0.3],
  ["predictor", 0.3],
  ["predictors", 0.3],
  ["determinant", 0.3],
  ["determinants", 0.3],
  ["examine", 0.3],
  ["examined", 0.3],
  ["analysis", 0.3],
  ["study", 0.3],
  ["studies", 0.3],
  ["research", 0.3],
  ["investigation", 0.3],
  ["effect", 0.5],
  ["effects", 0.5],
  ["effectiveness", 0.5]
]);

const ORIGINAL_TERM_BOOST = 10.0;
const EXPANDED_TERM_WEIGHT = 1.0;
const LOW_SIGNAL_ORIGINAL_CAP = 0.5;

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
    return res.json({
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
          if (!candidate.title && !candidate.link && !candidate.doi) continue;
          mergeCandidate(aggregate, candidate, term, field.name, field.bonus);
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

  const mergedRows = Array.from(aggregate.values()).map(finalizeMergedRow);

  let candidates = rankCandidatesWithBm25(mergedRows, query, userQuery);

  // 一次順位に関係なく、取得できた候補すべてに対して抄録取得を試す
  await enrichAbstractsForCandidates(candidates);

  candidates = rankCandidatesWithBm25(candidates, query, userQuery).slice(0, TOP_N);

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
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "corpus-v2-jstage-proxy/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`J-STAGE HTTP ${response.status}`);
  }

  return await response.text();
}

async function enrichAbstractsForCandidates(candidates) {
  for (let i = 0; i < candidates.length; i += ABSTRACT_FETCH_CONCURRENCY) {
    const batch = candidates.slice(i, i + ABSTRACT_FETCH_CONCURRENCY);

    await Promise.all(
      batch.map(async (candidate) => {
        if (!candidate.link || candidate.abstract) return;

        try {
          const abstract = await fetchAbstractFromArticleUrl(candidate.link);
          if (abstract) {
            candidate.abstract = abstract;
          }
        } catch (error) {
          console.error(`Abstract fetch failed: ${candidate.link}`, error.message);
        }
      })
    );
  }
}

async function fetchAbstractFromArticleUrl(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": "corpus-v2-jstage-proxy/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Article page HTTP ${response.status}`);
  }

  const html = await response.text();
  return extractAbstractFromHtml(html);
}

function extractAbstractFromHtml(html) {
  const $ = cheerio.load(html);

  $("script, style, noscript, template, svg").remove();

  const exactSectionSelectors = [
    "#article-overiew-abstract-wrap",
    "#article-overview-abstract-wrap",
    ".article-overiew-abstract-wrap",
    ".article-overview-abstract-wrap",
    "#article-overiew-abstract",
    "#article-overview-abstract",
    ".article-overiew-abstract",
    ".article-overview-abstract"
  ];

  for (const selector of exactSectionSelectors) {
    const node = $(selector).first();
    const text = extractAbstractFromSection($, node);
    if (isValidAbstractText(text)) return text;
  }

  const broadSectionSelectors = [
    '[id*="abstract"]',
    '[class*="abstract"]'
  ];

  for (const selector of broadSectionSelectors) {
    const nodes = $(selector);
    for (let i = 0; i < nodes.length; i++) {
      const text = extractAbstractFromSection($, $(nodes[i]));
      if (isValidAbstractText(text)) return text;
    }
  }

  const headingTexts = ["抄録", "Abstract", "ABSTRACT"];
  const nodes = $("h1, h2, h3, h4, h5, h6, dt, strong, div, span, p, li, th");

  for (let i = 0; i < nodes.length; i++) {
    const node = $(nodes[i]);
    const label = cleanExtractedText(node.text());

    if (!headingTexts.includes(label)) continue;

    const text = collectAbstractAfterHeading($, node);
    if (isValidAbstractText(text)) return text;

    const parentText = extractAbstractFromSection($, node.parent());
    if (isValidAbstractText(parentText)) return parentText;
  }

  return "";
}

function extractAbstractFromSection($, node) {
  if (!node || !node.length) return "";

  const cloned = node.first().clone();
  cloned.find("script, style, noscript, template, svg").remove();

  let text = cleanExtractedText(cloned.text());
  if (!text) return "";

  text = text.replace(/^(抄録|Abstract)\s*/i, "");

  const cut = text.match(
    /^([\s\S]{40,4000}?)(?=(引用文献|関連文献|著者関連情報|キーワード|被引用文献|Keywords|References|Cited by|Author information|J-STAGE|この記事を共有|この記事に関連する情報)\b|$)/i
  );

  if (cut && cut[1]) {
    text = cleanExtractedText(cut[1]);
  }

  if (isGarbageAbstractText(text)) return "";

  return text;
}

function collectAbstractAfterHeading($, headingNode) {
  const parts = [];

  let cur = headingNode.next();
  let hops = 0;

  while (cur.length && hops < 8) {
    const text = cleanExtractedText(cur.text());

    if (looksLikeSectionHeading(text)) break;
    if (isGarbageAbstractText(text)) {
      cur = cur.next();
      hops += 1;
      continue;
    }

    if (text) parts.push(text);

    cur = cur.next();
    hops += 1;
  }

  if (parts.length > 0) {
    return cleanExtractedText(parts.join(" "));
  }

  return "";
}

function isGarbageAbstractText(text) {
  if (!text) return true;

  return (
    text.includes("offset().top") ||
    text.includes("case '") ||
    text.includes('case "') ||
    text.includes("$('#") ||
    text.includes("function(") ||
    text.includes("function (") ||
    text.includes("article-overiew-abstract-wrap") ||
    text.includes("scrollTop") ||
    text.includes("switch(") ||
    text.includes("switch (") ||
    text.includes("return false") ||
    text.includes("window.") ||
    text.includes("document.") ||
    text.includes("addClass(")
  );
}

function looksLikeSectionHeading(text) {
  return /^(抄録|Abstract|引用文献|関連文献|著者関連情報|キーワード|本文|詳細|被引用文献|図|References|Keywords|Author information|Cited by)$/i.test(
    text || ""
  );
}

function cleanExtractedText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function isValidAbstractText(text) {
  if (!text) return false;
  if (text.length < 80) return false;
  if (text.length > 4000) return false;
  if (isGarbageAbstractText(text)) return false;
  return true;
}

function buildTerms(query) {
  const rawTerms = query
    .split(/[\s,，、;；|／/]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const terms = [];
  const seen = new Set();

  for (const term of rawTerms) {
    const normalized = normalizeTerm(term);
    if (!normalized) continue;

    const lower = normalized.toLowerCase();
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
  const doi = pickText(entry?.["prism:doi"]) || "";

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

function mergeCandidate(map, candidate, term, fieldName, fieldBonus) {
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
      articleTerms: new Set(),
      keywordTerms: new Set(),
      matchedTerms: new Set(),
      fieldBonus: 0
    });
  }

  const row = map.get(key);

  if (fieldName === "article" && !row.articleTerms.has(term)) {
    row.articleTerms.add(term);
    row.fieldBonus += fieldBonus;
  }

  if (fieldName === "keyword" && !row.keywordTerms.has(term)) {
    row.keywordTerms.add(term);
    row.fieldBonus += fieldBonus;
  }

  row.matchedTerms.add(term);

  if (!row.title && candidate.title) row.title = candidate.title;
  if ((!row.authors || row.authors.length === 0) && candidate.authors.length) row.authors = candidate.authors;
  if (!row.journal && candidate.journal) row.journal = candidate.journal;
  if (!row.year && candidate.year) row.year = candidate.year;
  if (!row.doi && candidate.doi) row.doi = candidate.doi;
  if (!row.link && candidate.link) row.link = candidate.link;
}

function finalizeMergedRow(row) {
  return {
    title: row.title,
    authors: row.authors,
    journal: row.journal,
    year: row.year,
    doi: row.doi,
    link: row.link,
    abstract: row.abstract,
    article_terms: Array.from(row.articleTerms),
    keyword_terms: Array.from(row.keywordTerms),
    matched_terms: Array.from(row.matchedTerms),
    field_bonus: Number(row.fieldBonus.toFixed(4))
  };
}

function rankCandidatesWithBm25(rows, query, userQuery) {
  const docs = rows.map((row, idx) => ({
    id: idx,
    title: row.title,
    subtitle: row.journal,
    authors: Array.isArray(row.authors) ? row.authors.join(" ") : String(row.authors || ""),
    publication_year: row.year,
    doi: row.doi,
    keywords: Array.isArray(row.keyword_terms) ? row.keyword_terms.join(" ") : "",
    abstract: row.abstract || "",
    matched_terms: row.matched_terms || [],
    _candidate: row
  }));

  const index = bm25Build(docs);
  const bm25Results = bm25Search(index, query, docs.length, userQuery);

  const byId = new Map();
  for (const result of bm25Results) {
    byId.set(result.document.id, result);
  }

  return docs
    .map((doc) => {
      const bm25 = byId.get(doc.id);
      const bm25Score = bm25 ? bm25.score : 0;
      const bm25MatchedTerms = bm25 ? bm25.matched_terms : [];

      const bothFieldBonus =
        intersectionSize(
          new Set(doc._candidate.article_terms || []),
          new Set(doc._candidate.keyword_terms || [])
        ) * 0.5;

      const abstractBonus = doc._candidate.abstract ? 1.0 : 0.0;

      const score = Number(
        (bm25Score + (doc._candidate.field_bonus || 0) + bothFieldBonus + abstractBonus).toFixed(4)
      );

      return {
        title: doc._candidate.title,
        authors: doc._candidate.authors,
        journal: doc._candidate.journal,
        year: doc._candidate.year,
        doi: doc._candidate.doi,
        link: doc._candidate.link,
        abstract: doc._candidate.abstract,
        score,
        matched_terms: Array.from(
          new Set([
            ...(doc._candidate.matched_terms || []),
            ...bm25MatchedTerms
          ])
        ),
        article_terms: doc._candidate.article_terms || [],
        keyword_terms: doc._candidate.keyword_terms || [],
        bm25_score: Number(bm25Score.toFixed(4)),
        field_bonus: doc._candidate.field_bonus || 0
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      const by = parseInt(b.year, 10);
      const ay = parseInt(a.year, 10);
      if (!Number.isNaN(by) && !Number.isNaN(ay) && by !== ay) {
        return by - ay;
      }

      return a.title.localeCompare(b.title, "ja");
    });
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[　\s]+/g, " ")
    .trim();
}

function hasJapanese(text) {
  return /[ぁ-ゖァ-ヺ一-龠々ー]/u.test(String(text || ""));
}

function makeJapaneseNgrams(text, minN = 2, maxN = 4) {
  const compact = String(text || "")
    .replace(/\s+/g, "")
    .replace(/[^ぁ-ゖァ-ヺ一-龠々ー]/gu, "");

  if (!compact) return [];

  const grams = [compact];
  const upper = Math.min(maxN, compact.length);

  for (let n = minN; n <= upper; n++) {
    for (let i = 0; i <= compact.length - n; i++) {
      grams.push(compact.slice(i, i + n));
    }
  }

  return grams;
}

function tokenize(text) {
  const normalized = normalizeText(text);

  const latinTokens = normalized.match(/[a-z0-9][a-z0-9._-]*/g) || [];

  const rawChunks = normalized
    .replace(/[a-z0-9._-]+/g, " ")
    .split(/[\s|,，、。．・:：;；()[\]{}"“”'‘’!?！？/]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const tokens = [...latinTokens];

  for (const chunk of rawChunks) {
    if (hasJapanese(chunk)) {
      tokens.push(...makeJapaneseNgrams(chunk, 2, 4));
    } else {
      tokens.push(chunk);
    }
  }

  return [...new Set(tokens.filter((x) => x.length >= 1))];
}

function buildDocText(doc) {
  return [
    doc.title,
    doc.subtitle,
    doc.authors,
    doc.publication_year,
    doc.doi,
    doc.keywords,
    doc.abstract,
    `${doc.authors || ""} ${doc.publication_year || ""}`
  ].join(" ");
}

function bm25Build(docs) {
  const built = docs.map((doc) => {
    const text = buildDocText(doc);
    const tokens = tokenize(text);
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    return {
      doc,
      tokens,
      tf,
      length: tokens.length
    };
  });

  const N = built.length;
  const df = new Map();
  let totalLength = 0;

  for (const item of built) {
    totalLength += item.length;
    const seen = new Set(item.tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const avgdl = N > 0 ? totalLength / N : 0;
  return { built, df, N, avgdl };
}

function buildQueryWeights(query, userQuery = "") {
  const expandedTokens = tokenize(query);
  const originalTokenSet = new Set(tokenize(userQuery));
  const weights = new Map();

  for (const token of expandedTokens) {
    const isOriginalTerm = originalTokenSet.has(token);
    const lowSignalWeight = LOW_SIGNAL_QUERY_TERM_WEIGHTS.get(token) || 1.0;

    let finalWeight;
    if (isOriginalTerm) {
      finalWeight = ORIGINAL_TERM_BOOST * lowSignalWeight;
      if (lowSignalWeight < 1.0) {
        finalWeight = Math.min(finalWeight, LOW_SIGNAL_ORIGINAL_CAP);
      }
    } else {
      finalWeight = EXPANDED_TERM_WEIGHT * lowSignalWeight;
    }

    weights.set(token, (weights.get(token) || 0) + finalWeight);
  }

  return weights;
}

function bm25Search(index, query, topK = 5, userQuery = "", k1 = 1.5, b = 0.75) {
  const qWeights = buildQueryWeights(query, userQuery);
  const qTerms = [...qWeights.keys()];
  if (qTerms.length === 0) return [];

  const results = [];

  for (const item of index.built) {
    let score = 0;
    const matchedTerms = [];

    for (const term of qTerms) {
      const freq = item.tf.get(term) || 0;
      if (freq === 0) continue;

      const df = index.df.get(term) || 0;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      const denom = freq + k1 * (1 - b + b * (item.length / (index.avgdl || 1)));
      const baseScore = idf * ((freq * (k1 + 1)) / denom);
      const termWeight = qWeights.get(term) || 1.0;

      score += termWeight * baseScore;
      matchedTerms.push(term);
    }

    if (score > 0) {
      results.push({
        score,
        matched_terms: [...new Set(matchedTerms)],
        document: item.doc
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
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
  if (typeof value === "object" && typeof value._ === "string") {
    return value._.trim();
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
