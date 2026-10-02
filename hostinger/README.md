# Funding Ready on Hostinger

The current public address is `https://ngocompass.com/FundingReady/`. This directory contains a PHP backend compatible with the existing Hostinger PHP/HTML site. Uploading the Node source alone would leave the assessment and admin workflows unavailable at that path.

## Release

Run `npm test` and `npm run build` in the repository, then validate the PHP files with `php -l`. Create a clean release directory with `node hostinger/package.mjs /absolute/new/release/path`. The output contains only the public site and the four PHP/Apache files. It excludes local records, credentials, dependencies, and Git metadata.

Before changing the live files, inspect the actual `/FundingReady/` document root and back it up. Keep the existing `ngo-compass-funding-ready-data` directory outside the public root. Upload the release contents to the existing `/FundingReady/` directory, preserving any unrelated server-owned files. Confirm the PHP version is 8.1 or newer, `mbstring` is available, and Apache rewrite rules work. Verify HTTPS, the public page, payment page, admin login, private file denial, access redemption, assessment save, and report download. Do not perform a real payment for a smoke test.

## Private configuration

The default private storage path is `/home/{account}/ngo-compass-funding-ready-data`; `DATA_DIR` can override it. Existing records and payment settings remain in that directory. The app must be able to create `payments`, `orders`, `access`, `sessions`, `uploads`, and `locks` beneath it. None belong in the public directory.

Admin sign-in requires an explicit `ADMIN_EMAIL` and either `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD` in the PHP environment. As a Hostinger alternative, put a private `admin-config.php` in the storage directory returning an array with `email` and `passwordHash`. Do not put this file or its values in the release or repository. Login stays disabled until configured. Set `REVIEWER_EMAIL` in the environment if an evidence-sharing account is available. Payment details come from the existing private `payment-settings.json` or from the admin settings form; no payee is built into the code.

Existing admin sessions are intentionally invalidated. Legacy payment records and private proof data remain in place. Before release, arrange a new explicit admin credential and confirm any active access links that must be reissued.
