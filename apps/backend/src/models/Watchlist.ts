import { model } from "mongoose";
import { WatchlistSchema } from "../schemas/WatchlistSchema";

export const Watchlist = model("Watchlist", WatchlistSchema);
