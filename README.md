# Sol-up-rug (devnet)

Simple Express panel to create/mint/freeze/thaw SPL tokens on Solana devnet and sweep funds.

- Endpoint: `/status` (also JSON if Accept: application/json)
- POST: `/create-mint`, `/mint`, `/revoke-mint-authority`, `/transfer-token`, `/freeze`, `/thaw`, `/sweep`
- Zip download: `/download/zip`

Run locally:
- npm ci
- npm start

Deploy on Render:
- Connect the repo
- Render will detect render.yaml and create a Web Service
- Build: npm ci | Start: node server.js | Port: uses PORT env var
