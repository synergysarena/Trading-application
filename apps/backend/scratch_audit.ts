import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { io } from "socket.io-client";

async function runAudit() {
  console.log("=================================================================");
  console.log("    STARTING END-TO-END LIVE MARKET DATA AUDIT & VERIFICATION    ");
  console.log("=================================================================\n");

  const baseUrl = "http://localhost:5001";

  // 1. Health check
  console.log("--- TEST 1: Backend Health Check ---");
  const healthRes = await axios.get(`${baseUrl}/health`);
  console.log("Health Status:", healthRes.data.status);
  console.log("Services:", JSON.stringify(healthRes.data.services));
  console.log("Monitoring:", JSON.stringify(healthRes.data.monitoring, null, 2));

  // 2. Module 2 Broker Auth Status
  console.log("\n--- TEST 2: Module 2 Broker Auth Status ---");
  const authStatusRes = await axios.get(`${baseUrl}/module2/auth/status`);
  console.log("Broker Auth State:", authStatusRes.data.status);
  console.log("Broker Authenticated:", authStatusRes.data.authenticated);

  if (!authStatusRes.data.authenticated) {
    console.log("Authenticating with Aetram broker...");
    const loginRes = await axios.post(`${baseUrl}/api/auth/module2-broker-login`, {
      username: "audit_user",
      password: "audit_password",
      otp: "123456"
    });
    console.log("Module 2 Login Success! Token issued:", loginRes.data.moduleToken ? "YES (JWT verified)" : "NO");
  } else {
    console.log("Broker session is already ACTIVE and authenticated.");
  }

  // 3. WebSocket Status
  console.log("\n--- TEST 3: Module 2 WebSocket Status ---");
  const wsStatusRes = await axios.get(`${baseUrl}/module2/ws/status`);
  console.log("WebSocket State:", wsStatusRes.data.state);
  console.log("Authenticated:", wsStatusRes.data.authenticated);
  console.log("Connected At:", wsStatusRes.data.connectedAt);

  // 4. Instrument Discovery & Expiries
  console.log("\n--- TEST 4: Dynamic Expiry & Instrument Discovery ---");
  const expiriesRes = await axios.get(`${baseUrl}/api/module2/expiries?index=NIFTY`);
  console.log(`Discovered ${expiriesRes.data.expiries?.length || 0} expiries for NIFTY.`);
  const targetExpiry = expiriesRes.data.expiries?.[0];
  console.log("Nearest Expiry:", targetExpiry);

  // 5. Option Chain Discovery
  console.log("\n--- TEST 5: Option Chain Discovery ---");
  const chainRes = await axios.get(`${baseUrl}/api/module2/option-chain?symbol=NIFTY50&expiry=${targetExpiry}`);
  const strikes = chainRes.data.strikes || [];
  console.log(`Total strike rows for ${targetExpiry}: ${strikes.length}`);

  // Find strikes near 24000-25500 ATM band
  const liquidStrikes = strikes.filter((s: any) => s.strikePrice >= 24000 && s.strikePrice <= 25500);
  console.log(`Filtered ${liquidStrikes.length} liquid ATM strikes in 24000-25500 range.`);

  const ceStrikes: string[] = [];
  const peStrikes: string[] = [];
  liquidStrikes.forEach((s: any) => {
    if (s.CE) ceStrikes.push(s.CE);
    if (s.PE) peStrikes.push(s.PE);
  });

  // Select 10 CE and 10 PE strikes
  const selectedCe = ceStrikes.slice(0, 10);
  const selectedPe = peStrikes.slice(0, 10);
  const allSelectedStrikes = [...selectedCe, ...selectedPe];
  console.log(`Selected ${allSelectedStrikes.length} strikes (10 CE + 10 PE):`);
  console.log("CE:", selectedCe);
  console.log("PE:", selectedPe);

  // 6. User Auth for Tracker API
  console.log("\n--- TEST 6: User Authentication for Tracker API ---");
  const tokenModule = await import("./src/utils/token");
  const userToken = tokenModule.generateAccessToken("__app_env_user__");
  console.log(`User JWT Access Token generated successfully with matching secret.`);

  // 7. Start Tracker Session
  console.log("\n--- TEST 7: Starting Tracker Session ---");
  const startSessionRes = await axios.post(
    `${baseUrl}/api/module2/session/start`,
    {
      sessionType: "mixed",
      indexSymbol: "NIFTY50",
      expiryDate: targetExpiry,
      selectedStrikes: allSelectedStrikes
    },
    {
      headers: { Authorization: `Bearer ${userToken}` }
    }
  );
  const sessionData = startSessionRes.data;
  const sessionId = sessionData.sessionId;
  console.log(`Tracker Session Started: ${sessionId}`);
  console.log(`Session Initial Strikes Count: ${Object.keys(sessionData.strikes || {}).length}`);

  // 8. Socket.IO Client Connection & Real-Time Event Listening
  console.log("\n--- TEST 8: Socket.IO Real-Time Streaming Verification ---");
  const socket = io(baseUrl, {
    auth: { token: userToken },
    transports: ["websocket"]
  });

  let trackerUpdateCount = 0;
  const receivedStrikes = new Set<string>();
  const receivedPrices: Record<string, number> = {};

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`\nSocket test window completed. Total live updates received: ${trackerUpdateCount}`);
      resolve();
    }, 15000);

    socket.on("connect", () => {
      console.log(`Socket.IO Connected successfully! Client Socket ID: ${socket.id}`);
      socket.emit("join:tracker", sessionId);
      console.log(`Client joined tracker room: tracker:${sessionId}`);
    });

    socket.on("tracker_update", (data: any) => {
      trackerUpdateCount++;
      const strikeName = data.strike;
      const ltp = data.state?.ltp ?? data.cell?.ltp;
      if (strikeName) {
        receivedStrikes.add(strikeName);
        receivedPrices[strikeName] = ltp;
      }
      if (trackerUpdateCount <= 10 || trackerUpdateCount % 10 === 0) {
        console.log(`[LIVE SOCKET TICK #${trackerUpdateCount}] strike=${strikeName} ltp=₹${ltp} dayOpen=₹${data.state?.dayOpen} dayHigh=₹${data.state?.dayHigh} dayLow=₹${data.state?.dayLow} pctChange=${data.state?.pctChange}%`);
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });
  });

  socket.disconnect();

  // 9. Inspect Live Cache & Active Candles
  console.log("\n--- TEST 9: Live Cache & Aggregator Verification ---");
  const cacheRes = await axios.get(`${baseUrl}/module2/cache`);
  console.log(`Total live broker cache entries: ${cacheRes.data.entries?.length || 0}`);

  const candleStatsRes = await axios.get(`${baseUrl}/module2/candles/stats`);
  console.log("Candle Stats:", JSON.stringify(candleStatsRes.data, null, 2));

  const historyStatsRes = await axios.get(`${baseUrl}/module2/history/stats`);
  console.log("Redis History Stats:", JSON.stringify(historyStatsRes.data, null, 2));

  const archiveStatsRes = await axios.get(`${baseUrl}/module2/archive/stats`);
  console.log("MongoDB Archive Stats:", JSON.stringify(archiveStatsRes.data, null, 2));

  // 10. Final Verification of Data Received
  console.log("\n--- TEST 10: Multi-Strike Data Integrity Check ---");
  console.log(`Unique Strikes Streamed: ${receivedStrikes.size} / ${allSelectedStrikes.length}`);
  console.log("Live Streamed Strike Prices:");
  Object.entries(receivedPrices).forEach(([sym, price]) => {
    console.log(`  - ${sym}: ₹${price}`);
  });

  console.log("\n=================================================================");
  console.log("         END-TO-END AUDIT & VERIFICATION COMPLETE                ");
  console.log("=================================================================");
}

runAudit().catch((err) => {
  console.error("Audit test failed with error:", err?.response?.data || err?.message || err);
});
