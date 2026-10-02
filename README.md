# Funding Ready

The local application is an Express server (`server.ts`) serving the plain JavaScript website in `site/` at `/FundingReady/`. Run it with `npm run dev`. The bundled files under `site/assets/` are an older unused export; the page loads `site/app-mtsvynal.js` and `site/questions-mtsvynal.js`.

For the existing PHP site at `ngocompass.com/FundingReady/`, use the Hostinger-compatible backend and packaging instructions in [hostinger/README.md](hostinger/README.md). Uploading the Express source directly to that directory will not run the API.

See [CLOUD-SETUP.md](CLOUD-SETUP.md) for environment variables, empty development storage, tests, payment setup, and admin access.
