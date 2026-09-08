import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  startSession,
  stopSession,
  getCurrentSession,
  updateStrikes,
  updateFilters,
  exportCSV
} from "../controllers/tracker";
import { getModule2SessionDiagnostics } from "../controllers/module2Diagnostics";

const router = Router();

router.post("/session/start", authenticate, startSession);
router.post("/session/stop", authenticate, stopSession);
router.get("/session/current", authenticate, getCurrentSession);
router.get("/session/diagnostics", authenticate, getModule2SessionDiagnostics);
router.put("/session/strikes", authenticate, updateStrikes);
router.put("/filters", authenticate, updateFilters);
router.get("/export", authenticate, exportCSV);

export default router;
