import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  CorpusDocument,
  CorpusInventoryDocument,
} from "./manifest.js";
import { readDocumentFormat } from "../../../src/documents/format.js";

const MAX_CORPUS_DOCUMENT_BYTES = 100 * 1_024 * 1_024;
const bioCInfonSchema = z.object({
  license: z.string().optional(),
  section_type: z.string().optional(),
  type: z.string().optional(),
});
const bioCPassageSchema = z.object({
  infons: bioCInfonSchema,
  text: z.string(),
});
const bioCDocumentSchema = z.object({
  id: z.string().regex(/^(?:PMC)?[0-9]+$/),
  infons: bioCInfonSchema,
  passages: z.array(bioCPassageSchema),
});
const bioCCollectionSchema = z.object({
  documents: z.array(bioCDocumentSchema),
});
const bioCResponseSchema = z.array(bioCCollectionSchema).min(1);

type BioCDocument = z.output<typeof bioCDocumentSchema>;

export async function downloadCorpusDocument(
  document: CorpusDocument,
): Promise<Buffer> {
  const response = await fetch(document.downloadUrl, {
    headers: { "user-agent": "CiteLoom/0.1 local evaluation corpus" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(
      `Download failed for ${document.title}: HTTP ${response.status}`,
    );
  }
  if (document.provider === "pmc-open-access") {
    const responseJson: unknown = await response.json();
    const article = decodeBioCArticle(responseJson, document.pmcid);
    if (article.infons.license !== document.license) {
      throw new Error(
        `PMC license changed for ${document.pmcid}: expected ${document.license}, received ${article.infons.license ?? "missing"}.`,
      );
    }
    const html = renderBioCArticle(document, article);
    return Buffer.from(html, "utf8");
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function decodeCorpusDocumentBytes(
  document: CorpusDocument,
  content: Buffer,
): Promise<Buffer> {
  const fileName = document.fileName;
  if (content.length === 0 || content.length > MAX_CORPUS_DOCUMENT_BYTES) {
    throw new Error(
      `Invalid corpus document size for ${fileName}: ${content.length} bytes.`,
    );
  }
  const format = readDocumentFormat(fileName);
  if (format.extension === ".pdf" && !content.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`Downloaded corpus document is not a PDF: ${fileName}.`);
  }
  if (format.extension === ".docx" && !content.subarray(0, 2).equals(Buffer.from("PK"))) {
    throw new Error(`Downloaded corpus document is not a DOCX file: ${fileName}.`);
  }
  if (format.extension === ".html" || format.extension === ".htm") {
    validateHtmlDocument(document, content.toString("utf8"));
  }
  return content;
}

export function buildCorpusInventoryDocument(
  document: CorpusDocument,
  content: Buffer,
): CorpusInventoryDocument {
  return {
    ...document,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function decodeBioCArticle(value: unknown, pmcid: string): BioCDocument {
  const result = bioCResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid BioC response for ${pmcid}: ${z.prettifyError(result.error)}`,
    );
  }
  const matches: BioCDocument[] = [];
  for (const collection of result.data) {
    for (const document of collection.documents) {
      if (normalizeBioCPmcid(document.id) === pmcid) {
        matches.push(document);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `BioC response for ${pmcid} contained ${matches.length} matching articles.`,
    );
  }
  const article = matches[0];
  if (article === undefined) {
    throw new Error(`BioC response did not contain ${pmcid}.`);
  }
  return article;
}

function normalizeBioCPmcid(value: string): string {
  return value.startsWith("PMC") ? value : `PMC${value}`;
}

function renderBioCArticle(
  document: Extract<CorpusDocument, { provider: "pmc-open-access" }>,
  article: BioCDocument,
): string {
  const body: string[] = [];
  let bodyPassageCount = 0;
  let previousSectionType: string | null = null;
  for (const passage of article.passages) {
    const text = passage.text.trim();
    if (text.length === 0) {
      continue;
    }
    const sectionType = passage.infons.section_type?.trim();
    if (
      sectionType !== undefined &&
      sectionType !== "TITLE" &&
      sectionType !== previousSectionType
    ) {
      body.push(`<h2>${escapeHtml(formatSectionName(sectionType))}</h2>`);
    }
    if (sectionType !== "TITLE") {
      if (isBioCHeadingPassage(text, passage.infons.type)) {
        body.push(`<h3>${escapeHtml(formatHeadingText(text))}</h3>`);
      } else {
        body.push(`<p>${escapeHtml(text)}</p>`);
        bodyPassageCount += 1;
      }
    }
    previousSectionType = sectionType ?? previousSectionType;
  }
  if (bodyPassageCount === 0) {
    throw new Error(`BioC article ${document.pmcid} contains no text passages.`);
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(document.title)}</title>`,
    "</head>",
    "<body>",
    `<article data-license="${escapeHtml(document.license)}" data-pmcid="${escapeHtml(document.pmcid)}">`,
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<p>Source: <a href="${escapeHtml(document.sourcePageUrl)}">${escapeHtml(document.pmcid)}</a></p>`,
    `<p>License: ${escapeHtml(document.license)}</p>`,
    ...body,
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function validateHtmlDocument(document: CorpusDocument, html: string): void {
  const prefix = html.slice(0, 4_096).toLowerCase();
  if (!prefix.includes("<html") && !prefix.includes("<!doctype html")) {
    throw new Error(`Downloaded corpus document is not HTML: ${document.fileName}.`);
  }
  if (document.provider !== "pmc-open-access") {
    return;
  }
  const pmcidMarker = `data-pmcid="${escapeHtml(document.pmcid)}"`;
  const licenseMarker = `data-license="${escapeHtml(document.license)}"`;
  if (!html.includes(pmcidMarker) || !html.includes(licenseMarker)) {
    throw new Error(
      `Stored PMC metadata does not match the manifest for ${document.pmcid}.`,
    );
  }
}

function formatSectionName(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function isBioCHeadingPassage(text: string, passageType: string | undefined): boolean {
  const normalizedType = passageType?.trim().toLocaleLowerCase() ?? "";
  if (normalizedType === "title" || normalizedType.startsWith("title_")) {
    return true;
  }
  if (text.length > 160 || /[.!?]$/u.test(text)) {
    return false;
  }
  const letters = text.replaceAll(/[^\p{L}]/gu, "");
  if (letters.length < 3 || letters !== letters.toLocaleUpperCase()) {
    return false;
  }
  return text.trim().split(/\s+/u).length <= 16;
}

function formatHeadingText(value: string): string {
  const words = value.trim().split(/\s+/u);
  const formatted: string[] = [];
  for (const word of words) {
    const letters = word.replaceAll(/[^\p{L}]/gu, "");
    if (letters.length <= 4 && letters === letters.toLocaleUpperCase()) {
      formatted.push(word);
      continue;
    }
    const normalized = word.toLocaleLowerCase();
    const first = normalized.at(0);
    formatted.push(
      first === undefined
        ? normalized
        : `${first.toLocaleUpperCase()}${normalized.slice(1)}`,
    );
  }
  return formatted.join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
