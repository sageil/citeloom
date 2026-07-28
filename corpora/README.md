# Evaluation corpora

The corpus manifest lists the external documents used in CiteLoom's initial Canadian legal and veterinary search benchmarks.
Downloaded files stay in the ignored `documents/` directory and are not included with CiteLoom.

## Contents

The `legal` corpus contains 16 consolidated Canadian federal laws from the official Justice Laws Website.
The `veterinary` corpus contains 14 peer-reviewed consensus statements from the PubMed Central Open Access Subset.
Version 2 records whether each source is a `document` or `image` separately from its legal or veterinary subject area.

The legal corpus uses official consolidated PDFs from the Justice Laws Website.
The Reproduction of Federal Law Order permits reproduction without charge or permission when the copy remains accurate and is not presented as an official version.
The veterinary corpus uses the authorized NCBI BioC API and converts structured article passages into local HTML with attribution.
Each veterinary manifest entry records the Creative Commons license reported by the PMC Open Access API.
Articles carrying a no-derivatives license are excluded from the transformed HTML corpus.

Sources and licenses can change.
Review the source page and current license before adding or replacing a manifest entry.
Curated images must be PNG, JPEG, or WebP.
They must use CC0-1.0, CC-BY-4.0, or public-domain terms and include an explicit attribution.
User uploads must never be copied into this benchmark corpus automatically.

## Download

Download both domains:

```bash
pnpm corpus:download download
```

Download one domain:

```bash
pnpm corpus:download download --domain legal
pnpm corpus:download download --domain veterinary
```

The downloader first validates the manifest.
It then processes one document at a time, checks PMC identifiers and licenses, verifies each downloaded file type, and writes the file in one safe operation.
It records file sizes and SHA-256 hashes in `documents/evaluation-corpora/inventory.json`.
On a later run, it validates and keeps existing files so an interrupted download can resume.
Use `--force` only when intentionally refreshing sources from their current upstream versions.

Validate the manifest, downloaded bytes, inventory, and proof selection together:

```bash
pnpm validate:corpus
```

## Proof corpus

The versioned [`proof.json`](proof.json) file selects four legal documents and four veterinary documents for the initial comparison.
For each domain, it declares two development documents and two holdout documents.
Each split contains 15 cases and records the fixed evaluation seed.

Preview how the selection would change the ingestion queue:

```bash
pnpm corpus:reconcile
```

Apply the selection and rebuild every selected document with the currently configured summary model:

```bash
pnpm corpus:reconcile --apply --force-selected
```

This command changes only ingestion jobs whose source paths are inside `documents/evaluation-corpora`.
It does not delete downloaded files or affect other uploads such as the scorecard.
It also refuses to change a job that is currently being processed.
Without `--apply`, it only previews the changes.

## Ingest

After downloading, ingest each directory with its domain tag:

```bash
pnpm ingest --recursive --tag legal ./documents/evaluation-corpora/legal
pnpm ingest --recursive --tag veterinary ./documents/evaluation-corpora/veterinary
```

Add `--enqueue` when the worker should process the corpus in the background.
Do not generate an evaluation dataset until `pnpm documents` shows every selected document as ready for the current embedding model.

## Provenance rules

- Use authoritative or peer-reviewed primary sources.
- Use only automated retrieval services allowed by the source provider.
- Record the source page, direct download URL, provider, license, stable filename, domain, and modality.
- Record attribution for every curated image and verify that its license permits the intended redistribution.
- Exclude no-derivatives articles from format conversion.
- Do not treat generated questions or model-judged relevance labels as professional legal or veterinary guidance.
- Review source currency, license metadata, generated questions, and relevance labels before freezing a benchmark.

## Official references

- [Justice Laws consolidated Acts](https://laws-lois.justice.gc.ca/eng/acts/)
- [Reproduction of Federal Law Order](https://laws-lois.justice.gc.ca/eng/regulations/SI-97-5/FullText.html)
- [PMC Open Access Subset](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/)
- [NCBI BioC API](https://www.ncbi.nlm.nih.gov/research/bionlp/APIs/BioC-PMC/)
- [PMC copyright notice](https://pmc.ncbi.nlm.nih.gov/about/copyright/)
