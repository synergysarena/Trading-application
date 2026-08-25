import { model } from "mongoose";
import { Module2SessionSchema } from "../schemas/Module2SessionSchema";

export const Module2Session = model("Module2Session", Module2SessionSchema);
