import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

console.log("[App] main.tsx loaded — React mounting");

class GlobalErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    console.error("[App] React error boundary caught:", error);
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", background: "#fef2f2", color: "#dc2626", minHeight: "100vh" }}>
          <h2 style={{ marginTop: 0 }}>React Render Error</h2>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {this.state.error?.toString()}
            {"\n\n"}
            {this.state.error?.stack}
          </pre>
          <p style={{ color: "#5b6b82", fontFamily: "sans-serif" }}>Open browser DevTools → Console for full details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  console.error("[App] FATAL: #root element not found in DOM");
} else {
  console.log("[App] #root element found — rendering React tree");
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <GlobalErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </GlobalErrorBoundary>
    </React.StrictMode>
  );
  console.log("[App] ReactDOM.createRoot().render() called");
}

