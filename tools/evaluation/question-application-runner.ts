import { pathToFileURL } from "node:url";

import { Agent, fetch } from "undici";
import { z } from "zod";

import { readWebConfig } from "../../src/api/config.js";
import {
  readAdministratorBootstrapConfig,
} from "../../src/database/administrator-bootstrap.js";
import {
  authenticateApplicationProbe,
  buildApplicationProbeHeaders,
  requireSuccessfulApplicationResponse,
} from "./application-http-client.js";

const researchThreadSchema = z.object({
  id: z.uuid(),
  turns: z.array(z.object({
    id: z.uuid(),
    question: z.string().min(1),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
  }).passthrough()),
}).passthrough();

const createdResearchThreadSchema = z.object({
  id: z.uuid(),
}).passthrough();

const defaultQuestion = (
  "How should systemic hypertension be diagnosed and treated in dogs and cats?"
);

export async function main(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  const question = arguments_.join(" ").trim() || defaultQuestion;
  const administrator = readAdministratorBootstrapConfig(process.env);
  const origin = readWebConfig(process.env).publicOrigin;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  try {
    const sessionCookie = await authenticateApplicationProbe(
      dispatcher,
      origin,
      administrator.administrator.username,
      administrator.password,
    );
    const threadId = await createResearchThread(
      dispatcher,
      origin,
      sessionCookie,
    );
    await sendQuestion(
      dispatcher,
      origin,
      sessionCookie,
      threadId,
      question,
    );
    const completed = await readCompletedQuestion(
      dispatcher,
      origin,
      sessionCookie,
      threadId,
      question,
    );
    console.log(JSON.stringify({
      question,
      runId: completed.runId,
      threadId,
      turnId: completed.id,
    }, null, 2));
  } finally {
    await dispatcher.close();
  }
}

async function createResearchThread(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
): Promise<string> {
  const response = await fetch(`${origin}/api/research/threads`, {
    body: JSON.stringify({ title: "Systemic hypertension application probe" }),
    dispatcher,
    headers: buildApplicationProbeHeaders(origin, sessionCookie),
    method: "POST",
  });
  await requireSuccessfulApplicationResponse(
    response,
    "Create Question research thread",
  );
  const result = createdResearchThreadSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error(`Invalid created research thread: ${result.error.message}`);
  }
  return result.data.id;
}

async function sendQuestion(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
  threadId: string,
  question: string,
): Promise<void> {
  const response = await fetch(`${origin}/api/questions`, {
    body: JSON.stringify({
      question,
      scope: { kind: "all" },
      threadId,
    }),
    dispatcher,
    headers: {
      ...buildApplicationProbeHeaders(origin, sessionCookie),
      Accept: "text/event-stream",
    },
    method: "POST",
  });
  await requireSuccessfulApplicationResponse(response, "Send Question");
  await response.text();
}

async function readCompletedQuestion(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
  threadId: string,
  question: string,
) {
  const response = await fetch(`${origin}/api/research/threads/${threadId}`, {
    dispatcher,
    headers: { Cookie: sessionCookie },
    method: "GET",
  });
  await requireSuccessfulApplicationResponse(
    response,
    "Read completed Question research thread",
  );
  const result = researchThreadSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error(`Invalid completed research thread: ${result.error.message}`);
  }
  let turn: z.infer<typeof researchThreadSchema>["turns"][number] | undefined;
  for (const candidate of result.data.turns) {
    if (candidate.question !== question) {
      continue;
    }
    if (turn === undefined || candidate.sequence > turn.sequence) {
      turn = candidate;
    }
  }
  if (turn === undefined) {
    throw new Error("Completed research thread has no matching Question turn.");
  }
  return turn;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
