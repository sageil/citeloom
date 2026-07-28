import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as requestUpstream } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const frontendUrlPrefix = "/web";

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

const host = readHost(process.env.CITELOOM_WEB_DEV_HOST);
const port = readPort(process.env.CITELOOM_WEB_DEV_PORT);
const apiOrigin = readApiOrigin(process.env.CITELOOM_API_ORIGIN);

const server = createServer((request, response) => {
  const requestUrl = request.url ?? "/";
  if (requestUrl === "/") {
    response.writeHead(302, { location: "/web/" });
    response.end();
    return;
  }
  if (requestUrl.startsWith("/api/")) {
    proxyApiRequest(request, response, requestUrl);
    return;
  }
  void serveStaticRequest(request, response, requestUrl);
});

server.listen(port, host, () => {
  console.log(`CiteLoom web development server: http://${host}:${port}/web/`);
  console.log(`CiteLoom API proxy: ${apiOrigin.origin}`);
});

function readHost(value) {
  if (value === undefined || value === "") {
    return "127.0.0.1";
  }
  if (value === "127.0.0.1" || value === "0.0.0.0") {
    return value;
  }
  throw new Error(
    "CITELOOM_WEB_DEV_HOST must be 127.0.0.1 or 0.0.0.0.",
  );
}

function readPort(value) {
  if (value === undefined || value === "") {
    return 5_175;
  }
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error("CITELOOM_WEB_DEV_PORT must be a valid TCP port.");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed > 65_535) {
    throw new Error("CITELOOM_WEB_DEV_PORT must be a valid TCP port.");
  }
  return parsed;
}

function readApiOrigin(value) {
  const candidate = value === undefined || value === ""
    ? "http://127.0.0.1:3000"
    : value;
  let origin;
  try {
    origin = new URL(candidate);
  } catch {
    throw new Error("CITELOOM_API_ORIGIN must be a valid HTTP origin.");
  }
  if (
    origin.protocol !== "http:"
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    throw new Error("CITELOOM_API_ORIGIN must be a valid HTTP origin.");
  }
  return origin;
}

function proxyApiRequest(request, response, requestUrl) {
  const upstreamUrl = new URL(requestUrl, apiOrigin);
  const headers = { ...request.headers, host: upstreamUrl.host };
  const upstreamRequest = requestUpstream(upstreamUrl, {
    headers,
    method: request.method,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("The CiteLoom API could not be reached.");
  });
  request.pipe(upstreamRequest);
}

async function serveStaticRequest(request, response, requestUrl) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = readStaticFilePath(requestUrl);
  if (filePath === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }
  if (!fileStats.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }

  const contentType = contentTypes[extname(filePath)] ?? "application/octet-stream";
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": fileStats.size,
    "content-type": contentType,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function readStaticFilePath(requestUrl) {
  let pathname;
  try {
    const parsed = new URL(requestUrl, "http://localhost");
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname === frontendUrlPrefix) {
    pathname = `${pathname}/`;
  }
  if (pathname.endsWith("/")) {
    pathname = `${pathname}index.html`;
  }

  if (
    pathname !== frontendUrlPrefix
    && !pathname.startsWith(`${frontendUrlPrefix}/`)
  ) {
    return null;
  }

  const relativePath = pathname.slice(frontendUrlPrefix.length);
  const filePath = resolve(frontendRoot, `.${relativePath}`);
  if (isInside(filePath, frontendRoot)) {
    return filePath;
  }
  return null;
}

function isInside(filePath, directory) {
  return filePath === directory || filePath.startsWith(`${directory}${sep}`);
}
