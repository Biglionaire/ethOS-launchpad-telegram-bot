import 'dotenv/config';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* ===================== ENV ===================== */
const {
  BOT_TOKEN,
  TARGET_CHAT_ID,
  RPC_WSS,
  CHAIN_ID = '11155111',                 // 11155111 = Sepolia, 1 = Mainnet
  LAUNCHPAD_ADDRESS,
  ETHERSCAN_API_KEY,
  ETHOS_URL_TEMPLATE = 'https://ethos.vision/?t={CA}',
  CREATE_EVENT_NAMES = 'TokenCreated,Created,Launched,TokenLaunched',
  LOCK_EVENT_NAMES   = 'SettingsLocked,LiquidityLocked,MechanismLocked',
  FROM_BLOCK,                              // contoh: latest-50
  WETH_ADDRESS                             // opsional (bot auto-detect via Deposit event)
} = process.env;

if (!BOT_TOKEN || !TARGET_CHAT_ID || !RPC_WSS || !LAUNCHPAD_ADDRESS) {
  console.error('Missing required .env: BOT_TOKEN, TARGET_CHAT_ID, RPC_WSS, LAUNCHPAD_ADDRESS');
  process.exit(1);
}

/* =================== Telegram =================== */
const bot = new Telegraf(BOT_TOKEN);
const send = async (html, rows = null) => {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (rows && Array.isArray(rows)) extra.reply_markup = { inline_keyboard: rows };
  return bot.telegram.sendMessage(TARGET_CHAT_ID, html, extra);
};

/* =================== Provider =================== */
const provider = new ethers.WebSocketProvider(RPC_WSS, Number(CHAIN_ID));

/* ============== Etherscan ABI (optional) ============== */
const chainToApiBase = id =>
  String(id) === '1' ? 'https://api.etherscan.io/api'
  : String(id) === '11155111' ? 'https://api-sepolia.etherscan.io/api'
  : 'https://api.etherscan.io/api';

async function fetchAbi(address) {
  if (!ETHERSCAN_API_KEY) return null;
  try {
    const url = `${chainToApiBase(CHAIN_ID)}?module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data.status === '1') return JSON.parse(data.result);
    console.warn('Etherscan ABI fetch status!=1:', data?.message || data);
  } catch (err) {
    console.warn('Failed to fetch ABI:', err.message);
  }
  return null;
}

/* =================== Helpers ==================== */
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function topicToAddress(topic) { return ethers.getAddress('0x' + topic.slice(26)); }
function ethosUrlFor(token) { return ETHOS_URL_TEMPLATE.replace('{CA}', token); }

const ZERO32 = '0x' + '00'.repeat(32);
const abiCoder = ethers.AbiCoder.defaultAbiCoder();

const fmtETH = (wei) => ethers.formatEther(wei);
const fmtEthShort = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
};
const fmtUSD = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return v < 1000 ? v.toFixed(2)
       : v < 1_000_000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : (v/1e6).toFixed(2) + 'M';
};

async function fetchEthUsd() {
  try {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { timeout: 8000 }
    );
    return Number(data?.ethereum?.usd || 0);
  } catch {
    try {
      const { data } = await axios.get('https://api.coinbase.com/v2/prices/ETH-USD/spot', { timeout: 8000 });
      return Number(data?.data?.amount || 0);
    } catch { return 0; }
  }
}

/* =============== Topics / Signatures =============== */
const TRANSFER_TOPIC      = ethers.id('Transfer(address,address,uint256)');
const PAIR_CREATED_TOPIC  = ethers.id('PairCreated(address,address,address,uint256)');
const SYNC_TOPIC          = ethers.id('Sync(uint112,uint112)');
const MINT_TOPIC          = ethers.id('Mint(address,uint256,uint256)');
const DEPOSIT_TOPIC       = ethers.id('Deposit(address,uint256)');
const TOKEN_CREATED_TOPIC = '0xffc04f682c7b287e4b552dacd4b833d7c33dc0549cd6da84388408e4830c0562';
const SETTINGS_LOCKED_TOPICS = [
  ethers.id('SettingsLocked(address)'),
  ethers.id('LiquidityLocked(address)'),
  ethers.id('MechanismLocked(address)')
];

/* ========== ENV-driven lists (mapping/keys) ========== */
function envList(name, fallbackArr) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallbackArr;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
function envMapFuncs(name, fallbackArr) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallbackArr;
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(x => {
    const [fn, type='string'] = x.split(':').map(s=>s.trim());
    return { fn, type: (type==='bytes32'?'bytes32':'string') };
  });
}
const SOCIAL_KEYS = envList('SOCIAL_KEYS', ['website','twitter','telegram','discord']);
const SOCIALS_MAPPING_FUNCS = envMapFuncs('SOCIALS_MAPPING_FUNCS', [
  { fn:'links',   type:'string' },
  { fn:'socials', type:'string' },
  { fn:'urls',    type:'string' },
  { fn:'linkOf',  type:'string' },
  { fn:'links',   type:'bytes32' },
  { fn:'socials', type:'bytes32' },
]);

const MECH_UINT_KEYS = envList('MECH_UINT_KEYS', [
  'reflect','reflections_percent','reflection_percent','reflection',
  'liquidity_fee','auto_lp','auto_lp_share','lp_share','liquidity_share',
  'dev_fee','dev_share','developer_fee',
  'gamble','gamble_fee','gamble_share','gamble_percent',
  'buy_fee','sell_fee','tax_fee','total_fee',
  'burn_buy','burn_sell','max_daily_pump','death_time','reaper_period',
  'apy','apy_per_epoch','max_wallet','max_tx'
]);
const MECH_BOOL_KEYS = envList('MECH_BOOL_KEYS', [
  'reflect','eth_reflect','gamble','swap_enabled','antibot','trading_enabled'
]);
const MECH_MAPPING_UINT_FUNCS = envMapFuncs('MECH_MAPPING_UINT_FUNCS', [
  { fn:'fees',     type:'string' },
  { fn:'config',   type:'string' },
  { fn:'settings', type:'string' },
  { fn:'params',   type:'string' },
  { fn:'get',      type:'string' },
  { fn:'fees',     type:'bytes32' },
  { fn:'config',   type:'bytes32' },
  { fn:'settings', type:'bytes32' },
  { fn:'get',      type:'bytes32' },
]);
const MECH_MAPPING_BOOL_FUNCS = envMapFuncs('MECH_MAPPING_BOOL_FUNCS', [
  { fn:'flags',   type:'string' },
  { fn:'feature', type:'string' },
  { fn:'flags',   type:'bytes32' },
]);

/* ============== Generic contract calls ============== */
async function tryCallString(token, sig) {
  try {
    const iface = new ethers.Interface([`function ${sig}`]);
    const c = new ethers.Contract(token, iface, provider);
    const fn = sig.split('(')[0];
    const out = await c[fn]();
    if (typeof out === 'string' && out.trim()) return out.trim();
  } catch {}
  return null;
}
async function tryCallUint(token, sig) {
  try {
    const iface = new ethers.Interface([`function ${sig}`]);
    const c = new ethers.Contract(token, iface, provider);
    const fn = sig.split('(')[0];
    const out = await c[fn]();
    if (typeof out === 'bigint') return out;
    if (out != null) return BigInt(out.toString());
  } catch {}
  return null;
}
async function tryCallBool(token, sig) {
  try {
    const iface = new ethers.Interface([`function ${sig}`]);
    const c = new ethers.Contract(token, iface, provider);
    const fn = sig.split('(')[0];
    const out = await c[fn]();
    if (typeof out === 'boolean') return out;
  } catch {}
  return null;
}
async function tryCallMappingString(token, fnName, key, keyType='string') {
  try {
    const iface = new ethers.Interface([`function ${fnName}(${keyType}) view returns (string)`]);
    const c = new ethers.Contract(token, iface, provider);
    const arg = keyType==='bytes32' ? ethers.id(key) : key;
    const out = await c[fnName](arg);
    if (typeof out === 'string' && out.trim()) return out.trim();
  } catch {}
  return null;
}
async function tryCallMappingUint(token, fnName, key, keyType='string') {
  try {
    const iface = new ethers.Interface([`function ${fnName}(${keyType}) view returns (uint256)`]);
    const c = new ethers.Contract(token, iface, provider);
    const arg = keyType==='bytes32' ? ethers.id(key) : key;
    const out = await c[fnName](arg);
    if (out != null) return BigInt(out.toString());
  } catch {}
  return null;
}
async function tryCallMappingBool(token, fnName, key, keyType='string') {
  try {
    const iface = new ethers.Interface([`function ${fnName}(${keyType}) view returns (bool)`]);
    const c = new ethers.Contract(token, iface, provider);
    const arg = keyType==='bytes32' ? ethers.id(key) : key;
    const out = await c[fnName](arg);
    if (typeof out === 'boolean') return out;
  } catch {}
  return null;
}
async function tryCallTuple(token, sig, keys) {
  try {
    const iface = new ethers.Interface([`function ${sig}`]);
    const c = new ethers.Contract(token, iface, provider);
    const fn = sig.split('(')[0];
    const out = await c[fn]();
    const arr = Array.isArray(out) ? out : [out];
    const res = {};
    for (let i=0;i<Math.min(arr.length, keys.length);i++) {
      const v = arr[i];
      if (v == null) continue;
      if (typeof v === 'bigint') res[keys[i]] = v.toString();
      else if (typeof v === 'boolean') res[keys[i]] = v;
      else res[keys[i]] = String(v);
    }
    return res;
  } catch {}
  return {};
}

/* ================= Token basics ================= */
async function readTokenBasics(token) {
  const iface = new ethers.Interface([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)'
  ]);
  const c = new ethers.Contract(token, iface, provider);
  let name = '', symbol = '', decimals = 18, totalSupply = 0n;
  try { name = await c.name(); } catch {}
  try { symbol = await c.symbol(); } catch {}
  try { decimals = Number(await c.decimals()); } catch {}
  try { totalSupply = await c.totalSupply(); } catch {}
  return { name, symbol, decimals, totalSupply };
}

/* ================= Socials ================= */
function normalizeUrl(v, base) {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (base) return `${base}${v.replace(/^@/,'')}`;
  return v;
}
const isXUrl = u => /https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(String(u||''));
const isTgUrl = u => /https?:\/\/(t\.me|telegram(\.me|\.org))\//i.test(String(u||''));
const isDcUrl = u => /https?:\/\/(discord\.gg|discord(app)?\.com)\//i.test(String(u||''));

function classifyUrl(u) {
  const s = String(u || '').trim().toLowerCase();
  if (isXUrl(s)) return 'twitter';
  if (isTgUrl(s)) return 'telegram';
  if (isDcUrl(s)) return 'discord';
  if (/^https?:\/\//.test(s)) return 'website';
  return 'unknown';
}

function parseDataUrlToJson(s) {
  if (!/^data:application\/json/i.test(s)) return null;
  const base64 = s.split(',')[1];
  if (!base64) return null;
  try {
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch { return null; }
}
function parseMaybeJsonString(s) { try { return JSON.parse(s); } catch { return null; } }
async function fetchJsonMaybe(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  try { const { data } = await axios.get(url, { timeout: 12000 }); return data; } catch { return null; }
}

function pickSocialsFromJson(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const bag = {};
  const buckets = [
    obj, obj.links, obj.socials, obj.properties?.links, obj.properties?.socials,
    obj.attributes, obj.extensions, obj.metadata, obj.data
  ].filter(Boolean);
  for (const j of buckets) {
    for (const [k,v] of Object.entries(j)) {
      const kk = k.toLowerCase();
      const url = String(v || '');
      const t = classifyUrl(url);
      if (t === 'twitter' && !bag.twitter) bag.twitter = normalizeUrl(url);
      if (t === 'telegram' && !bag.telegram) bag.telegram = normalizeUrl(url);
      if (t === 'discord' && !bag.discord) bag.discord = normalizeUrl(url);
      if (t === 'website' && !bag.website) bag.website = normalizeUrl(url);
      if (!/^https?:\/\//i.test(url)) {
        if (['twitter','x'].includes(kk) && !bag.twitter) bag.twitter = normalizeUrl(url,'https://twitter.com/');
        if (['telegram','tg'].includes(kk) && !bag.telegram) bag.telegram = normalizeUrl(url,'https://t.me/');
        if (['website','site','homepage'].includes(kk) && !bag.website) bag.website = normalizeUrl(url);
      }
    }
  }
  return bag;
}

function extractAsciiStringsFromHex(hex) {
  if (!hex || hex.length < 10 || !hex.startsWith('0x')) return [];
  const buf = Buffer.from(hex.slice(2), 'hex');
  const out = [];
  let cur = [];
  for (const b of buf) {
    const ok = b >= 0x20 && b <= 0x7e;
    if (ok) cur.push(b);
    else { if (cur.length >= 4) out.push(Buffer.from(cur).toString('utf8')); cur = []; }
  }
  if (cur.length >= 4) out.push(Buffer.from(cur).toString('utf8'));
  return [...new Set(out.map(s => s.trim()))];
}
function socialsFromStrings(strs) {
  const s = {};
  for (const raw of strs) {
    const t = raw.trim();
    const typ = classifyUrl(t);
    if (typ === 'twitter' && !s.twitter) { s.twitter = normalizeUrl(t); continue; }
    if (typ === 'telegram' && !s.telegram) { s.telegram = normalizeUrl(t); continue; }
    if (typ === 'discord' && !s.discord) { s.discord = normalizeUrl(t); continue; }
    if (typ === 'website' && !s.website) { s.website = normalizeUrl(t); continue; }
  }
  return s;
}

/* Anchor style: website · X (Twitter) · telegram */
function socialsLine(s) {
  const parts = [];
  if (s.website)  parts.push(`<a href="${s.website}">website</a>`);
  if (s.twitter)  parts.push(`<a href="${s.twitter}">X (Twitter)</a>`);
  if (s.telegram) parts.push(`<a href="${s.telegram}">telegram</a>`);
  if (s.discord)  parts.push(`<a href="${s.discord}">discord</a>`);
  return parts.join(' · ');
}

function resolveWebsiteAndX(inObj) {
  const vals = Object.values(inObj).filter(Boolean).map(String);
  const candidates = { twitter: [], website: [], telegram: [], discord: [] };
  for (const v of vals) {
    const t = classifyUrl(v);
    if (t && candidates[t]) candidates[t].push(normalizeUrl(v));
  }
  const out = { ...inObj };
  const pickedTwitter = candidates.twitter.find(u => isXUrl(u)) || (out.website && isXUrl(out.website) ? out.website : null);
  const pickedWebsite = candidates.website.find(u => !isXUrl(u)) || (out.website && !isXUrl(out.website) ? out.website : null);
  if (pickedTwitter) out.twitter = pickedTwitter; else delete out.twitter;
  if (pickedWebsite) out.website = pickedWebsite; else delete out.website;
  if (out.website && isXUrl(out.website)) delete out.website;
  return out;
}

async function readSocials(token, txHexInput) {
  const out = {};

  // Direct getters
  const website = await (async () => {
    for (const sig of ['website() view returns (string)','web() view returns (string)','site() view returns (string)','url() view returns (string)','homepage() view returns (string)']) {
      const v = await tryCallString(token, sig); if (v) return normalizeUrl(v);
    } return null;
  })();
  if (website) out.website = website;

  const twitter = await (async () => {
    for (const sig of ['twitter() view returns (string)','x() view returns (string)','twitterUrl() view returns (string)']) {
      const v = await tryCallString(token, sig); if (v) return normalizeUrl(v,'https://twitter.com/');
    } return null;
  })();
  if (twitter) out.twitter = twitter;

  const telegram = await (async () => {
    for (const sig of ['telegram() view returns (string)','tg() view returns (string)','telegramUrl() view returns (string)']) {
      const v = await tryCallString(token, sig); if (v) return normalizeUrl(v,'https://t.me/');
    } return null;
  })();
  if (telegram) out.telegram = telegram;

  const discord = await (async () => {
    for (const sig of ['discord() view returns (string)','discordUrl() view returns (string)']) {
      const v = await tryCallString(token, sig); if (v) return normalizeUrl(v);
    } return null;
  })();
  if (discord) out.discord = discord;

  // contractURI()
  const contractUri = await tryCallString(token, 'contractURI() view returns (string)');
  if (contractUri) {
    const jsonA = parseDataUrlToJson(contractUri);
    const jsonB = jsonA || await fetchJsonMaybe(contractUri);
    const jsonC = jsonB || parseMaybeJsonString(contractUri);
    Object.assign(out, pickSocialsFromJson(jsonC));
  }

  // Public mappings
  for (const { fn, type } of SOCIALS_MAPPING_FUNCS) {
    for (const key of SOCIAL_KEYS) {
      if (out[key]) continue;
      const v = await tryCallMappingString(token, fn, key, type);
      if (v) {
        const classified = classifyUrl(v);
        if (classified === 'twitter') out.twitter = normalizeUrl(v);
        else if (classified === 'telegram') out.telegram = normalizeUrl(v);
        else if (classified === 'discord') out.discord = normalizeUrl(v);
        else out[key] = normalizeUrl(v);
      }
    }
  }

  // Tuple opsional
  Object.assign(out, await tryCallTuple(token, 'getSocials() view returns (string,string,string,string)', SOCIAL_KEYS));

  // Fallback dari calldata ASCII
  if (txHexInput) {
    const strs = extractAsciiStringsFromHex(txHexInput);
    Object.assign(out, socialsFromStrings(strs));
  }

  return resolveWebsiteAndX(out);
}

/* ================= Mechanisms ================= */

/** Per-key denominators; reflect+slices = % (100), APY = bps (10000). */
const KEY_DENOM = {
  reflect: 100, reflections_percent: 100, reflection_percent: 100, reflection: 100,
  dev_fee: 100, dev_share: 100, developer_fee: 100,
  liquidity_fee: 100, auto_lp: 100, auto_lp_share: 100, lp_share: 100, liquidity_share: 100,
  gamble: 100, gamble_fee: 100, gamble_share: 100, gamble_percent: 100,
  buy_fee: 100, sell_fee: 100, tax_fee: 100, total_fee: 100,
  burn_buy: 100, burn_sell: 100,
  max_daily_pump: 100,
  apy: 10000, apy_per_epoch: 10000,
};

async function readFeeDenominator(token) {
  for (const sig of [
    'feeDenominator() view returns (uint256)',
    'FEE_DENOMINATOR() view returns (uint256)',
    'denominator() view returns (uint256)'
  ]) {
    const v = await tryCallUint(token, sig);
    if (v) return Number(v);
  }
  return null;
}
function guessDenominator(m) {
  const nums = Object.entries(m)
    .filter(([k,v]) => typeof v === 'string' && /^\d+$/.test(v))
    .map(([,v]) => BigInt(v));
  if (nums.some(v => v >= 1000n && v <= 20000n)) return 10000;
  if (nums.some(v => v >= 100n && v <= 1000n))   return 1000;
  return 100;
}
function bestPctFromRaw(raw, expectedMax = 25) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const cands = [
    { d: 10000, p: (v * 100) / 10000 },
    { d: 1000,  p: (v * 100) / 1000  },
    { d: 100,   p: (v * 100) / 100   },
  ];
  const within = cands.filter(c => c.p > 0 && c.p <= expectedMax + 1e-9);
  const chosen = (within.length ? within : cands).reduce((mx, c) => (c.p > mx.p ? c : mx));
  return Number(chosen.p.toFixed(2));
}
function getPctSmart(mech, key, expectedMax, defaultDenom = 100) {
  if (mech[key] == null) return null;
  const raw = Number(mech[key]);
  if (!Number.isFinite(raw)) return null;
  const preferred = KEY_DENOM[key] || defaultDenom || 100;
  let pct = (raw * 100) / preferred;
  if (pct > expectedMax || pct < 0.01) {
    const alt = bestPctFromRaw(raw, expectedMax);
    if (alt != null) pct = alt;
  }
  return Number(pct.toFixed(2));
}

async function readMechanisms(token) {
  const mech = {};

  // Flags / toggles
  const boolProbes = [
    ['antibot',          ['antiBotEnabled() view returns (bool)','isAntiBotEnabled() view returns (bool)','drainIsForbidden() view returns (bool)']],
    ['trading_enabled',  ['tradingEnabled() view returns (bool)','isTradingEnabled() view returns (bool)','tradingOpen() view returns (bool)']],
    ['reflect',          ['reflectionEnabled() view returns (bool)','reflectionsEnabled() view returns (bool)','isReflectionEnabled() view returns (bool)']],
    ['eth_reflect',      ['ethReflectionEnabled() view returns (bool)','ethReflectEnabled() view returns (bool)']],
    ['gamble_enabled',   ['gambleEnabled() view returns (bool)','gamble() view returns (bool)']],
  ];
  for (const [key, sigs] of boolProbes) {
    for (const sig of sigs) { const v = await tryCallBool(token, sig); if (v !== null) { mech[key] = v; break; } }
  }

  // Values (nama getter versi EthOS & variasinya)
  const uintProbes = [
    ['reflect',         ['reflect() view returns (uint256)','reflection() view returns (uint256)','reflectionPercent() view returns (uint256)','reflectionsPercent() view returns (uint256)','reflectPercent() view returns (uint256)']],
    ['auto_lp_share',   ['autoLPShare() view returns (uint256)','lpShare() view returns (uint256)','autoLiquidityFee() view returns (uint256)','liquidityFee() view returns (uint256)','liquidityShare() view returns (uint256)']],
    ['gamble',          ['gambleFee() view returns (uint256)','gambleRate() view returns (uint256)','gambleShare() view returns (uint256)','gamblePercent() view returns (uint256)']],
    ['dev_fee',         ['devFee() view returns (uint256)','developerFee() view returns (uint256)','devShare() view returns (uint256)']],
    ['burn_buy',        ['burnPercentageBuy() view returns (uint256)','buyBurn() view returns (uint256)']],
    ['burn_sell',       ['burnPercentageSell() view returns (uint256)','sellBurn() view returns (uint256)']],
    ['max_daily_pump',  ['maxDailyPumpRate() view returns (uint256)','pumpRate() view returns (uint256)']],
    ['death_time',      ['deathTime() view returns (uint256)','reaperPeriod() view returns (uint256)']],
    ['gamble_period',   ['gamblePeriod() view returns (uint256)','gambleHours() view returns (uint256)']],
    ['apy',             ['apy() view returns (uint256)']],
    ['apy_per_epoch',   ['apyPerEpoch() view returns (uint256)']],
    ['max_wallet',      ['maxWallet() view returns (uint256)','maxWalletAmount() view returns (uint256)']],
    ['max_tx',          ['maxTxAmount() view returns (uint256)','maxTransactionAmount() view returns (uint256)']],
  ];
  for (const [key, sigs] of uintProbes) {
    for (const sig of sigs) { const v = await tryCallUint(token, sig); if (v !== null) { mech[key] = v.toString(); break; } }
  }

  // Tuples populer (beberapa kontrak expose sekaligus)
  Object.assign(mech, await tryCallTuple(token, 'getReflectSplits() view returns (uint256,uint256,uint256)', ['auto_lp_share','gamble','dev_fee']));
  Object.assign(mech, await tryCallTuple(token, 'reflectSplits() view returns (uint256,uint256,uint256)', ['auto_lp_share','gamble','dev_fee']));
  Object.assign(mech, await tryCallTuple(token, 'reflectShares() view returns (uint256,uint256,uint256)', ['auto_lp_share','gamble','dev_fee']));

  // Fallback via mapping
  for (const { fn, type } of MECH_MAPPING_UINT_FUNCS) {
    for (const k of MECH_UINT_KEYS) {
      if (mech[k] != null) continue;
      const v = await tryCallMappingUint(token, fn, k, type);
      if (v !== null) mech[k] = v.toString();
    }
  }
  for (const { fn, type } of MECH_MAPPING_BOOL_FUNCS) {
    for (const k of MECH_BOOL_KEYS) {
      if (mech[k] != null) continue;
      const v = await tryCallMappingBool(token, fn, k, type);
      if (v !== null) mech[k] = v;
    }
  }

  const denom = await readFeeDenominator(token);
  if (denom) mech._denominator = String(denom);

  return mech;
}

/** Build “Specs Mechanisms” dgn baris Auto LP / ETH Reward / Gamble / Dev Fee. */
function buildSpecs(mech) {
  if (!mech || !Object.keys(mech).length) return '';

  const defaultDenom = mech._denominator ? Number(mech._denominator) : guessDenominator(mech);

  const reflectPct =
    getPctSmart(mech, 'reflect', 25, defaultDenom) ??
    getPctSmart(mech, 'reflections_percent', 25, defaultDenom) ??
    getPctSmart(mech, 'reflection_percent', 25, defaultDenom) ??
    getPctSmart(mech, 'reflection', 25, defaultDenom);

  const autoLPslice = getPctSmart(mech, 'auto_lp_share', 100, defaultDenom) ??
                      getPctSmart(mech, 'liquidity_fee', 100, defaultDenom) ??
                      getPctSmart(mech, 'lp_share', 100, defaultDenom) ??
                      getPctSmart(mech, 'liquidity_share', 100, defaultDenom);

  const gambleSlice = getPctSmart(mech, 'gamble', 100, defaultDenom) ??
                      getPctSmart(mech, 'gamble_fee', 100, defaultDenom) ??
                      getPctSmart(mech, 'gamble_share', 100, defaultDenom) ??
                      getPctSmart(mech, 'gamble_percent', 100, defaultDenom);

  const devSlice    = getPctSmart(mech, 'dev_fee', 100, defaultDenom) ??
                      getPctSmart(mech, 'dev_share', 100, defaultDenom) ??
                      getPctSmart(mech, 'developer_fee', 100, defaultDenom);

  // ETH Reward = sisa dari reflect
  let ethRewardSlice = null;
  if (reflectPct != null) {
    const used = (autoLPslice || 0) + (gambleSlice || 0) + (devSlice || 0);
    ethRewardSlice = Math.max(0, Number((100 - used).toFixed(2)));
  }

  const antiBot   = mech.antibot === true ? 'ON' : (mech.antibot === false ? 'OFF' : null);
  const burnBuy   = getPctSmart(mech, 'burn_buy', 25, defaultDenom);
  const burnSell  = getPctSmart(mech, 'burn_sell', 25, defaultDenom);
  const pump      = getPctSmart(mech, 'max_daily_pump', 300, defaultDenom);
  const reaperSec = mech.death_time ? Number(mech.death_time)
                    : (mech.reaper_period ? Number(mech.reaper_period) : null);
  const apyDay    = getPctSmart(mech, 'apy', 100, defaultDenom);
  const gambleHrs = mech.gamble_period ? Number(mech.gamble_period) : null;

  const lines = [];
  if (antiBot) lines.push(`Anti-bot: ${antiBot}`);
  if (reflectPct != null) {
    lines.push(`Reflect: ${reflectPct.toFixed(2)}%`);
    if (autoLPslice != null)    lines.push(`• Auto LP: ${autoLPslice.toFixed(2)}% of reflect`);
    if (ethRewardSlice != null) lines.push(`• ETH Reward: ${ethRewardSlice.toFixed(2)}% of reflect`);
    if (gambleSlice != null)    lines.push(`• Gamble: ${gambleSlice.toFixed(2)}% of reflect${gambleHrs ? ` (period: ${gambleHrs} h)` : ''}`);
    if (devSlice != null)       lines.push(`• Dev Fee: ${devSlice.toFixed(2)}% of reflect`);
  }
  if (burnBuy != null)   lines.push(`Burn (Buy): ${burnBuy.toFixed(2)}%`);
  if (burnSell != null)  lines.push(`Burn (Sell): ${burnSell.toFixed(2)}%`);
  if (pump != null)      lines.push(`Max Daily Pump: ${pump.toFixed(2)}%`);
  if (reaperSec != null) lines.push(`Reaper period: ${(reaperSec/3600).toFixed(1)} h`);
  if (apyDay != null)    lines.push(`APY / day: ${apyDay.toFixed(2)}%`);

  return lines.join('\n');
}

/* ================= Decoders (tanpa ABI) ================= */
function decodeTokenCreatedLog(log) {
  try {
    if (!log.topics?.length) return null;
    if (log.topics[0].toLowerCase() !== TOKEN_CREATED_TOPIC) return null;
    const tokenAddress = topicToAddress(log.topics[1]);
    const [name, symbol] = abiCoder.decode(['string','string'], log.data);
    return { tokenAddress, name, symbol };
  } catch { return null; }
}
function decodePairCreatedLog(log) {
  try {
    if (!log.topics?.length || log.topics[0] !== PAIR_CREATED_TOPIC) return null;
    const token0 = topicToAddress(log.topics[1]);
    const token1 = topicToAddress(log.topics[2]);
    const [pair/*, allPairs*/] = abiCoder.decode(['address','uint256'], log.data);
    return { token0, token1, pair: ethers.getAddress(pair) };
  } catch { return null; }
}
function decodeMintLog(log) {
  try {
    if (!log.topics?.length || log.topics[0] !== MINT_TOPIC) return null;
    const [amount0, amount1] = abiCoder.decode(['uint256','uint256'], log.data);
    return { amount0, amount1 };
  } catch { return null; }
}
function decodeSyncLog(log) {
  try {
    if (!log.topics?.length || log.topics[0] !== SYNC_TOPIC) return null;
    const [reserve0, reserve1] = abiCoder.decode(['uint112','uint112'], log.data);
    return { reserve0: BigInt(reserve0), reserve1: BigInt(reserve1) };
  } catch { return null; }
}

/* =============== Token detection (receipt) =============== */
async function detectNewTokenFromReceipt(receipt) {
  if (!receipt.to || receipt.to.toLowerCase() !== LAUNCHPAD_ADDRESS.toLowerCase()) return null;

  // 1) TokenCreated
  let tokenCA=null, tokenName='', tokenSymbol='';
  for (const lg of receipt.logs) {
    const dec = decodeTokenCreatedLog(lg);
    if (dec) { tokenCA=dec.tokenAddress; tokenName=dec.name; tokenSymbol=dec.symbol; break; }
  }
  // Fallback: first mint Transfer from 0x0 by token itself
  if (!tokenCA) {
    for (const lg of receipt.logs) {
      if (lg.topics?.[0] === TRANSFER_TOPIC && lg.topics[1] === ZERO32) {
        tokenCA = ethers.getAddress(lg.address); break;
      }
    }
  }
  if (!tokenCA) return null;

  // 2) PairCreated → pair & orientation
  let pairAddr=null, token0=null, token1=null;
  for (const lg of receipt.logs) {
    const p = decodePairCreatedLog(lg);
    if (p && (p.token0.toLowerCase()===tokenCA.toLowerCase() || p.token1.toLowerCase()===tokenCA.toLowerCase())) {
      pairAddr=p.pair; token0=p.token0; token1=p.token1; break;
    }
  }

  // 3) Dev & LP token amounts (transfer dari factory)
  let devAmount=0n, lpTokenAmount=0n;
  for (const lg of receipt.logs) {
    if (lg.address.toLowerCase() !== tokenCA.toLowerCase()) continue;
    if (lg.topics?.[0] !== TRANSFER_TOPIC) continue;
    const from = topicToAddress(lg.topics[1]);
    const to   = topicToAddress(lg.topics[2]);
    const amt  = ethers.toBigInt(lg.data);
    if (from.toLowerCase() === LAUNCHPAD_ADDRESS.toLowerCase()) {
      if (pairAddr && to.toLowerCase() === pairAddr.toLowerCase()) lpTokenAmount += amt;
      else devAmount += amt;
    }
  }

  // 4) LP ETH (Mint/Sync atau WETH Deposit→Transfer ke pair)
  let lpEthWei = 0n;
  let wethAddr = (WETH_ADDRESS && WETH_ADDRESS.length===42) ? ethers.getAddress(WETH_ADDRESS) : null;

  if (pairAddr) {
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== pairAddr.toLowerCase()) continue;
      const m = decodeMintLog(lg);
      if (m && token0 && token1) {
        if (token0.toLowerCase()===tokenCA.toLowerCase()) lpEthWei = BigInt(m.amount1);
        else lpEthWei = BigInt(m.amount0);
      }
      const s = decodeSyncLog(lg);
      if (s && token0 && token1) {
        if (token0.toLowerCase()===tokenCA.toLowerCase()) lpEthWei = BigInt(s.reserve1);
        else lpEthWei = BigInt(s.reserve0);
      }
    }
  }
  if (lpEthWei === 0n) {
    let inferWeth=null, inferAmount=0n;
    for (const lg of receipt.logs) if (lg.topics?.[0] === DEPOSIT_TOPIC) inferWeth = ethers.getAddress(lg.address);
    if (inferWeth && pairAddr) {
      for (const lg of receipt.logs) {
        if (lg.address.toLowerCase() !== inferWeth.toLowerCase()) continue;
        if (lg.topics?.[0] !== TRANSFER_TOPIC) continue;
        const to = topicToAddress(lg.topics[2]);
        if (to.toLowerCase() === pairAddr.toLowerCase()) inferAmount += ethers.toBigInt(lg.data);
      }
    }
    if (inferAmount > 0n) { lpEthWei = inferAmount; wethAddr = inferWeth || wethAddr; }
  }

  const basics = await readTokenBasics(tokenCA);

  return {
    tokenCA, tokenName: tokenName || basics.name, tokenSymbol: tokenSymbol || basics.symbol,
    pairAddr, token0, token1,
    devAmount, lpTokenAmount, lpEthWei,
    tokenDecimals: basics.decimals, totalSupply: basics.totalSupply
  };
}

/* ================= Lock (1-liner) ================= */
function detectSettingsLockedFromReceipt(receipt) {
  for (const lg of receipt.logs) {
    if (!lg.topics?.length) continue;
    if (SETTINGS_LOCKED_TOPICS.includes(lg.topics[0])) {
      let ca = null;
      if (lg.topics[1]) ca = topicToAddress(lg.topics[1]);
      else if (lg.data && lg.data.length>=66) ca = ethers.getAddress('0x' + lg.data.slice(26,66));
      return { ca };
    }
  }
  return null;
}

/* ============== (Optional) via ABI ============== */
let iface = null;
const createNames = CREATE_EVENT_NAMES.split(',').map(s=>s.trim()).filter(Boolean);
const lockNames   = LOCK_EVENT_NAMES.split(',').map(s=>s.trim()).filter(Boolean);

async function handleReceiptWithAbi(receipt) {
  for (const lg of receipt.logs) {
    if (String(lg.address).toLowerCase() !== String(LAUNCHPAD_ADDRESS).toLowerCase()) continue;
    let parsed=null; try { parsed = iface.parseLog({ topics: lg.topics, data: lg.data }); } catch { continue; }
    const evName = parsed?.name || '';
    const argsArr = parsed?.args ?? [];
    const namedArgs = {};
    if (parsed?.fragment?.inputs) parsed.fragment.inputs.forEach((inp,idx)=>{ namedArgs[inp.name||`arg${idx}`]=argsArr[idx]; });

    if (createNames.some(n=>n.toLowerCase()===evName.toLowerCase())) {
      const token = namedArgs.tokenAddress || namedArgs.token ||
        Object.values(namedArgs).find(v=>typeof v==='string'&&v.startsWith('0x')&&v.length===42);
      const name = namedArgs.name || ''; const symbol = namedArgs.symbol || '';
      const ethos = token ? ethosUrlFor(token) : ethosUrlFor('');
      const lines = [
        `<b>🚀 New EOS20 Token Created</b>`,
        token ? `CA: <code>${token}</code>` : '',
        (name||symbol) ? `Name: <b>${escapeHtml(name)}</b>` : '',
        `Ticker: ${symbol ? `<b>${escapeHtml(symbol)}</b>` : ''}`
      ].filter(Boolean);
      await send(lines.join('\n') + `\n\n`, [
        [{ text:'Open in EthOS', url: ethos }]
      ]);
      return true;
    }

    if (lockNames.some(n=>n.toLowerCase()===evName.toLowerCase())) {
      const token = namedArgs.tokenAddress || namedArgs.token || null;
      const ethos = token ? ethosUrlFor(token) : ethosUrlFor('');
      const line = token
        ? `🔒 <code>${token}</code>\n<b>Settings locked forever</b>`
        : `🔒 <b>Settings locked forever</b>`;
      await send(line, [[{ text:'Open in EthOS', url: ethos }]]);
      return true;
    }
  }
  return false;
}

/* ================= Orchestration ================= */
const seenTx = new Set();

async function resolveFromBlock(fromSpec) {
  if (!fromSpec) return null;
  if (/^latest-\d+$/.test(fromSpec)) {
    const sub = Number(fromSpec.split('-')[1]);
    const latest = await provider.getBlockNumber();
    return Math.max(0, latest - sub);
  }
  const n = Number(fromSpec);
  return Number.isFinite(n) ? n : null;
}

function socialsLineOrEmpty(s) {
  const t = socialsLine(s);
  return t ? t : '';
}

async function handleReceipt(receipt) {
  if (iface) { const handled = await handleReceiptWithAbi(receipt); if (handled) return; }

  const created = await detectNewTokenFromReceipt(receipt);
  if (created) {
    const {
      tokenCA, tokenName, tokenSymbol,
      devAmount, lpTokenAmount, lpEthWei,
      tokenDecimals, totalSupply
    } = created;

    // Tx input → socials-fallback
    let txInputHex = '';
    try { const tx = await provider.getTransaction(receipt.hash); txInputHex = tx?.data || tx?.input || ''; } catch {}

    // Enrich
    const [socialsRaw, mechanisms, ethUsd] = await Promise.all([
      readSocials(tokenCA, txInputHex),
      readMechanisms(tokenCA),
      fetchEthUsd()
    ]);
    const socials = socialsRaw ? socialsRaw : {};

    // FDV: (totalSupply * LP_ETH) / LP_TOKENS
    let fdvWei = 0n;
    if (lpTokenAmount>0n && lpEthWei>0n && totalSupply>0n) fdvWei = (totalSupply * lpEthWei) / lpTokenAmount;
    const fdvEthNum = fdvWei>0n ? Number(fmtETH(fdvWei)) : 0;
    const fdvUsd = ethUsd>0 && fdvEthNum>0 ? fdvEthNum * ethUsd : 0;

    // LP shown as USD + ETH side
    const lpEthSide = lpEthWei > 0n ? Number(fmtETH(lpEthWei)) : 0;
    const lpUsdCombined = (ethUsd>0 && lpEthSide>0) ? lpEthSide * ethUsd * 2 : 0;

    const ethosUrl   = ethosUrlFor(tokenCA);

    // Dev Hold %
    const total = Number(ethers.formatUnits(totalSupply, tokenDecimals || 18));
    const dev   = Number(ethers.formatUnits(devAmount,   tokenDecimals || 18));
    const devPct = total > 0 ? (dev / total) * 100 : 0;

    // ==== MESSAGE ====
    const header = [
      `<b>🚀 New EOS20 Token Created</b>`,
      `CA: <code>${tokenCA}</code>`,
      `Name: <b>${escapeHtml(tokenName||'')}</b>`,
      `Ticker: ${tokenSymbol ? `<b>${escapeHtml(tokenSymbol)}</b>` : ''}`,
      socialsLineOrEmpty(socials)
    ].filter(Boolean).join('\n');

    const mid = [
      `Dev Hold: <b>${devPct ? devPct.toFixed(2) : '0.00'}%</b>`,
      (lpUsdCombined>0 || lpEthSide>0)
        ? `LP: <b>~$${fmtUSD(lpUsdCombined)} (${fmtEthShort(lpEthSide)} ETH)</b>` : null,
      (fdvUsd>0) ? `FDV (mcap): <b>~$${fmtUSD(fdvUsd)}</b>`
                 : (fdvEthNum>0 ? `FDV (mcap): <b>${fdvEthNum.toFixed(12)} ETH</b>` : null)
    ].filter(Boolean).join('\n');

    const specs = buildSpecs(mechanisms);
    const specsBlock = specs ? `<b>Specs Mechanisms:</b>\n${specs}` : '';

    const msg = [header, '', mid, '', specsBlock].join('\n');

    await send(msg, [
      [{ text:'Open in EthOS', url: ethosUrl }]
    ]);
  }

  const locked = detectSettingsLockedFromReceipt(receipt);
  if (locked) {
    const ethos = ethosUrlFor(locked.ca || '');
    const line = locked.ca
      ? `🔒 <code>${locked.ca}</code>\n<b>Settings locked forever</b>`
      : `🔒 <b>Settings locked forever</b>`;
    await send(line, [[{ text:'Open in EthOS', url: ethos }]]);
  }
}

async function processLogs(logs) {
  for (const lg of logs) {
    if (seenTx.has(lg.transactionHash)) continue;
    const receipt = await provider.getTransactionReceipt(lg.transactionHash);
    if (receipt) await handleReceipt(receipt);
    seenTx.add(lg.transactionHash);
  }
}

async function init() {
  const abi = await fetchAbi(LAUNCHPAD_ADDRESS);
  if (abi) {
    try { iface = new ethers.Interface(abi); }
    catch { console.warn('ABI present but failed to parse. Continuing without ABI.'); iface = null; }
  } else {
    console.warn('Launchpad ABI not found. Falling back to log-based detection.');
  }

  const fromBlock = await resolveFromBlock(FROM_BLOCK);
  if (fromBlock != null) {
    const latest = await provider.getBlockNumber();
    console.log(`Backfilling logs ${fromBlock}..${latest} for ${LAUNCHPAD_ADDRESS}`);
    const logs = await provider.getLogs({ address: LAUNCHPAD_ADDRESS, fromBlock, toBlock: latest });
    await processLogs(logs);
  }

  provider.on({ address: LAUNCHPAD_ADDRESS }, async (log) => {
    try {
      if (seenTx.has(log.transactionHash)) return;
      const receipt = await provider.getTransactionReceipt(log.transactionHash);
      if (receipt) await handleReceipt(receipt);
      seenTx.add(log.transactionHash);
    } catch (e) {
      console.error('handle log error:', e);
    }
  });

  console.log('Bot is running. Subscribed to', LAUNCHPAD_ADDRESS);
  await bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
init().catch((e)=>{ console.error('Fatal init error:', e); process.exit(1); });
