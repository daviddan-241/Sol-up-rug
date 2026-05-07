# Sol-up-rug (devnet)

Simple Express panel to create/mint/freeze/thaw SPL tokens on Solana devnet and sweep funds.

- Endpoint: `/status` (also JSON if Accept: application/json)
- POST: `/create-mint`, `/mint`, `/revoke-mint-authority`, `/transfer-token`, `/freeze`, `/thaw`, `/sweep`
- Zip download: `/download/zip`

Run locally:
- npm ci
- npm start

Deploy on Render:

Environment variables:
- OPERATOR_PUBKEY: destination pubkey for service fees.
- FEE_USD: e.g. 3 to charge $3 per action.
- FEE_SOL_OVERRIDE: set instead of FEE_USD to charge a fixed SOL amount.
- NETWORK: devnet|mainnet-beta|testnet.
- RPC_URL: your mainnet RPC endpoint.
- DISABLE_AIRDROP: true on mainnet (default).
- Connect the repo
- Render will detect render.yaml and create a Web Service
- Build: npm ci | Start: node server.js | Port: uses PORT env var
