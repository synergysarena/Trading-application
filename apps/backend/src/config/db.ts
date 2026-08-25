import mongoose from "mongoose";

const maskMongoUri = (uri: string): string => {
  try {
    // Replace user:password@ with ***:***@ to avoid leaking credentials in logs
    return uri.replace(/:\/\/([^:@]+)(:[^@]+)?@/, "://***:***@");
  } catch {
    return "[configured]";
  }
};

export const connectDB = async (): Promise<void> => {
  const mongoUri =
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/stock_dashboard";

  mongoose.set("bufferCommands", false);

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log("[DB] MongoDB connected:", maskMongoUri(mongoUri));
};