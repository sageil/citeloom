import packageMetadata from "../../../package.json" with { type: "json" };

const semanticVersionPattern = /^\d+\.\d+\.\d+$/u;

function decodeCiteLoomMetadata(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The root package.json must contain an object.");
  }
  const license = parsed.license;
  if (typeof license !== "string" || license.trim() === "") {
    throw new Error("The root package.json must contain a license identifier.");
  }
  const version = parsed.version;
  if (typeof version !== "string" || !semanticVersionPattern.test(version)) {
    throw new Error(
      "The root package.json version must use the x.y.z semantic-version format.",
    );
  }
  return { license, version };
}

const metadata = decodeCiteLoomMetadata(packageMetadata);

export const citeloomLicense = metadata.license;
export const citeloomVersion = metadata.version;
