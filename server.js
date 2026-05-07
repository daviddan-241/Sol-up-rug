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

function htmlPage(content) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>SOL Rug Panel (devnet)</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:30px auto;padding:0 16px} code,pre{background:#f4f4f4;padding:6px 8px;border-radius:6px} button{padding:8px 12px} input{padding:6px 8px;margin:4px 0;width:100%} .card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}</style>
  </head><body>
  <h2>SOL Rug Control Panel (devnet)</h2>
  <p>Wallet: <code>${payer.publicKey.toBase58()}</code></p>
  <p>Service Fee: <code>${FEE_USD || FEE_SOL_OVERRIDE ? (FEE_USD ? ('$' + FEE_USD) : (FEE_SOL_OVERRIDE + ' SOL')) : 'none'}</code>
  ${OPERATOR_PUBKEY ? '(to ' + (OPERATOR_PUBKEY.toBase58()) + ')' : ''}</p>
  <div class="card">
    <h3>Status</h3>
    <form method="get" action="/status"><button type="submit">Refresh Status</button></form>
  </div>
  <div class="card">
    <h3>Quick Controls</h3>
    <form method="post" action="/create-mint"><button type="submit">Create Mint (defaults)</button></form>
    <form method="post" action="/mint" style="margin-top:6px"><input type="hidden" name="amount" value="100000"/><button type="submit">Mint 100k</button></form>
    <form method="post" action="/revoke-mint-authority" style="margin-top:6px"><button type="submit">Revoke Mint Authority</button></form>
  </div>
  <div class="card">
    <h3>Create SPL Token (Mint)</h3>
    <form method="post" action="/create-mint">
      <label>Decimals (0-9)<input name="decimals" value="9"/></label>
      <label>Initial Supply (whole tokens)<input name="initial" value="1000000000"/></label>
      <label>Keep Freeze Authority?<select name="keepFreeze"><option value="true">true</option><option value="false">false</option></select></label>
      <button type="submit">Create Mint</button>
    </form>
  </div>
  <div class="card">
    <h3>Mint More Tokens</h3>
    <form method="post" action="/mint">
      <label>Amount (whole tokens)<input name="amount" value="1000000"/></label>
      <button type="submit">Mint</button>
    </form>
  </div>
  <div class="card">
    <h3>Revoke Mint Authority (optics)</h3>
    <form method="post" action="/revoke-mint-authority"><button type="submit">Revoke</button></form>
  </div>
  <div class="card">
    <h3>Transfer Tokens</h3>
    <form method="post" action="/transfer-token">
      <label>Destination Wallet<input name="to" placeholder="Destination public key"/></label>
      <label>Amount (whole tokens)<input name="amount" value="1000"/></label>
      <button type="submit">Send Tokens</button>
    </form>
  </div>
  <div class="card">
    <h3>Freeze/Thaw Holder</h3>
    <form method="post" action="/freeze">
      <label>Holder Wallet<input name="holder" placeholder="Public key to freeze"/></label>
      <button type="submit">Freeze</button>
    </form>
    <form method="post" action="/thaw" style="margin-top:8px">
      <label>Holder Wallet<input name="holder" placeholder="Public key to thaw"/></label>
      <button type="submit">Thaw</button>
    </form>
  </div>
  <div class="card">
    <h3>Sweep Funds</h3>
    <form method="post" action="/sweep">
      <label>Destination Wallet<input name="to" placeholder="Destination public key"/></label>
      <button type="submit">Sweep All SOL + Tokens</button>
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
  const out = { wallet: payer.publicKey.toBase58(), sol: solBal / LAMPORTS_PER_SOL, token: tokenInfo };
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    res.json(out);
  } else {
    res.send(htmlPage(`<pre>${JSON.stringify(out, null, 2)}</pre>`));
  }
});

app.post('/create-mint', async (req, res) => {
  try {
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
