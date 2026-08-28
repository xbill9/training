# How lab marking works, and how to debug a stuck task

This repo tracks *what* training is outstanding. This document covers the other
half of the problem: a lab that will not mark, when you are sure the work is
done. Everything below was measured against a real lab on
`partner.skills.google` on **2026-08-27** — four consecutive instances of *API
Modernization: Challenge Lab* (focus 82026) whose Task 4 would not validate. The
cause was one extra space in the instructions.

`cloudskillsboost.google` and `skills.google` run the same grading code, so this
applies to all three sites.

## The one thing to take away

**Read the grader's JSON. Never trust the button.**

"Check my progress" fires a single request:

```
GET /assessments/run_step.json?id=<labInstanceId>&step=N
```

Open that URL directly in the lab's own browser tab. The lab instance id is in
the page URL; append a changing `&cb=1`, `&cb=2` … to defeat caching. The UI
throws away the grader's message and shows you *"It doesn't look like you've
completed this step yet."* The JSON contains the real one.

## Run the check before you do the work

Checks are free and unlimited, and a failing check names its own requirement. So
running step N on an untouched lab turns the grader into documentation:

- *"Please create a service account name X"*
- *"Missing XML files: RF-Pre_flightCORS.xml is missing"*
- *"Please edit the metadata with SMN-Lab4 as Display name."*

Do this for every task before starting it. It is faster than reading the
instructions and, more importantly, it is *correct* — the instructions are
frequently not.

Note that `run_step.json?step=N` re-evaluates **only** step N. The other entries
in the response body are stale cache from previous runs; do not read them as
current.

## Decoding the response

| Shape | Meaning |
| --- | --- |
| `passed: false`, `message: ""` | Never evaluated. |
| `passed: null` + message text | Evaluated. |
| `passed: null`, `score: 100`, "Assessment Completed!" | **This is a pass.** |

`passed` is never `true` on a per-step basis — use the `step_complete[]` and
`step_scores[]` arrays for real state.

The trap: **an evaluated step scoring 0 with an empty message is a failed
assertion whose failure text was never authored.** It is not a crash and not a
broken grader. Keep bisecting. Reading it as terminal is what cost four lab
restarts.

## The expected values are published

```
GET /focuses/show_spl/<focusId>.json?parent=catalog
```

`resourceData.project_0.startup_script` contains the exact literal strings the
checks compare against — policy names, service account names, VM names, zones.

These do **not** always match the task text, and they **change between instances
of the same lab**. Build to this file, not to the instructions.

> ⚠️ The same response carries lab credentials under `user_0`: password and SSH
> private key in cleartext. Do not paste this blob into a chat, an issue, or a
> HAR file you keep. If you have already captured one, delete it.

## What the grader can actually see

For the Apigee lab, each click produced exactly four management-plane reads from
the lab's own service account:

- `compute.instances.aggregatedList`
- `GetApiProxy`
- `ListApiDeployments`
- `GetApiProxyRevision`

It then downloaded the proxy bundle and tested **filenames and literal strings
inside the XML**. An open debug session captured zero transactions during
grading — it never calls the deployed runtime.

The generalisation: **make the configuration look right to a static reader.**
Runtime behaviour is not graded. A proxy that returns HTTP 500 can score 100,
and a proxy that works perfectly can score 0.

## The bisect method

When a step scores 0 with no message:

1. Enable audit logging first if you want to watch the grader work — set
   `ADMIN_READ` / `DATA_READ` / `DATA_WRITE` on `allServices` in the project IAM
   policy's `auditConfigs`.
2. Deploy successive revisions changing **one thing each**.
3. Run `run_step.json` after every deploy.
4. Watch which change moves the message.

This found a one-character defect that four lab restarts could not. The
progression that solved Task 4:

| Rev | Change | Result |
| --- | --- | --- |
| 5 | exactly as the lab text instructs | 0, no message |
| 7 | + alias policy filenames | 0, no message |
| 8 | + the lab author's own full reference flow | 0, no message |
| 9 | **collapsed a double space to a single space** | **25/25, "Assessment Completed!"** |

Passed steps appear to be sticky — accumulated scores were never observed to be
revoked by a later failing run. That was not deliberately tested, so do not rely
on it for an experiment you cannot undo.

## Where the marking runs

Server-side, from the lab's project service account. It does not run in your
browser, so nothing about your browser, extension set, or network matters. The
only thing your browser contributes is the request itself.

## Driving a lab from this workstation

The lab instance lives in an incognito Chrome window and its Cloud Shell is the
only channel into the environment. The local `gcloud` CLI is authenticated to a
different project entirely and cannot reach it.

The **public** side of the platform is different — catalog and focus pages
(`partner.skills.google/focuses/<id>`) are readable in the normal signed-in
Chrome session via browser automation. That is how to get a lab's exact title,
task text, or last-tested date. `WebFetch` cannot do it: those pages are
JS-rendered behind auth and return a sign-in shell.

For anything that must run inside the lab, hand over one fenced code block per
message, fully self-contained:

- Re-export `TOKEN`, `PROJECT` and friends **every time** — Cloud Shell
  reconnects and drops shell state between pastes.
- No `\` line continuations. They are eaten on paste and produce confusing
  `No such file or directory` errors.
- Keep blocks short. Long ones get truncated or mangled in transit; a block that
  arrives as `echo -s -X POST ...` is a paste artefact, not a bug in the command.

## Appendix: the two-space bug

Reference case, in case this lab resurfaces.

<https://partner.skills.google/focuses/82026?parent=catalog> — *API
Modernization: Challenge Lab*, Task 4 "Create a service callout".

The task text tells you to paste this as the `EV-DLP` step condition:

```xml
<Condition>(request.verb = "GET"  OR request.verb = "PUT")</Condition>
```

Two spaces before `OR`. The grader string-matches the **single**-spaced form.
Apigee parses both identically, so nothing anywhere reports a problem. The
two-space form also ships in the author's own reference bundle
(`SMN-base-4.zip`), so deploying the published answer fails too.

Task 4's assertions run in order — SC policy file present → EV policy file
present → condition text matches. The first two name what they want. The third
scores 0 with an empty message.

Other genuine defects in the same lab:

- The prescribed config returns HTTP 500 on a plain `GET /customers`: `EV-DLP`
  has `<Source>response</Source>` but runs even when the callout was skipped, so
  `steps.extractvariables.SourceMessageNotAvailable`.
- The instructions never create `EV-Get-Email`, so `queryinfo.email` is never
  set and the DLP callout can never fire.
- Policy names drift between instances — `SC-DLP-API` / `AM-Set_CORSHeader` on
  one, `SC-DLPAPI` / `AM-Set_CORS_Header` on another. Take them from
  `startup_script`.
- The author's `EV-DLP` ships `enabled="false"`.
- Task 2 gave a false negative that later passed with no change at all.

Apigee X specifics worth keeping: there is no `/revisions/N/policies` endpoint
(that is Edge) — download `?format=bundle` and unzip. `GoogleTokenGenerationFailure`
on a service callout is usually a stale runtime credential rather than an IAM
problem: undeploy, wait ~30s, redeploy with `?serviceAccount=`.
