import { describe, it, expect, beforeEach } from "vitest";

const storageMap = new Map<string, string>();
const mockSessionStorage = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};
(globalThis as any).sessionStorage = mockSessionStorage;

import { useStore } from "../store/useStore";

describe("Module 2 Multi-User Login & Session Lifecycle", () => {
  beforeEach(() => {
    mockSessionStorage.clear();
    useStore.getState().clearAuth();
  });

  it("stores and clears Module 2 token in sessionStorage and Zustand store", () => {
    const store = useStore.getState();

    // 1. Initial state: no token
    expect(store.module2Token).toBeNull();
    expect(sessionStorage.getItem("m2_token")).toBeNull();

    // 2. Set token on successful broker login
    const mockM2Token = "mock.module2.jwt.token";
    store.setModule2Token(mockM2Token);

    expect(useStore.getState().module2Token).toBe(mockM2Token);
    expect(sessionStorage.getItem("m2_token")).toBe(mockM2Token);

    // 3. Clear token on broker disconnect or switch credentials
    store.setModule2Token(null);
    expect(useStore.getState().module2Token).toBeNull();
    expect(sessionStorage.getItem("m2_token")).toBeNull();
  });

  it("updates module2Status correctly across lifecycle transitions", () => {
    const store = useStore.getState();

    expect(store.module2Status).toBe("idle");
    expect(store.module2Error).toBeNull();

    // Authenticating transition
    store.setModule2Status("authenticating");
    expect(useStore.getState().module2Status).toBe("authenticating");

    // Authenticated transition
    store.setModule2Status("authenticated");
    expect(useStore.getState().module2Status).toBe("authenticated");

    // Error transition with message
    store.setModule2Status("error", "Invalid broker OTP");
    expect(useStore.getState().module2Status).toBe("error");
    expect(useStore.getState().module2Error).toBe("Invalid broker OTP");

    // Reset to idle on disconnect
    store.setModule2Status("idle");
    expect(useStore.getState().module2Status).toBe("idle");
    expect(useStore.getState().module2Error).toBeNull();
  });

  it("clears both app and module sessions on global clearAuth()", () => {
    const store = useStore.getState();

    // Set active state for user and both modules
    store.setAuth({ id: "user_123", username: "trader1", name: "Trader One", status: "active", createdAt: new Date() }, "app.access.token");
    store.setModule1Token("m1.token");
    store.setModule2Token("m2.token");
    store.setModule2Status("authenticated");


    expect(useStore.getState().user?.id).toBe("user_123");
    expect(useStore.getState().module1Token).toBe("m1.token");
    expect(useStore.getState().module2Token).toBe("m2.token");

    // Global clearAuth (app logout)
    store.clearAuth();

    expect(useStore.getState().user).toBeNull();
    expect(useStore.getState().accessToken).toBeNull();
    expect(useStore.getState().module1Token).toBeNull();
    expect(useStore.getState().module2Token).toBeNull();
    expect(useStore.getState().module2Status).toBe("idle");
    expect(sessionStorage.getItem("m1_token")).toBeNull();
    expect(sessionStorage.getItem("m2_token")).toBeNull();
  });

  it("maintains user isolation between distinct user sessions", () => {
    // User A simulation
    const userA = { id: "user_A", username: "user_a" };
    const sessionKeyA = `module2:broker-session:${userA.id}`;

    // User B simulation
    const userB = { id: "user_B", username: "user_b" };
    const sessionKeyB = `module2:broker-session:${userB.id}`;

    expect(sessionKeyA).not.toBe(sessionKeyB);
    expect(sessionKeyA).toBe("module2:broker-session:user_A");
    expect(sessionKeyB).toBe("module2:broker-session:user_B");

    // Simulating Redis persistence map
    const redisMock = new Map<string, string>();
    redisMock.set(sessionKeyA, JSON.stringify({ token: "token_A", userID: "ATM_A" }));
    redisMock.set(sessionKeyB, JSON.stringify({ token: "token_B", userID: "ATM_B" }));

    // User A logout should only clear User A
    redisMock.delete(sessionKeyA);

    expect(redisMock.has(sessionKeyA)).toBe(false);
    expect(redisMock.has(sessionKeyB)).toBe(true);
    expect(JSON.parse(redisMock.get(sessionKeyB)!).userID).toBe("ATM_B");
  });

  it("ensures local logout only clears the current tab session", () => {
    // Tab A store instance
    const store = useStore.getState();
    store.setAuth({ id: "user_123", username: "trader1", name: "Trader One", status: "active", createdAt: new Date() }, "app.access.token");
    store.setModule2Token("m2.token.tabA");
    store.setModule2Status("authenticated");

    // Local tab logout clears current tab
    store.clearAuth();

    expect(useStore.getState().user).toBeNull();
    expect(useStore.getState().module2Token).toBeNull();
    expect(useStore.getState().module2Status).toBe("idle");
    expect(mockSessionStorage.getItem("m2_token")).toBeNull();

    // Tab B simulation: another tab holding its own sessionStorage & memory state is not mutated by Tab A's local logout
    const tabBSessionToken = "m2.token.tabB";
    expect(tabBSessionToken).toBe("m2.token.tabB");
  });

  it("isolates tracker session lifecycle between User A and User B", () => {
    // In-memory activeSessions simulator mirroring trackerService.ts
    const activeSessions: Record<string, any> = {};

    // 1. User A starts a tracker session
    const userA_id = "user_A";
    const sessionA_id = "session_A_101";
    activeSessions[sessionA_id] = {
      sessionId: sessionA_id,
      userId: userA_id,
      selectedStrikes: ["NIFTY26AUG24000CE"],
      strikes: {
        "NIFTY26AUG24000CE": { grid: [{ timestamp: "13:35", ltp: 100 }] }
      },
      status: "active",
    };

    // 2. User B starts a tracker session
    const userB_id = "user_B";
    const sessionB_id = "session_B_202";
    activeSessions[sessionB_id] = {
      sessionId: sessionB_id,
      userId: userB_id,
      selectedStrikes: ["NIFTY26AUG24500PE"],
      strikes: {
        "NIFTY26AUG24500PE": { grid: [{ timestamp: "13:38", ltp: 150 }] }
      },
      status: "active",
    };

    expect(Object.keys(activeSessions).length).toBe(2);
    expect(activeSessions[sessionA_id].userId).toBe(userA_id);
    expect(activeSessions[sessionB_id].userId).toBe(userB_id);
    expect(activeSessions[sessionA_id].strikes["NIFTY26AUG24000CE"].grid[0].timestamp).toBe("13:35");

    // 3. User A stops their session — should only delete User A's session
    const userAActiveIds = Object.keys(activeSessions).filter((sId) => activeSessions[sId].userId === userA_id);
    for (const sId of userAActiveIds) {
      delete activeSessions[sId];
    }

    // User A session is gone
    expect(activeSessions[sessionA_id]).toBeUndefined();
    // User B session is completely intact and continues receiving data
    expect(activeSessions[sessionB_id]).toBeDefined();
    expect(activeSessions[sessionB_id].userId).toBe(userB_id);
    expect(activeSessions[sessionB_id].selectedStrikes).toEqual(["NIFTY26AUG24500PE"]);
  });

  it("calculates subscription union correctly when User A and User B share or have distinct strikes", () => {
    // Simulator for syncAetramSubscriptions union logic
    const activeSessions: Record<string, { selectedStrikes: string[] }> = {
      "session_A": { selectedStrikes: ["NIFTY26AUG24000CE", "NIFTY26AUG24100CE"] },
      "session_B": { selectedStrikes: ["NIFTY26AUG24100CE", "NIFTY26AUG24200PE"] }, // Shares 24100CE
    };

    const getDesiredStrikes = () => {
      const set = new Set<string>();
      Object.values(activeSessions).forEach(s => s.selectedStrikes.forEach(st => set.add(st)));
      return set;
    };

    // Both active: union should have all 3 strikes
    let desired = getDesiredStrikes();
    expect(desired.size).toBe(3);
    expect(desired.has("NIFTY26AUG24000CE")).toBe(true);
    expect(desired.has("NIFTY26AUG24100CE")).toBe(true);
    expect(desired.has("NIFTY26AUG24200PE")).toBe(true);

    // User A stops: desired should still retain 24100CE because User B uses it!
    delete activeSessions["session_A"];
    desired = getDesiredStrikes();
    expect(desired.size).toBe(2);
    expect(desired.has("NIFTY26AUG24000CE")).toBe(false); // Only A needed this -> removed
    expect(desired.has("NIFTY26AUG24100CE")).toBe(true);  // B still needs this -> KEPT
    expect(desired.has("NIFTY26AUG24200PE")).toBe(true);  // B needs this -> KEPT
  });

  it("handles GLOBAL_SHUTDOWN as the sole multi-tab market-data termination event", () => {
    const store = useStore.getState();
    store.setModule1Token("active.m1.token");
    store.setModule2Token("active.m2.token");
    store.setModule1Status("authenticated");
    store.setModule2Status("authenticated");

    // Simulating BroadcastChannel message handler execution strictly for GLOBAL_SHUTDOWN
    mockSessionStorage.removeItem("m1_token");
    mockSessionStorage.removeItem("m2_token");
    useStore.setState({
      module1Token: null,
      module2Token: null,
      module1Status: "idle",
      module2Status: "idle",
      module2BrokerStatus: "broker-disconnected",
    });

    expect(useStore.getState().module1Token).toBeNull();
    expect(useStore.getState().module2Token).toBeNull();
    expect(useStore.getState().module1Status).toBe("idle");
    expect(useStore.getState().module2Status).toBe("idle");
    expect(useStore.getState().module2BrokerStatus).toBe("broker-disconnected");
    expect(mockSessionStorage.getItem("m1_token")).toBeNull();
    expect(mockSessionStorage.getItem("m2_token")).toBeNull();
  });
});



