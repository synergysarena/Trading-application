import dotenv from "dotenv";
dotenv.config();

import { loginToAetram, getActiveSubscribedInstruments } from "./src/services/aetramMarketDataService";
import { connect, getStatus } from "./src/services/marketDataWebSocketService";
import { startTrackerSession, stopTrackerSession } from "./src/services/trackerService";

const runTest = async () => {
  console.log("--- STARTING MODULE 2 ARCHITECTURAL AUDIT TEST ---");

  // 1. Authenticate & Connect WS
  await loginToAetram();
  await connect();

  console.log("WebSocket Status:", getStatus());

  // 2. Start Session 1 with 8 specific strikes (22000 - 22150)
  const session1Strikes = [
    "NIFTY22000CE",
    "NIFTY22000PE",
    "NIFTY22050CE",
    "NIFTY22050PE",
    "NIFTY22100CE",
    "NIFTY22100PE",
    "NIFTY22150CE",
    "NIFTY22150PE"
  ];

  console.log("\n1. Starting Session 1 (User test_user_1)...");
  const session1 = await startTrackerSession(
    "test_user_1",
    "mixed",
    "NIFTY50",
    "2026-08-18",
    session1Strikes
  );

  console.log("Session 1 ID:", session1.sessionId);
  console.log("Active Subscriptions Count:", getActiveSubscribedInstruments().length);

  // 3. Listen 5 seconds for incoming ticks
  console.log("\n2. Listening 5s for Session 1 ticks (verifying deduplicated processing & no 22200+ strikes)...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 4. Start Session 2 for same user with reduced strike set (22000 - 22050 only)
  console.log("\n3. Starting Session 2 for same user with reduced strike set (22000 - 22050)...");
  const session2Strikes = [
    "NIFTY22000CE",
    "NIFTY22000PE",
    "NIFTY22050CE",
    "NIFTY22050PE"
  ];

  const session2 = await startTrackerSession(
    "test_user_1",
    "mixed",
    "NIFTY50",
    "2026-08-18",
    session2Strikes
  );

  console.log("Session 2 ID:", session2.sessionId);
  console.log("Active Subscriptions Count after Session 2:", getActiveSubscribedInstruments().length);

  // 5. Listen 5 seconds for incoming ticks
  console.log("\n4. Listening 5s for Session 2 ticks (verifying stale 22100/22150 strikes were unsubscribed)...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 6. Stop Session 2
  console.log("\n5. Stopping Session 2...");
  await stopTrackerSession(session2.sessionId);
  console.log("Active Subscriptions Count after stop:", getActiveSubscribedInstruments().length);

  console.log("\n--- AUDIT TEST COMPLETE ---");
  process.exit(0);
};

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
