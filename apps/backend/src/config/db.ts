import mongoose from "mongoose";

const maskMongoUri = (uri: string): string => {
  try {
    // Replace user:password@ with ***:***@ to avoid leaking credentials in logs
    return uri.replace(/:\/\/([^:@]+)(:[^@]+)?@/, "://***:***@");
  } catch {
    return "[configured]";
  }
};

// Human-readable mongoose connection state — used by the Module 1 persistence
// diagnostics so a "write succeeded" log can be trusted (or not).
export const mongoConnectionStateName = (): string => {
  switch (mongoose.connection.readyState) {
    case 0: return "disconnected";
    case 1: return "connected";
    case 2: return "connecting";
    case 3: return "disconnecting";
    default: return `unknown(${mongoose.connection.readyState})`;
  }
};

export const isMongoConnected = (): boolean => mongoose.connection.readyState === 1;

let connectionListenersBound = false;

// Surfaces mid-session connection loss. With bufferCommands=false a drop makes
// every subsequent write throw immediately — without these lines that failure
// is only visible as a throttled persist-error counter nobody watches.
const bindConnectionListeners = (): void => {
  if (connectionListenersBound) return;
  connectionListenersBound = true;
  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] MongoDB DISCONNECTED — writes will fail until reconnect (bufferCommands is off).");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("[DB] MongoDB reconnected.");
  });
  mongoose.connection.on("error", (err: any) => {
    console.error("[DB] MongoDB connection error:", err?.message || err);
  });
};

export const connectDB = async (): Promise<void> => {
  const mongoUri =
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/stock_dashboard";

  mongoose.set("bufferCommands", false);
  bindConnectionListeners();

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log(
    `[DB] MongoDB connected: ${maskMongoUri(mongoUri)} | db=${mongoose.connection.name} | state=${mongoConnectionStateName()}`
  );
};