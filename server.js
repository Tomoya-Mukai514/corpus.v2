const express = require("express");
const xml2js = require("xml2js");

const app = express();
const PORT = process.env.PORT || 10000;

const JSTAGE_API_URL = "https://api.jstage.jst.go.jp/searchapi/do";

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

  try {
    const xml = await searchJstage(query);
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true
    });

    const feed = parsed.feed || {};
    const result = feed.result || {};
    const status = result.status || "";
    const message = result.message || "";

    if (status && status !== "0") {
      return res.status(200).json({
        query,
        user_query: userQuery,
        candidates: [],
        jstage_status: status,
        jstage_message: message || ""
      });
    }

    const entries = normalizeToArray(feed.entry);
    const candidates = entries.map((entry, index) => mapEntryToCandidate(entry, index));

    return res.json({
      query,
      user_query: userQuery,
      candidates,
      jstage_status: status || "0",
      jstage_message: message || ""
    });
  } catch (error) {
    console.error("J-STAGE request failed:", error);

    return res.status(500).json({
      error: "Failed to fetch or parse J-STAGE response",
      detail: error.message
    });
  }
});

async function searchJstage(query) {
  const params = new URLSearchParams({
    service: "3",
    article: query,
    count: "20",
    start: "1",
    sortflg: "1"
  });

  const url = `${JSTAGE_API_URL}?${params.toString()}`;

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

function mapEntryToCandidate(entry, index) {
  const titleJa = pickText(entry?.article_title?.ja);
  const titleEn = pickText(entry?.article_title?.en);
  const title = titleJa || titleEn || pickText(entry?.title) || "";

  const linkJa =
    pickText(entry?.article_link?.ja) ||
    pickHref(entry?.link) ||
    pickText(entry?.id);

  const linkEn = pickText(entry?.article_link?.en);
  const link = linkJa || linkEn || "";

  const journalJa = pickText(entry?.material_title?.ja);
  const journalEn = pickText(entry?.material_title?.en);
  const journal = journalJa || journalEn || "";

  const authorsJa = normalizeNames(entry?.author?.ja?.name);
  const authorsEn = normalizeNames(entry?.author?.en?.name);
  const authors = authorsJa.length ? authorsJa : authorsEn;

  const year = pickText(entry?.pubyear) || "";
  const doi = pickText(entry?.["prism:doi"]) || "";
  const updated = pickText(entry?.updated) || "";

  return {
    title,
    authors,
    journal,
    year,
    doi,
    link,
    abstract: "",
    score: null,
    updated,
    rank: index + 1
  };
}

function normalizeToArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeNames(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(pickText).filter(Boolean);
  }
  const one = pickText(value);
  return one ? [one] : [];
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
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && typeof value.href === "string") {
    return value.href.trim();
  }
  return "";
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
