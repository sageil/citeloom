import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const bootstrapSqlUrl = new URL("../drizzle/bootstrap.sql", import.meta.url);
const bootstrapSql = readFileSync(bootstrapSqlUrl, "utf8");

describe("application settings bootstrap", () => {
  it("removes the obsolete answer maximum while preserving the settings documents", () => {
    expect(bootstrapSql).not.toMatch(/"answerMaximumOutputTokens"\s*:/u);
    expect(bootstrapSql.match(
      /#- '\{runtime,answerMaximumOutputTokens\}'/gu,
    )).toHaveLength(2);
    expect(bootstrapSql).toContain(
      '"application_settings"."defaults"#>\'{runtime,answerMaximumOutputTokens}\'\n    IS NOT NULL',
    );
    expect(bootstrapSql).toContain(
      '"application_settings"."settings"#>\'{runtime,answerMaximumOutputTokens}\'\n    IS NOT NULL',
    );
  });
});
