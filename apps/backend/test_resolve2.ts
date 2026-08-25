import * as dotenv from "dotenv";
dotenv.config();

import { loginToAetram, resolveOptionStrikeToken, subscribeToInstruments } from "./src/services/aetramMarketDataService";
import { connect as connectMarketDataWebSocket } from "./src/services/marketDataWebSocketService";

async function test() {
  console.log("\n--- STARTING END-TO-END VERIFICATION TEST ---");
  await loginToAetram();
  await connectMarketDataWebSocket();

  console.log("\n1. Resolving NIFTY22000CE for 2026-08-18...");
  const ce = await resolveOptionStrikeToken("NIFTY50", "2026-08-18", "NIFTY22000CE");
  console.log("CE Resolution Result:", ce);

  console.log("\n2. Resolving NIFTY22000PE for 2026-08-18...");
  const pe = await resolveOptionStrikeToken("NIFTY50", "2026-08-18", "NIFTY22000PE");
  console.log("PE Resolution Result:", pe);

  if (ce && pe) {
    console.log("\n3. Testing Subscribe to unique instruments (with deliberate duplicates in array)...");
    await subscribeToInstruments([ce, pe, ce, pe]);
  }

  console.log("\n4. Listening 8 seconds for incoming live ticks from Aetram WebSocket...");
  await new Promise(r => setTimeout(r, 8000));

  console.log("\n--- TEST COMPLETE ---");
  process.exit(0);
}

test();
