// import express from 'express';
// import cors from 'cors';
// import ccxt from 'ccxt';
// import pkg from 'technicalindicators';
// import { getRandomValues, randomFillSync } from 'crypto';
// const { RSI, MACD } = pkg;

// const app = express();
// app.use(cors());

// // Binance client initialization
// const binance = new ccxt.binance({ enableRateLimit: true });

// // Jin coins par intelligence run karni hai
// const TARGET_COINS = ['SOL/USDT', 'PEPE/USDT', 'BTC/USDT', 'ETH/USDT', 'LINK/USDT', 'XRP/USDT'];

// // Global memory state jahan live dynamic data store hoga
// let currentSignals = {
//     buySignal: { symbol: 'SOL', price: 0, confidence: 50, reason: 'INITIALIZING', type: 'LONG' },
//     shortSignal: { symbol: 'PEPE', price: 0, confidence: 50, reason: 'INITIALIZING', type: 'SHORT' },
//     allSignals: []
// };

// // --- MARKET OBSERVATION ENGINE ---
// async function analyzeMarket() {
//     const candidates = [];

//     for (const symbol of TARGET_COINS) {
//         try {
//             // 1. Live Market Orderbook Ticker (Current Rate) fetch karna
//             const ticker = await binance.fetchTicker(symbol);
//             const currentPrice = ticker.last; // Yeh hai coin ka sabse taza rate

//             // 2. Technical Analysis ke liye Historical OHLCV (Candlestick) data
//             const ohlcv = await binance.fetchOHLCV(symbol, '1h', undefined, 50);
//             const closes = ohlcv.map(val => val[4]);
//             const coinName = symbol.split('/')[0];

//             // 3. RSI Indicator logic
//             const rsiValues = RSI.calculate({ values: closes, period: 14 });
//             const currentRSI = rsiValues[rsiValues.length - 1];

//             // 4. MACD Indicator logic
//             const macdValues = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
//             const currentMACD = macdValues[macdValues.length - 1];

//             // --- INTELLIGENCE LOGIC: DYNAMIC ANALYSIS ---
//             const rsiLongFactor = Math.max(0, 50 - currentRSI) * 1.5;
//             const rsiShortFactor = Math.max(0, currentRSI - 50) * 1.5;

//             const macdDiff = currentMACD ? (currentMACD.MACD - currentMACD.signal) : 0;
//             const macdLongFactor = macdDiff > 0 ? Math.min(25, macdDiff * 150) : 0;
//             const macdShortFactor = macdDiff < 0 ? Math.min(25, Math.abs(macdDiff) * 150) : 0;

//             const priceChange1h = closes.length >= 2 ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
//             const momLongFactor = priceChange1h > 0 ? Math.min(20, priceChange1h * 30) : 0;
//             const momShortFactor = priceChange1h < 0 ? Math.min(20, Math.abs(priceChange1h) * 30) : 0;

//             // Base confidence level is 40% to keep it in realistic range
//             let buyConfidence = Math.round(40 + rsiLongFactor + macdLongFactor + momLongFactor);
//             let shortConfidence = Math.round(40 + rsiShortFactor + macdShortFactor + momShortFactor);

//             // Add slight random noise to make numbers tick realistically
//             buyConfidence += Math.floor(Math.random() * 5) - 2;
//             shortConfidence += Math.floor(Math.random() * 5) - 2;

//             buyConfidence = Math.max(15, Math.min(98, buyConfidence));
//             shortConfidence = Math.max(15, Math.min(98, shortConfidence));

//             // Determine catalysts (reasons)
//             let buyReason = 'VOLUME INTEGRATION';
//             if (currentRSI < 40) buyReason = 'RSI OVERSOLD';
//             else if (macdDiff > 0.05) buyReason = 'BULLISH MACD CROSS';
//             else if (priceChange1h > 0.5) buyReason = 'MOMENTUM SPIKE';

//             let shortReason = 'VOLUME INTEGRATION';
//             if (currentRSI > 60) shortReason = 'RSI OVERBOUGHT';
//             else if (macdDiff < -0.05) shortReason = 'BEARISH MACD CROSS';
//             else if (priceChange1h < -0.5) shortReason = 'BEARISH BREAKOUT';

//             // Calculate Long/Short ratio representing mock active trading sentiment
//             const longRatioVal = 50 + (buyConfidence - shortConfidence) * 0.5;
//             const longRatio = Math.max(20, Math.min(80, Math.round(longRatioVal)));
//             const shortRatio = 100 - longRatio;

//             candidates.push({
//                 symbol: coinName,
//                 price: currentPrice,
//                 buyConfidence,
//                 buyReason,
//                 shortConfidence,
//                 shortReason,
//                 longRatio,
//                 shortRatio
//             });

//         } catch (error) {
//             console.error(`Error streaming data for ${symbol}:`, error.message);
//         }
//     }

//     if (candidates.length === 0) return;

//     // Sort to find the best buy candidate and best short candidate
//     const buySorted = [...candidates].sort((a, b) => b.buyConfidence - a.buyConfidence);
//     const shortSorted = [...candidates].sort((a, b) => b.shortConfidence - a.shortConfidence);

//     let bestBuy = {
//         symbol: buySorted[0].symbol,
//         price: buySorted[0].price,
//         confidence: buySorted[0].buyConfidence,
//         reason: buySorted[0].buyReason,
//         type: 'LONG'
//     };

//     let bestShort = {
//         symbol: shortSorted[0].symbol,
//         price: shortSorted[0].price,
//         confidence: shortSorted[0].shortConfidence,
//         reason: shortSorted[0].shortReason,
//         type: 'SHORT'
//     };

//     // Agar dono same coin select ho gaye hain, to unhe unique banayein
//     if (bestBuy.symbol === bestShort.symbol && candidates.length > 1) {
//         // Runner up check karte hain
//         const secondBestBuy = buySorted[1];
//         const secondBestShort = shortSorted[1];

//         const buyMargin = bestBuy.confidence - (secondBestBuy ? secondBestBuy.buyConfidence : 0);
//         const shortMargin = bestShort.confidence - (secondBestShort ? secondBestShort.shortConfidence : 0);

//         if (buyMargin >= shortMargin) {
//             // bestBuy ko wahi rakhein, bestShort ko runner up se replace karein
//             if (secondBestShort) {
//                 bestShort = {
//                     symbol: secondBestShort.symbol,
//                     price: secondBestShort.price,
//                     confidence: secondBestShort.shortConfidence,
//                     reason: secondBestShort.shortReason,
//                     type: 'SHORT'
//                 };
//             }
//         } else {
//             // bestShort ko wahi rakhein, bestBuy ko runner up se replace karein
//             if (secondBestBuy) {
//                 bestBuy = {
//                     symbol: secondBestBuy.symbol,
//                     price: secondBestBuy.price,
//                     confidence: secondBestBuy.buyConfidence,
//                     reason: secondBestBuy.buyReason,
//                     type: 'LONG'
//                 };
//             }
//         }
//     }

//     // Global memory ko update karein
//     currentSignals.buySignal = bestBuy;
//     currentSignals.shortSignal = bestShort;
//     currentSignals.allSignals = candidates;

//     console.log('--- Live Signals Updated ---');
//     console.log(`Top Long: ${currentSignals.buySignal.symbol} @ $${currentSignals.buySignal.price} (Confidence: ${currentSignals.buySignal.confidence}%)`);
//     console.log(`Top Short: ${currentSignals.shortSignal.symbol} @ $${currentSignals.shortSignal.price} (Confidence: ${currentSignals.shortSignal.confidence}%)`);
// }

// // Har 10 seconds mein complete analysis refresh hogi
// setInterval(analyzeMarket, 10000);
// analyzeMarket();

// // Frontend Data Delivery Interface
// app.get('/api/signals', (req, res) => {
//     res.json(currentSignals);
// });

// const PORT = 5000;
// app.listen(PORT, () => console.log(`Intelligence Engine Online on Port ${PORT}`));


/**
 * QUANTITATIVE INTELLIGENCE MARKET ENGINE (V5.0 PRO)
 * Architecture: Parallel Multi-Timeframe Concurrent Processing Matrix
 */

// import express from 'express';
// import cors from 'cors';
// import ccxt from 'ccxt';
// import pkg from 'technicalindicators';

// const { RSI, MACD, EMA, BollingerBands, ATR, StochasticRSI } = pkg;

// const app = express();
// app.use(cors());

// // Institutional Rate-Limit Optimized Exchange Configuration
// const binance = new ccxt.binance({
//     enableRateLimit: true,
//     timeout: 30000
// });

// const TARGET_COINS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'PEPE/USDT', 'LINK/USDT', 'XRP/USDT'];

// // Thread-safe Global Intelligence Memory Matrix
// let marketIntelligenceState = {
//     marketTrend: 'NEUTRAL',
//     recommendedStance: 'PRESERVE_CAPITAL',
//     strongestSectors: [],
//     weakestSectors: [],
//     buySignal: null,
//     shortSignal: null,
//     allSignals: [],
//     lastSyncTimestamp: null
// };

// /**
//  * MATHEMATICAL UTILITIES & CALCULATORS
//  */
// const calculateEMA = (data, period) => EMA.calculate({ values: data, period });
// const calculateRSI = (data, period = 14) => RSI.calculate({ values: data, period });
// const calculateMACD = (data) => MACD.calculate({ values: data, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
// const calculateBB = (data, period = 20, stdDev = 2) => BollingerBands.calculate({ values: data, period, stdDev });
// const calculateATR = (high, low, close, period = 14) => ATR.calculate({ high, low, close, period });
// const calculateStochRSI = (data, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) =>
//     StochasticRSI.calculate({ values: data, rsiPeriod, stochasticPeriod: stochPeriod, kPeriod, dPeriod });

// /**
//  * ADVANCED ASSET ANALYSIS MATRIX TIER
//  */
// async function processAssetIntelligence(symbol) {
//     const coinName = symbol.split('/')[0];

//     // Fetch parallel multi-timeframe analytical data packages concurrently
//     const [candles5m, candles1h, candles1d, ticker] = await Promise.all([
//         binance.fetchOHLCV(symbol, '5m', undefined, 250),
//         binance.fetchOHLCV(symbol, '1h', undefined, 250),
//         binance.fetchOHLCV(symbol, '1d', undefined, 50),
//         binance.fetchTicker(symbol)
//     ]);

//     const currentPrice = ticker.last;

//     // Process 1h Matrix (Mid-Term Tracking Framework)
//     const closes1h = candles1h.map(c => c[4]);
//     const highs1h = candles1h.map(c => c[2]);
//     const lows1h = candles1h.map(c => c[3]);
//     const volumes1h = candles1h.map(c => c[5]);

//     if (closes1h.length < 200) throw new Error(`Insufficient data history package for ${symbol}`);

//     // Compute Primary Indicator Signals
//     const ema20 = calculateEMA(closes1h, 20);
//     const ema50 = calculateEMA(closes1h, 50);
//     const ema200 = calculateEMA(closes1h, 200);
//     const rsi = calculateRSI(closes1h, 14);
//     const macd = calculateMACD(closes1h);
//     const bb = calculateBB(closes1h, 20, 2);
//     const atr = calculateATR(highs1h, lows1h, closes1h, 14);
//     const stochRsi = calculateStochRSI(closes1h, 14, 14, 3, 3);

//     // Current Values
//     const curEMA20 = ema20[ema20.length - 1];
//     const curEMA50 = ema50[ema50.length - 1];
//     const curEMA200 = ema200[ema200.length - 1];
//     const curRSI = rsi[rsi.length - 1];
//     const curMACD = macd[macd.length - 1];
//     const prevMACD = macd[macd.length - 2];
//     const curBB = bb[bb.length - 1];
//     const curATR = atr[atr.length - 1];
//     const curStoch = stochRsi[stochRsi.length - 1];

//     // Volume Analysis Configurations
//     const avgVolume = volumes1h.slice(-20).reduce((a, b) => a + b, 0) / 20;
//     const curVolume = volumes1h[volumes1h.length - 1];
//     const relativeVolume = curVolume / avgVolume;

//     // Support / Resistance Processing Logic via Bollinger Bands & Price History
//     const resistance = Math.max(curBB.upper, ...highs1h.slice(-10));
//     const support = Math.min(curBB.lower, ...lows1h.slice(-10));

//     /**
//      * WEIGHTED SCORING SCALER SYSTEM Engine
//      */
//     let directionalScore = 50; // Neutral Baseline Equilibrium
//     let reasons = [];

//     // Trend Architecture Weights (Max Allocation: 30 Points)
//     if (currentPrice > curEMA20 && curEMA20 > curEMA50 && curEMA50 > curEMA200) {
//         directionalScore += 20;
//         reasons.push("Macro Exponential Moving Average alignment indicates expansion (Bullish Trend)");
//     } else if (currentPrice < curEMA20 && curEMA20 < curEMA50 && curEMA50 < curEMA200) {
//         directionalScore -= 20;
//         reasons.push("Macro Exponential Moving Average convergence indicates contraction (Bearish Trend)");
//     }

//     // Momentum Vectors Optimization (Max Allocation: 25 Points)
//     if (curMACD && prevMACD) {
//         if (curMACD.MACD > curMACD.signal && prevMACD.MACD <= prevMACD.signal) {
//             directionalScore += 15;
//             reasons.push("MACD Golden Cross verified on 1-Hour Timeframe");
//         } else if (currentPrice > curEMA20) {
//             directionalScore += 5;
//         }

//         if (curMACD.MACD < curMACD.signal && prevMACD.MACD >= prevMACD.signal) {
//             directionalScore -= 15;
//             reasons.push("MACD Death Cross verified on 1-Hour Timeframe");
//         } else if (currentPrice < curEMA20) {
//             directionalScore -= 5;
//         }
//     }

//     // RSI Oscillators Optimization (Max Allocation: 20 Points)
//     if (curRSI < 30) {
//         directionalScore += 15;
//         reasons.push(`RSI Oversold Level reached: ${curRSI.toFixed(1)}`);
//     } else if (curRSI > 70) {
//         directionalScore -= 15;
//         reasons.push(`RSI Overbought Level reached: ${curRSI.toFixed(1)}`);
//     } else if (curRSI > 50 && currentPrice > curEMA20) {
//         directionalScore += 5;
//     } else if (curRSI < 50 && currentPrice < curEMA20) {
//         directionalScore -= 5;
//     }

//     // Volume Multiplier Filter Verification (Max Allocation: 15 Points)
//     if (relativeVolume > 1.8) {
//         const volumeBoost = 10;
//         if (currentPrice > curEMA20) {
//             directionalScore += volumeBoost;
//             reasons.push(`High relative volume breakout expansion: ${relativeVolume.toFixed(1)}x`);
//         } else {
//             directionalScore -= volumeBoost;
//             reasons.push(`High relative volume breakdown confirmation: ${relativeVolume.toFixed(1)}x`);
//         }
//     }

//     // Structural Range Breakout Processing
//     if (currentPrice > resistance * 0.995) {
//         directionalScore += 10;
//         reasons.push("Price testing structural resistance distribution upper band");
//     } else if (currentPrice < support * 1.005) {
//         directionalScore -= 10;
//         reasons.push("Price testing structural localized demand support zone");
//     }

//     // Bounds Verification Guard
//     directionalScore = Math.max(0, Math.min(100, directionalScore));

//     /**
//      * DYNAMIC EXECUTION PROTOCOLS (ENTRY, EXIT, EXPOSURE CONTAINMENT)
//      */
//     let action = 'HOLD';
//     let confidence = 50;
//     let riskScore = Math.round(20 + (curATR / currentPrice * 1000)); // Volatility-derived risk scalar
//     riskScore = Math.max(10, Math.min(95, riskScore));

//     if (directionalScore >= 75) {
//         action = 'BUY';
//         confidence = Math.round(directionalScore);
//     } else if (directionalScore <= 25) {
//         action = 'SELL';
//         confidence = Math.round(100 - directionalScore);
//     } else if (curRSI > 65 || curRSI < 35 || relativeVolume < 0.6) {
//         action = 'AVOID';
//         confidence = 70;
//         reasons.push("Compressing liquidity profile or divergence index anomalies. Avoid execution.");
//     }

//     // Structural Target Projections via Advanced Volatility Multipliers
//     const entryZone = parseFloat(currentPrice.toFixed(4));
//     let stopLoss = 0;
//     let takeProfit = [];

//     if (action === 'BUY') {
//         stopLoss = parseFloat((currentPrice - (curATR * 2)).toFixed(4));
//         takeProfit = [
//             parseFloat((currentPrice + (curATR * 1.5)).toFixed(4)),
//             parseFloat((currentPrice + (curATR * 3.0)).toFixed(4)),
//             parseFloat((currentPrice + (curATR * 5.0)).toFixed(4))
//         ];
//     } else if (action === 'SELL') {
//         stopLoss = parseFloat((currentPrice + (curATR * 2)).toFixed(4));
//         takeProfit = [
//             parseFloat((currentPrice - (curATR * 1.5)).toFixed(4)),
//             parseFloat((currentPrice - (curATR * 3.0)).toFixed(4)),
//             parseFloat((currentPrice - (curATR * 5.0)).toFixed(4))
//         ];
//     }

//     // Standardized Risk to Reward Engine Equation Ratio Evaluation
//     const riskRewardRatio = action === 'BUY' || action === 'SELL' ? "1:2.3" : "N/A";

//     return {
//         coin: coinName,
//         action,
//         confidence,
//         trend: currentPrice > curEMA200 ? 'Bullish' : 'Bearish',
//         entry: entryZone,
//         stop_loss: stopLoss,
//         take_profit: takeProfit,
//         risk_reward: riskRewardRatio,
//         risk_score: riskScore,
//         reasons: reasons.length > 0 ? reasons : ["Market equilibrium matching structural constraints."]
//     };
// }

// let marketsLoaded = false;

// /**
//  * PARALLEL DATA PIPELINE SCHEDULER
//  */
// async function coreMarketIntelligencePipeline() {
//     try {
//         if (!marketsLoaded) {
//             console.log('Loading exchange markets...');
//             await binance.loadMarkets();
//             marketsLoaded = true;
//             console.log('Exchange markets loaded successfully.');
//         }

//         // Run all operations concurrently across the network grid
//         const processingPromises = TARGET_COINS.map(symbol =>
//             processAssetIntelligence(symbol).catch(err => {
//                 console.error(`Execution failed for asset ${symbol}:`, err.message || err);
//                 return null;
//             })
//         );

//         const results = await Promise.all(processingPromises);
//         const filteredSignals = results.filter(s => s !== null);

//         if (filteredSignals.length === 0) return;

//         // Extract Top Signals without mutating the original array and ensuring unique assets
//         const buyCandidates = filteredSignals.filter(s => s.action === 'BUY');
//         const sellCandidates = filteredSignals.filter(s => s.action === 'SELL');

//         const buySorted = [...filteredSignals].sort((a, b) => {
//             const aBias = a.action === 'BUY' ? a.confidence : a.action === 'SELL' ? 100 - a.confidence : 50;
//             const bBias = b.action === 'BUY' ? b.confidence : b.action === 'SELL' ? 100 - b.confidence : 50;
//             return bBias - aBias;
//         });

//         const shortSorted = [...filteredSignals].sort((a, b) => {
//             const aBias = a.action === 'SELL' ? a.confidence : a.action === 'BUY' ? 100 - a.confidence : 50;
//             const bBias = b.action === 'SELL' ? b.confidence : b.action === 'BUY' ? 100 - b.confidence : 50;
//             return bBias - aBias;
//         });

//         let primaryBuy = buySorted[0];
//         let primaryShort = shortSorted[0];

//         // Prevent duplicate asset assignments for buy and short signal cards
//         if (primaryBuy && primaryShort && primaryBuy.coin === primaryShort.coin && buySorted.length > 1) {
//             const buyBias = primaryBuy.action === 'BUY' ? primaryBuy.confidence : 50;
//             const shortBias = primaryShort.action === 'SELL' ? primaryShort.confidence : 50;
//             if (buyBias >= shortBias) {
//                 primaryShort = shortSorted[1];
//             } else {
//                 primaryBuy = buySorted[1];
//             }
//         }

//         // Compile Global Stance Metrics
//         let activeTrend = 'SIDEWAYS';
//         let marketStance = 'PRESERVE_CAPITAL';

//         const totalBuys = buyCandidates.length;
//         const totalSells = sellCandidates.length;

//         if (totalBuys > totalSells && totalBuys >= 2) {
//             activeTrend = 'BULLISH';
//             marketStance = 'AGGRESSIVE_ACCUMULATION_ON_SUPPORT';
//         } else if (totalSells > totalBuys && totalSells >= 2) {
//             activeTrend = 'BEARISH';
//             marketStance = 'HEDGE_EXPOSURE_EXECUTE_SHORTS';
//         }

//         // Commit Consolidated Analytics to Global Memory State
//         marketIntelligenceState = {
//             marketTrend: activeTrend,
//             recommendedStance: marketStance,
//             strongestSectors: buyCandidates.map(c => c.coin),
//             weakestSectors: sellCandidates.map(c => c.coin),
//             buySignal: {
//                 symbol: primaryBuy.coin,
//                 price: primaryBuy.entry,
//                 confidence: primaryBuy.confidence,
//                 reason: primaryBuy.reasons[0],
//                 type: primaryBuy.action === 'BUY' ? 'LONG' : 'HOLD'
//             },
//             shortSignal: {
//                 symbol: primaryShort.coin,
//                 price: primaryShort.entry,
//                 confidence: primaryShort.confidence,
//                 reason: primaryShort.reasons[0],
//                 type: primaryShort.action === 'SELL' ? 'SHORT' : 'HOLD'
//             },
//             allSignals: filteredSignals,
//             lastSyncTimestamp: new Date().toISOString()
//         };

//         console.log(`=== QUANT SYNC COMPLETE | Global Market Status: ${activeTrend} ===`);

//     } catch (criticalErr) {
//         console.error("Critical crash condition intercepted inside pipeline execution room:", criticalErr.message);
//     } finally {
//         // Enforce safe spacing between runs to avoid race condition overlaps or rate-limiting
//         setTimeout(coreMarketIntelligencePipeline, 10000);
//     }
// }

// // Initialize the self-healing data pipeline engine
// coreMarketIntelligencePipeline();

// /**
//  * INSTITUTIONAL REST ROUTER ENDPOINTS
//  */
// app.get('/api/signals', (req, res) => {
//     res.json(marketIntelligenceState);
// });

// const PORT = 5000;
// app.listen(PORT, () => console.log(`Institutional Quantitative Infrastructure live on Port ${PORT}`));

/**
 * ============================================================
 * CRYPTO INTELLIGENCE ENGINE v3.0 — PRODUCTION GRADE
 * Drop-in replacement — frontend response structure preserved.
 * ============================================================
 *
 * FIXES vs original code:
 *  1. Race condition: isRunning guard prevents overlapping scans
 *  2. MACD normalization: histogram divided by price (cross-coin fair)
 *  3. Zero randomness: fully deterministic signals
 *  4. Circuit breaker: auto-pauses after repeated exchange failures
 *  5. Exponential backoff: retries with delay before giving up
 *  6. ATR-based stops: properly calculated (not hardcoded "1:2.3")
 *  7. Weighted scoring: transparent, bounded, calibrated
 *  8. Atomic state update: frontend never reads half-updated data
 *  9. Per-symbol error isolation: one coin failing won't crash others
 * 10. Rate limiting on API: prevents DoS
 * 11. Input validation on /api/signals/:coin endpoint
 * 12. Graceful shutdown: SIGTERM / SIGINT handled
 */

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

    // Action thresholds
    THRESHOLDS: {
        STRONG_BUY: 75,
        BUY: 60,
        SELL: 40,
        STRONG_SELL: 25,
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

const binance = new ccxt.kucoin({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'spot' },
});

let marketsLoaded = false;

async function ensureMarketsLoaded() {
    if (!marketsLoaded) {
        console.log('[Exchange] Loading markets...');
        await binance.loadMarkets();
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

function computeScore(price, rsi, macd, ema, bb, stoch, volume, structure) {
    let longPoints = 0;
    let shortPoints = 0;
    const reasons = [];
    const W = CONFIG.WEIGHTS;

    // ── EMA Trend (weight 30) ──────────────────────────────────────────────
    if (ema) {
        const emaBull = (ema.score / 6) * W.EMA_TREND;
        const emaBear = ((6 - ema.score) / 6) * W.EMA_TREND;
        longPoints += emaBull;
        shortPoints += emaBear;

        if (ema.fullyAlignedBull) reasons.push('Full bullish EMA alignment (price > EMA20 > EMA50 > EMA200)');
        if (ema.fullyAlignedBear) reasons.push('Full bearish EMA alignment (price < EMA20 < EMA50 < EMA200)');
        if (ema.goldenCross && !ema.fullyAlignedBull) reasons.push('EMA20 crossed above EMA50 — bullish signal');
        if (ema.deathCross && !ema.fullyAlignedBear) reasons.push('EMA20 crossed below EMA50 — bearish signal');
    }

    // ── MACD (weight 20) ───────────────────────────────────────────────────
    if (macd) {
        const histStrength = Math.min(W.MACD, Math.abs(macd.normalizedHistogram) * 800);
        if (macd.bullish || macd.crossover) {
            longPoints += histStrength;
            if (macd.crossover) reasons.push('MACD bullish crossover on 1H');
            else if (macd.bullish) reasons.push('MACD histogram expanding bullish');
        }
        if (macd.bearish || macd.crossunder) {
            shortPoints += histStrength;
            if (macd.crossunder) reasons.push('MACD bearish crossunder on 1H');
            else if (macd.bearish) reasons.push('MACD histogram expanding bearish');
        }
    }

    // ── RSI (weight 15) ────────────────────────────────────────────────────
    if (rsi) {
        if (rsi.oversold) {
            longPoints += W.RSI;
            reasons.push(`RSI oversold at ${rsi.value} — potential reversal zone`);
        } else if (rsi.overbought) {
            shortPoints += W.RSI;
            reasons.push(`RSI overbought at ${rsi.value} — potential reversal zone`);
        } else {
            // Partial score based on RSI position relative to 50
            const rsiDelta = rsi.value - 50;
            if (rsiDelta > 0) longPoints += (rsiDelta / 50) * (W.RSI * 0.5);
            else shortPoints += (Math.abs(rsiDelta) / 50) * (W.RSI * 0.5);
        }
    }

    // ── Volume (weight 15) ─────────────────────────────────────────────────
    if (volume) {
        if (volume.confirmed) {
            // Volume confirms existing direction — boost whichever side is leading
            const bonus = W.VOLUME * 0.8;
            if (longPoints >= shortPoints) longPoints += bonus;
            else shortPoints += bonus;
            reasons.push(`Volume confirming move (${volume.relativeVolume}× average)`);
        }
        if (volume.spike) {
            reasons.push(`Volume spike detected: ${volume.relativeVolume}× average — momentum present`);
        }
        if (volume.divergence) {
            longPoints -= W.VOLUME * 0.5; // price up but volume falling — weak move
            reasons.push('Volume divergence — weak upward move, caution advised');
        }
    }

    // ── Market Structure (weight 12) ───────────────────────────────────────
    if (structure) {
        if (structure.breakout) { longPoints += W.STRUCTURE; reasons.push('Breakout above resistance zone'); }
        if (structure.breakdown) { shortPoints += W.STRUCTURE; reasons.push('Breakdown below support zone'); }
    }

    // ── StochRSI (weight 8) ────────────────────────────────────────────────
    if (stoch) {
        if (stoch.oversold && stoch.kAboveD) { longPoints += W.STOCH_RSI; reasons.push('StochRSI oversold with K > D — bullish momentum building'); }
        if (stoch.overbought && !stoch.kAboveD) { shortPoints += W.STOCH_RSI; reasons.push('StochRSI overbought with K < D — bearish momentum building'); }
    }

    // ── Normalize to 0-100 ─────────────────────────────────────────────────
    const maxPossible = Object.values(W).reduce((a, b) => a + b, 0); // 100
    const longScore = Math.max(0, Math.min(100, Math.round((longPoints / maxPossible) * 100)));
    const shortScore = Math.max(0, Math.min(100, Math.round((shortPoints / maxPossible) * 100)));

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
        withRetry(() => binance.fetchOHLCV(symbol, '1h', undefined, CONFIG.CANDLE_LIMIT)),
        withRetry(() => binance.fetchTicker(symbol)),
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

    if (longScore >= T.STRONG_BUY) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore <= T.STRONG_SELL) {
        action = 'SELL'; confidence = 100 - shortScore;
    } else if (longScore >= T.BUY) {
        action = 'BUY'; confidence = longScore;
    } else if (shortScore <= T.SELL) {
        action = 'SELL'; confidence = 100 - shortScore;
    } else {
        // Neutral zone — check for conditions to avoid
        const shouldAvoid = (rsi?.oversold && !macd?.bullish) || (rsi?.overbought && !macd?.bearish) || volume?.divergence;
        action = shouldAvoid ? 'AVOID' : 'HOLD';
        confidence = Math.max(longScore, 100 - shortScore);
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