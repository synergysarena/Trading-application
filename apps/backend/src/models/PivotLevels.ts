import { model } from "mongoose";
import { PivotLevelsSchema } from "../schemas/PivotLevelsSchema";

export const PivotLevels = model("PivotLevels", PivotLevelsSchema);
