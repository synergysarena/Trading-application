import { useCallback, useRef, useState } from "react";
import { startTrackerSessionBridge, StartTrackerSessionParams } from "../../data/module2MarketApi";

/**
 * Bridges this new screen to the Phase 4 subscription registry's session
 * requirement (Phase 13 plumbing, not one of Step 4's named hooks).
 *
 * subscriptionService.ts (Phase 4) validates every subscribe call's
 * `sessionId` against trackerService's `activeSessions` — the tracker
 * session store the OLD Module 2 Strike Tracker screen populates via
 * POST /api/module2/session/start. That endpoint and trackerService are
 * both off-limits to modify, so this hook calls that exact same, unmodified
 * endpoint to mint a sessionId of its own the first time this screen needs
 * one, and reuses it for every subsequent subscribe call in this browser tab.
 *
 * Deliberately NOT stored in the global Zustand store (unlike the old
 * screen's `activeSession`) — keeping it local to this hook means this
 * screen's session can never collide with or overwrite the old Strike
 * Tracker screen's own active session.
 */
export const useTrackerSessionBridge = () => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Promise<string> | null>(null);

  const ensureSessionId = useCallback(
    async (params: StartTrackerSessionParams): Promise<string> => {
      if (sessionId) return sessionId;
      if (pendingRef.current) return pendingRef.current;

      setError(null);
      const promise = startTrackerSessionBridge(params)
        .then((data) => {
          setSessionId(data.sessionId);
          return data.sessionId;
        })
        .catch((err: any) => {
          setError(err?.message || "Could not start a tracking session.");
          throw err;
        })
        .finally(() => {
          pendingRef.current = null;
        });

      pendingRef.current = promise;
      return promise;
    },
    [sessionId]
  );

  return { sessionId, error, ensureSessionId };
};
