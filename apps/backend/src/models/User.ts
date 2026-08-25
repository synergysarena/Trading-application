import { model } from "mongoose";
import { UserSchema } from "../schemas/UserSchema";

export const User = model("User", UserSchema);
