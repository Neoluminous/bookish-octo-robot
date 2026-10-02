# Funding Ready setup

## Start

Use Node.js 20 or newer. Run `npm install`, then `npm run dev`. The server listens on `PORT` (default `3000`), and the app is available at `http://localhost:3000/FundingReady/`. The admin page is `/FundingReady/admin`.

By default, development data is written to the ignored `data-dev/` directory. Start with empty storage by using a new empty `DATA_DIR` path. Do not copy production records into development or test storage. A cloud deployment must mount persistent private storage and set `DATA_DIR` to that directory. Store the uploads directory there as well; it is never served statically.

## Environment

Set these in the hosting environment, not in source control:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `DATA_DIR` | Private persistent storage; defaults to ignored `data-dev/` |
| `ADMIN_EMAIL` | Explicit admin sign-in email |
| `ADMIN_PASSWORD` | Long unique admin password; login is disabled when absent |
| `REVIEWER_EMAIL` | Optional account to which applicants may grant restricted evidence access |

The admin signs in and configures the UPI payee and ID in payment settings. With no configuration, the payment page says payments are unavailable. No payment destination is built into the code. There is no simulated payment mode. Payment submissions stay pending until an authenticated admin verifies or rejects them. The admin copies a one-time assessment link for the applicant after verification. The app does not send email automatically.

An admin may explicitly grant complimentary access using the manual access form. That creates a separate manual record without a fake transaction reference. Access links are single-use. The applicant's browser receives a bounded access cookie on redemption.

Legacy sessions and access links created before this change are intentionally invalidated because older session and link records were committed to Git. An admin must reissue links for any affected applicants. Existing assessment drafts remain in private storage and reopen through the new verified access session.

Applicants can save drafts, resume on the same browser, review applicable answers, and submit. A report becomes downloadable from the assessment page after an admin uploads a reviewed PDF. A reviewer may enter a score; no score or expert findings are generated automatically. The review moves to `delivered` when the applicant downloads the report. The app records no email delivery event.

## Checks

Run `npm test` for synthetic security and workflow tests and `npm run build` for type and syntax checks. Test storage is created in temporary directories and deleted afterward.

## Historical data exposure

An earlier commit in the repository tracked applicant, payment, access-token, and session JSON under `data/`. This branch stops tracking those files and ignores runtime storage, without deleting local copies or rewriting history. **Removing files from the latest commit does not remove prior Git history or any copies already fetched.** The repository owner should assess who could access that history, rotate any credentials or active links and sessions represented there, contact affected people as appropriate, and arrange a separate history-remediation process if warranted. Do not paste those records into issues or logs.

## Legal wording sources

The questionnaire does not determine legal applicability or statutory thresholds. Where applicability is uncertain, it asks for reviewer confirmation. The following official sources informed the neutral wording:

- [Income Tax Department forms page](https://www.incometax.gov.in/iec/foportal/downloads/income-tax-forms): lists Forms 10B and 10BB as distinct audit reports.
- [FCRA online FAQ](https://fcraonline.nic.in/home/PDF_Doc/fc_faq_04102022.pdf): distinguishes registration and prior permission applications.
- [Ministry of Corporate Affairs CSR FAQ](https://www.mca.gov.in/Ministry/pdf/FAQ_CSR.pdf): explains CSR implementing-agency registration and CSR-1.

Reviewers should verify current requirements for each organisation and funding context before giving legal advice.
