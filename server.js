function extractAbstractFromHtml(html) {
  const $ = cheerio.load(html);

  $("script, style, noscript").remove();

  const headingTexts = ["抄録", "Abstract", "ABSTRACT"];
  const nodes = $("h1, h2, h3, h4, h5, h6, dt, strong, div, span, p, li");

  for (let i = 0; i < nodes.length; i++) {
    const node = $(nodes[i]);
    const label = cleanExtractedText(node.text());

    if (!headingTexts.includes(label)) continue;

    const text = collectAbstractAfterHeading($, node);
    if (isValidAbstractText(text)) return text;
  }

  return "";
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

  return cleanExtractedText(parts.join(" "));
}

function isGarbageAbstractText(text) {
  if (!text) return true;

  return (
    text.includes("offset().top") ||
    text.includes("case '") ||
    text.includes("$('#") ||
    text.includes("function(") ||
    text.includes("article-overiew-abstract-wrap")
  );
}

function looksLikeSectionHeading(text) {
  return /^(抄録|Abstract|引用文献|関連文献|著者関連情報|キーワード|本文|詳細|被引用文献|図|References|Keywords)$/i.test(text || "");
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
