import { randomUUID } from "node:crypto";
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

const createdConversationSchema = z.object({
  id: z.uuid(),
}).passthrough();

const completedConversationSchema = z.object({
  runs: z.array(z.object({
    errorMessage: z.string().nullable(),
    id: z.uuid(),
    state: z.enum([
      "accepted",
      "embedding",
      "retrieving",
      "generating",
      "publishing",
      "completed",
      "failed",
      "canceled",
    ]),
  }).passthrough()),
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
    const conversationId = await createConversation(
      dispatcher,
      origin,
      sessionCookie,
    );
    const runId = randomUUID();
    await sendMessage(
      dispatcher,
      origin,
      sessionCookie,
      conversationId,
      runId,
      question,
    );
    await requireCompletedRun(
      dispatcher,
      origin,
      sessionCookie,
      conversationId,
      runId,
    );
    console.log(JSON.stringify({ conversationId, question, runId }, null, 2));
  } finally {
    await dispatcher.close();
  }
}

async function createConversation(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
): Promise<string> {
  const response = await fetch(`${origin}/api/chat/conversations`, {
    body: JSON.stringify({
      scope: { kind: "all" },
      title: "Systemic hypertension application probe",
    }),
    dispatcher,
    headers: buildApplicationProbeHeaders(origin, sessionCookie),
    method: "POST",
  });
  await requireSuccessfulApplicationResponse(response, "Create Chat conversation");
  const result = createdConversationSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error(`Invalid created Chat conversation: ${result.error.message}`);
  }
  return result.data.id;
}

async function sendMessage(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
  conversationId: string,
  runId: string,
  question: string,
): Promise<void> {
  const response = await fetch(
    `${origin}/api/chat/conversations/${conversationId}/messages`,
    {
      body: JSON.stringify({ content: question, requestId: runId }),
      dispatcher,
      headers: {
        ...buildApplicationProbeHeaders(origin, sessionCookie),
        Accept: "text/event-stream",
      },
      method: "POST",
    },
  );
  await requireSuccessfulApplicationResponse(response, "Send Chat message");
  await response.text();
}

async function requireCompletedRun(
  dispatcher: Agent,
  origin: string,
  sessionCookie: string,
  conversationId: string,
  runId: string,
): Promise<void> {
  const response = await fetch(
    `${origin}/api/chat/conversations/${conversationId}`,
    {
      dispatcher,
      headers: { Cookie: sessionCookie },
      method: "GET",
    },
  );
  await requireSuccessfulApplicationResponse(
    response,
    "Read completed Chat conversation",
  );
  const result = completedConversationSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error(`Invalid completed Chat conversation: ${result.error.message}`);
  }
  const run = result.data.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`Completed Chat conversation does not contain run ${runId}.`);
  }
  if (run.state !== "completed") {
    throw new Error(
      `Chat run ${runId} ended in state ${run.state}: ${run.errorMessage ?? "no error detail"}`,
    );
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
