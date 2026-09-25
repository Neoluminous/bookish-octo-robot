# NGO Compass Funding Ready — Google AI Studio export

This is the NGO Compass Funding Ready website currently used at:

- Public frontend: `https://ngocompass.com/FundingReady/`
- Admin panel: `https://ngocompass.com/FundingReady/admin`

The `site/` folder is the deployable website package. It includes the hashed frontend JavaScript/CSS bundles, animation behavior, images, payment and assessment UI bundles, PHP API, PHP admin panel, questions, and Apache rewrite rules.

## Deploy or preview

Serve `site/` as the `/FundingReady/` document root on a PHP-enabled host. Keep the data directory outside the public web root. The API and admin panel use the existing `ngo-compass-funding-ready-data` storage directory on production.

For Google AI Studio, import this ZIP and treat `site/index.html` as the public entry page. The exact bundled JavaScript and CSS are already built, so the interactive frontend and animations do not require a Node server.

## Important security setup

- `site/admin.php` contains a password-hash placeholder in this export. Set a secure hash before deployment; no plaintext password is included.
- Do not import or commit production payment, applicant, session, access, or order records.
- Preserve the existing `/FundingReady/` rewrite rules when mounting this package under a subpath.

## Included behavior

- NGO Compass funding-readiness landing page and animations
- Payment reference and UPI checkout flow
- Assessment flow and autosave API
- Results/report flow
- Admin payment review and assessment response dashboard
- Static assets, fonts references, favicon, social preview, questions, and rewrite rules
