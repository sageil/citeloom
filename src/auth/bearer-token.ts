const MAXIMUM_BEARER_TOKEN_LENGTH = 16_384;

export class BearerTokenRejectedError extends Error {
  public constructor() {
    super("The Bearer authorization value is invalid.");
    this.name = "BearerTokenRejectedError";
  }
}

export function readBearerToken(
  authorizationHeader: string | string[] | undefined,
): string {
  if (typeof authorizationHeader !== "string") {
    throw new BearerTokenRejectedError();
  }
  const match = /^Bearer ([^\s]+)$/iu.exec(authorizationHeader);
  const token = match?.[1];
  if (
    token === undefined
    || token.length === 0
    || token.length > MAXIMUM_BEARER_TOKEN_LENGTH
  ) {
    throw new BearerTokenRejectedError();
  }
  return token;
}

export function hasBearerTokenPrefix(
  authorizationHeader: string | string[] | undefined,
  tokenPrefix: string,
): boolean {
  try {
    return readBearerToken(authorizationHeader).startsWith(tokenPrefix);
  } catch (error: unknown) {
    if (error instanceof BearerTokenRejectedError) {
      return false;
    }
    throw error;
  }
}
