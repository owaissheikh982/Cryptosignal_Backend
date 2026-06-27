import express from 'express';
import cors from 'cors';
import ccxt from 'ccxt';
import pkg from 'technicalindicators';

const { RSI, MACD, EMA, BollingerBands, ATR, StochasticRSI } = pkg;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — single place to change everything
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
    TARGET_COINS: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'PEPE/USDT', 'LINK/USDT', 'XRP/USDT'],
    CANDLE_LIMIT: 260,          // EMA200 needs 200+, 260 gives warmup buffer
    REFRESH_INTERVAL_MS: 30000, // 30s — respectful of rate limits
    PORT: 5000,

    // Scoring weights — must reflect indicator reliability
    WEIGHTS: {
        EMA_TREND: 30,   // strongest: multi-period alignment is robust
        MACD: 20,   // reliable momentum indicator
        RSI: 15,   // oscillator — confirms, doesn't lead
        VOLUME: 15,   // confirms price moves
        STRUCTURE: 12,   // support/resistance
        STOCH_RSI: 8,   // fine-tuning oscillator
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

// ─────────────────────────────────────────────────────────────────────────────
// EXCHANGE — rate limit safe, timeout set
// ─────────────────────────────────────────────────────────────────────────────

// BUG FIX #1: Variable naam "binance" misleading tha — actually KuCoin use ho raha hai
// Rename kiya: binance → exchange (future exchange swap bhi easy hoga)
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

    // CRITICAL FIX: normalize histogram by price to make cross-coin comparable
    // BTC histogram of 100 is noise; PEPE histogram of 0.000001 is huge — without
    // normalization, large-cap coins always dominate the score unfairly.
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

    // Score 0-6: each true condition adds 1
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
        isPriceUp: priceCh > 0, // direction flag — computeScore ko closes array pass karne ki zaroorat nahi
    };
}

function computeMarketStructure(ohlcv) {
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const price = ohlcv[ohlcv.length - 1][4];

    // Recent 10-candle high/low for support & resistance
    const recentHighs = highs.slice(-10);
    const recentLows = lows.slice(-10);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);

    return {
        support: +support.toFixed(8),
        resistance: +resistance.toFixed(8),
        breakout: price > resistance * 0.998,
        breakdown: price < support * 1.002,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE — weighted, deterministic, bounded 0-100
// ─────────────────────────────────────────────────────────────────────────────

// closes parameter removed — volume object mein isPriceUp flag already calculated hai
function computeScore(price, rsi, macd, ema, bb, stoch, volume, structure) {
    let longPoints = 0;
    let shortPoints = 0;
    const reasons = [];
    const W = CONFIG.WEIGHTS;

    // ── EMA Trend (weight 30) ──────────────────────────────────────────────
    // Score 0-6: EMA alignment — direct bullish/bearish signal
    if (ema) {
        // Bullish points: score/6 fraction of full weight
        const emaBullPct = ema.score / 6;        // 0.0 to 1.0
        const emaBearPct = (6 - ema.score) / 6;  // 1.0 to 0.0

        longPoints  += emaBullPct * W.EMA_TREND;
        shortPoints += emaBearPct * W.EMA_TREND;

        if (ema.fullyAlignedBull) reasons.push('Full bullish EMA alignment (price > EMA20 > EMA50 > EMA200)');
        else if (ema.fullyAlignedBear) reasons.push('Full bearish EMA alignment (price < EMA20 < EMA50 < EMA200)');
        else if (ema.goldenCross) reasons.push('EMA20 crossed above EMA50 — bullish signal');
        else if (ema.deathCross) reasons.push('EMA20 crossed below EMA50 — bearish signal');
        else if (ema.score >= 4) reasons.push(`EMA stack bullish (${ema.score}/6 aligned)`);
        else if (ema.score <= 2) reasons.push(`EMA stack bearish (only ${ema.score}/6 aligned)`);
    }

    // ── MACD (weight 20) ───────────────────────────────────────────────────
    // Audit Fix #1: Histogram-only scoring mein "infinite points trap" tha
    // Bina crossover ke bhi pure 20pts mil jaate the — risky
    // Ab: crossover = full weight, histogram expand = capped at 60% of weight
    if (macd) {
        const rawStrength = Math.abs(macd.normalizedHistogram) * 3000;
        // Crossover nahi hua to max 60% weight — momentum confirm karta hai, lead nahi karta
        const histStrength = Math.min(W.MACD * 0.6, rawStrength);

        if (macd.crossover) {
            longPoints += W.MACD; // crossover = confirmed momentum = full points
            reasons.push('MACD bullish crossover — strong momentum signal');
        } else if (macd.crossunder) {
            shortPoints += W.MACD;
            reasons.push('MACD bearish crossunder — strong momentum signal');
        } else if (macd.bullish) {
            longPoints += histStrength; // capped at 12/20
            if (histStrength > W.MACD * 0.3) reasons.push('MACD histogram expanding bullish');
        } else if (macd.bearish) {
            shortPoints += histStrength; // capped at 12/20
            if (histStrength > W.MACD * 0.3) reasons.push('MACD histogram expanding bearish');
        }
        // Neutral (shrinking histogram) = no points — correct behaviour
    }

    // ── RSI (weight 15) ────────────────────────────────────────────────────
    // Oversold/overbought: full weight. Neutral: proportional partial score
    if (rsi) {
        if (rsi.oversold) {
            longPoints += W.RSI;
            reasons.push(`RSI oversold at ${rsi.value} — potential reversal zone`);
        } else if (rsi.overbought) {
            shortPoints += W.RSI;
            reasons.push(`RSI overbought at ${rsi.value} — potential reversal zone`);
        } else {
            // Neutral zone: linear scaling from 0 at RSI=50 to W.RSI at RSI=70/30
            // RSI 65 → bullish partial: (65-50)/20 * 15 = 11.25
            const rsiDelta = rsi.value - 50; // positive = bullish, negative = bearish
            if (rsiDelta > 0) {
                longPoints  += Math.min(W.RSI * 0.8, (rsiDelta / 20) * W.RSI);
            } else {
                shortPoints += Math.min(W.RSI * 0.8, (Math.abs(rsiDelta) / 20) * W.RSI);
            }
        }
    }

    // ── Volume (weight 15) ─────────────────────────────────────────────────
    // isPriceUp flag computeVolume mein pehle se calculate ho chuka hai
    // closes array ka yahan koi dependency nahi — clean aur thread-safe
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

    // ── Market Structure (weight 12) ───────────────────────────────────────
    if (structure) {
        if (structure.breakout) {
            longPoints  += W.STRUCTURE;
            reasons.push('Breakout above recent resistance zone');
        }
        if (structure.breakdown) {
            shortPoints += W.STRUCTURE;
            reasons.push('Breakdown below recent support zone');
        }
    }

    // ── StochRSI (weight 8) ────────────────────────────────────────────────
    if (stoch) {
        if (stoch.oversold && stoch.kAboveD) {
            longPoints  += W.STOCH_RSI;
            reasons.push('StochRSI oversold with K > D — bullish momentum building');
        } else if (stoch.overbought && !stoch.kAboveD) {
            shortPoints += W.STOCH_RSI;
            reasons.push('StochRSI overbought with K < D — bearish momentum building');
        } else if (stoch.kAboveD && !stoch.overbought) {
            longPoints  += W.STOCH_RSI * 0.4; // mild bullish bias
        } else if (!stoch.kAboveD && !stoch.oversold) {
            shortPoints += W.STOCH_RSI * 0.4; // mild bearish bias
        }
    }

    // ── Normalize to 0-100 ─────────────────────────────────────────────────
    // maxPossible = sum of all weights = 100
    const maxPossible = Object.values(W).reduce((a, b) => a + b, 0);
    const longScore  = Math.max(0, Math.min(100, Math.round((longPoints  / maxPossible) * 100)));
    const shortScore = Math.max(0, Math.min(100, Math.round((shortPoints / maxPossible) * 100)));

    // Fallback reason if nothing triggered
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

    // Widen stop slightly if volatility is high (risk-adjusted)
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

    const primaryRR = riskAmount > 0
        ? `1:${(riskAmount * CONFIG.RISK.TP_RATIOS[0] / riskAmount).toFixed(1)}`
        : 'N/A';

    return { entry, stop_loss, take_profit, risk_reward: primaryRR };
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSET ANALYSIS — processes one coin, returns full signal
// ─────────────────────────────────────────────────────────────────────────────

async function processAssetIntelligence(symbol) {
    const coinName = symbol.split('/')[0];

    if (cb.isOpen()) throw new Error('Circuit breaker open — skipping exchange calls');

    // Fetch ticker + 1H candles in parallel (5m and 1d removed — not used in scoring)
    const [ohlcv1h, ticker] = await Promise.all([
        withRetry(() => exchange.fetchOHLCV(symbol, '1h', undefined, CONFIG.CANDLE_LIMIT)),
        withRetry(() => exchange.fetchTicker(symbol)),
    ]);

    const currentPrice = ticker.last;
    if (!currentPrice || !Number.isFinite(currentPrice)) throw new Error(`Invalid price for ${symbol}`);
    if (ohlcv1h.length < 210) throw new Error(`Only ${ohlcv1h.length} candles for ${symbol} — need 210+`);

    const closes = ohlcv1h.map(c => c[4]);

    // ── Run all indicators ────────────────────────────────────────────────
    const rsi = computeRSI(closes);
    const macd = computeMACD(closes);
    const ema = computeEMAStack(closes);
    const bb = computeBB(closes);
    const atr = computeATR(ohlcv1h);
    const stoch = computeStochRSI(closes);
    const volume = computeVolume(ohlcv1h);
    const structure = computeMarketStructure(ohlcv1h);

    // ── Compute directional score ─────────────────────────────────────────
    const { longScore, shortScore, reasons } = computeScore(
        currentPrice, rsi, macd, ema, bb, stoch, volume, structure
    );

    // ── Determine action ──────────────────────────────────────────────────
    const T = CONFIG.THRESHOLDS;
    let action, confidence;

    // Audit Fix #3: Sideways trap — sirf spread check nahi tha
    // longScore=52, shortScore=49 par bhi BUY flash hota tha (3pts farq par!)
    // Ab minimum spread (separation) enforce kiya — false signals se bachao
    const scoreSpread = Math.abs(longScore - shortScore);
    const STRONG_SPREAD = 12; // Strong signal ke liye minimum 12pts gap
    const NORMAL_SPREAD = 6;  // Normal signal ke liye minimum 6pts gap

    if (longScore >= T.STRONG_BUY && longScore > shortScore && scoreSpread >= STRONG_SPREAD) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore >= T.STRONG_SELL && shortScore > longScore && scoreSpread >= STRONG_SPREAD) {
        action = 'SELL'; confidence = shortScore;
    } else if (longScore >= T.BUY && longScore > shortScore && scoreSpread >= NORMAL_SPREAD) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore >= T.SELL && shortScore > longScore && scoreSpread >= NORMAL_SPREAD) {
        action = 'SELL'; confidence = shortScore;
    } else {
        // Neutral / sideways — check for specific avoidance conditions
        const shouldAvoid = (rsi?.oversold && !macd?.bullish) || (rsi?.overbought && !macd?.bearish) || volume?.divergence;
        action = shouldAvoid ? 'AVOID' : 'HOLD';
        confidence = Math.max(longScore, shortScore);
    }

    // ── Risk score (volatility-derived, bounded) ───────────────────────────
    const riskScore = Math.max(10, Math.min(95,
        Math.round(20 + (atr?.pct ?? 2) * 5)
    ));

    // ── Trade parameters ──────────────────────────────────────────────────
    const isBuy = action === 'BUY';
    const { entry, stop_loss, take_profit, risk_reward } = computeTradeParams(
        currentPrice, atr, isBuy, riskScore
    );

    // ── Trend label ───────────────────────────────────────────────────────
    const trend = ema ? ema.trend : (currentPrice > closes[0] ? 'Bullish' : 'Bearish');

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
        reasons: reasons.length > 0 ? reasons : ['Market in equilibrium — no strong directional signal'],

        // Extra data for advanced frontends (won't break existing structure)
        indicators: {
            rsi: rsi ? { value: rsi.value, zone: rsi.oversold ? 'oversold' : rsi.overbought ? 'overbought' : 'neutral' } : null,
            macd: macd ? { bullish: macd.bullish, crossover: macd.crossover } : null,
            ema: ema ? { score: ema.score, trend: ema.trend } : null,
            atr: atr ? { pct: atr.pct, volatility: atr.volatility } : null,
            volume: volume ? { relativeVolume: volume.relativeVolume, spike: volume.spike } : null,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE — atomic, never half-written
// ─────────────────────────────────────────────────────────────────────────────

// Preserves exact same structure your frontend expects
let marketIntelligenceState = {
    marketTrend: 'NEUTRAL',
    recommendedStance: 'PRESERVE_CAPITAL',
    strongestSectors: [],
    weakestSectors: [],
    buySignal: null,
    shortSignal: null,
    allSignals: [],
    lastSyncTimestamp: null,
    // Added fields (non-breaking additions)
    scanCount: 0,
    engineStatus: 'initializing',
    errors: {},
};

let isRunning = false; // CRITICAL: prevents overlapping scan runs

// ─────────────────────────────────────────────────────────────────────────────
// CORE PIPELINE — sequential per coin, atomic state update
// ─────────────────────────────────────────────────────────────────────────────

async function coreMarketIntelligencePipeline() {
    // RACE CONDITION FIX: if previous scan still running, skip this tick
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

        // Sequential per coin — Binance free tier can't handle 6 concurrent OHLCV fetches
        // The original code's Promise.all for 6 × 4 timeframes = 24 concurrent requests
        // That triggers rate-limit errors and produces corrupt data silently
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

        // ── Classify market trend ───────────────────────────────────────────
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

        // ── Select best buy / short — must be different coins ─────────────
        const longSorted = [...freshSignals]
            .filter(s => s.action === 'BUY')
            .sort((a, b) => b.confidence - a.confidence);

        const shortSorted = [...freshSignals]
            .filter(s => s.action === 'SELL')
            .sort((a, b) => b.confidence - a.confidence);

        let primaryBuy = longSorted[0] ?? null;
        let primaryShort = shortSorted[0] ?? null;

        // Ensure different coins for buy vs short
        if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin) {
            const buyMargin = primaryBuy.confidence - (longSorted[1]?.confidence ?? 0);
            const shortMargin = primaryShort.confidence - (shortSorted[1]?.confidence ?? 0);
            if (buyMargin >= shortMargin) primaryShort = shortSorted[1] ?? null;
            else primaryBuy = longSorted[1] ?? null;
        }

        // ── ATOMIC STATE UPDATE — frontend reads consistent snapshot ───────
        marketIntelligenceState = {
            marketTrend: activeTrend,
            recommendedStance: marketStance,
            strongestSectors: buyCandidates.map(c => c.coin),
            weakestSectors: sellCandidates.map(c => c.coin),

            // Frontend-compatible buySignal / shortSignal structure preserved
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
                confidence: primaryShort.confidence,  // ab directly shortScore hai (0-100)
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
        if (primaryBuy) console.log(`  TOP LONG:  ${primaryBuy.coin}  @ $${primaryBuy.entry} (${primaryBuy.confidence}%)`);
        if (primaryShort) console.log(`  TOP SHORT: ${primaryShort.coin} @ $${primaryShort.entry} (${primaryShort.confidence}%)`);

    } catch (criticalErr) {
        console.error('[Pipeline] Critical error:', criticalErr.message);
        marketIntelligenceState = { ...marketIntelligenceState, engineStatus: 'error' };
    } finally {
        isRunning = false;
        scheduleNext();
    }
}

// Recursive setTimeout — prevents drift and ensures no overlap with interval
function scheduleNext() {
    setTimeout(coreMarketIntelligencePipeline, CONFIG.REFRESH_INTERVAL_MS);
}

// Boot immediately
coreMarketIntelligencePipeline();

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE IN-MEMORY RATE LIMITER — no extra dependencies
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
// Cleanup every minute
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of rateLimitStore.entries()) {
        if (now > rec.resetAt) rateLimitStore.delete(ip);
    }
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ?? '*',
    methods: ['GET'],
}));

// Main endpoint — SAME URL as original, same response shape
app.get('/api/signals', rateLimit, (req, res) => {
    if (marketIntelligenceState.engineStatus === 'initializing') {
        return res.status(202).json({ message: 'Engine initializing — first scan in progress. Try again in 30s.' });
    }
    res.json(marketIntelligenceState);
});

// Single coin endpoint (new, non-breaking addition)
app.get('/api/signals/:coin', rateLimit, (req, res) => {
    const coin = req.params.coin?.toUpperCase();
    if (!coin || !/^[A-Z0-9]{2,10}$/.test(coin)) {
        return res.status(400).json({ error: 'Invalid coin symbol' });
    }
    const signal = marketIntelligenceState.allSignals?.find(s => s.coin === coin);
    if (!signal) return res.status(404).json({ error: `${coin} not found or not yet scanned` });
    res.json(signal);
});

// Health check — for uptime monitors
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
    console.log(`[API]  GET /api/signals         — Full scan results`);
    console.log(`[API]  GET /api/signals/:coin   — Single coin`);
    console.log(`[API]  GET /api/health          — Health check`);
});

// Graceful shutdown
const shutdown = (sig) => {
    console.log(`\n[Server] ${sig} — shutting down gracefully`);
    server.close(() => { console.log('[Server] Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled rejection:', reason);
    // Do NOT crash — log and continue
});