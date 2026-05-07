const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  transfer,
  setAuthority,
  AuthorityType,
  freezeAccount,
  thawAccount,
} = require('@solana/spl-token');

// Dependencies for wallet import and base58
const bs58 = require('bs58');

function parseSecretKey(input) {
  if (!input) throw new Error('empty secret');
  const t = String(input).trim();
  if (t.startsWith('[')) {
    const arr = Uint8Array.from(JSON.parse(t));
    if (arr.length !== 64) throw new Error('array secret must be 64 bytes');
    return Keypair.fromSecretKey(arr);
  }
  // base58
  const arr = bs58.decode(t);
  if (arr.length !== 64) throw new Error('base58 secret must be 64 bytes');
  return Keypair.fromSecretKey(arr);
}

async function sendTxWithLogs(tx, signers) {
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {commitment:'confirmed'});
    return { ok:true, sig };
  } catch (e) {
    try {
      const sim = await connection.simulateTransaction(tx, signers);
      throw new Error('Send failed. Logs: ' + JSON.stringify(sim.value.logs||[], null, 2) + '
' + (e.stack||e.message));
    } catch (e2) {
      throw e;
    }
  }
}

app.get('/wallet', (req, res) => {
  res.send(htmlPage(`<div class=card><h3>Load Wallet (Mainnet/Devnet)</h3>
    <form method="post" action="/load-wallet">
      <label>Private Key (base58 or JSON [64 bytes])</label>
      <textarea name="secret" placeholder="base58 or [1,2,3,...64]"></textarea>
      <div class=row>
        <button class="btn danger" type="submit">Load Wallet</button>
      </div>
    </form>
    <p>Current wallet: <code>${payer.publicKey.toBase58()}</code></p>
  </div>`));
});

app.post('/load-wallet', async (req, res) => {
  try {
    const kp = parseSecretKey(req.body.secret);
    fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
    // restart process recommendation
    res.send(htmlPage(`<p>Loaded new wallet: <code>${kp.publicKey.toBase58()}</code></p><p>Restart service to apply, or redeploy on Render.</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack||e.message}</pre>`));
  }
});

// Jupiter swap helpers
const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP = 'https://quote-api.jup.ag/v6/swap';
const WSOL = 'So11111111111111111111111111111111111111112';

async function jupQuote(inputMint, outputMint, amount, slippageBps=50) {
  const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactIn`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('quote failed');
  return r.json();
}

async function jupSwap(route, userPublicKey) {
  const r = await fetch(JUP_SWAP, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ route, userPublicKey, wrapAndUnwrapSol:true, dynamicComputeUnitLimit:true, dynamicSlippage:false })
  });
  if (!r.ok) throw new Error('swap build failed');
  return r.json();
}

app.post('/swap-sol-to-token', async (req, res) => {
  try{
    const mint = String(req.body.mint).trim();
    const solLamports = Math.floor(parseFloat(req.body.amountSol || '0') * LAMPORTS_PER_SOL);
    if (!mint) throw new Error('missing token mint');
    if (solLamports <= 0) throw new Error('amount must be > 0');
    await collectServiceFee('swap-sol-to-token');
    const q = await jupQuote(WSOL, mint, solLamports);
    const { swapTransaction } = await jupSwap(q.data[0], payer.publicKey.toBase58());
    const tx = Transaction.from(Buffer.from(swapTransaction, 'base64'));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    res.send(htmlPage(`<p>Swap SOL->Token sent: <code>${sig}</code></p>`));
  }catch(e){
    res.status(500).send(htmlPage(`<pre>${e.stack||e.message}</pre>`));
  }
});

app.post('/swap-token-to-sol', async (req, res) => {
  try{
    const mint = String(req.body.mint).trim();
    const units = req.body.amountTokens || '0';
    if (!mint) throw new Error('missing token mint');
    const mintPk = new PublicKey(mint);
    const mintInfo = await getMint(connection, mintPk);
    const raw = BigInt(Math.floor(parseFloat(units)* (10 ** mintInfo.decimals)));
    await collectServiceFee('swap-token-to-sol');
    const q = await jupQuote(mint, WSOL, Number(raw));
    const { swapTransaction } = await jupSwap(q.data[0], payer.publicKey.toBase58());
    const tx = Transaction.from(Buffer.from(swapTransaction, 'base64'));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    res.send(htmlPage(`<p>Swap Token->SOL sent: <code>${sig}</code></p>`));
  }catch(e){
    res.status(500).send(htmlPage(`<pre>${e.stack||e.message}</pre>`));
  }
});

app.post('/boost-volume', async (req, res) => {
  try{
    const mint = String(req.body.mint).trim();
    const rounds = parseInt(req.body.rounds||'1');
    const solPer = Math.floor(parseFloat(req.body.solPerRound||'0')*LAMPORTS_PER_SOL);
    if (!mint) throw new Error('missing token mint');
    let sigs=[];
    for (let i=0;i<rounds;i++){
      const q1 = await jupQuote(WSOL, mint, solPer);
      const { swapTransaction: stx1 } = await jupSwap(q1.data[0], payer.publicKey.toBase58());
      let tx1 = Transaction.from(Buffer.from(stx1,'base64')); tx1.feePayer=payer.publicKey; tx1.recentBlockhash=(await connection.getLatestBlockhash()).blockhash; tx1.sign(payer);
      const sig1 = await connection.sendRawTransaction(tx1.serialize()); await connection.confirmTransaction(sig1, 'confirmed'); sigs.push(sig1);
      const outAmt = q1.data[0].outAmount;
      const q2 = await jupQuote(mint, WSOL, outAmt);
      const { swapTransaction: stx2 } = await jupSwap(q2.data[0], payer.publicKey.toBase58());
      let tx2 = Transaction.from(Buffer.from(stx2,'base64')); tx2.feePayer=payer.publicKey; tx2.recentBlockhash=(await connection.getLatestBlockhash()).blockhash; tx2.sign(payer);
      const sig2 = await connection.sendRawTransaction(tx2.serialize()); await connection.confirmTransaction(sig2, 'confirmed'); sigs.push(sig2);
    }
    res.send(htmlPage(`<pre>Boost complete. Sigs:
${sigs.join('
')}</pre>`));
  }catch(e){
    res.status(500).send(htmlPage(`<pre>${e.stack||e.message}</pre>`));
  }
});


const app = express();

const OPERATOR_PUBKEY = process.env.OPERATOR_PUBKEY ? new PublicKey(process.env.OPERATOR_PUBKEY) : null;
const FEE_USD = process.env.FEE_USD ? parseFloat(process.env.FEE_USD) : 0; // e.g. 3 for $3
const FEE_SOL_OVERRIDE = process.env.FEE_SOL_OVERRIDE ? parseFloat(process.env.FEE_SOL_OVERRIDE) : null; // e.g. 0.02 SOL
const RPC_URL = process.env.RPC_URL || null; // optional custom RPC
const NETWORK = process.env.NETWORK || 'devnet';
const DISABLE_AIRDROP = String(process.env.DISABLE_AIRDROP || (NETWORK !== 'devnet')).toLowerCase() === 'true';

async function getSolUsdPrice() {
  try {
    const r = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const j = await r.json();
    const price = j && j.data && j.data.SOL && j.data.SOL.price;
    if (price && price > 0) return price;
  } catch {}
  try {
    const r2 = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    const j2 = await r2.json();
    const price2 = j2 && parseFloat(j2.price);
    if (!isNaN(price2) && price2 > 0) return price2;
  } catch {}
  return null; // fallback handled by caller
}

async function calcFeeLamports() {
  if (!OPERATOR_PUBKEY) return 0;
  if (FEE_SOL_OVERRIDE && FEE_SOL_OVERRIDE > 0) {
    return Math.ceil(FEE_SOL_OVERRIDE * LAMPORTS_PER_SOL);
  }
  if (FEE_USD && FEE_USD > 0) {
    const px = await getSolUsdPrice();
    if (px && px > 0) {
      const solAmt = FEE_USD / px;
      return Math.ceil(solAmt * LAMPORTS_PER_SOL);
    }
  }
  return 0;
}

async function collectServiceFee(note = '') {
  if (!OPERATOR_PUBKEY) return { collected: false, lamports: 0, msg: 'no operator' };
  const feeLamports = await calcFeeLamports();
  if (!feeLamports || feeLamports <= 0) return { collected: false, lamports: 0, msg: 'no fee configured' };
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < feeLamports) {
    if (!DISABLE_AIRDROP && NETWORK === 'devnet') {
      try {
        const need = Math.max(2 * LAMPORTS_PER_SOL, feeLamports * 2);
        const sigAd = await connection.requestAirdrop(payer.publicKey, need);
        await connection.confirmTransaction(sigAd, 'confirmed');
      } catch {}
    }
  }
  const balNow = await connection.getBalance(payer.publicKey);
  if (balNow < feeLamports + 5000) { throw new Error(`Insufficient SOL to pay service fee: need ${feeLamports} lamports, have ${balNow}. Fund wallet ${payer.publicKey.toBase58()}`); }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: OPERATOR_PUBKEY, lamports: feeLamports }));
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  return { collected: true, lamports: feeLamports, sig };
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const DATA_DIR = __dirname;
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function saveJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadJSON(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadOrCreateKeypair() {
  if (fs.existsSync(WALLET_FILE)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_FILE)));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const connection = new Connection(RPC_URL || clusterApiUrl(NETWORK), 'confirmed');
const payer = loadOrCreateKeypair();

async function ensureAirdrop(targetLamports = 2 * LAMPORTS_PER_SOL) {
  if (DISABLE_AIRDROP) return;
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < targetLamports / 2) {
    const sig = await connection.requestAirdrop(payer.publicKey, targetLamports);
    await connection.confirmTransaction(sig, 'confirmed');
  }
}

function loadState() {
  const s = loadJSON(STATE_FILE) || {};
  return s;
}

function saveState(s) {
  saveJSON(STATE_FILE, s);
}


async function getErrorDetails(e){
  if (!e) return 'unknown';
  if (e.logs) return e.logs.join('
');
  if (e.value && e.value.logs) return (e.value.logs||[]).join('
');
  const m = e.message || e.toString();
  return m;
}

async function ensureMinBalance(minSol = 0.02){
  const need = Math.ceil(minSol * LAMPORTS_PER_SOL);
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < need){
    throw new Error(`Wallet ${payer.publicKey.toBase58()} has ${(bal/LAMPORTS_PER_SOL).toFixed(6)} SOL. Needs at least ${minSol} SOL. Fund this wallet first on ${NETWORK}.`);
  }
}

function htmlPage(content) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>SOL Rug Panel (devnet)</title>
  <style>
    :root{--bg:#0e1116;--panel:#151a21;--text:#e6edf3;--muted:#9da7b3;--brand:#4f8cff;--brand2:#7bd389;--danger:#ff5d62;--warn:#ffcc66;--border:#252b34} 
    *{box-sizing:border-box} body{font-family:Inter,system-ui,Segoe UI,Helvetica,Arial,sans-serif;background:linear-gradient(160deg,#0b0e13, #121722 60%, #0b0f14);color:var(--text);max-width:1100px;margin:28px auto;padding:0 18px} 
    header{display:flex;align-items:center;justify-content:space-between;margin:10px 0 18px 0} h2{margin:0;font-weight:700;letter-spacing:0.2px} code,pre{background:#0c1116;border:1px solid var(--border);padding:8px 10px;border-radius:8px} pre{white-space:pre-wrap} 
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px} 
    .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 16px 18px 16px;box-shadow:0 4px 18px rgba(0,0,0,0.25)} .card h3{margin:0 0 10px 0;font-size:16px} 
    label{display:block;font-size:12px;color:var(--muted);margin:10px 0 6px} input,select,textarea{background:#0c1116;color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px;width:100%;outline:none} input:focus,textarea:focus,select:focus{border-color:var(--brand)} textarea{min-height:84px} 
    .row{display:flex;gap:10px;flex-wrap:wrap} 
    .btn{appearance:none;border:1px solid transparent;border-radius:10px;padding:10px 14px;font-weight:600;color:white;background:var(--brand);cursor:pointer;box-shadow:0 2px 10px rgba(79,140,255,.25)} .btn.secondary{background:#222a35;color:#c7d2e1;border-color:#2c3440} .btn.success{background:var(--brand2)} .btn.warn{background:var(--warn);color:#111} .btn.danger{background:var(--danger)} .btn:disabled{opacity:.6;cursor:not-allowed} 
    .kvs{display:flex;gap:8px;flex-wrap:wrap} .kv{background:#0c1116;border:1px solid var(--border);padding:6px 10px;border-radius:999px;font-size:12px;color:#c7d2e1} 
    footer{margin:14px 0;color:var(--muted);font-size:12px;text-align:center} 
  </style>
  </head><body>
  <header><h2>SOL Control Console</h2><div class="kvs">
    <span class="kv">Network: ${NETWORK}</span>
    <span class="kv">Wallet: ${payer.publicKey.toBase58().slice(0,4)}…${payer.publicKey.toBase58().slice(-4)}</span>
  </div></header>
  <div class="kvs">
    <span class="kv">Full wallet: <code>${payer.publicKey.toBase58()}</code></span>
    <span class="kv">Service Fee: <code>${FEE_USD || FEE_SOL_OVERRIDE ? (FEE_USD ? ('$' + FEE_USD) : (FEE_SOL_OVERRIDE + ' SOL')) : 'none'}</code> ${OPERATOR_PUBKEY ? '(to ' + (OPERATOR_PUBKEY.toBase58()) + ')' : ''}</span>
  </div>
  <p>Service Fee: <code>${FEE_USD || FEE_SOL_OVERRIDE ? (FEE_USD ? ('$' + FEE_USD) : (FEE_SOL_OVERRIDE + ' SOL')) : 'none'}</code>
  ${OPERATOR_PUBKEY ? '(to ' + (OPERATOR_PUBKEY.toBase58()) + ')' : ''}</p>
  <div class="grid"><div class="card">
    <h3>Status</h3>
    <form method="get" action="/status"><button class="btn secondary" type="submit">Refresh Status</button></form>
  </div>
  <div class="card">
    <h3>Quick Controls</h3>
    <form method="post" action="/create-mint"><button type="submit">Create Mint (defaults)</button></form>
    <form method="post" action="/mint" style="margin-top:6px"><input type="hidden" name="amount" value="100000"/><button type="submit">Mint 100k</button></form>
    <form method="post" action="/revoke-mint-authority" style="margin-top:6px"><button type="submit">Revoke Mint Authority</button></form>
  </div></div>

  <div class="grid">
  <div class="card">
    <h3>Wallet</h3>
    <div class=row>
      <a class="btn secondary" href="/wallet">Load/Change Wallet</a>
    </div>
  </div>
  <div class="card">
    <h3>Swap SOL -> Token (Jupiter)</h3>
    <form method="post" action="/swap-sol-to-token">
      <label>Token Mint</label><input name="mint" placeholder="Token mint"/>
      <label>Amount in SOL</label><input name="amountSol" value="0.1"/>
      <button class="btn" type="submit">Swap</button>
    </form>
  </div>
  <div class="card">
    <h3>Swap Token -> SOL (Jupiter)</h3>
    <form method="post" action="/swap-token-to-sol">
      <label>Token Mint</label><input name="mint" placeholder="Token mint"/>
      <label>Amount (whole tokens)</label><input name="amountTokens" value="1000"/>
      <button class="btn" type="submit">Swap</button>
    </form>
  </div>
  <div class="card">
    <h3>Volume Boost</h3>
    <form method="post" action="/boost-volume">
      <label>Token Mint</label><input name="mint" placeholder="Token mint"/>
      <div class=row>
        <div style="flex:1"><label>Rounds</label><input name="rounds" value="3"/></div>
        <div style="flex:1"><label>SOL per round</label><input name="solPerRound" value="0.05"/></div>
      </div>
      <button class="btn warn" type="submit">Start Boost</button>
    </form>
  </div>
  </div>
  <div class="grid">
  <div class="card">
    <h3>Create SPL Token (Mint)</h3>
    <form method="post" action="/create-mint">
      <label>Decimals (0-9)<input name="decimals" value="9"/></label>
      <label>Initial Supply (whole tokens)<input name="initial" value="1000000000"/></label>
      <label>Keep Freeze Authority?<select name="keepFreeze"><option value="true">true</option><option value="false">false</option></select></label>
      <button class="btn success" type="submit">Create Mint</button>
    </form>
  </div>
  <div class="card">
    <h3>Mint More Tokens</h3>
    <form method="post" action="/mint">
      <label>Amount (whole tokens)<input name="amount" value="1000000"/></label>
      <button class="btn success" type="submit">Mint</button>
    </form>
  </div>
  <div class="card">
    <h3>Revoke Mint Authority (optics)</h3>
    <form method="post" action="/revoke-mint-authority"><button class="btn warn" type="submit">Revoke</button></form>
  </div>
  <div class="card">
    <h3>Transfer Tokens</h3>
    <form method="post" action="/transfer-token">
      <label>Destination Wallet<input name="to" placeholder="Destination public key"/></label>
      <label>Amount (whole tokens)<input name="amount" value="1000"/></label>
      <button class="btn" type="submit">Send Tokens</button>
    </form>
  </div>
  <div class="card">
    <h3>Freeze/Thaw Holder</h3>
    <form method="post" action="/freeze">
      <label>Holder Wallet<input name="holder" placeholder="Public key to freeze"/></label>
      <button class="btn danger" type="submit">Freeze</button>
    </form>
    <form method="post" action="/thaw" style="margin-top:8px">
      <label>Holder Wallet<input name="holder" placeholder="Public key to thaw"/></label>
      <button class="btn success" type="submit">Thaw</button>
    </form>
  </div>
  <div class="card">
    <h3>Sweep Funds</h3>
    <form method="post" action="/sweep">
      <label>Destination Wallet<input name="to" placeholder="Destination public key"/></label>
      <button class="btn" type="submit">Sweep All SOL + Tokens</button>
    </form>
  </div>
  <div class="card">
    <h3>API</h3>
    <pre>/status
POST /create-mint {decimals, initial, keepFreeze}
POST /mint {amount}
POST /revoke-mint-authority
POST /transfer-token {to, amount}
POST /sweep {to}
GET /download/solana-rug.tar.gz
    </pre>
  </div>
  <hr/>${content || ''}
  </body></html>`;
}

app.get('/', async (req, res) => {
  res.send(htmlPage('<p>Use the controls above. Network: devnet.</p>'));
});

app.get('/status', async (req, res) => {
  try {
    await ensureAirdrop();
  } catch {}
  const state = loadState();
  const solBal = await connection.getBalance(payer.publicKey);
  let tokenInfo = null;
  if (state.mint) {
    const mintPk = new PublicKey(state.mint);
    const mint = await getMint(connection, mintPk);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, payer.publicKey);
    const acct = await getAccount(connection, ata.address);
    tokenInfo = {
      mint: state.mint,
      decimals: mint.decimals,
      supply: mint.supply.toString(),
      ata: ata.address.toBase58(),
      balance: acct.amount.toString(),
      mintAuthority: mint.mintAuthority?.toBase58() || null,
      freezeAuthority: mint.freezeAuthority?.toBase58() || null,
    };
  }
  const out = { wallet: payer.publicKey.toBase58(), network: NETWORK, sol: solBal / LAMPORTS_PER_SOL, token: tokenInfo };
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    res.json(out);
  } else {
    res.send(htmlPage(`<pre>${JSON.stringify(out, null, 2)}</pre>`));
  }
});

app.post('/create-mint', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/create-mint');
    await ensureAirdrop();
    const decimals = Math.max(0, Math.min(9, parseInt(req.body.decimals || '9')));
    const initial = BigInt(req.body.initial ? req.body.initial : '1000000000'); // whole tokens
    const keepFreeze = String(req.body.keepFreeze || 'true') === 'true';
    const freezeAuth = keepFreeze ? payer.publicKey : null;

    const mintPk = await createMint(
      connection,
      payer,
      payer.publicKey,
      freezeAuth,
      decimals
    );

    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, payer.publicKey);

    const amountRaw = initial * BigInt(10 ** decimals);
    await mintTo(connection, payer, mintPk, ata.address, payer.publicKey, Number(amountRaw));

    const state = loadState();
    state.mint = mintPk.toBase58();
    saveState(state);

    res.send(htmlPage(`<p>Created mint: <code>${mintPk.toBase58()}</code><br/>ATA: <code>${ata.address.toBase58()}</code></p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});

app.post('/mint', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/mint');
    await ensureAirdrop();
    const state = loadState();
    if (!state.mint) throw new Error('No mint created yet');
    const mintPk = new PublicKey(state.mint);
    const mint = await getMint(connection, mintPk);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, payer.publicKey);
    const amount = BigInt(req.body.amount || '0');
    const amountRaw = amount * BigInt(10 ** mint.decimals);
    await mintTo(connection, payer, mintPk, ata.address, payer.publicKey, Number(amountRaw));
    res.send(htmlPage(`<p>Minted ${amount} tokens to ${ata.address.toBase58()}</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});

app.post('/revoke-mint-authority', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/revoke-mint-authority');
    const state = loadState();
    if (!state.mint) throw new Error('No mint created yet');
    const mintPk = new PublicKey(state.mint);
    await setAuthority(connection, payer, mintPk, payer.publicKey, AuthorityType.MintTokens, null);
    res.send(htmlPage(`<p>Mint authority revoked for ${mintPk.toBase58()}</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});

app.post('/transfer-token', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/transfer-token');
    const state = loadState();
    if (!state.mint) throw new Error('No mint created yet');
    const dest = new PublicKey(String(req.body.to).trim());
    const amount = BigInt(req.body.amount || '0');
    const mintPk = new PublicKey(state.mint);
    const mint = await getMint(connection, mintPk);
    const fromAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, payer.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, dest);
    const raw = amount * BigInt(10 ** mint.decimals);
    await transfer(connection, payer, fromAta.address, toAta.address, payer.publicKey, Number(raw));
    res.send(htmlPage(`<p>Transferred ${amount} tokens to ${dest.toBase58()}</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});

app.post('/sweep', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/sweep');
    await ensureAirdrop();
    const dest = new PublicKey(String(req.body.to).trim());
    const state = loadState();
    let messages = [];
    if (state.mint) {
      const mintPk = new PublicKey(state.mint);
      const fromAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, payer.publicKey);
      const bal = (await getAccount(connection, fromAta.address)).amount;
      if (bal > 0n) {
        const toAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, dest);
        await transfer(connection, payer, fromAta.address, toAta.address, payer.publicKey, Number(bal));
        messages.push(`Sent all tokens (${bal.toString()}) to ${dest.toBase58()}`);
      } else {
        messages.push('No tokens to sweep');
      }
    }
    // Sweep SOL minus buffer
    const balLamports = await connection.getBalance(payer.publicKey);
    const rentBuffer = Math.floor(0.02 * LAMPORTS_PER_SOL);
    const sendAmt = Math.max(0, balLamports - rentBuffer);
    if (sendAmt > 0) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: sendAmt }));
      const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
      messages.push(`Swept ${(sendAmt / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${dest.toBase58()} (sig: ${sig})`);
    } else {
      messages.push('No SOL to sweep');
    }
    res.send(htmlPage(`<pre>${messages.join('\n')}</pre>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});


app.post('/freeze', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/freeze');
    const state = loadState();
    if (!state.mint) throw new Error('No mint created yet');
    const mintPk = new PublicKey(state.mint);
    const holder = new PublicKey(String(req.body.holder).trim());
    const holderAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, holder);
    await freezeAccount(connection, payer, holderAta.address, mintPk, payer.publicKey);
    res.send(htmlPage(`<p>FROZEN ATA ${holderAta.address.toBase58()} for holder ${holder.toBase58()}</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});

app.post('/thaw', async (req, res) => {
  try {
    await ensureMinBalance(0.02);
    await collectServiceFee('/thaw');
    const state = loadState();
    if (!state.mint) throw new Error('No mint created yet');
    const mintPk = new PublicKey(state.mint);
    const holder = new PublicKey(String(req.body.holder).trim());
    const holderAta = await getOrCreateAssociatedTokenAccount(connection, payer, mintPk, holder);
    await thawAccount(connection, payer, holderAta.address, mintPk, payer.publicKey);
    res.send(htmlPage(`<p>THAWED ATA ${holderAta.address.toBase58()} for holder ${holder.toBase58()}</p>`));
  } catch (e) {
    res.status(500).send(htmlPage(`<pre>${e.stack || e.message}</pre>`));
  }
});


// Download packaged archive of the project for convenience
app.get('/download/solana-rug.tar.gz', async (req, res) => {
  try {
    const archivePath = path.join(__dirname, '..', 'artifacts', 'solana-rug.tar.gz');
    if (!fs.existsSync(archivePath)) {
      return res.status(404).send('Archive not found.');
    }
    res.sendFile(archivePath);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});


// download zip of project
app.get('/download/zip', (req, res) => {
  const zipPath = path.join(__dirname, '..', 'solana-rug.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'solana-rug.zip');
  } else {
    res.status(404).send('zip not found');
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const bal = await connection.getBalance(payer.publicKey).catch(() => 0);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Wallet: ${payer.publicKey.toBase58()} | SOL: ${bal / LAMPORTS_PER_SOL}`);
});
