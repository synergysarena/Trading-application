import { model } from "mongoose";
import { Module2StrikeTickSchema } from "../schemas/Module2StrikeTickSchema";

export const Module2StrikeTick = model("Module2StrikeTick", Module2StrikeTickSchema);
