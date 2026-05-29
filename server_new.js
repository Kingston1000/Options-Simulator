const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

function fetchUrl(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        ...extraHeaders
      }
    };
    https.get(targetUrl, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

let cachedCookie = '';
let cachedCrumb = '';
let crumbExpiry = 0;

async function getYahooCrumb() {
  if (Date.now() < crumbExpiry && cachedCrumb) return { cookie: cachedCookie, crumb: cachedCrumb };
  try {
    const cookieRes = await new Promise((resolve, reject) => {
      https.get({ hostname: 'fc.yahoo.com', path: '/', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ headers: res.headers }));
      }).on('error', reject);
    });
    cachedCookie = (cookieRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const crumbRes = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'query2.finance.yahoo.com', path: '/v1/test/getcrumb',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cachedCookie }
      }, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    cachedCrumb = crumbRes.trim();
    crumbExpiry = Date.now() + 3600000;
    console.log('✓ Yahoo crumb:', cachedCrumb.slice(0,10)+'...');
    return { cookie: cachedCookie, crumb: cachedCrumb };
  } catch (e) {
    console.log('⚠ Crumb failed:', e.message);
    return { cookie: '', crumb: '' };
  }
}

async function yahooFetch(path) {
  const { cookie, crumb } = await getYahooCrumb();
  const sep = path.includes('?') ? '&' : '?';
  const crumbParam = crumb ? `${sep}crumb=${encodeURIComponent(crumb)}` : '';
  const result = await fetchUrl(
    `https://query2.finance.yahoo.com${path}${crumbParam}`,
    cookie ? { 'Cookie': cookie } : {}
  );
  return JSON.parse(result.body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;
  const symbol = (query.symbol || '').toUpperCase();

  // Serve HTML
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'options-simulator.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('options-simulator.html not found');
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  try {
    if (pathname === '/quote' && symbol) {
      console.log(`→ Quote: ${symbol}`);
      const data = await yahooFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error('No data for ' + symbol);
      res.end(JSON.stringify({
        symbol,
        price: meta.regularMarketPrice || meta.previousClose,
        prevClose: meta.previousClose,
        high52: meta.fiftyTwoWeekHigh,
        low52: meta.fiftyTwoWeekLow,
        name: meta.shortName || symbol
      }));

    } else if (pathname === '/options' && symbol) {
      console.log(`→ Full options chain: ${symbol}`);

      // First call — gets all expiry timestamps + first expiry chain
      const data = await yahooFetch(`/v7/finance/options/${symbol}`);
      const result = data?.optionChain?.result?.[0];
      if (!result) throw new Error('No options data for ' + symbol);

      // All expiry dates Yahoo knows about
      const allExpiries = (result.expirationDates || []).map(ts => {
        const d = new Date(ts * 1000);
        // Yahoo uses UTC midnight — format as local date
        return d.toISOString().split('T')[0];
      }).filter(e => {
        // Only future expiries
        const dte = Math.round((new Date(e+'T00:00:00') - new Date()) / 864e5);
        return dte >= 0;
      });

      console.log(`  Found ${allExpiries.length} expiries:`, allExpiries.slice(0,6).join(', '), '...');

      // Parse first expiry's chain from the initial call
      const opts0 = result.options?.[0];
      const parseContracts = (arr) => (arr||[]).map(c => ({
        strike: c.strike,
        last: c.lastPrice || 0,
        bid: c.bid || 0,
        ask: c.ask || 0,
        iv: c.impliedVolatility || 0,
        volume: c.volume || 0,
        oi: c.openInterest || 0,
        itm: c.inTheMoney || false
      }));

      const firstExpiry = allExpiries[0];
      const chainData = {};
      chainData[firstExpiry] = {
        calls: parseContracts(opts0?.calls),
        puts: parseContracts(opts0?.puts)
      };

      // Get strikes from first expiry calls
      const strikes = [...new Set(parseContracts(opts0?.calls).map(c=>c.strike))]
        .sort((a,b)=>a-b);

      // ATM IV
      const spot = result.quote?.regularMarketPrice || 0;
      let atmIV = 0.30;
      if(strikes.length > 0 && spot > 0) {
        const atmCall = parseContracts(opts0?.calls).reduce((a,b) =>
          Math.abs(b.strike-spot) < Math.abs(a.strike-spot) ? b : a,
          parseContracts(opts0?.calls)[0] || {strike:0,iv:0}
        );
        if(atmCall?.iv > 0) atmIV = atmCall.iv;
      }

      res.end(JSON.stringify({
        symbol,
        allExpiries,        // ALL expiry dates
        firstExpiry,
        strikes,            // Real strikes for first expiry
        chainData,          // First expiry chain pre-loaded
        atmIV,
        spot
      }));

    } else if (pathname === '/options-expiry' && symbol && query.date) {
      console.log(`→ Chain for ${symbol} @ ${query.date}`);
      const ts = Math.floor(new Date(query.date + 'T00:00:00Z').getTime() / 1000);
      const data = await yahooFetch(`/v7/finance/options/${symbol}?date=${ts}`);
      const opts = data?.optionChain?.result?.[0]?.options?.[0];
      const parseContracts = (arr) => (arr||[]).map(c => ({
        strike: c.strike, last: c.lastPrice||0, bid: c.bid||0, ask: c.ask||0,
        iv: c.impliedVolatility||0, volume: c.volume||0, oi: c.openInterest||0, itm: c.inTheMoney||false
      }));
      res.end(JSON.stringify({
        symbol, expiry: query.date,
        calls: parseContracts(opts?.calls),
        puts: parseContracts(opts?.puts)
      }));

    } else if (pathname === '/health') {
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    }
  } catch (e) {
    console.error('✗ Error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Options Simulator Server v2.0        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Running at http://localhost:${PORT}         ║`);
  console.log('║  Open Chrome: http://localhost:3000      ║');
  console.log('║  Press Ctrl+C to stop                   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  getYahooCrumb().then(({crumb}) => {
    if (crumb) console.log('✓ Ready\n');
    else console.log('⚠ Auth failed\n');
  });
});
