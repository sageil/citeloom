import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type { ResearchFeedbackInput } from "../research/store.js";
import type {
  FeedbackDimension,
  ResearchFeedbackSummary,
} from "../research/types.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  decodeResearchFeedback,
  decodeResearchFeedbackSummary,
} from "./request-boundary.js";

export interface ResearchFeedbackRuntimeServices {
  addResearchFeedback: (
    principal: AuthorizationPrincipal,
    input: ResearchFeedbackInput,
  ) => Promise<ResearchFeedbackSummary>;
  readResearchFeedback: (
    principal: AuthorizationPrincipal,
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
  ) => Promise<ResearchFeedbackSummary>;
}

export interface ResearchFeedbackRouteServices {
  run: <T>(
    operation: (runtime: ResearchFeedbackRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface ResearchFeedbackRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: ResearchFeedbackRouteServices;
}

export function registerResearchFeedbackRoutes(
  server: FastifyInstance,
  options: ResearchFeedbackRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.post("/api/research/feedback", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const feedback = decodeResearchFeedback(request.body);
    const summary = await services.run(async (runtime) => {
      return runtime.addResearchFeedback(principal, feedback);
    });
    return reply.status(200).send(summary);
  });

  server.post("/api/research/feedback-summary", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const feedback = decodeResearchFeedbackSummary(request.body);
    return services.run(async (runtime) => {
      return runtime.readResearchFeedback(
        principal,
        feedback.turnId,
        feedback.dimension,
        feedback.citationId,
      );
    });
  });
}
