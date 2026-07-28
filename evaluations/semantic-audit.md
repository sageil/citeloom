# Evaluation Semantic Audit

## Outcome

All 60 evaluation cases passed a review against the exact `source_elements` records stored in the database.
Before the final review, 11 unsupported or repetitive cases were replaced and five unclear questions were rewritten.

| Verdict | Count | Meaning |
| --- | ---: | --- |
| Pass | 60 | The exact labeled element directly supports a realistic and sufficiently precise question. |
| Revise | 0 | No imprecise questions remain. |
| Reject | 0 | No unsupported labels remain. |

Within the corpus limits described below, the final datasets are suitable for use as accepted benchmark data.
The first audit found 47 passing cases, six cases that needed revision, and seven rejected cases.
The follow-up replaced the seven rejected cases and four repetitive coat-of-arms cases.
It also rewrote the remaining five unclear questions and regenerated every affected baseline.
Those version 2 results were later removed when version 3 introduced new provenance records and element IDs.

## Method

Each question was compared with the complete content of its labeled source element in the local database.
Legal images were exported to a temporary local directory and reviewed at their original stored resolution.
The review did not download documents or other files.
A source was not rejected only because it came from a reference list when its cited title directly supplied the answer.

The generator labels only the selected source element in `tools/evaluation/generator.ts`.
The evaluator then scores retrieval against that element's ID in `tools/evaluation/index.ts`.
The labeled element must therefore support the question directly, even if another part of the same document contains the answer.

## Legal Development

| Verdict | Case | Exact source evidence | Finding |
| --- | --- | --- | --- |
| Pass | `legal-development-5767db9ba528b152` | Text deems members of the Canadian Forces and Royal Canadian Mounted Police to be employed by the Crown. | The replacement question directly asks for the two named services. |
| Pass | `legal-development-3467e88ef09827e9` | Index table maps `15` to `Extension of time limits`. | Direct answer: section 15. |
| Pass | `legal-development-e76826d7a8528eab` | Text permits regional or branch offices `not exceeding twelve`. | Direct answer: no more than 12 offices. |
| Pass | `legal-development-6d7e836071f1677c` | Index table maps `36.1` to `Pay Equity Division`. | Direct answer: section 36.1. |
| Pass | `legal-development-a547624056b23c98` | Text states the rights available after an error or omission is found in administrative personal information. | The replacement question directly asks for those rights. |
| Pass | `legal-development-6dac3d0b15c82a8a` | French text states that refusal or adverse differentiation based on a prohibited ground is discriminatory. | The English question is a faithful paraphrase of the labeled French provision. |
| Pass | `legal-development-9a6ecefc22c7efba` | Index table maps `47` to appointment of a conciliator. | Direct answer: section 47. |
| Pass | `legal-development-79293f10304e8a60` | Text specifies the official-language and translation obligations for personal information disclosed under the provision. | The replacement question directly asks for those obligations. |
| Pass | `legal-development-83311958fd01d945` | French text provides for permanent review by a Commons, Senate, or joint committee designated or established by Parliament. | The question is directly supported. |
| Pass | `legal-development-308667002fee76e2` | Index table maps `14.1` to retaliation. | Direct answer: section 14.1. |
| Pass | `legal-development-e63ccc3355c5435f` | Image depicts the Canadian coat of arms. | Direct visual identification: Canada. |
| Pass | `legal-development-93fa4c363a787b16` | The fragment says the Commission must notify the complainant and respondent in writing and describe the action taken. | The rewritten question asks only for the supported recipients and notice contents. |
| Pass | `legal-development-d999920fad339dcf` | Index table maps `74` to immunity from prosecution or civil proceedings. | Direct answer: section 74. |
| Pass | `legal-development-733bea6a05e8acb1` | The table maps the Privacy Commissioner's findings to the applicable section. | The replacement question directly asks for that section. |
| Pass | `legal-development-b4687eee7546527f` | The table maps a court order to remove information from a file to its applicable section. | The replacement question directly asks for that section. |

## Legal Holdout

| Verdict | Case | Exact source evidence | Finding |
| --- | --- | --- | --- |
| Pass | `legal-holdout-a757458e7582d030` | French text says amending text becomes part of the amended text to the extent compatible with its content. | The English question is directly supported. |
| Pass | `legal-holdout-9cfc8ef41f25ba2c` | The Act's index maps `124` to access to the record by the young person. | The rewritten question correctly refers to the Act. |
| Pass | `legal-holdout-0f1e604a36728bc9` | French text deems an existing provincial pre-charge review program to be established under subsection 1. | The question is directly supported. |
| Pass | `legal-holdout-887a9c915e2c8c96` | The French schedule places `Australie` immediately after `Antigua et Barbuda`. | The rewritten question asks for the supported sequence rather than an unsupported translation pairing. |
| Pass | `legal-holdout-8d9e190d5db9232f` | The table identifies the section covering victims' rights. | The replacement question directly asks for that section. |
| Pass | `legal-holdout-34479edd9f2f8375` | Text lists the young person, a parent, the Attorney General, the provincial director, and provincial and federal correctional representatives. | The question directly asks for this list. |
| Pass | `legal-holdout-e9d14ad594e69675` | Index table maps `84` to keeping young people apart from adults. | Direct answer: section 84. |
| Pass | `legal-holdout-8530ede5aedf7115` | Text states what the Clerk must endorse on an instrument. | The replacement question directly asks for the required endorsement. |
| Pass | `legal-holdout-0af1bb9883f66e7d` | Text lists the Part XXIII Criminal Code provisions that still apply with necessary modifications. | The question is directly supported. |
| Pass | `legal-holdout-24a5cb4e1124d014` | Table pairs `Transfer to adult facility` with `Transfèrement à un établissement correctionnel provincial pour adultes`. | The question is directly supported. |
| Pass | `legal-holdout-c855d9cfb2f9a7cc` | Text preserves Aboriginal and treaty rights when construing an enactment. | The replacement question directly asks for that construction rule. |
| Pass | `legal-holdout-1ddea28a1a531863` | Text requires a fair, large, and liberal construction that best ensures the enactment's objects. | The replacement question directly asks for the remedial interpretation rule. |
| Pass | `legal-holdout-9daa2c22f63f4e65` | Index table maps `28` to calculation of a period of months after or before a specified day. | Direct answer: section 28. |
| Pass | `legal-holdout-b041970cb15bdbe9` | Text states that marginal notes form no part of an enactment and are inserted only for convenience of reference. | The replacement question directly asks for their legal status and purpose. |
| Pass | `legal-holdout-4525c8ddeb355fda` | Section 84 lists the statutory exceptions that permit placement with adults. | The question is directly supported. |

## Veterinary Development

| Verdict | Case | Exact source evidence | Finding |
| --- | --- | --- | --- |
| Pass | `veterinary-development-db8d4853e9d808fa` | Text says structural epilepsy significantly reduces median lifespan while idiopathic epilepsy does not reduce it relative to dogs generally. | The requested comparison is direct. |
| Pass | `veterinary-development-e10e1e8772bddb41` | The consensus table gives the recommended initial phenobarbital dose for canine seizure management. | The replacement question directly asks for that dose. |
| Pass | `veterinary-development-b60e0689a66030b8` | Text reports higher seropositivity in Bernese Mountain Dogs than other breeds. | Direct answer: Bernese Mountain Dog. |
| Pass | `veterinary-development-ff2333f2559591f1` | Text associates North American canine disease with `B. burgdorferi sensu stricto`. | The rewritten question correctly asks for the Borrelia species. |
| Pass | `veterinary-development-da9e11f5e36896c6` | Consensus table places using quantitative titers to decide treatment in the nonconsensus column. | Direct answer: there is no consensus supporting that use. |
| Pass | `veterinary-development-465c53dd0c606b5d` | Text reports significantly lower seizure frequency and monthly seizure days on the MCT test diet than placebo. | The question is directly supported. |
| Pass | `veterinary-development-41368d331251d9c7` | Text identifies increased serum chloride and decreased bicarbonate or TCO2. | The requested laboratory changes are direct. |
| Pass | `veterinary-development-153394a3b8b8f5cf` | Table gives imepitoin monotherapy grade `A`. | Direct answer: grade A. |
| Pass | `veterinary-development-14b8b24c24693c97` | Text says quantitative C6 does not provide evidence-based treatment guidance for a nonclinical, nonproteinuric dog. | The question is directly supported. |
| Pass | `veterinary-development-c63ef8d61252b27d` | Text enumerates four panel criteria for starting antiepileptic treatment. | The question directly asks for the enumerated criteria. |
| Pass | `veterinary-development-a7e711be2d4b5259` | Vaccine table marks Recombitek Lyme as having no adjuvant. | Direct answer: Recombitek Lyme. |
| Pass | `veterinary-development-6d3fc1fdb47a96c5` | Abstract says the update guides diagnosis, treatment, and prevention of Lyme borreliosis in dogs and cats. | The question is directly supported. |
| Pass | `veterinary-development-4bcc865437ee66f5` | Drug table lists gastrointestinal upset and gingival hyperplasia for cyclosporine. | The question is directly supported. |
| Pass | `veterinary-development-d0c4cbd479a8b801` | Table records Connecticut as `22,132/135,483; 16.34`. | Direct answer: 16.34 percent. |
| Pass | `veterinary-development-4d52e81bbd60f825` | Abstract describes a concise sequential approach to chronic seizure management, response, monitoring, and quality of life. | The question is directly supported. |

## Veterinary Holdout

| Verdict | Case | Exact source evidence | Finding |
| --- | --- | --- | --- |
| Pass | `veterinary-holdout-f343c47aedf4f5fc` | Text requires continual review at least every six months and updates when new guidance appears. | Direct answer: at least every six months. |
| Pass | `veterinary-holdout-f984feae416c5cdf` | Text identifies exudative retinal detachment as the most commonly observed ocular finding. | The question is directly supported. |
| Pass | `veterinary-holdout-b4b07f351801ef02` | A cited study title states that a closed system reduced platinum-containing cytostatic workplace contamination in a veterinary hospital. | Direct answer: introduce a closed-system drug-transfer device. |
| Pass | `veterinary-holdout-1bb0e0aad6cd4bc8` | Text enumerates PPE, absorbent materials, labeled disposal bags, a scoop, and a puncture-resistant fragment container. | The question directly asks for the enumerated spill-kit contents. |
| Pass | `veterinary-holdout-8273dab2db085d7d` | Table classifies SBP at or above 180 mm Hg as severely hypertensive with high target-organ-damage risk. | The question is directly supported. |
| Pass | `veterinary-holdout-695ee9416c55f2e6` | Abbreviation list expands SDMA to symmetric dimethylarginine. | Direct answer: symmetric dimethylarginine. |
| Pass | `veterinary-holdout-071fa58cfd96ab66` | Panel text recommends `idiopathic` in place of `essential`. | Direct answer: idiopathic hypertension. |
| Pass | `veterinary-holdout-3b2b72dc440ac585` | A cited study title describes darbepoetin stimulation of erythropoiesis for anemia of chronic kidney disease in 25 cats. | The title directly supports a qualified yes. |
| Pass | `veterinary-holdout-911705a85f940d2a` | Conclusion recommends large multicenter BP-assessment studies and long-term hypertension-treatment studies. | The question is directly supported. |
| Pass | `veterinary-holdout-01a1859fcb87cf89` | Text reports a 1 to 3 mm Hg annual increase in some canine studies while noting that other studies found no age effect. | The rewritten question accurately asks what has been reported in some studies. |
| Pass | `veterinary-holdout-d5585e4c1e62e0da` | Text reports hound BP approximately 10 to 20 mm Hg above mongrels. | The question is directly supported. |
| Pass | `veterinary-holdout-660733b1872adede` | Cited titles report generalized peripheral edema and gingival hyperplasia associated with amlodipine in dogs. | The titles directly support those potential adverse effects. |
| Pass | `veterinary-holdout-1b783317b0b56474` | Target-organ-damage table lists renal findings and serum, urine, and GFR tests. | The question directly asks for that row's findings and tests. |
| Pass | `veterinary-holdout-bbdafe8a9904d331` | Excretion table reports carboplatin in urine, feces, and other products for 21 days. | Direct answer: 21 days. |
| Pass | `veterinary-holdout-518c4216f18fada1` | Text specifies cuff width of 30 to 40 percent of extremity circumference. | The question is directly supported. |

## Image Subset Finding

All eight originally selected image cases showed the same Canadian coat of arms.
Seven were removed to avoid repetitive labels and questions about unsupported visual details.
The remaining `legal-development-e63ccc3355c5435f` case asks only which country the clearly visible arms represent.
No different suitable image was found in the four legal source documents.
The final benchmark therefore has one valid image case and does not claim broad coverage of image retrieval.
No additional files were downloaded to expand the image subset.

## Archived version 2 baselines

After the original corrections, all four baselines were regenerated with the embedding space `embeddinggemma:latest:embeddinggemma:768`.
These figures are historical.
Do not use them for current comparisons because the version 3 migration changed element identities.
Each report contains all four required search modes and 15 cases per mode, with no skipped modes.
An independent calculation reproduced every reported total from the individual case results.

| Dataset | Cases | BM25 NDCG / recall | Dense NDCG / recall | Hybrid NDCG / recall | Hybrid-reranked NDCG / recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legal development | 15 | 0.4031 / 0.6667 | 0.4929 / 0.6000 | 0.4550 / 0.6000 | 0.6919 / 0.8667 |
| Legal holdout | 15 | 0.3947 / 0.4667 | 0.5345 / 0.6000 | 0.4411 / 0.5333 | 0.6244 / 0.8000 |
| Veterinary development | 15 | 0.7185 / 1.0000 | 0.8499 / 1.0000 | 0.7836 / 1.0000 | 0.9374 / 1.0000 |
| Veterinary holdout | 15 | 0.6225 / 0.9333 | 0.7265 / 0.9333 | 0.6894 / 0.9333 | 0.8929 / 1.0000 |

## Reranked misses

The following cases are valid, but the hybrid reranked search did not return their labeled source:

- `legal-development-733bea6a05e8acb1`: the source table maps the Privacy Commissioner's findings and recommendations to the requested section.
- `legal-development-b4687eee7546527f`: the source table maps the court order to remove a file from an exempt bank to the requested section.
- `legal-holdout-9cfc8ef41f25ba2c`: the source index maps a young person's access to their own record to section 124.
- `legal-holdout-8d9e190d5db9232f`: the source table maps a victim's right to information to the requested section.
- `legal-holdout-9daa2c22f63f4e65`: the source table maps calculation of a period of months to section 28.

Neither veterinary split has a hybrid-reranked miss.

## Completed follow-up

All seven rejected cases were replaced with source elements that directly support their questions.
Four repetitive image cases were also replaced, and the remaining five unclear questions were rewritten.
Dataset validation now rejects generated cases with no source label, duplicate case IDs, duplicate normalized questions, or duplicate source elements.
All four version 2 baselines were regenerated and checked independently.
They were archived after the version 3 migration changed their dataset hashes and element IDs.
The remaining corpus limit is explicit: the legal documents contain only one distinct image subject, so the benchmark does not claim broad coverage across text and images.

## Version 3 benchmark metadata

The four reviewed datasets were migrated to the version 3 schema using the evidence and findings in this audit.
The migration kept all 60 case IDs and questions.
It matched 34 outdated element IDs to unique normalized content and checked every resulting target against the published search index.
Each dataset now records its source type and parser protocol.
Each source also records the protocol that determines its element IDs.
Each accepted source judgment records `semantic-audit` as the review process, the original audit commit as the process version, and that commit's time as the review time.
Development splits use `development` access.
Previously examined holdouts use `regression` access and cannot be used by tuning code.

The paired study is designed to detect an NDCG change of at least 0.20.
It assumes a standard deviation of 0.25 for paired score differences, which requires 13 cases for 80 percent statistical power with a two-sided alpha of 0.05.
Each split contains 15 cases.
This study design cannot support precise claims about smaller changes.
The metadata records every question as English and classifies visual identification, comparison, definition, procedure, and factoid cases separately.
No sealed holdout was created from these reviewed cases because previously examined data cannot be treated as an untouched final test.
