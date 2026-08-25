import { model } from "mongoose";
import { Module1CandleArchiveSchema } from "../schemas/Module1CandleArchiveSchema";

export const Module1CandleArchive = model("Module1CandleArchive", Module1CandleArchiveSchema);
