import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from the apps/backend directory
dotenv.config({ path: path.join(__dirname, "../../.env") });

const run = async () => {
  const mongoUri =
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/stock_dashboard";

  console.log("[FixDB] Connecting to MongoDB at:", mongoUri);

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("[FixDB] Connected successfully.");

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Mongoose connection DB is undefined.");
    }
    const collections = await db.listCollections().toArray();
    const usersCollectionExists = collections.some((c) => c.name === "users");

    if (usersCollectionExists) {
      console.log("[FixDB] Found 'users' collection. Dropping all existing indexes...");
      await db.collection("users").dropIndexes();
      console.log("[FixDB] Successfully dropped all indexes for 'users' collection.");
    } else {
      console.log("[FixDB] 'users' collection does not exist yet. No indexes to drop.");
    }
  } catch (error) {
    console.error("[FixDB] Fatal error during index cleanup:", error);
  } finally {
    await mongoose.disconnect();
    console.log("[FixDB] Disconnected from MongoDB.");
  }
};

run().catch(console.error);
