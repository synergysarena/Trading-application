import { useStore } from "../store/useStore";

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  timeoutMs?: number;
}

export const API_BASE = import.meta.env.VITE_API_URL || "";

const DEFAULT_TIMEOUT_MS = 30_000;

const friendlyError = (err: any, response?: Response): string => {
  if (err?.name === "AbortError") return "Request timed out. Please try again.";
  if (!navigator.onLine) return "Internet connection lost. Reconnecting…";

  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("network request")) {
    return "Unable to connect to the server. Please check your connection.";
  }

  if (response) {
    if (response.status === 401) return "Your session has expired. Please log in again.";
    if (response.status === 403) return "You do not have permission to perform this action.";
    if (response.status === 502 || response.status === 503) return "Unable to connect to the broker. Please try again.";
    if (response.status >= 500) return "Server error. Please try again in a moment.";
  }

  return err?.message || "An unexpected error occurred. Please try again.";
};

const handleResponse = async (response: Response) => {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err: any = new Error(data?.error || friendlyError(null, response));
    if (data) Object.assign(err, data);
    err.status = response.status;
    throw err;
  }
  return data;
};

export const api = {
  request: async (url: string, options: RequestOptions = {}): Promise<any> => {
    const { accessToken, setAuth } = useStore.getState();
    const headers = new Headers(options.headers || {});
    const { timeoutMs = DEFAULT_TIMEOUT_MS, skipAuth, ...fetchOptions } = options;

    const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;

    if (!(fetchOptions.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    if (accessToken && !skipAuth) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    fetchOptions.headers = headers;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fullUrl, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timeoutId);

      // Handle 401 — attempt silent token refresh
      if (response.status === 401 && accessToken && !skipAuth) {
        console.log("[API] Access token expired. Attempting silent refresh...");
        const refreshController = new AbortController();
        const refreshTimeout = setTimeout(() => refreshController.abort(), timeoutMs);

        try {
          const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
            method: "POST",
            credentials: "include",
            signal: refreshController.signal,
          });
          clearTimeout(refreshTimeout);
          const refreshData = await refreshRes.json();

          if (refreshRes.ok && refreshData.accessToken) {
            const { user } = useStore.getState();
            setAuth(user, refreshData.accessToken);
            headers.set("Authorization", `Bearer ${refreshData.accessToken}`);
            fetchOptions.headers = headers;
            const retryController = new AbortController();
            const retryTimeout = setTimeout(() => retryController.abort(), timeoutMs);
            const retryResponse = await fetch(fullUrl, { ...fetchOptions, signal: retryController.signal });
            clearTimeout(retryTimeout);
            return await handleResponse(retryResponse);
          } else {
            console.warn("[API] Silent refresh failed (status", refreshRes.status, "). Clearing app session.");
            useStore.getState().clearAppAuth();
            throw new Error("Your broker session has expired. Please reconnect.");
          }
        } catch (refreshErr: any) {
          clearTimeout(refreshTimeout);
          if (!refreshErr?.message?.includes("session")) {
            useStore.getState().clearAppAuth();
          }
          throw new Error(friendlyError(refreshErr));
        }
      }

      return await handleResponse(response);
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.status) throw err; // already enriched response error
      throw new Error(friendlyError(err));
    }
  },

  get: (url: string, options?: RequestOptions) =>
    api.request(url, { ...options, method: "GET" }),

  post: (url: string, body?: any, options?: RequestOptions) =>
    api.request(url, { ...options, method: "POST", body: body ? JSON.stringify(body) : undefined }),

  put: (url: string, body?: any, options?: RequestOptions) =>
    api.request(url, { ...options, method: "PUT", body: body ? JSON.stringify(body) : undefined }),

  delete: (url: string, options?: RequestOptions) =>
    api.request(url, { ...options, method: "DELETE" }),
};

export default api;
