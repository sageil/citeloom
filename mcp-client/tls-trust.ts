import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

const PEM_CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

export async function configureTlsTrust(caFile: string | null): Promise<void> {
  if (caFile === null) {
    return;
  }
  let contents: string;
  try {
    contents = await readFile(caFile, "utf8");
  } catch (error: unknown) {
    throw new Error(`Unable to read the CA file ${caFile}.`, { cause: error });
  }
  const certificates = readPemCertificates(contents, caFile);
  const trustedCertificates = getCACertificates("default");
  setDefaultCACertificates([...trustedCertificates, ...certificates]);
}

export function readPemCertificates(contents: string, source: string): string[] {
  const certificates = contents.match(PEM_CERTIFICATE_PATTERN) ?? [];
  if (certificates.length === 0) {
    throw new Error(`The CA file ${source} contains no PEM certificates.`);
  }
  for (const certificate of certificates) {
    try {
      new X509Certificate(certificate);
    } catch (error: unknown) {
      throw new Error(`The CA file ${source} contains an invalid certificate.`, {
        cause: error,
      });
    }
  }
  return certificates;
}
