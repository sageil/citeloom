# Evaluation

CiteLoom measures retrieval quality and claim verification against data reviewed by people.
Generated questions and model judgments are never treated as trusted benchmark answers until a reviewer accepts them.
The [corpus guide](../corpora/README.md) explains where sources come from, which licenses apply, and how to select the proof corpus.
The evaluation code lives in [`tools/evaluation/`](../tools/evaluation/) and is not part of the production server or worker build.
It uses the application core through a one-way dependency, so removing the evaluation tool does not change production code.

Use this workflow in order:

1. Download and validate the evaluation corpus.
2. Generate or review a development dataset.
3. Prepare fixed retrieval results.
4. Tune settings with development data.
5. Freeze the selected configuration.
6. Run the final evaluation against a sealed dataset.

## Prepare the corpus

Download and reconcile the versioned corpus selection.

```bash
pnpm corpus:download download
pnpm corpus:reconcile
```

Review the reconciliation preview before adding `--apply --force-selected`.
Before using a generated question or model-judged relevance label in a benchmark, review that individual case and accept its judgment.

Check the corpus files, evaluation schemas, source records, element IDs, source types, and image IDs against the current search index.

```bash
pnpm validate:benchmark
```

CiteLoom stops preparation if the current source records do not match the dataset.

## Dataset access

- Use development datasets to tune settings and select parameters.
- Use regression datasets to check previously reviewed holdouts for regressions.
  Because these datasets have already been examined, they do not prove performance on unseen data.
- Open sealed datasets only for the final evaluation after selecting and freezing the configuration.

Generated judgments start with `pending` status.
A dataset cannot run in a benchmark until a reviewer accepts every judgment.

## Generate a development dataset

Dataset generation records two statistical assumptions:

- The smallest paired normalized discounted cumulative gain (NDCG) change the evaluation should detect.
- The expected standard deviation of the score difference for each paired case.

If you omit the case count, CiteLoom calculates it with 80 percent statistical power, a two-sided alpha of 0.05, and a normal approximation.

```bash
pnpm evaluate:generate \
  --domain legal \
  --language en \
  --question-type factoid \
  --split development \
  --minimum-detectable-ndcg-delta 0.1 \
  --assumed-paired-ndcg-stddev 0.25 \
  --output evaluations/legal.development.v3.json \
  --enrich
```

Add `--enrich` to gather candidate passages from keyword, meaning-based, combined, and configured reranked retrieval.

## Preparation and offline scoring

A connected evaluation runs each case against the configured database and model services.
It saves fixed queries, candidate rankings, traces, and reranker scores that can be reused later.
The configured `topK` must equal dataset `atK`, and `candidateK` must be at least that value.

```bash
pnpm evaluate evaluations/legal.development.json \
  --preparation-output results/legal-development.preparation.json \
  --output results/legal-development.json
```

You can then score the saved preparation without model or database access.
The same inputs produce exactly the same output file.

```bash
pnpm evaluate \
  --from-preparation results/legal-development.preparation.json \
  --output results/legal-development.rescored.json
```

## Answer evidence threshold calibration

Answer-threshold calibration uses accepted evaluation questions as answerable cases.
For each one, it creates an unanswerable comparison by searching a corpus from another declared domain.
For example, it can run a legal question against the veterinary corpus.
Each comparison uses the same query expansion, retrieval, source loading, and reranking path as a production question.
The saved preparation records the strongest scores, document scopes, telemetry, corpus and model identities, retrieval settings, and code revision for both cases.

Prepare each development domain separately.
This prevents an interrupted model or database operation from leaving a partial file that looks complete.

```bash
pnpm evaluate \
  --prepare-answer-threshold evaluations/legal.development.json \
  --negative-domain veterinary \
  --output results/legal-development.answer-threshold.json

pnpm evaluate \
  --prepare-answer-threshold evaluations/veterinary.development.json \
  --negative-domain legal \
  --output results/veterinary-development.answer-threshold.json

pnpm evaluate \
  --prepare-answer-threshold evaluations/legal.holdout.json \
  --negative-domain veterinary \
  --output results/legal-regression.answer-threshold.json

pnpm evaluate \
  --prepare-answer-threshold evaluations/veterinary.holdout.json \
  --negative-domain legal \
  --output results/veterinary-regression.answer-threshold.json
```

Selection chooses the threshold that accepts the most answerable cases while staying within the maximum measured false-acceptance rate, both overall and in each included domain.
If several thresholds produce the same measured result, CiteLoom chooses the midpoint between the positive and negative score boundaries.

The report shows answerable pass rates, false-acceptance rates, results for each domain, Wilson 95 percent confidence intervals, and accepted cases that retrieval missed.
Each generated negative remains paired with its accepted source case, and each pair is counted once.
The maximum false-acceptance rate is a selection rule based on the measured sample, not a guarantee about future questions.
Promote a threshold only when its upper confidence bound, sample size, domain coverage, and negative-case difficulty meet your deployment policy.

```bash
pnpm evaluate \
  --select-answer-threshold \
  --maximum-false-acceptance-rate 0.05 \
  --from-preparation results/legal-development.answer-threshold.json \
  --from-preparation results/veterinary-development.answer-threshold.json \
  --from-preparation results/legal-regression.answer-threshold.json \
  --from-preparation results/veterinary-regression.answer-threshold.json \
  --output results/answer-threshold.selection.json
```

Selection requires development preparations.
It stops if the preparations use different code revisions, embedding spaces, models, HNSW index settings, or retrieval settings.
Regression preparations may be included in the selection command after all development preparations.
They do not influence selection.
The report uses them only to show answerable pass rates, false-acceptance rates, retrieval misses, and domain results at the threshold selected from development data.

Threshold reports can still help compare historical reranker scores, but CiteLoom does not use a raw reranker score to decide whether to generate an answer.
Create new preparations after changing any part of search or scoring.
This includes the reranker, provider scoring, embedding space, query expansion, candidate count, result fusion, HNSW settings, corpus, or relevant code.
This calibration measures accepted positive cases against negatives from another domain.
It does not establish performance for arbitrary real-world questions or difficult negatives from the same domain.

## Parameter search

Tuning accepts development preparations only.
It rejects regression and sealed data before generating any candidates.

Use [`evaluation-tuning.example.json`](../evaluation-tuning.example.json) as the required search format.
It defines the reference configuration, optimization goal, regression limit for each domain, latency limits, and every value to test.

Run one search across all development domains participating in the objective.

```bash
pnpm evaluate \
  --tune \
  --specification evaluation-tuning.example.json \
  --from-preparation results/legal-development.preparation.json \
  --from-preparation results/veterinary-development.preparation.json \
  --output results/retrieval-tuning.selection.json \
  --freeze-output results/retrieval-tuning.freeze.json
```

If no candidate meets the goal and every domain and latency limit, the command does not select a winner.
A successful result lists every candidate, explains each rejection, identifies the winner, shows the effect of removing individual changes, and saves the winning configuration.

## Frozen configuration and sealed holdouts

A freeze records the code revision, settings version, model identities, embedding space, index settings, result-fusion settings, and the rest of the retrieval configuration.
This includes the selected embedding input format.
Its SHA-256 fingerprint detects later changes.
It does not prevent anyone from changing the application or services.

Create a freeze after selection and before opening a sealed dataset.

```bash
pnpm evaluate \
  --freeze-configuration \
  --output results/sealed.freeze.json
```

Use both the tuning selection and its freeze for a tuned sealed evaluation.

```bash
pnpm evaluate evaluations/final.sealed.json \
  --tuning-selection results/retrieval-tuning.selection.json \
  --frozen-configuration results/retrieval-tuning.freeze.json \
  --preparation-output results/final-sealed.preparation.json \
  --output results/final-sealed.json
```

CiteLoom checks for configuration changes before opening the sealed dataset.
If you change the configuration after seeing sealed results, that dataset is no longer an untouched final test.

## Audited claim verification

To measure claim verification, use an approved answer set that includes human-reviewed citation judgments and claim statuses.
The report includes citation precision, citation recall, claim coverage, unsupported-claim rate, and verifier error rate overall and by domain.

```bash
pnpm evaluate \
  --claims \
  --dataset evaluations/claims.audited.json \
  --output results/claims.report.json
```
