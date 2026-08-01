import { readFileSync } from "node:fs";

export type SqlQueryName =
  | "browse-document-catalog"
  | "match-keyword-documents"
  | "retrieve-keyword-discovery"
  | "retrieve-lexical-candidates";

const queryFiles: Record<SqlQueryName, string> = {
  "browse-document-catalog": "browse-document-catalog.sql",
  "match-keyword-documents": "match-keyword-documents.sql",
  "retrieve-keyword-discovery": "retrieve-keyword-discovery.sql",
  "retrieve-lexical-candidates": "retrieve-lexical-candidates.sql",
};

export function readSqlQuery(name: SqlQueryName): string {
  const fileName = queryFiles[name];
  const queryUrl = new URL(`../../queries/${fileName}`, import.meta.url);
  const query = readFileSync(queryUrl, "utf8").trim();
  if (query.length === 0) {
    throw new Error(`SQL query file ${fileName} is empty.`);
  }
  return query;
}
