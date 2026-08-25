import dns from "dns";
import net from "net";
import tls from "tls";
import https from "https";
import http from "http";
import dotenv from "dotenv";

dotenv.config();

export interface DiagnosticResult {
  timestamp: string;
  environment: {
    nodeVersion: string;
    platform: string;
    nodeEnv: string;
    outboundIp?: string;
    outboundOrg?: string;
  };
  proxyConfig: {
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    ALL_PROXY?: string;
    NO_PROXY?: string;
    hasProxy: boolean;
  };
  envConfig: {
    AETRAM_MARKETDATA_AUTH_URL: { status: "SET" | "MISSING"; value?: string };
    AETRAM_MARKETDATA_API_BASE_URL: { status: "SET" | "MISSING"; value?: string };
    AETRAM_APP_KEY_OR_MOD2_KEY: { status: "SET" | "MISSING" };
    AETRAM_SECRET_KEY_OR_MOD2_SECRET: { status: "SET" | "MISSING" };
    AETRAM_SOURCE: { status: "SET" | "DEFAULT_USED"; value: string };
  };
  dns: {
    status: "PASS" | "FAIL";
    host: string;
    resolvedAddress?: string;
    family?: number;
    durationMs?: number;
    error?: string;
  };
  tcp: {
    status: "PASS" | "FAIL";
    host: string;
    port: number;
    durationMs?: number;
    localAddress?: string;
    localPort?: number;
    error?: string;
    errno?: string;
    syscall?: string;
  };
  tls: {
    status: "PASS" | "FAIL";
    authorized?: boolean;
    authorizationError?: string;
    protocol?: string;
    cipher?: any;
    certSubject?: any;
    certIssuer?: any;
    certValidTo?: string;
    durationMs?: number;
    error?: string;
  };
  http: {
    status: "PASS" | "FAIL";
    url: string;
    method: string;
    statusCode?: number;
    statusMessage?: string;
    durationMs?: number;
    serverHeader?: string;
    responseBodyPreview?: string;
    error?: string;
    errorCode?: string;
  };
}

async function getPublicIp(): Promise<{ ip?: string; org?: string }> {
  return new Promise((resolve) => {
    const req = https.get("https://api.ipify.org?format=json", { timeout: 4000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ip: parsed.ip });
        } catch {
          resolve({ ip: data.trim() });
        }
      });
    });
    req.on("error", () => resolve({ ip: "UNKNOWN (Request Failed)" }));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve({ ip: "TIMEOUT" });
    });
  });
}

export async function runAetramDiagnostics(): Promise<DiagnosticResult> {
  const host = "secure.aetramtrades.in";
  const port = 443;
  const authUrl = (process.env.AETRAM_MARKETDATA_AUTH_URL || "https://secure.aetramtrades.in/apimarketdata/auth/login").trim();

  const publicIpInfo = await getPublicIp();

  const result: DiagnosticResult = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      nodeEnv: process.env.NODE_ENV || "development",
      outboundIp: publicIpInfo.ip,
    },
    proxyConfig: {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      hasProxy: !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY),
    },
    envConfig: {
      AETRAM_MARKETDATA_AUTH_URL: {
        status: process.env.AETRAM_MARKETDATA_AUTH_URL ? "SET" : "MISSING",
        value: process.env.AETRAM_MARKETDATA_AUTH_URL || "(default: https://secure.aetramtrades.in/apimarketdata/auth/login)",
      },
      AETRAM_MARKETDATA_API_BASE_URL: {
        status: process.env.AETRAM_MARKETDATA_API_BASE_URL ? "SET" : "MISSING",
        value: process.env.AETRAM_MARKETDATA_API_BASE_URL || "(default: https://secure.aetramtrades.in/apimarketdata)",
      },
      AETRAM_APP_KEY_OR_MOD2_KEY: {
        status: (process.env.AETRAM_APP_KEY || process.env.MOD2_API_KEY) ? "SET" : "MISSING",
      },
      AETRAM_SECRET_KEY_OR_MOD2_SECRET: {
        status: (process.env.AETRAM_SECRET_KEY || process.env.MOD2_API_SECRET) ? "SET" : "MISSING",
      },
      AETRAM_SOURCE: {
        status: process.env.AETRAM_SOURCE ? "SET" : "DEFAULT_USED",
        value: process.env.AETRAM_SOURCE || "WEBAPI",
      },
    },
    dns: { status: "FAIL", host },
    tcp: { status: "FAIL", host, port },
    tls: { status: "FAIL" },
    http: { status: "FAIL", url: authUrl, method: "POST" },
  };

  // 1. DNS Lookup
  const dnsStart = Date.now();
  try {
    const lookupRes = await dns.promises.lookup(host, { all: false });
    result.dns = {
      status: "PASS",
      host,
      resolvedAddress: lookupRes.address,
      family: lookupRes.family,
      durationMs: Date.now() - dnsStart,
    };
  } catch (err: any) {
    result.dns = {
      status: "FAIL",
      host,
      durationMs: Date.now() - dnsStart,
      error: `${err.code || err.name}: ${err.message}`,
    };
  }

  // 2. TCP Connection Test
  const tcpStart = Date.now();
  await new Promise<void>((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(7000);

    socket.connect(port, host, () => {
      if (!isResolved) {
        isResolved = true;
        result.tcp = {
          status: "PASS",
          host,
          port,
          durationMs: Date.now() - tcpStart,
          localAddress: socket.localAddress,
          localPort: socket.localPort,
        };
        socket.destroy();
        resolve();
      }
    });

    socket.on("timeout", () => {
      if (!isResolved) {
        isResolved = true;
        result.tcp = {
          status: "FAIL",
          host,
          port,
          durationMs: Date.now() - tcpStart,
          error: "TCP connection timed out (ETIMEDOUT) after 7000ms",
          errno: "ETIMEDOUT",
          syscall: "connect",
        };
        socket.destroy();
        resolve();
      }
    });

    socket.on("error", (err: any) => {
      if (!isResolved) {
        isResolved = true;
        result.tcp = {
          status: "FAIL",
          host,
          port,
          durationMs: Date.now() - tcpStart,
          error: `${err.code || err.name}: ${err.message}`,
          errno: err.errno || err.code,
          syscall: err.syscall,
        };
        resolve();
      }
    });
  });

  // 3. TLS Handshake Test (if TCP or DNS worked)
  const tlsStart = Date.now();
  await new Promise<void>((resolve) => {
    let isResolved = false;
    const tlsSocket = tls.connect(
      {
        host,
        port,
        servername: host,
        timeout: 8000,
        rejectUnauthorized: true,
      },
      () => {
        if (!isResolved) {
          isResolved = true;
          const cert: any = tlsSocket.getPeerCertificate();
          result.tls = {
            status: "PASS",
            authorized: tlsSocket.authorized,
            authorizationError: tlsSocket.authorizationError ? String(tlsSocket.authorizationError) : undefined,
            protocol: tlsSocket.getProtocol() || undefined,
            cipher: tlsSocket.getCipher()?.name,
            certSubject: cert?.subject?.CN,
            certIssuer: cert?.issuer?.O,
            certValidTo: cert?.valid_to,
            durationMs: Date.now() - tlsStart,
          };
          tlsSocket.end();
          resolve();
        }
      }
    );

    tlsSocket.on("timeout", () => {
      if (!isResolved) {
        isResolved = true;
        result.tls = {
          status: "FAIL",
          durationMs: Date.now() - tlsStart,
          error: "TLS Handshake timed out after 8000ms",
        };
        tlsSocket.destroy();
        resolve();
      }
    });

    tlsSocket.on("error", (err: any) => {
      if (!isResolved) {
        isResolved = true;
        result.tls = {
          status: "FAIL",
          durationMs: Date.now() - tlsStart,
          error: `${err.code || err.name}: ${err.message}`,
        };
        resolve();
      }
    });
  });

  // 4. HTTP Request Test (Mock/Diagnostic probe without credentials)
  const httpStart = Date.now();
  await new Promise<void>((resolve) => {
    let isResolved = false;
    const req = https.request(
      authUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TradePro-Diagnostic/1.0",
        },
        timeout: 10000,
      },
      (res) => {
        let bodyData = "";
        res.on("data", (chunk) => (bodyData += chunk));
        res.on("end", () => {
          if (!isResolved) {
            isResolved = true;
            result.http = {
              status: "PASS",
              url: authUrl,
              method: "POST",
              statusCode: res.statusCode,
              statusMessage: res.statusMessage,
              durationMs: Date.now() - httpStart,
              serverHeader: res.headers["server"] as string,
              responseBodyPreview: bodyData.substring(0, 300),
            };
            resolve();
          }
        });
      }
    );

    req.on("timeout", () => {
      if (!isResolved) {
        isResolved = true;
        result.http = {
          status: "FAIL",
          url: authUrl,
          method: "POST",
          durationMs: Date.now() - httpStart,
          error: "HTTP request timed out (10000ms)",
          errorCode: "ECONNABORTED / ETIMEDOUT",
        };
        req.destroy();
        resolve();
      }
    });

    req.on("error", (err: any) => {
      if (!isResolved) {
        isResolved = true;
        result.http = {
          status: "FAIL",
          url: authUrl,
          method: "POST",
          durationMs: Date.now() - httpStart,
          error: `${err.code || err.name}: ${err.message}`,
          errorCode: err.code,
        };
        resolve();
      }
    });

    // Send empty payload (safe diagnostic probe to test gateway HTTP reachability)
    req.write(JSON.stringify({}));
    req.end();
  });

  return result;
}

// Standalone CLI execution
if (require.main === module) {
  runAetramDiagnostics().then((res) => {
    console.log("\n=======================================================");
    console.log("       AETRAM PRODUCTION CONNECTIVITY DIAGNOSTIC       ");
    console.log("=======================================================\n");
    console.log(JSON.stringify(res, null, 2));
    console.log("\n=======================================================");
  });
}
