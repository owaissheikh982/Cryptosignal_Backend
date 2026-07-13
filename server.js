import express from 'express';
import cors from 'cors';
import ccxt from 'ccxt';
import pkg from 'technicalindicators';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHmac, timingSafeEqual } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { RSI, MACD, EMA, BollingerBands, ATR, StochasticRSI } = pkg;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — single place to change everything
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
    TARGET_COINS: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'PEPE/USDT', 'LINK/USDT', 'XRP/USDT'],
    CANDLE_LIMIT: 260,          // EMA200 needs 200+, 260 gives warmup buffer
    REFRESH_INTERVAL_MS: 30000, // 30s — respectful of rate limits
    PORT: 5000,

    // ── 🔔 DISCORD WEBHOOK CONFIG ──
    // Webhook URL kaise banayein:
    // Discord Server → Channel Settings → Integrations → Webhooks → New Webhook → Copy URL
    DISCORD: {
        ENABLED:              true,               // Webhook URL set karne ke baad true karo
        WEBHOOK_URL:          'https://discord.com/api/webhooks/1523642169221709904/mId9GmVMrtfQumYLcqtv4qormSl3EbVYnQNPyGZxql7BmtAfechgnioomCpxp5RXgBOZ',
        MIN_CONFIDENCE_ALERT: 55,                  // 55% se kam confidence ka alert nahi aayega
    },

    // ── 🔮 DYNAMIC ENGINE CONFIG MODULE ──
    DYNAMIC: {
        COIN_LIMIT: 6,                  // Top 6 liquid coins to process on-the-fly
        MAX_PRICE_FILTER: 1.0,          // Strict sub-$1 boundary filter
        MIN_24H_VOLUME_USD: 5000000,    // Trigger scan only on coins with > $5M volume
        SCREENER_INTERVAL_MS: 120000,   // Autonomous background scan — har 2 minute
    },

    // Scoring weights — total = 100
    WEIGHTS: {
        EMA_TREND:  30,  // strongest: multi-period alignment is robust
        MACD:       20,  // reliable momentum indicator
        RSI:        15,  // oscillator — confirms, doesn't lead
        VOLUME:     15,  // confirms price moves
        STRUCTURE:   8,  // support/resistance (reduced to make room for BB)
        STOCH_RSI:   7,  // fine-tuning oscillator (reduced to make room for BB)
        BB:          5,  // Bollinger Bands — squeeze + pctB position
    },

    // Action thresholds — symmetric scoring ke liye
    // longScore aur shortScore dono 0-100 scale par independent hain
    THRESHOLDS: {
        STRONG_BUY: 62,   // strong bullish confluence
        BUY: 48,          // moderate bullish signal — realistic threshold
        STRONG_SELL: 62,  // strong bearish confluence (shortScore)
        SELL: 48,         // moderate bearish signal (shortScore)
    },

    // Risk parameters
    RISK: {
        ATR_STOP_MULTIPLIER: 1.5,  // stop = price ± 1.5 × ATR (tighter than original 2×)
        TP_RATIOS: [1.5, 3.0, 5.0], // R multiples for TP1/2/3
        MAX_RISK_PCT: 1.5,  // max risk per trade as % of portfolio
    },

    // Circuit breaker
    CIRCUIT_BREAKER: {
        MAX_ERRORS: 5,
        PAUSE_MS: 120000, // 2 min cooldown
    },
};

const AUTH_CONFIG = {
    ADMIN_EMAIL: process.env.ADMIN_EMAIL?.trim() || '',
    ADMIN_USERNAME: process.env.ADMIN_USERNAME?.trim() || '',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD?.trim() || '',
    SECRET: process.env.AUTH_SECRET?.trim() || 'dev-auth-secret-change-me',
    SESSION_TTL_MS: Number(process.env.AUTH_SESSION_TTL_MS || 8 * 60 * 60 * 1000),
    COOKIE_NAME: 'quant_session',
};

function toBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function createSessionToken(sessionPayload, ttlMs) {
    const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = toBase64Url(JSON.stringify({ ...sessionPayload, exp: Date.now() + ttlMs }));
    const signature = createHmac('sha256', AUTH_CONFIG.SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
}

function verifySessionToken(token) {
    if (typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = createHmac('sha256', AUTH_CONFIG.SECRET).update(`${header}.${payload}`).digest('base64url');
    const expectedBuffer = Buffer.from(expectedSignature);
    const actualBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== actualBuffer.length) return null;

    try {
        timingSafeEqual(expectedBuffer, actualBuffer);
    } catch {
        return null;
    }

    try {
        const parsed = JSON.parse(fromBase64Url(payload));
        if (!parsed.exp || Date.now() > parsed.exp) return null;
        return parsed;
    } catch {
        return null;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie ?? '';
    return header.split(';').map((segment) => segment.trim()).filter(Boolean).reduce((acc, entry) => {
        const separatorIndex = entry.indexOf('=');
        if (separatorIndex === -1) return acc;
        const key = decodeURIComponent(entry.slice(0, separatorIndex));
        const value = decodeURIComponent(entry.slice(separatorIndex + 1));
        acc[key] = value;
        return acc;
    }, {});
}

function setSessionCookie(res, token, ttlMs) {
    const cookieValue = `${AUTH_CONFIG.COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookieValue);
}

function clearSessionCookie(res) {
    const cookieValue = `${AUTH_CONFIG.COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookieValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXCHANGE — rate limit safe, timeout set
// ─────────────────────────────────────────────────────────────────────────────

const exchange = new ccxt.kucoin({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'spot' },
});

let marketsLoaded = false;

async function ensureMarketsLoaded() {
    if (!marketsLoaded) {
        console.log('[Exchange] Loading markets...');
        await exchange.loadMarkets();
        marketsLoaded = true;
        console.log('[Exchange] Markets loaded.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER — auto-pause on repeated failures
// ─────────────────────────────────────────────────────────────────────────────

const cb = {
    errors: 0,
    paused: false,
    resumeAt: null,

    recordError() {
        this.errors++;
        if (this.errors >= CONFIG.CIRCUIT_BREAKER.MAX_ERRORS && !this.paused) {
            this.paused = true;
            this.resumeAt = Date.now() + CONFIG.CIRCUIT_BREAKER.PAUSE_MS;
            console.error(`[CircuitBreaker] ${this.errors} errors — pausing ${CONFIG.CIRCUIT_BREAKER.PAUSE_MS / 1000}s`);
        }
    },

    recordSuccess() { this.errors = 0; },

    isOpen() {
        if (this.paused && Date.now() > this.resumeAt) {
            this.paused = false;
            this.errors = 0;
            console.log('[CircuitBreaker] Reset — resuming');
        }
        return this.paused;
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// RETRY WITH EXPONENTIAL BACKOFF
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry(fn, maxRetries = 2, baseDelayMs = 800) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            cb.recordSuccess();
            return result;
        } catch (err) {
            if (attempt === maxRetries) { cb.recordError(); throw err; }
            const delay = baseDelayMs * Math.pow(2, attempt);
            console.warn(`[Retry] Attempt ${attempt + 1} failed (${err.message}). Retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDICATORS — pure functions, no side effects
// ─────────────────────────────────────────────────────────────────────────────

function computeRSI(closes, period = 14) {
    const values = RSI.calculate({ values: closes, period });
    if (!values.length) return null;
    const value = values[values.length - 1];
    const prev = values[values.length - 2] ?? value;
    return {
        value: +value.toFixed(2),
        prev: +prev.toFixed(2),
        oversold: value < 30,
        overbought: value > 70,
        rising: value > prev,
    };
}

function computeMACD(closes) {
    const values = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    if (values.length < 2) return null;
    const cur = values[values.length - 1];
    const prev = values[values.length - 2];
    if (!cur?.MACD || !cur?.signal) return null;

    const histogram = cur.MACD - cur.signal;
    const prevHistogram = (prev?.MACD ?? cur.MACD) - (prev?.signal ?? cur.signal);

    const price = closes[closes.length - 1];
    const normalizedHistogram = price > 0 ? (histogram / price) * 100 : 0;

    return {
        histogram: +histogram.toFixed(8),
        normalizedHistogram: +normalizedHistogram.toFixed(6),
        bullish: histogram > 0 && histogram > prevHistogram,
        bearish: histogram < 0 && histogram < prevHistogram,
        crossover: histogram > 0 && prevHistogram <= 0,
        crossunder: histogram < 0 && prevHistogram >= 0,
    };
}

function computeEMAStack(closes) {
    const ema20 = EMA.calculate({ values: closes, period: 20 });
    const ema50 = EMA.calculate({ values: closes, period: 50 });
    const ema200 = EMA.calculate({ values: closes, period: 200 });
    if (!ema200.length) return null;

    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const e200 = ema200[ema200.length - 1];
    const p = closes[closes.length - 1];

    const score =
        (p > e20 ? 1 : 0) +
        (p > e50 ? 1 : 0) +
        (p > e200 ? 1 : 0) +
        (e20 > e50 ? 1 : 0) +
        (e50 > e200 ? 1 : 0) +
        (e20 > e200 ? 1 : 0);

    return {
        ema20: +e20.toFixed(8), ema50: +e50.toFixed(8), ema200: +e200.toFixed(8),
        score,
        fullyAlignedBull: score === 6,
        fullyAlignedBear: score === 0,
        goldenCross: e20 > e50,
        deathCross: e20 < e50,
        trend: score >= 5 ? 'Strongly Bullish' : score >= 3 ? 'Bullish' : score >= 2 ? 'Bearish' : 'Strongly Bearish',
    };
}

function computeBB(closes) {
    const values = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (!values.length) return null;
    const bb = values[values.length - 1];
    const price = closes[closes.length - 1];
    const bw = bb.upper - bb.lower;
    const pctB = bw > 0 ? (price - bb.lower) / bw : 0.5;
    return {
        upper: +bb.upper.toFixed(8), middle: +bb.middle.toFixed(8), lower: +bb.lower.toFixed(8),
        pctB: +pctB.toFixed(4),
        squeeze: bw / bb.middle < 0.03,
        nearUpper: pctB > 0.85,
        nearLower: pctB < 0.15,
    };
}

function computeATR(ohlcv) {
    const high = ohlcv.map(c => c[2]);
    const low = ohlcv.map(c => c[3]);
    const close = ohlcv.map(c => c[4]);
    const vals = ATR.calculate({ high, low, close, period: 14 });
    if (!vals.length) return null;
    const atr = vals[vals.length - 1];
    const price = close[close.length - 1];
    return {
        value: +atr.toFixed(8),
        pct: +((atr / price) * 100).toFixed(4),
        volatility: atr / price * 100 > 5 ? 'HIGH' : atr / price * 100 > 2 ? 'MEDIUM' : 'LOW',
    };
}

function computeStochRSI(closes) {
    const vals = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
    if (!vals.length) return null;
    const cur = vals[vals.length - 1];
    return {
        k: +(cur.k ?? 50).toFixed(2),
        d: +(cur.d ?? 50).toFixed(2),
        oversold: (cur.k ?? 50) < 20,
        overbought: (cur.k ?? 50) > 80,
        kAboveD: (cur.k ?? 50) > (cur.d ?? 50),
    };
}

function computeVolume(ohlcv) {
    const vols = ohlcv.map(c => c[5]);
    const closes = ohlcv.map(c => c[4]);
    const cur = vols[vols.length - 1];
    const avg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const rel = avg > 0 ? cur / avg : 1;
    const priceCh = closes.length >= 2
        ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
        : 0;
    return {
        relativeVolume: +rel.toFixed(2),
        spike: rel > 2.0,
        confirmed: (priceCh > 0 && rel > 1.2) || (priceCh < 0 && rel > 1.2),
        divergence: priceCh > 0 && rel < 0.7,
        isPriceUp: priceCh > 0,
    };
}

function computeMarketStructure(ohlcv) {
    const highs = ohlcv.map(c => c[2]);
    const lows  = ohlcv.map(c => c[3]);
    const price = ohlcv[ohlcv.length - 1][4];

    const recentHighs = highs.slice(-30);
    const recentLows  = lows.slice(-30);
    const resistance  = Math.max(...recentHighs);
    const support     = Math.min(...recentLows);

    const pivotLen = 5;
    const pivotHighs = [];
    const pivotLows  = [];
    for (let i = pivotLen; i < ohlcv.length - pivotLen; i++) {
        const localHighs = highs.slice(i - pivotLen, i + pivotLen + 1);
        const localLows  = lows.slice(i  - pivotLen, i + pivotLen + 1);
        if (highs[i] === Math.max(...localHighs)) pivotHighs.push(highs[i]);
        if (lows[i]  === Math.min(...localLows))  pivotLows.push(lows[i]);
    }

    const ph = pivotHighs.slice(-2);
    const pl = pivotLows.slice(-2);
    const higherHighs = ph.length >= 2 && ph[1] > ph[0];
    const higherLows  = pl.length >= 2 && pl[1] > pl[0];
    const lowerHighs  = ph.length >= 2 && ph[1] < ph[0];
    const lowerLows   = pl.length >= 2 && pl[1] < pl[0];

    return {
        support:     +support.toFixed(8),
        resistance:  +resistance.toFixed(8),
        breakout:    price > resistance * 1.008,
        breakdown:   price < support  * 0.992,
        uptrendStructure:   higherHighs && higherLows,
        downtrendStructure: lowerHighs  && lowerLows,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE — weighted, deterministic, bounded 0-100
// ─────────────────────────────────────────────────────────────────────────────

function computeScore(price, rsi, macd, ema, bb, stoch, volume, structure) {
    let longPoints = 0;
    let shortPoints = 0;
    const reasons = [];
    const W = CONFIG.WEIGHTS;

    if (ema) {
        const emaBullPct = ema.score / 6;
        const emaBearPct = (6 - ema.score) / 6;
        longPoints  += emaBullPct * W.EMA_TREND;
        shortPoints += emaBearPct * W.EMA_TREND;

        if (ema.fullyAlignedBull) reasons.push('Full bullish EMA alignment (price > EMA20 > EMA50 > EMA200)');
        else if (ema.fullyAlignedBear) reasons.push('Full bearish EMA alignment (price < EMA20 < EMA50 < EMA200)');
        else if (ema.goldenCross) reasons.push('EMA20 crossed above EMA50 — bullish signal');
        else if (ema.deathCross) reasons.push('EMA20 crossed below EMA50 — bearish signal');
        else if (ema.score >= 4) reasons.push(`EMA stack bullish (${ema.score}/6 aligned)`);
        else if (ema.score <= 2) reasons.push(`EMA stack bearish (only ${ema.score}/6 aligned)`);
    }

    if (macd) {
        const rawStrength = Math.abs(macd.normalizedHistogram) * 3000;
        const histStrength = Math.min(W.MACD * 0.6, rawStrength);

        if (macd.crossover) {
            longPoints += W.MACD;
            reasons.push('MACD bullish crossover — strong momentum signal');
        } else if (macd.crossunder) {
            shortPoints += W.MACD;
            reasons.push('MACD bearish crossunder — strong momentum signal');
        } else if (macd.bullish) {
            longPoints += histStrength;
            if (histStrength > W.MACD * 0.3) reasons.push('MACD histogram expanding bullish');
        } else if (macd.bearish) {
            shortPoints += histStrength;
            if (histStrength > W.MACD * 0.3) reasons.push('MACD histogram expanding bearish');
        }
    }

    if (rsi) {
        if (rsi.oversold) {
            longPoints += W.RSI;
            if (rsi.rising) {
                longPoints += W.RSI * 0.3;
                reasons.push(`RSI oversold at ${rsi.value} and rising — bullish reversal confirming`);
            } else {
                reasons.push(`RSI oversold at ${rsi.value} — potential reversal zone`);
            }
        } else if (rsi.overbought) {
            shortPoints += W.RSI;
            if (!rsi.rising) {
                shortPoints += W.RSI * 0.3;
                reasons.push(`RSI overbought at ${rsi.value} and falling — bearish reversal confirming`);
            } else {
                reasons.push(`RSI overbought at ${rsi.value} — potential reversal zone`);
            }
        } else {
            const rsiDelta = rsi.value - 50;
            if (rsiDelta > 0) {
                longPoints  += Math.min(W.RSI * 0.8, (rsiDelta / 20) * W.RSI);
                if (rsi.rising) longPoints += W.RSI * 0.1;
            } else {
                shortPoints += Math.min(W.RSI * 0.8, (Math.abs(rsiDelta) / 20) * W.RSI);
                if (!rsi.rising) shortPoints += W.RSI * 0.1;
            }
        }
    }

    if (volume) {
        if (volume.spike || (volume.confirmed && volume.relativeVolume > 1.2)) {
            const allocatedPoints = volume.spike ? W.VOLUME * 0.9 : W.VOLUME * 0.5;
            if (volume.isPriceUp) {
                longPoints  += allocatedPoints;
                reasons.push(`Volume expansion (${volume.relativeVolume}×) confirming bullish price action`);
            } else {
                shortPoints += allocatedPoints;
                reasons.push(`Volume expansion (${volume.relativeVolume}×) confirming bearish price action`);
            }
        }
        if (volume.divergence) {
            longPoints = Math.max(0, longPoints - W.VOLUME * 0.4);
            reasons.push('Volume divergence detected — upward move losing momentum');
        }
    }

    if (structure) {
        if (structure.breakout) {
            longPoints  += W.STRUCTURE;
            reasons.push('Confirmed breakout above 30-candle resistance');
        }
        if (structure.breakdown) {
            shortPoints += W.STRUCTURE;
            reasons.push('Confirmed breakdown below 30-candle support');
        }
        if (structure.uptrendStructure && !structure.breakout) {
            longPoints  += W.STRUCTURE * 0.5;
            reasons.push('Higher Highs + Higher Lows — uptrend structure intact');
        }
        if (structure.downtrendStructure && !structure.breakdown) {
            shortPoints += W.STRUCTURE * 0.5;
            reasons.push('Lower Highs + Lower Lows — downtrend structure intact');
        }
    }

    if (stoch) {
        if (stoch.oversold && stoch.kAboveD) {
            longPoints  += W.STOCH_RSI;
            reasons.push('StochRSI oversold with K > D — bullish momentum building');
        } else if (stoch.overbought && !stoch.kAboveD) {
            shortPoints += W.STOCH_RSI;
            reasons.push('StochRSI overbought with K < D — bearish momentum building');
        } else if (stoch.kAboveD && !stoch.overbought) {
            longPoints  += W.STOCH_RSI * 0.4;
        } else if (!stoch.kAboveD && !stoch.oversold) {
            shortPoints += W.STOCH_RSI * 0.4;
        }
    }

    if (bb) {
        if (bb.squeeze) {
            const squeezBonus = W.BB * 0.4;
            if (longPoints >= shortPoints) {
                longPoints  += squeezBonus;
                reasons.push('Bollinger Band squeeze — bullish breakout building');
            } else {
                shortPoints += squeezBonus;
                reasons.push('Bollinger Band squeeze — bearish breakout building');
            }
        } else if (bb.nearUpper) {
            shortPoints += W.BB * 0.6;
            reasons.push('Price near upper Bollinger Band — extended, potential reversal');
        } else if (bb.nearLower) {
            longPoints  += W.BB * 0.6;
            reasons.push('Price near lower Bollinger Band — oversold, potential bounce');
        } else {
            const bbDelta = bb.pctB - 0.5;
            if (bbDelta > 0.1) longPoints  += W.BB * (bbDelta * 2) * 0.5;
            else if (bbDelta < -0.1) shortPoints += W.BB * (Math.abs(bbDelta) * 2) * 0.5;
        }
    }

    const maxPossible = Object.values(W).reduce((a, b) => a + b, 0);
    const longScore  = Math.max(0, Math.min(100, Math.round((longPoints  / maxPossible) * 100)));
    const shortScore = Math.max(0, Math.min(100, Math.round((shortPoints / maxPossible) * 100)));

    if (reasons.length === 0) {
        if (longScore > shortScore) reasons.push('Mild bullish confluence — no strong single signal');
        else if (shortScore > longScore) reasons.push('Mild bearish confluence — no strong single signal');
        else reasons.push('Market in equilibrium — no directional bias');
    }

    return { longScore, shortScore, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE PARAMETERS — proper ATR-based stops, calculated R:R
// ─────────────────────────────────────────────────────────────────────────────

function computeTradeParams(price, atr, isBuy, riskScore) {
    if (!price || !atr?.value) return { entry: price, stop_loss: 0, take_profit: [], risk_reward: 'N/A' };

    const riskAdj = 1 + (riskScore / 100) * 0.4;
    const stopDist = atr.value * CONFIG.RISK.ATR_STOP_MULTIPLIER * riskAdj;
    const entry = +price.toFixed(8);
    const stop_loss = isBuy
        ? +Math.max(0, price - stopDist).toFixed(8)
        : +(price + stopDist).toFixed(8);

    const riskAmount = Math.abs(entry - stop_loss);
    const take_profit = CONFIG.RISK.TP_RATIOS.map(r =>
        isBuy
            ? +(price + riskAmount * r).toFixed(8)
            : +Math.max(0, price - riskAmount * r).toFixed(8)
    );

    const primaryRR = riskAmount > 0 && take_profit.length > 0
        ? `1:${(Math.abs(take_profit[0] - entry) / riskAmount).toFixed(1)}`
        : 'N/A';

    const suggestedPositionSizePct = CONFIG.RISK.MAX_RISK_PCT;

    return { entry, stop_loss, take_profit, risk_reward: primaryRR, suggestedPositionSizePct };
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSET ANALYSIS — processes one coin, returns full signal
// ─────────────────────────────────────────────────────────────────────────────

async function processAssetIntelligence(symbol, timeframe = '1h') {
    const coinName = symbol.split('/')[0];

    if (cb.isOpen()) throw new Error('Circuit breaker open — skipping exchange calls');

    const macroTimeframe = '1h';
    const needsMacro = timeframe !== macroTimeframe;

    const fetchPromises = [
        withRetry(() => exchange.fetchOHLCV(symbol, timeframe, undefined, CONFIG.CANDLE_LIMIT)),
        withRetry(() => exchange.fetchTicker(symbol)),
    ];
    if (needsMacro) {
        fetchPromises.push(withRetry(() => exchange.fetchOHLCV(symbol, macroTimeframe, undefined, CONFIG.CANDLE_LIMIT)));
    }

    const [ohlcvPrimary, ticker, ohlcvMacro] = await Promise.all(fetchPromises);

    const currentPrice = ticker.last;
    if (!currentPrice || !Number.isFinite(currentPrice)) throw new Error(`Invalid price for ${symbol}`);
    if (ohlcvPrimary.length < 210) throw new Error(`Only ${ohlcvPrimary.length} candles for ${symbol} — need 210+`);
    if (needsMacro && ohlcvMacro.length < 210) throw new Error(`Macro (1h) only ${ohlcvMacro.length} candles — need 210+`);

    const closes = ohlcvPrimary.map(c => c[4]);

    let isMacroBullish = null;
    if (needsMacro) {
        const closesMacro = ohlcvMacro.map(c => c[4]);
        const ema200macro  = EMA.calculate({ values: closesMacro, period: 200 });
        const currentEMA200 = ema200macro[ema200macro.length - 1];
        isMacroBullish = currentPrice > currentEMA200;
    }

    const rsi       = computeRSI(closes);
    const macd      = computeMACD(closes);
    const ema       = computeEMAStack(closes);
    const bb        = computeBB(closes);
    const atr       = computeATR(ohlcvPrimary);
    const stoch     = computeStochRSI(closes);
    const volume    = computeVolume(ohlcvPrimary);
    const structure = computeMarketStructure(ohlcvPrimary);

    let { longScore, shortScore, reasons } = computeScore(
        currentPrice, rsi, macd, ema, bb, stoch, volume, structure
    );

    if (isMacroBullish !== null) {
        if (isMacroBullish) {
            longScore  = Math.min(100, longScore  + 15);
            shortScore = Math.max(0,   shortScore - 30);
            reasons.unshift('Macro 1H above EMA200 — institutional bullish guard active');
        } else {
            shortScore = Math.min(100, shortScore + 15);
            longScore  = Math.max(0,   longScore  - 30);
            reasons.unshift('Macro 1H below EMA200 — institutional bearish guard active');
        }
    }

    const T = CONFIG.THRESHOLDS;
    let action, confidence;

    const scoreSpread  = Math.abs(longScore - shortScore);
    const STRONG_SPREAD = 12;
    const NORMAL_SPREAD = 6;

    if (longScore >= T.STRONG_BUY && longScore > shortScore && scoreSpread >= STRONG_SPREAD) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore >= T.STRONG_SELL && shortScore > longScore && scoreSpread >= STRONG_SPREAD) {
        action = 'SELL'; confidence = shortScore;
    } else if (longScore >= T.BUY && longScore > shortScore && scoreSpread >= NORMAL_SPREAD) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore >= T.SELL && shortScore > longScore && scoreSpread >= NORMAL_SPREAD) {
        action = 'SELL'; confidence = shortScore;
    } else {
        const shouldAvoid = (rsi?.oversold && !macd?.bullish) || (rsi?.overbought && !macd?.bearish) || volume?.divergence;
        action = shouldAvoid ? 'AVOID' : 'HOLD';
        confidence = Math.max(longScore, shortScore);
    }

    const riskScore = Math.max(10, Math.min(95, Math.round(20 + (atr?.pct ?? 2) * 5)));

    const isBuy = action === 'BUY';
    const { entry, stop_loss, take_profit, risk_reward, suggestedPositionSizePct } = computeTradeParams(
        currentPrice, atr, isBuy, riskScore
    );

    const baseTrend = ema ? ema.trend : (currentPrice > closes[0] ? 'Bullish' : 'Bearish');
    const trend = isMacroBullish !== null
        ? `${baseTrend} (Macro: ${isMacroBullish ? 'Bullish' : 'Bearish'})`
        : baseTrend;

    return {
        coin: coinName,
        action,
        confidence: Math.min(98, Math.max(10, confidence)),
        trend,
        entry,
        stop_loss,
        take_profit,
        risk_reward,
        risk_score: riskScore,
        suggestedPositionSizePct,
        reasons: reasons.length > 0 ? reasons : ['Market in equilibrium — no strong directional signal'],
        indicators: {
            rsi:    rsi    ? { value: rsi.value, zone: rsi.oversold ? 'oversold' : rsi.overbought ? 'overbought' : 'neutral', rising: rsi.rising } : null,
            macd:   macd   ? { bullish: macd.bullish, crossover: macd.crossover } : null,
            ema:    ema    ? { score: ema.score, trend: ema.trend } : null,
            bb:     bb     ? { pctB: bb.pctB, squeeze: bb.squeeze, nearUpper: bb.nearUpper, nearLower: bb.nearLower } : null,
            atr:    atr    ? { pct: atr.pct, volatility: atr.volatility } : null,
            volume: volume ? { relativeVolume: volume.relativeVolume, spike: volume.spike } : null,
            structure: structure ? { uptrendStructure: structure.uptrendStructure, downtrendStructure: structure.downtrendStructure } : null,
            mtf: isMacroBullish !== null ? { macroBullish: isMacroBullish, guardActive: true } : { guardActive: false },
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 🧠 DYNAMIC QUANT SCREENER SUB-ENGINE MODULE (NEW GENERATION)
// ─────────────────────────────────────────────────────────────────────────────

// fetchTickers() cache — har request par 500+ pairs load karna slow aur unnecessary tha
// 90 second TTL: same watchlist milegi jab tak market drastically shift na kare
const screenerCache = {
    watchlist: null,       // cached coin list
    cachedAt:  0,          // timestamp
    TTL_MS:    90_000,     // 90 seconds
    isValid()  { return this.watchlist && (Date.now() - this.cachedAt) < this.TTL_MS; },
    set(list)  { this.watchlist = list; this.cachedAt = Date.now(); },
};

async function runDynamicVolumePriceScreener() {
    // Cache valid hai to fresh exchange call avoid karo
    if (screenerCache.isValid()) {
        console.log(`[DynamicScreener] Cache hit — returning cached watchlist (${screenerCache.watchlist.join(', ')})`);
        return screenerCache.watchlist;
    }

    try {
        await ensureMarketsLoaded();
        console.log('[DynamicScreener] Cache miss — scanning full market tickers...');
        
        const tickers = await exchange.fetchTickers();
        const qualifiedPool = [];

        for (const [symbol, ticker] of Object.entries(tickers)) {
            // Sirf spot USDT pairs — futures (:) exclude
            if (!symbol.endsWith('/USDT') || symbol.includes(':')) continue;

            const currentPrice  = ticker.last;
            // Fix: explicit number check — undefined/null quoteVolume safely skip ho jaye
            const quoteVolume24h = typeof ticker.quoteVolume === 'number' ? ticker.quoteVolume : 0;

            if (
                currentPrice &&
                Number.isFinite(currentPrice) &&
                currentPrice <= CONFIG.DYNAMIC.MAX_PRICE_FILTER &&   // sub-$1 filter (intentional — small capital trading)
                quoteVolume24h >= CONFIG.DYNAMIC.MIN_24H_VOLUME_USD  // min $5M 24h volume — liquidity guarantee
            ) {
                qualifiedPool.push({ symbol, price: currentPrice, volume24h: quoteVolume24h });
            }
        }

        // Sort by volume descending — highest liquidity first
        qualifiedPool.sort((a, b) => b.volume24h - a.volume24h);

        const targetedAssets = qualifiedPool.slice(0, CONFIG.DYNAMIC.COIN_LIMIT).map(a => a.symbol);
        
        if (targetedAssets.length === 0) {
            console.warn('[DynamicScreener] No coins passed filters — check price/volume thresholds. Using fallback.');
            throw new Error('No qualified coins found');
        }

        console.log(`[DynamicScreener] Qualified watchlist (${targetedAssets.length} coins): ${targetedAssets.join(', ')}`);
        
        // Cache kar lo — agle 90 seconds fresh exchange call nahi hogi
        screenerCache.set(targetedAssets);
        return targetedAssets;

    } catch (screenerErr) {
        console.error('[DynamicScreener] Screener failed:', screenerErr.message);
        // Fallback — sub-$1 high-volume coins jo usually qualify karte hain
        const fallback = ['PEPE/USDT', 'DOGE/USDT', 'SHIB/USDT', 'TRX/USDT', 'XLM/USDT', 'WIN/USDT'];
        console.warn(`[DynamicScreener] Using fallback watchlist: ${fallback.join(', ')}`);
        return fallback;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD ALERT HELPER
// ─────────────────────────────────────────────────────────────────────────────

// Last sent signal track karo — har 30s scan par same coin repeat alert na ho
// Discord duplicate guard — 3-layer protection:
// Layer 1: same coin track — dobara nahi bhejega jab tak coin na badle
// Layer 2: 10 min cooldown — same coin teen alag sources se bhi spam nahi hoga
// Layer 3: source label — Discord footer mein dikh sake kahan se aaya
// 🛡️ MULTI-COIN MAP MATRIX — har coin ka apna independent cooldown timer
// Pehle: single variable (lastBuyCoin/lastShortCoin) — LAB ne SOL ka state overwrite kar diya
// Ab: har coin ki apni entry — SOL, LAB, PEPE sab alag alag track honge
const discordState = {
    buySignals:  {},  // { 'SOL': timestamp, 'LAB': timestamp, 'PEPE': timestamp }
    shortSignals: {}, // { 'SOL': timestamp, 'LAB': timestamp }
    COOLDOWN_MS:  10 * 60 * 1000, // 10 minutes — per-coin independent lock
};

async function sendDiscordAlert(payload) {
    if (!CONFIG.DISCORD.ENABLED) return;
    try {
        const res = await fetch(CONFIG.DISCORD.WEBHOOK_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error('[Discord] Webhook error:', res.status, err);
        } else {
            console.log('[Discord] Alert sent ✓');
        }
    } catch (err) {
        console.error('[Discord] Network error:', err.message);
    }
}

function buildDiscordBuyPayload(signal, source = 'Pipeline') {
    return {
        username:   'QuantTrader Pro',
        avatar_url: 'https://i.imgur.com/4M34hi2.png', // optional bot avatar
        embeds: [{
            title:       `⚡ LONG SIGNAL — ${signal.coin}/USDT`,
            color:       0x00FF99, // green
            description: `**Bullish confluence detected — entry opportunity**`,
            fields: [
                { name: '💰 Entry Price',   value: `$${signal.entry}`,               inline: true  },
                { name: '🛑 Stop Loss',     value: `$${signal.stop_loss}`,            inline: true  },
                { name: '📊 Confidence',    value: `**${signal.confidence}%**`,       inline: true  },
                { name: '🎯 TP1',           value: `$${signal.take_profit[0]}`,       inline: true  },
                { name: '🎯 TP2',           value: `$${signal.take_profit[1] ?? '—'}`, inline: true },
                { name: '🎯 TP3',           value: `$${signal.take_profit[2] ?? '—'}`, inline: true },
                { name: '⚖️ Risk:Reward',   value: signal.risk_reward,               inline: true  },
                { name: '📈 Trend',         value: signal.trend,                     inline: true  },
                { name: '💡 Reason',        value: signal.reasons[0] ?? 'Bullish confluence', inline: false },
            ],
            footer:    { text: `QuantTrader Pro • ${source}` },
            timestamp: new Date().toISOString(),
        }],
    };
}

function buildDiscordShortPayload(signal, source = 'Pipeline') {
    return {
        username:   'QuantTrader Pro',
        avatar_url: 'https://i.imgur.com/4M34hi2.png',
        embeds: [{
            title:       `🔻 SHORT SIGNAL — ${signal.coin}/USDT`,
            color:       0xFF4444, // red
            description: `**Bearish confluence detected — short opportunity**`,
            fields: [
                { name: '💰 Entry Price',   value: `$${signal.entry}`,               inline: true  },
                { name: '🛑 Stop Loss',     value: `$${signal.stop_loss}`,            inline: true  },
                { name: '📊 Confidence',    value: `**${signal.confidence}%**`,       inline: true  },
                { name: '🎯 TP1',           value: `$${signal.take_profit[0]}`,       inline: true  },
                { name: '🎯 TP2',           value: `$${signal.take_profit[1] ?? '—'}`, inline: true },
                { name: '🎯 TP3',           value: `$${signal.take_profit[2] ?? '—'}`, inline: true },
                { name: '⚖️ Risk:Reward',   value: signal.risk_reward,               inline: true  },
                { name: '📉 Trend',         value: signal.trend,                     inline: true  },
                { name: '💡 Reason',        value: signal.reasons[0] ?? 'Bearish confluence', inline: false },
            ],
            footer:    { text: `QuantTrader Pro • ${source}` },
            timestamp: new Date().toISOString(),
        }],
    };
}

// ── Shared Discord Alert Dispatcher ──────────────────────────────────────
// Multi-Coin Map Matrix — har coin apna alag cooldown rakhta hai
// SOL ka timer LAB se, LAB ka timer PEPE se kabhi overwrite nahi hoga
function processDiscordSignalAlert(primaryBuy, primaryShort, source = 'Pipeline') {
    if (!CONFIG.DISCORD.ENABLED) return;

    const now = Date.now();

    // 🟢 BUY guard — per-coin independent check
    if (primaryBuy && primaryBuy.confidence >= CONFIG.DISCORD.MIN_CONFIDENCE_ALERT) {
        const coin       = primaryBuy.coin;
        const lastSentAt = discordState.buySignals[coin] || 0;
        const cooldownOver = (now - lastSentAt) >= discordState.COOLDOWN_MS;

        if (cooldownOver) {
            discordState.buySignals[coin] = now; // sirf is coin ka timer update
            sendDiscordAlert(buildDiscordBuyPayload(primaryBuy, source));
            console.log(`[Discord] BUY alert sent — ${coin} | Source: ${source}`);
        } else {
            const remainSec = Math.round((discordState.COOLDOWN_MS - (now - lastSentAt)) / 1000);
            console.log(`[Discord] BUY duplicate blocked — ${coin} already sent. Cooldown: ${remainSec}s remaining`);
        }
    }

    // 🔴 SHORT guard — per-coin independent check
    if (primaryShort && primaryShort.confidence >= CONFIG.DISCORD.MIN_CONFIDENCE_ALERT) {
        const coin       = primaryShort.coin;
        const lastSentAt = discordState.shortSignals[coin] || 0;
        const cooldownOver = (now - lastSentAt) >= discordState.COOLDOWN_MS;

        if (cooldownOver) {
            discordState.shortSignals[coin] = now; // sirf is coin ka timer update
            sendDiscordAlert(buildDiscordShortPayload(primaryShort, source));
            console.log(`[Discord] SHORT alert sent — ${coin} | Source: ${source}`);
        } else {
            const remainSec = Math.round((discordState.COOLDOWN_MS - (now - lastSentAt)) / 1000);
            console.log(`[Discord] SHORT duplicate blocked — ${coin} already sent. Cooldown: ${remainSec}s remaining`);
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────

let marketIntelligenceState = {
    marketTrend: 'NEUTRAL',
    recommendedStance: 'PRESERVE_CAPITAL',
    strongestSectors: [],
    weakestSectors: [],
    buySignal: null,
    shortSignal: null,
    allSignals: [],
    lastSyncTimestamp: null,
    scanCount: 0,
    engineStatus: 'initializing',
    errors: {},
};

let isRunning = false;

// ─────────────────────────────────────────────────────────────────────────────
// CORE PIPELINE — sequential per coin, atomic state update
// ─────────────────────────────────────────────────────────────────────────────

async function coreMarketIntelligencePipeline() {
    if (isRunning) {
        console.warn('[Pipeline] Still running from last cycle — skipping tick');
        scheduleNext();
        return;
    }

    isRunning = true;
    const startTime = Date.now();
    console.log(`\n[Pipeline] === Scan #${marketIntelligenceState.scanCount + 1} starting ===`);

    try {
        await ensureMarketsLoaded();

        const freshSignals = [];
        const freshErrors = {};

        for (const symbol of CONFIG.TARGET_COINS) {
            try {
                const signal = await processAssetIntelligence(symbol);
                freshSignals.push(signal);
                console.log(`  ✓ ${signal.coin.padEnd(6)} | ${signal.action.padEnd(5)} | Conf: ${signal.confidence}% | Risk: ${signal.risk_score}`);
            } catch (err) {
                const coin = symbol.split('/')[0];
                freshErrors[coin] = err.message;
                console.error(`  ✗ ${coin}: ${err.message}`);
            }
        }

        if (freshSignals.length === 0) {
            console.error('[Pipeline] Zero results — preserving last good state');
            marketIntelligenceState = { ...marketIntelligenceState, engineStatus: 'error', errors: freshErrors };
            return;
        }

        const buyCandidates = freshSignals.filter(s => s.action === 'BUY');
        const sellCandidates = freshSignals.filter(s => s.action === 'SELL');

        let activeTrend = 'SIDEWAYS';
        let marketStance = 'PRESERVE_CAPITAL';

        if (buyCandidates.length >= 2 && buyCandidates.length > sellCandidates.length) {
            activeTrend = 'BULLISH';
            marketStance = 'AGGRESSIVE_ACCUMULATION_ON_SUPPORT';
        } else if (sellCandidates.length >= 2 && sellCandidates.length > buyCandidates.length) {
            activeTrend = 'BEARISH';
            marketStance = 'HEDGE_EXPOSURE_EXECUTE_SHORTS';
        }

        const longSorted = [...freshSignals]
            .filter(s => s.action === 'BUY')
            .sort((a, b) => b.confidence - a.confidence);

        const shortSorted = [...freshSignals]
            .filter(s => s.action === 'SELL')
            .sort((a, b) => b.confidence - a.confidence);

        let primaryBuy = longSorted[0] ?? null;
        let primaryShort = shortSorted[0] ?? null;

        if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin) {
            const buyMargin = primaryBuy.confidence - (longSorted[1]?.confidence ?? 0);
            const shortMargin = primaryShort.confidence - (shortSorted[1]?.confidence ?? 0);
            if (buyMargin >= shortMargin) primaryShort = shortSorted[1] ?? null;
            else primaryBuy = longSorted[1] ?? null;
        }

        marketIntelligenceState = {
            marketTrend: activeTrend,
            recommendedStance: marketStance,
            strongestSectors: buyCandidates.map(c => c.coin),
            weakestSectors: sellCandidates.map(c => c.coin),

            buySignal: primaryBuy ? {
                symbol: primaryBuy.coin,
                price: primaryBuy.entry,
                confidence: primaryBuy.confidence,
                reason: primaryBuy.reasons[0] ?? 'Bullish confluence detected',
                type: 'LONG',
            } : null,

            shortSignal: primaryShort ? {
                symbol: primaryShort.coin,
                price: primaryShort.entry,
                confidence: primaryShort.confidence,
                reason: primaryShort.reasons[0] ?? 'Bearish confluence detected',
                type: 'SHORT',
            } : null,

            allSignals: freshSignals,
            lastSyncTimestamp: new Date().toISOString(),
            scanCount: marketIntelligenceState.scanCount + 1,
            engineStatus: Object.keys(freshErrors).length > 0 ? 'degraded' : 'ok',
            errors: freshErrors,
            scanDurationMs: Date.now() - startTime,
        };

        const dur = Date.now() - startTime;
        console.log(`[Pipeline] Scan complete in ${dur}ms | Trend: ${activeTrend} | ${freshSignals.length}/${CONFIG.TARGET_COINS.length} coins`);

        // ── Discord alerts — shared dispatcher ───────────────────────────
        processDiscordSignalAlert(primaryBuy, primaryShort, 'Robot1 • Major Coins 30s');

    } catch (criticalErr) {
        console.error('[Pipeline] Critical error:', criticalErr.message);
        marketIntelligenceState = { ...marketIntelligenceState, engineStatus: 'error' };
    } finally {
        isRunning = false;
        scheduleNext();
    }
}

function scheduleNext() {
    setTimeout(coreMarketIntelligencePipeline, CONFIG.REFRESH_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AUTONOMOUS BACKGROUND DYNAMIC SCREENER PIPELINE (WEBSITE-INDEPENDENT)
// Frontend band ho ya chalu — yeh robot har 2 minute baad khud chalta rahega
// aur sub-$1 high-volume coins scan karke signals Discord par push karega
// ─────────────────────────────────────────────────────────────────────────────

async function autonomousDynamicScreenerPipeline() {
    console.log('\n[AutonomousScreener] 🤖 Running scheduled full-market scan...');
    try {
        const fluidTargetWatchlist = await runDynamicVolumePriceScreener();

        const freshSignals = [];
        const freshErrors  = {};

        for (const symbol of fluidTargetWatchlist) {
            try {
                const signal = await processAssetIntelligence(symbol, '1h');
                freshSignals.push(signal);
                console.log(`  [AutonomousScreener] ✓ ${signal.coin.padEnd(6)} | ${signal.action.padEnd(5)} | Conf: ${signal.confidence}%`);
            } catch (err) {
                const coin = symbol.split('/')[0];
                freshErrors[coin] = err.message;
                console.error(`  [AutonomousScreener] ✗ ${coin}: ${err.message}`);
            }
        }

        if (freshSignals.length === 0) {
            console.warn('[AutonomousScreener] All coins failed this cycle — skipping Discord dispatch.');
            return;
        }

        const longSorted  = freshSignals.filter(s => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
        const shortSorted = freshSignals.filter(s => s.action === 'SELL').sort((a, b) => b.confidence - a.confidence);

        let primaryBuy   = longSorted[0]  ?? null;
        let primaryShort = shortSorted[0] ?? null;

        if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin) {
            const buyMargin   = primaryBuy.confidence   - (longSorted[1]?.confidence  ?? 0);
            const shortMargin = primaryShort.confidence - (shortSorted[1]?.confidence ?? 0);
            if (buyMargin >= shortMargin) primaryShort = shortSorted[1] ?? null;
            else                          primaryBuy   = longSorted[1]  ?? null;
        }

        if (primaryBuy || primaryShort) {
            console.log(`[AutonomousScreener] Signal found — dispatching to Discord...`);
            processDiscordSignalAlert(primaryBuy, primaryShort, 'Robot2 • Sub-$1 Scanner 2min');
        } else {
            console.log(`[AutonomousScreener] No coin met minimum thresholds — no alert sent.`);
        }

    } catch (criticalErr) {
        console.error('[AutonomousScreener] Critical cycle failure:', criticalErr.message);
    } finally {
        setTimeout(autonomousDynamicScreenerPipeline, CONFIG.DYNAMIC.SCREENER_INTERVAL_MS);
    }
}

// ── BOOT: Dono pipelines simultaneously start honge ──
coreMarketIntelligencePipeline();       // Robot 1: Major coins (BTC/ETH/SOL) — har 30s
autonomousDynamicScreenerPipeline();    // Robot 2: Sub-$1 full market scanner — har 2 min

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE IN-MEMORY RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitStore = new Map();
function rateLimit(req, res, next) {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const rec = rateLimitStore.get(ip);
    if (!rec || now > rec.resetAt) {
        rateLimitStore.set(ip, { count: 1, resetAt: now + 60000 });
        return next();
    }
    rec.count++;
    if (rec.count > 60) {
        return res.status(429).json({ error: 'Rate limit exceeded — max 60 requests/minute' });
    }
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of rateLimitStore.entries()) {
        if (now > rec.resetAt) rateLimitStore.delete(ip);
    }
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP & ROUTING LAYERS
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

app.use(express.json({ limit: '200kb' }));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((entry) => entry.trim()).filter(Boolean) : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
}));

const VALID_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];
const DEFAULT_TIMEFRAME = '1h';

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const current = loginAttempts.get(ip);

    if (!current || now > current.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
        return next();
    }

    current.count += 1;
    if (current.count > 10) {
        return res.status(429).json({ message: 'Too many login attempts. Please try again shortly.' });
    }

    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of loginAttempts.entries()) {
        if (now > record.resetAt) loginAttempts.delete(ip);
    }
}, 15 * 60 * 1000);

app.post('/api/auth/login', loginRateLimit, (req, res) => {
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const rememberMe = Boolean(req.body?.rememberMe);

    if (!identifier || !password) {
        return res.status(400).json({ message: 'Invalid email or password.' });
    }

    if (!AUTH_CONFIG.ADMIN_EMAIL || !AUTH_CONFIG.ADMIN_PASSWORD) {
        return res.status(503).json({ message: 'Authentication is not configured on the server.' });
    }

    const normalizedIdentifier = identifier.toLowerCase();
    const normalizedEmail = AUTH_CONFIG.ADMIN_EMAIL.toLowerCase();
    const normalizedUsername = AUTH_CONFIG.ADMIN_USERNAME.toLowerCase();
    const validCredentials = normalizedIdentifier === normalizedEmail || normalizedIdentifier === normalizedUsername;

    if (!validCredentials || password !== AUTH_CONFIG.ADMIN_PASSWORD) {
        return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const ttlMs = rememberMe ? AUTH_CONFIG.SESSION_TTL_MS : Math.min(60 * 60 * 1000, AUTH_CONFIG.SESSION_TTL_MS);
    const token = createSessionToken({ user: { email: AUTH_CONFIG.ADMIN_EMAIL, username: AUTH_CONFIG.ADMIN_USERNAME || AUTH_CONFIG.ADMIN_EMAIL }, rememberMe }, ttlMs);
    setSessionCookie(res, token, ttlMs);

    return res.json({ ok: true, message: 'Authentication successful.' });
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true, message: 'Signed out.' });
});

app.get('/api/auth/me', (req, res) => {
    const cookies = parseCookies(req);
    const session = verifySessionToken(cookies[AUTH_CONFIG.COOKIE_NAME]);

    if (!session) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    return res.json({ ok: true, user: session.user });
});

// ── ENDPOINT 1: STATIC/STANDARD WATCHLIST SIGNALS (UNTOUCHED 🟢)
app.get('/api/signals', rateLimit, async (req, res) => {
    const timeframe = req.query.timeframe ?? DEFAULT_TIMEFRAME;

    if (!VALID_TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `Invalid timeframe. Valid options: ${VALID_TIMEFRAMES.join(', ')}` });
    }

    if (timeframe === DEFAULT_TIMEFRAME) {
        if (marketIntelligenceState.engineStatus === 'initializing') {
            return res.status(202).json({ message: 'Engine initializing — first scan in progress. Try again in 30s.' });
        }
        return res.json({ ...marketIntelligenceState, requestedTimeframe: timeframe });
    }

    try {
        await ensureMarketsLoaded();
        const freshSignals = [];
        const freshErrors  = {};

        for (const symbol of CONFIG.TARGET_COINS) {
            try {
                const signal = await processAssetIntelligence(symbol, timeframe);
                freshSignals.push(signal);
            } catch (err) {
                const coin = symbol.split('/')[0];
                freshErrors[coin] = err.message;
            }
        }

        if (freshSignals.length === 0) {
            return res.status(503).json({ error: 'All coins failed to scan', errors: freshErrors });
        }

        const buyCandidates  = freshSignals.filter(s => s.action === 'BUY');
        const sellCandidates = freshSignals.filter(s => s.action === 'SELL');
        let activeTrend = 'SIDEWAYS';
        let marketStance = 'PRESERVE_CAPITAL';
        if (buyCandidates.length >= 2 && buyCandidates.length > sellCandidates.length) {
            activeTrend = 'BULLISH'; marketStance = 'AGGRESSIVE_ACCUMULATION_ON_SUPPORT';
        } else if (sellCandidates.length >= 2 && sellCandidates.length > buyCandidates.length) {
            activeTrend = 'BEARISH'; marketStance = 'HEDGE_EXPOSURE_EXECUTE_SHORTS';
        }

        const longSorted  = freshSignals.filter(s => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
        const shortSorted = freshSignals.filter(s => s.action === 'SELL').sort((a, b) => b.confidence - a.confidence);
        let primaryBuy   = longSorted[0]  ?? null;
        let primaryShort = shortSorted[0] ?? null;

        if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin) {
            const buyMargin   = primaryBuy.confidence   - (longSorted[1]?.confidence  ?? 0);
            const shortMargin = primaryShort.confidence - (shortSorted[1]?.confidence ?? 0);
            if (buyMargin >= shortMargin) primaryShort = shortSorted[1]  ?? null;
            else                          primaryBuy   = longSorted[1] ?? null;
        }

        return res.json({
            requestedTimeframe: timeframe,
            marketTrend:        activeTrend,
            recommendedStance:  marketStance,
            strongestSectors:   buyCandidates.map(c => c.coin),
            weakestSectors:     sellCandidates.map(c => c.coin),
            buySignal:   primaryBuy   ? { symbol: primaryBuy.coin,   price: primaryBuy.entry,   confidence: primaryBuy.confidence,   reason: primaryBuy.reasons[0]   ?? 'Bullish confluence detected', type: 'LONG'  } : null,
            shortSignal: primaryShort ? { symbol: primaryShort.coin, price: primaryShort.entry, confidence: primaryShort.confidence, reason: primaryShort.reasons[0] ?? 'Bearish confluence detected', type: 'SHORT' } : null,
            allSignals:         freshSignals,
            lastSyncTimestamp:  new Date().toISOString(),
            engineStatus:       Object.keys(freshErrors).length > 0 ? 'degraded' : 'ok',
            errors:             freshErrors,
        });

    } catch (criticalErr) {
        res.status(500).json({ error: criticalErr.message });
    }
});

// ── 🧠 ENDPOINT 2: AUTOMATED DYNAMIC SCREENER ROUTE (BRAND NEW ADDTION 🚀)
app.get('/api/signals/dynamic', rateLimit, async (req, res) => {
    const timeframe = req.query.timeframe ?? DEFAULT_TIMEFRAME;

    if (!VALID_TIMEFRAMES.includes(timeframe)) {
        return res.status(400).json({ error: `Invalid timeframe. Options: ${VALID_TIMEFRAMES.join(', ')}` });
    }

    try {
        // Trigger screener — cache hit ya fresh scan
        const fluidTargetWatchlist = await runDynamicVolumePriceScreener();
        
        const freshSignals = [];
        const freshErrors = {};

        // Sequential multi-threading protection loops over dynamic scanned coins
        for (const symbol of fluidTargetWatchlist) {
            try {
                const signal = await processAssetIntelligence(symbol, timeframe);
                freshSignals.push(signal);
                console.log(`  [Dynamic/${timeframe}] ✓ ${signal.coin.padEnd(6)} | ${signal.action.padEnd(5)} | Vol Rank Safe`);
            } catch (err) {
                const coin = symbol.split('/')[0];
                freshErrors[coin] = err.message;
                console.error(`  [Dynamic/${timeframe}] ✗ ${coin}: ${err.message}`);
            }
        }

        if (freshSignals.length === 0) {
            return res.status(503).json({ error: 'All dynamic filtered assets failed to process calculations', errors: freshErrors });
        }

        // Structural classifications matching the primary engine logic templates
        const buyCandidates = freshSignals.filter(s => s.action === 'BUY');
        const sellCandidates = freshSignals.filter(s => s.action === 'SELL');
        
        let activeTrend = 'SIDEWAYS';
        let marketStance = 'PRESERVE_CAPITAL';
        
        if (buyCandidates.length >= 2 && buyCandidates.length > sellCandidates.length) {
            activeTrend = 'BULLISH'; marketStance = 'AGGRESSIVE_ACCUMULATION_ON_SUPPORT';
        } else if (sellCandidates.length >= 2 && sellCandidates.length > buyCandidates.length) {
            activeTrend = 'BEARISH'; marketStance = 'HEDGE_EXPOSURE_EXECUTE_SHORTS';
        }

        const longSorted = freshSignals.filter(s => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
        const shortSorted = freshSignals.filter(s => s.action === 'SELL').sort((a, b) => b.confidence - a.confidence);
        let primaryBuy = longSorted[0] ?? null;
        let primaryShort = shortSorted[0] ?? null;

        if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin) {
            const buyMargin = primaryBuy.confidence - (longSorted[1]?.confidence ?? 0);
            const shortMargin = primaryShort.confidence - (shortSorted[1]?.confidence ?? 0);
            if (buyMargin >= shortMargin) primaryShort = shortSorted[1] ?? null;
            else primaryBuy = longSorted[1] ?? null;
        }

        // ── Dynamic route Discord dispatch ───────────────────────────────
        // Same shared function — sub-$1 coins ke signals bhi Discord par jayenge
        processDiscordSignalAlert(primaryBuy, primaryShort, 'API • Dynamic Route');

        // Return pristine layout structures matching your core UI state expectation maps
        return res.json({
            requestedTimeframe: timeframe,
            marketTrend: activeTrend,
            recommendedStance: marketStance,
            strongestSectors: buyCandidates.map(c => c.coin),
            weakestSectors: sellCandidates.map(c => c.coin),
            buySignal: primaryBuy ? { symbol: primaryBuy.coin, price: primaryBuy.entry, confidence: primaryBuy.confidence, reason: primaryBuy.reasons[0] ?? 'Dynamic trend velocity buy', type: 'LONG' } : null,
            shortSignal: primaryShort ? { symbol: primaryShort.coin, price: primaryShort.entry, confidence: primaryShort.confidence, reason: primaryShort.reasons[0] ?? 'Dynamic velocity break short', type: 'SHORT' } : null,
            allSignals: freshSignals,
            lastSyncTimestamp: new Date().toISOString(),
            engineStatus: Object.keys(freshErrors).length > 0 ? 'degraded' : 'ok',
            errors: freshErrors,
            // Dynamic screener meta — frontend visibility
            screenerMeta: {
                scannedCoins:    fluidTargetWatchlist,             // exactly which coins were picked
                priceFilter:     `<= $${CONFIG.DYNAMIC.MAX_PRICE_FILTER}`,
                volumeFilter:    `>= $${(CONFIG.DYNAMIC.MIN_24H_VOLUME_USD / 1_000_000).toFixed(0)}M 24h`,
                cacheStatus:     screenerCache.isValid() ? 'cached' : 'fresh',
                cacheExpiresInS: Math.max(0, Math.round((screenerCache.cachedAt + screenerCache.TTL_MS - Date.now()) / 1000)),
            },
        });

    } catch (criticalDynamicErr) {
        console.error(`[DynamicScreenerRouter/Critical] Core crash node:`, criticalDynamicErr.message);
        res.status(500).json({ error: criticalDynamicErr.message });
    }
});

// Single coin endpoint
app.get('/api/signals/:coin', rateLimit, (req, res) => {
    const coin = req.params.coin?.toUpperCase();
    if (!coin || !/^[A-Z0-9]{2,10}$/.test(coin)) {
        return res.status(400).json({ error: 'Invalid coin symbol' });
    }
    const signal = marketIntelligenceState.allSignals?.find(s => s.coin === coin);
    if (!signal) return res.status(404).json({ error: `${coin} not found or not yet scanned` });
    res.json(signal);
});

// Health check
app.get('/api/health', (req, res) => {
    const ok = ['ok', 'degraded'].includes(marketIntelligenceState.engineStatus);
    res.status(ok ? 200 : 503).json({
        status: ok ? 'healthy' : 'unhealthy',
        engineStatus: marketIntelligenceState.engineStatus,
        lastScan: marketIntelligenceState.lastSyncTimestamp,
        scanCount: marketIntelligenceState.scanCount,
        errors: marketIntelligenceState.errors,
        circuitBreaker: { paused: cb.paused, errors: cb.errors },
        uptime: process.uptime(),
    });
});

// 404 catch-all
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ─────────────────────────────────────────────────────────────────────────────
// SERVER BOOT
// ─────────────────────────────────────────────────────────────────────────────

const server = app.listen(CONFIG.PORT, () => {
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  CRYPTO INTELLIGENCE ENGINE v3.0          ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`[API]  Live on http://localhost:${CONFIG.PORT}`);
    console.log(`[API]  GET /api/signals         — Full scan results (default: 1h cached)`);
    console.log(`[API]  GET /api/signals/dynamic — 🧠 REAL-TIME FULL MARKET VOL-SCREENER`);
    console.log(`[API]  GET /api/signals/:coin   — Single coin`);
    console.log(`[API]  GET /api/health          — Health check`);
});

const shutdown = (sig) => {
    console.log(`\n[Server] ${sig} — shutting down gracefully`);
    server.close(() => { console.log('[Server] Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled rejection:', reason);
});