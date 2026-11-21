# Issue #220: repository evidence record

**Snapshot date:** 2026-11-20 (UTC)  
**Scope:** Public GitHub repository metadata for PRs #214–#218 and Issue #220.

This record organizes repository facts relevant to the attribution concern in
[Issue #220](https://github.com/Orbit-xyz/Orbit/issues/220). It is not a finding
of copying, misconduct, authorship, or entitlement to program rewards. Creation
times and matching paths can inform review, but cannot establish who authored
particular code or why it was submitted.

## Pull request timeline

Times below are GitHub's public `created_at` and `merged_at` values in UTC.
Status and changed-file counts were checked on the snapshot date.

| PR | Author shown by GitHub | Created (UTC) | Status at snapshot | Changed files |
|---|---|---:|---|---:|
| [#214](https://github.com/Orbit-xyz/Orbit/pull/214) | `markankamaransheogarat-sys` | 2026-10-19 14:26:35 | Open | 0 reported |
| [#215](https://github.com/Orbit-xyz/Orbit/pull/215) | `markankamaransheogarat-sys` | 2026-10-19 15:45:11 | Open | 7 |
| [#216](https://github.com/Orbit-xyz/Orbit/pull/216) | `markankamaransheogarat-sys` | 2026-10-19 16:00:13 | Open | 9 |
| [#217](https://github.com/Orbit-xyz/Orbit/pull/217) | `markankamaransheogarat-sys` | 2026-10-19 17:04:19 | Open | 11 |
| [#218](https://github.com/Orbit-xyz/Orbit/pull/218) | `Aabidah-06` | 2026-10-19 21:43:45 | Merged at 21:45:54 | 21 |

GitHub reports a 2 minute 9 second interval between creation and merge of
PR #218. PRs #214–#217 were open at the time of this snapshot; their current
state does not, by itself, establish the state or review history at every
earlier point in time. The GitHub API reported zero changed files for PR #214
when checked, so this record does not infer a code comparison for that PR.

## Exact changed-path overlap

The following paths occur in the changed-file lists for both PR #218 and the
listed earlier PR. This is a filename comparison only; it is not a comparison
of patch contents or proof of code provenance.

**PR #215 and PR #218**

- `apps/backend/graphql.js`
- `apps/backend/index.js`
- `apps/backend/package-lock.json`
- `apps/backend/package.json`

**PR #216 and PR #218**

- `packages/checkout-widget/README.md`
- `packages/checkout-widget/package-lock.json`
- `packages/checkout-widget/package.json`
- `packages/checkout-widget/src/OrbitCheckout.jsx`
- `packages/checkout-widget/src/ReceiptView.jsx`
- `packages/checkout-widget/src/mobileHandover.js`
- `packages/checkout-widget/test/mobileHandover.test.js`

**PR #217 and PR #218**

- `apps/frontend/src/components/dashboard/views/payroll-view.tsx`

The comparison uses each pull request's public changed-file list:
[#215 files](https://github.com/Orbit-xyz/Orbit/pull/215/files),
[#216 files](https://github.com/Orbit-xyz/Orbit/pull/216/files),
[#217 files](https://github.com/Orbit-xyz/Orbit/pull/217/files), and
[#218 files](https://github.com/Orbit-xyz/Orbit/pull/218/files).

## Limits of this record

Repository metadata and path overlap cannot independently establish:

- who originated a particular implementation or whether one patch derived from
  another;
- the complete timing or contents of applications and decisions in the
  Stellar Wave/Drips system;
- whether the program's rules were followed, or how any points should be
  allocated; or
- whether a commit or contributor attribution should be amended.

Those questions require review of the actual commit and patch histories, the
applicable program records and rules, and input from the people and maintainers
involved. The public timeline above is intended to help that review, not
replace it.

## Requested maintainer review

1. Compare the relevant commits and patch contents across PRs #214–#218,
   including authorship metadata and branch history.
2. Verify any program application, acceptance, completion, and points records
   with the Stellar Wave/Drips administrators.
3. Determine whether any repository attribution correction is appropriate.
4. Record the maintainers' disposition and any follow-up actions on Issue #220.

