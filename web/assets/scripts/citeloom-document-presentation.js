const exactDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat();

export function readBasename(sourceFile) {
  const normalized = sourceFile.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? sourceFile;
}

export function readFileType(filename) {
  return filename.toLowerCase().split(".").at(-1) ?? "file";
}

export function formatCount(value) {
  return numberFormatter.format(value);
}

export function readContentCountLabel(value, available) {
  return available ? formatCount(value) : "Waiting";
}

export function formatDocumentLocationCount(filename, count) {
  if (count === null) {
    return "N/A";
  }
  const extension = `.${readFileType(filename)}`;
  let unit = count === 1 ? "page" : "pages";
  if (extension === ".xlsx") {
    unit = count === 1 ? "sheet" : "sheets";
  } else if (extension === ".pptx") {
    unit = count === 1 ? "slide" : "slides";
  }
  return `${formatCount(count)} ${unit}`;
}

export function formatRelativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "recently";
  }
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1_000),
  );
  if (elapsedSeconds < 10) {
    return "now";
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} sec ago`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}

export function formatElapsedDuration(startedAt, currentTimeMs) {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return "Duration unavailable";
  }
  const elapsedSeconds = Math.max(
    0,
    Math.floor((currentTimeMs - startedAtMs) / 1_000),
  );
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} sec`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const remainingSeconds = elapsedSeconds % 60;
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ${remainingSeconds} sec`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  if (elapsedHours < 24) {
    return `${elapsedHours} hr ${remainingMinutes} min`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  const remainingHours = elapsedHours % 24;
  return `${elapsedDays} d ${remainingHours} hr`;
}

export function formatExactDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return exactDateFormatter.format(timestamp);
}

export function formatByteLength(value) {
  if (value === null) {
    return "Unknown";
  }
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_024 * 1_024) {
    return `${(value / 1_024).toFixed(1)} KB`;
  }
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function buildCollections(facets) {
  const collections = [{
    count: facets.total,
    key: "all",
    label: "All documents",
  }];
  for (const facet of facets.tags.slice(0, 6)) {
    collections.push({
      count: facet.count,
      key: `tag:${facet.tag}`,
      label: titleCase(facet.tag),
    });
  }
  collections.push({
    count: facets.uploads,
    key: "uploads",
    label: "Uploads",
  });
  collections.push({
    count: facets.untagged,
    key: "untagged",
    label: "Untagged",
  });
  return collections;
}

export function readCollectionLabel(collection) {
  if (collection === "all") {
    return "All documents";
  }
  if (collection === "uploads") {
    return "Uploads";
  }
  if (collection === "untagged") {
    return "Untagged";
  }
  return titleCase(collection.slice(4));
}

export function readDocumentStatusCopy(document) {
  if (document.displayStatus === "running") {
    const detail = document.phase === "normalized"
      ? readEmbeddingProgressDetail(document.embeddingProgress)
      : null;
    return {
      detail,
      label: readActivePhaseLabel(document),
    };
  }
  if (document.displayStatus === "pending") {
    if (document.phase === "discovered") {
      return { detail: null, label: "Waiting to normalize" };
    }
    if (document.phase === "normalized") {
      let label = "Waiting to resume embedding";
      if (document.embeddingProgress.state === "not-started") {
        label = "Waiting to embed";
      } else if (document.embeddingProgress.state === "complete") {
        label = "Waiting to finish embedding";
      }
      return {
        detail: readEmbeddingProgressDetail(document.embeddingProgress),
        label,
      };
    }
    return { detail: null, label: "Waiting to publish" };
  }
  if (document.displayStatus === "ready") {
    return { detail: "Available to ask", label: "Ready" };
  }
  if (document.displayStatus === "reindex-required") {
    return {
      detail: "Not indexed in the active embedding space",
      label: "Reindex required",
    };
  }
  if (document.phase === "discovered") {
    return { detail: null, label: "Normalization failed" };
  }
  if (document.phase === "normalized") {
    return {
      detail: readEmbeddingProgressDetail(document.embeddingProgress),
      label: "Embedding failed",
    };
  }
  if (document.phase === "indexed") {
    return { detail: null, label: "Publishing failed" };
  }
  return { detail: null, label: "Ingestion failed" };
}

export function combineStatusDetails(...values) {
  const details = [];
  for (const value of values) {
    if (value !== null && value !== "") {
      details.push(value);
    }
  }
  return details.length === 0 ? null : details.join(". ");
}

export function readMediaProgressDetail(document, kind) {
  const progress = readMediaProgress(document, kind);
  const completed = formatCount(progress.completed);
  const total = formatCount(progress.total);
  return `${completed} of ${total} ${progress.label} processed`;
}

export function buildPhaseStages(document) {
  const labels = ["Stored", "Normalize", "Embed", "Ready"];
  const stages = [];
  if (document.status === "ready") {
    const completedLabels = ["Stored", "Normalized", "Embedded", "Ready"];
    for (const label of completedLabels) {
      stages.push({ label, state: "complete" });
    }
    return stages;
  }
  let currentIndex = 1;
  if (document.phase === "normalized") {
    currentIndex = 2;
    labels[1] = "Normalized";
    labels[2] = "Embedding";
  } else if (document.phase === "indexed") {
    currentIndex = 3;
    labels[1] = "Normalized";
    labels[2] = "Embedded";
    labels[3] = "Publishing";
  } else {
    labels[1] = "Normalizing";
  }
  for (let index = 0; index < labels.length; index += 1) {
    let state = "upcoming";
    if (index < currentIndex) {
      state = "complete";
    } else if (index === currentIndex) {
      state = document.status === "failed" ? "failed" : "current";
    }
    stages.push({ label: labels[index], state });
  }
  return stages;
}

export function buildPageNumbers(currentPage, totalPages) {
  const firstPage = Math.max(1, Math.min(currentPage - 1, totalPages - 2));
  const lastPage = Math.min(totalPages, firstPage + 2);
  const pages = [];
  for (let page = firstPage; page <= lastPage; page += 1) {
    pages.push(page);
  }
  return pages;
}

export function readNextSelectedDocument(current, catalog) {
  if (current !== null) {
    return findDocument(catalog, current.sourceFile) ?? current;
  }
  return catalog.attention.documents[0] ?? catalog.documents[0] ?? null;
}

export function readRetryPhase(document) {
  if (document.phase === "discovered") {
    return "normalization";
  }
  if (document.phase === "normalized") {
    return "embedding";
  }
  if (document.phase === "indexed") {
    return "publishing";
  }
  return "the saved phase";
}

function titleCase(value) {
  if (value === "") {
    return value;
  }
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function readActivePhaseLabel(document) {
  if (document.phase === "normalized") {
    if (document.embeddingProgress.state === "complete") {
      return "Finishing embedding";
    }
    return "Embedding";
  }
  if (document.phase === "indexed") {
    return "Publishing";
  }
  return "Normalizing";
}

export function readEmbeddingProgressDetail(progress) {
  if (progress.state === "not-started") {
    return null;
  }
  const completed = formatCount(progress.completedElements);
  const total = formatCount(progress.totalElements);
  return `${completed} of ${total} elements embedded`;
}

function readMediaProgress(document, kind) {
  if (kind === "images") {
    return {
      completed: document.mediaDescriptionProgress.completedImages,
      label: "images",
      total: document.images,
    };
  }
  return {
    completed: document.mediaDescriptionProgress.completedTables,
    label: "tables",
    total: document.tables,
  };
}

function findDocument(catalog, sourceFile) {
  for (const document of catalog.attention.documents) {
    if (document.sourceFile === sourceFile) {
      return document;
    }
  }
  for (const document of catalog.documents) {
    if (document.sourceFile === sourceFile) {
      return document;
    }
  }
  return null;
}
