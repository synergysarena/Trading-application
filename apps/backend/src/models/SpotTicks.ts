import { model } from "mongoose";
import { SpotTicksSchema } from "../schemas/SpotTicksSchema";

export const SpotTicks = model("SpotTicks", SpotTicksSchema);
