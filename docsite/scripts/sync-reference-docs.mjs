import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsiteDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(docsiteDirectory, "..");
const sourceDirectory = join(repositoryDirectory, "docs");
const targetDirectory = join(docsiteDirectory, "src", "content", "docs", "reference");
const repositoryUrl = "https://github.com/sageil/citeloom/blob/main/";
const repositoryEditUrl = "https://github.com/sageil/citeloom/edit/main/";

const descriptions = new Map([
  ["architecture.md", "System boundaries and the execution paths for ingestion, retrieval, answers, storage, and authorization."],
  ["commands.md", "Repository package and command reference for development and operations."],
  ["configuration.md", "Complete application, provider, search, document processing, and service configuration reference."],
  ["deployment.md", "Complete deployment, storage, HTTPS, scaling, and administrator bootstrap reference."],
  ["evaluation.md", "Evaluation datasets, scoring, tuning, and controlled comparison workflows."],
  ["features.md", "Supported workflows, formats, administration features, and product limits."],
  ["oauth.md", "Application-wide OAuth, identity linking, MCP authorization, and host recovery."],
  ["operations.md", "Backup, restore, reindexing, diagnostics, retention, recovery, and maintenance procedures."],
  ["releases.md", "CiteLoom release highlights and compatibility notes."],
]);

await rm(targetDirectory, { force: true, recursive: true });
await mkdir(targetDirectory, { recursive: true });

const entries = await readdir(sourceDirectory, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) {
    continue;
  }
  const sourcePath = join(sourceDirectory, entry.name);
  const source = await readFile(sourcePath, "utf8");
  const titleMatch = source.match(/^# (.+)$/mu);
  if (titleMatch === null) {
    throw new Error(`Reference document ${entry.name} has no level-one title.`);
  }
  const title = titleMatch[1];
  const description = descriptions.get(entry.name);
  if (description === undefined) {
    throw new Error(`Reference document ${entry.name} has no site description.`);
  }
  const body = source
    .replace(/^# .+\n+/u, "")
    .replace(/\]\(\.\.\/([^):#]+)(#[^)]+)?\)/gu, (_match, path, hash = "") => {
      return `](${repositoryUrl}${path}${hash})`;
    })
    .replace(/\]\(([^)/:#]+)\.md(#[^)]+)?\)/gu, (_match, fileName, hash = "") => {
      return `](../${fileName}/${hash})`;
    });
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `editUrl: ${JSON.stringify(`${repositoryEditUrl}docs/${entry.name}`)}`,
    "---",
    "",
  ].join("\n");
  await writeFile(join(targetDirectory, entry.name), frontmatter + body, "utf8");
}

const exampleSource = join(repositoryDirectory, "deployments", "examples", "seaweedfs-caddy", "README.md");
const exampleTarget = join(targetDirectory, "seaweedfs-caddy-example.md");
const example = await readFile(exampleSource, "utf8");
const exampleBody = example
  .replace(/^# .+\n+/u, "")
  .replace(/\]\(\.\.\/\.\.\/\.\.\/docs\/([^):#]+)\.md(#[^)]+)?\)/gu, (_match, fileName, hash = "") => {
    return `](../${fileName}/${hash})`;
  })
  .replace(/\]\(\.\.\/\.\.\/\.\.\/([^):#]+)(#[^)]+)?\)/gu, (_match, path, hash = "") => {
    return `](${repositoryUrl}${path}${hash})`;
  })
  .replace(/\]\(\.\/([^):#]+)(#[^)]+)?\)/gu, (_match, path, hash = "") => {
    return `](${repositoryUrl}deployments/examples/seaweedfs-caddy/${path}${hash})`;
  })
  .replace(/\]\(\.env\.example\)/gu, `](${repositoryUrl}deployments/examples/seaweedfs-caddy/.env.example)`);
await writeFile(exampleTarget, [
  "---",
  "title: Self-hosted SeaweedFS with Caddy",
  "description: A fixed single-host SeaweedFS deployment with two stateless S3 gateways behind Caddy.",
  `editUrl: ${repositoryEditUrl}deployments/examples/seaweedfs-caddy/README.md`,
  "---",
  "",
  exampleBody,
].join("\n"), "utf8");
