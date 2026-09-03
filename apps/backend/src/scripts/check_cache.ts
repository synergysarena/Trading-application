import axios from "axios";

async function checkCache() {
  try {
    const res = await axios.get("http://localhost:5001/module2/cache");
    console.log("Cache count:", res.data?.count);
    console.log("Sample cache entries:", res.data?.entries?.slice(0, 3));
    
    const candleStats = await axios.get("http://localhost:5001/module2/candles/stats");
    console.log("Candle Stats:", candleStats.data);

    const archiveStats = await axios.get("http://localhost:5001/module2/archive/stats");
    console.log("Archive Stats:", archiveStats.data);

    const historyStats = await axios.get("http://localhost:5001/module2/history/stats");
    console.log("History Stats:", historyStats.data);
  } catch (err: any) {
    console.error("Cache check failed:", err.message);
  }
}

checkCache();
