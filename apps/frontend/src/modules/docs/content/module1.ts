import type { Section } from "./types";

// ── MODULE 1 — client-facing documentation ────────────────────────────────────
// Audience: traders / the client. No internal file names, service names, or
// backend implementation detail — only what a user of the screen can see and
// needs to understand. Every fact here is verified against the current
// implementation; hidden/unreachable controls are described as unavailable,
// not as active features.

export const MODULE1_SECTIONS: Section[] = [
  // ── 1. OVERVIEW ───────────────────────────────────────────────────────────
  {
    id: "m1-overview",
    heading: "1 — Overview",
    blocks: [
      {
        type: "para",
        content:
          "Module 1 is a live market worksheet for NIFTY options. You pick one Call option and one Put option — your chosen strike and expiry — and the screen shows their prices candle by candle, side by side with the NIFTY Future and the NIFTY Spot index, in an Excel-style table that updates by itself while the market is open.",
      },
      {
        type: "para",
        content:
          "For every candle the table works out MMA, TLA and Ranking for all four instruments, plus five indicator columns: SMC, FIB, RSI, EMA and VWAP. Ranking is the module's core output — it tells you, candle by candle, whether the Call side or the Put side is currently stronger.",
      },
      {
        type: "para",
        content:
          "Without this screen you would need a broker terminal open on four instruments plus a spreadsheet to do the same maths by hand for every candle. Module 1 automates the whole chain: it connects to your broker, receives every price tick live, builds the candles, applies the formulas, and keeps the table current.",
      },
      {
        type: "note",
        content:
          "This is an analysis tool only. It shows prices and calculations to help you decide — it never places, modifies or cancels any order.",
      },
      {
        type: "fields",
        fields: [
          {
            label: "What it watches",
            text: "One Call option, one Put option, the nearest NIFTY Future, and the NIFTY Spot index — all four for the strike/expiry you select.",
          },
          {
            label: "What it produces",
            text: "A live, scrolling table of candles with MMA, TLA and Ranking for each instrument, plus SMC, FIB, RSI, EMA and VWAP.",
          },
          {
            label: "Who it's for",
            text: "Traders who want a single screen answering: which side — Call or Put — is dominant right now, and why.",
          },
        ],
      },
    ],
  },

  // ── 2. LOGIN & SESSION ───────────────────────────────────────────────────
  {
    id: "m1-login",
    heading: "2 — Login & Session",
    subsections: [
      {
        id: "m1-login-app",
        heading: "2.1 Signing in to the application",
        blocks: [
          {
            type: "para",
            content:
              "Signing in to the application is separate from connecting to your broker. You sign in once with your username and password; depending on how your account is configured you may also be asked for a one-time password (OTP) sent to complete sign-in.",
          },
        ],
      },
      {
        id: "m1-login-broker",
        heading: "2.2 Connecting your broker (Module 1)",
        blocks: [
          {
            type: "para",
            content:
              "The first time you open Module 1 — or any time your connection has fully expired — you'll see a \"Connect to Zebu Trading Account\" screen. This is what actually starts the live market feed; nothing in Module 1 shows real data until this step is complete.",
          },
          {
            type: "fields",
            fields: [
              {
                label: "User ID",
                text: "Your Zebu client ID.",
              },
              {
                label: "Password",
                text: "Your Zebu trading password.",
              },
              {
                label: "Factor 2 / TOTP",
                text: "Whatever second factor your Zebu account is registered with — PAN, date of birth, or a TOTP code.",
              },
              {
                label: "Remember Credentials",
                text: "This checkbox is present on the form, but at the moment it does not change anything — session length is always the same (see 2.3) whether or not it is ticked.",
              },
            ],
          },
          {
            type: "note",
            content:
              "There's no partial validation on this form — if a field is wrong or missing, the connection attempt is sent to Zebu and their own rejection message is shown to you.",
          },
        ],
      },
      {
        id: "m1-login-active",
        heading: "2.3 Active session",
        blocks: [
          {
            type: "para",
            content:
              "Once connected, your Module 1 broker session stays active for 8 hours. During that time you can navigate away from Module 1 and come back without reconnecting.",
          },
        ],
      },
      {
        id: "m1-login-resume",
        heading: "2.4 Session resume",
        blocks: [
          {
            type: "para",
            content:
              "If you reload the page or come back to Module 1 later in the same 8-hour window, the screen automatically re-establishes the live feed in the background — you do not need to re-enter your broker credentials. If that automatic resume can't succeed (for example the broker ended the session from their side), the screen falls back to the normal \"Broker Disconnected\" recovery message (see section 11).",
          },
        ],
      },
      {
        id: "m1-login-switch",
        heading: "2.5 Switching broker credentials",
        blocks: [
          {
            type: "para",
            content:
              "From the Module Selection screen, if Module 1 already has an active session you'll see a \"Switch credentials\" link under the Module 1 card. Using it takes you back to the connection screen so you can log in with a different Zebu account.",
          },
        ],
      },
      {
        id: "m1-login-logout",
        heading: "2.6 Logout",
        blocks: [
          {
            type: "warn",
            content:
              "Logging out of the application also disconnects your Module 1 broker feed — there is currently no way to sign out of the app while keeping only the broker connection alive, and no way to disconnect the broker without also signing out of the app.",
          },
          {
            type: "para",
            content:
              "If your broker session ends unexpectedly mid-day (for example you logged into the same Zebu account elsewhere), the screen shows \"Broker Session Expired\" and you'll need to connect again with your credentials — this does not happen automatically.",
          },
        ],
      },
    ],
  },

  // ── 3. DASHBOARD OVERVIEW ────────────────────────────────────────────────
  {
    id: "m1-dashboard",
    heading: "3 — Dashboard Overview",
    blocks: [
      {
        type: "para",
        content:
          "Once connected, the Module 1 screen has three parts, top to bottom: a slim title bar, a selection area for choosing what to watch, and the live worksheet itself.",
      },
    ],
    subsections: [
      {
        id: "m1-dash-titlebar",
        heading: "3.1 Title bar",
        blocks: [
          {
            type: "bullets",
            items: [
              "Shows the platform name.",
              "A \"PP\" toggle (4-Bar / Classic) sits on the right. This is a legacy control from an earlier version of the table — it currently has no visible effect on any column shown today.",
            ],
          },
        ],
      },
      {
        id: "m1-dash-selection",
        heading: "3.2 Selection area",
        blocks: [
          {
            type: "para",
            content:
              "A bar showing the live Spot and Future prices, followed by the Instrument, Symbol, Expiry Date, Call Strike and Put Strike dropdowns (see section 4). Click the bar to collapse it into a one-line summary and give the table more room; click again to expand it.",
          },
        ],
      },
      {
        id: "m1-dash-toolbar",
        heading: "3.3 Toolbar",
        blocks: [
          {
            type: "bullets",
            items: [
              "Timeframe buttons — 1m, 2m, 3m, 5m, 10m, 15m, 30m, 45m, 1h, 2h, 3h, 4h.",
              "A status light showing the live feed's current state (see section 11).",
              "Download Excel — exports exactly what's currently on screen.",
              "Columns — show/hide and reorder columns.",
            ],
          },
        ],
      },
      {
        id: "m1-dash-worksheet-area",
        heading: "3.4 Worksheet area",
        blocks: [
          {
            type: "para",
            content:
              "Shows either the live table, or — while the market is closed, the broker isn't connected, or the feed has a problem — a full-screen message explaining the situation and what to do about it (see section 11).",
          },
        ],
      },
    ],
  },

  // ── 4. MARKET SELECTION ──────────────────────────────────────────────────
  {
    id: "m1-selection",
    heading: "4 — Market Selection",
    blocks: [
      {
        type: "para",
        content:
          "The selection fields form a chain — each one depends on the one before it. Changing a field clears everything after it, so you can never end up with a mismatched combination.",
      },
    ],
    subsections: [
      {
        id: "m1-sel-instrument",
        heading: "4.1 Instrument",
        blocks: [
          {
            type: "para",
            content:
              "The instrument type, shown as the exchange's own codes (OPTIDX, FUTIDX, INDEX, EQ, OPTSTK, FUTSTK, FUTCUR, OPTCUR, FUTCOM, OPTCOM). \"OPTIDX\" (Index Options) is pre-selected and is the type Module 1 is built around.",
          },
        ],
      },
      {
        id: "m1-sel-symbol",
        heading: "4.2 Symbol",
        blocks: [
          {
            type: "para",
            content:
              "The underlying you want to trade — the list includes NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX and BANKEX. At the moment, live prices, expiries and strikes are only actually available for NIFTY, BANKNIFTY, FINNIFTY and MIDCPNIFTY — the other symbols appear in the list but will not return live expiries or strikes yet.",
          },
        ],
      },
      {
        id: "m1-sel-expiry",
        heading: "4.3 Expiry Date",
        blocks: [
          {
            type: "para",
            content:
              "The settlement date of the option — the nearest valid expiry is pre-selected for you, and dates already in the past are never shown. Hidden entirely for instrument types that don't settle (INDEX, EQ).",
          },
        ],
      },
      {
        id: "m1-sel-strike",
        heading: "4.4 Call Strike / Put Strike",
        blocks: [
          {
            type: "para",
            content:
              "The strike price of each option, chosen from the real list of strikes available for that symbol and expiry. Module 1 currently always watches both a Call and a Put together — there is no Call-only or Put-only mode available on screen.",
          },
        ],
      },
      {
        id: "m1-sel-generate",
        heading: "4.5 Starting the table",
        blocks: [
          {
            type: "para",
            content:
              "You don't need to press a \"Generate\" button — the table starts itself automatically the moment your selection is complete (Instrument, Symbol, Expiry, both strikes) and the live feed confirms real prices are flowing. Changing any part of your selection afterwards clears the table and restarts the process with the new choice.",
          },
        ],
      },
    ],
  },

  // ── 5. LIVE WORKSHEET ────────────────────────────────────────────────────
  {
    id: "m1-worksheet",
    heading: "5 — Live Worksheet",
    blocks: [
      {
        type: "para",
        content:
          "Every row in the table is one candle of your chosen timeframe. Rows run oldest to newest, top to bottom — the newest candle is always the bottom row, and it refreshes about twice a second while it's still forming. When its time window ends, it freezes as a permanent history row and a fresh live row starts underneath it.",
      },
      {
        type: "bullets",
        items: [
          "Twelve timeframes are available: 1m, 2m, 3m, 5m, 10m, 15m, 30m, 45m, 1h, 2h, 3h, 4h. Switching timeframe reloads the day's completed candles at the new size and restarts the live row.",
          "Minute-based candles line up on clean clock boundaries (a 5m candle always starts at :00, :05, :10 …). Hour-based candles are anchored to the 09:15 market open, so the first 1-hour candle always runs 09:15–10:15.",
          "The table shows the current trading session only — it does not carry candles over from a previous day.",
          "You can click-and-drag to select a block of cells, then press Ctrl+C (Cmd+C on Mac) to copy them — they paste cleanly into Excel.",
          "Drag any column's header edge to resize it, or use the Columns panel in the toolbar to hide columns and reorder them; your layout is remembered for your account and restored next time you log in.",
        ],
      },
      {
        type: "note",
        content:
          "The table is deliberately honest about missing data — if an instrument has no trade in a given candle, its cells show \"—\" rather than borrowing a number from somewhere else. The one documented exception: if a Spot candle is ever missing, the table uses the Future's candle for that row only.",
      },
    ],
  },

  // ── 6. TABLE COLUMNS ─────────────────────────────────────────────────────
  {
    id: "m1-columns",
    heading: "6 — Table Columns",
    subsections: [
      {
        id: "m1-col-layout",
        heading: "6.1 How the table is organised",
        blocks: [
          {
            type: "para",
            content:
              "The table has 31 data columns arranged in 7 groups, plus one reserved blank spacer column between Future and Spot for visual separation (it never carries data). Reading left to right: Date & Time (frozen so it never scrolls out of view), six columns for the Call, six for the Put, the single Ranking column, six for the Future, the spacer, six for the Spot, and finally the five indicator columns.",
          },
          {
            type: "para",
            content:
              "Notation used below: O = Open (first price of the candle), H = High (highest price), L = Low (lowest), C = Close (last price). \"Premium\" means the price of the option itself. Click any column name to expand its full explanation.",
          },
        ],
      },
      {
        id: "m1-col-reference",
        heading: "6.2 Column reference",
        blocks: [
          {
            type: "columns",
            columns: [
              {
                id: "datetime",
                name: "Date & Time",
                tint: "neutral",
                description:
                  "The starting time of the candle, in Indian Standard Time, 12-hour format with AM/PM (e.g. \"15 Jul, 10:35 AM\"). Frozen on the left so it stays visible while you scroll sideways.",
                howToRead:
                  "Tells you exactly which slice of the trading day the row describes. On a 5m timeframe, \"10:35 AM\" covers 10:35:00 to 10:39:59.",
              },
              {
                id: "ce-ohlc",
                name: "Call — Open / High / Low / Close",
                tint: "call",
                description:
                  "The traded price (premium) of your selected Call option during that candle — where it started, the highest and lowest it reached, and where it ended. These are the option's own prices, never the index level.",
                howToRead:
                  "A rising Call Close usually means the market is moving up. \"—\" means no Call trade arrived in that candle.",
              },
              {
                id: "mma-c",
                name: "Call MMA",
                tint: "call",
                formula:
                  "MMA = (Open + High + Low − Close) ÷ 4\n\nExample: O=70.70, H=76.75, L=70.15, C=75.20\nMMA = (70.70 + 76.75 + 70.15 − 75.20) ÷ 4 = 35.60",
                description:
                  "A per-candle strength number for the Call, calculated from that candle's own four prices exactly as specified: add Open, High and Low, subtract Close, divide by four.",
                howToRead:
                  "Not read on its own — its job is to be compared against the Put MMA in the Ranking column. Because Close is subtracted, the value is roughly half the option's price — that is expected, not an error.",
              },
              {
                id: "tla-c",
                name: "Call TLA",
                tint: "call",
                formula:
                  "TLA = (2 × MMA) − High\n\nExample: MMA = 35.60, High = 76.75\nTLA = (2 × 35.60) − 76.75 = −5.55",
                description: "A follow-on value from the Call's MMA: double the MMA, minus the candle's High.",
                howToRead: "TLA is often negative — that is normal and expected with the current MMA formula, not an error.",
              },
              {
                id: "pe-ohlc",
                name: "Put — Open / High / Low / Close",
                tint: "put",
                description:
                  "The same four prices for your selected Put option. Put columns are amber-tinted so you always know which side you're reading.",
                howToRead:
                  "A rising Put Close usually means the market is moving down. \"—\" means no Put trade in that candle.",
              },
              {
                id: "mma-p",
                name: "Put MMA",
                tint: "put",
                formula:
                  "MMA = (Open + High + Low − Close) ÷ 4\n\nExample: O=73.30, H=74.40, L=70.05, C=71.20\nMMA = (73.30 + 74.40 + 70.05 − 71.20) ÷ 4 = 36.64",
                description: "The same MMA formula, applied to the Put option's candle.",
                howToRead: "Compared against the Call MMA in the Ranking column — whichever is bigger wins the candle for its side.",
              },
              {
                id: "tla-p",
                name: "Put TLA",
                tint: "put",
                formula:
                  "TLA = (2 × MMA) − High\n\nExample: MMA = 36.64, High = 74.40\nTLA = (2 × 36.64) − 74.40 = −1.13",
                description: "The same TLA formula, applied to the Put's MMA and High.",
                howToRead: "Same reading as Call TLA — negative values are normal.",
              },
              {
                id: "ranking",
                name: "Ranking",
                tint: "neutral",
                formula:
                  "Ranking = the HIGHER of (Call MMA, Put MMA)\nIf they are exactly equal, Call wins.\nIf only one side has data, that side wins outright.\n\nExample: Call MMA = 35.60, Put MMA = 36.64\nRanking = 36.64 (Put wins)",
                description:
                  "The module's core output. For each candle it compares Call MMA against Put MMA and shows the winner's value — nothing else feeds into it, no weighting, no history.",
                howToRead:
                  "White background; a bold green \"+\" prefix means the value is higher than the previous candle's, a bold red \"−\" prefix means lower. If unchanged (or on the very first row), the text colour instead names the winner: blue = Call side, amber = Put side. The number shown is always the actual Ranking value, never a difference.",
              },
              {
                id: "fut-ohlc",
                name: "Future — Open / High / Low / Close",
                tint: "neutral",
                description:
                  "The four prices of the NIFTY futures contract for that candle — an index-level number, not an option premium. The Future also feeds RSI, SMC and FIB.",
                howToRead:
                  "Shows the direction of the underlying market driving both your options. If no fresh price has arrived for more than 8 seconds, the live row shows \"—\" rather than repeating a stale price.",
              },
              {
                id: "fut-mma-tla",
                name: "Future MMA / Future TLA",
                tint: "neutral",
                formula: "Same formulas as the option columns:\nMMA = (O + H + L − C) ÷ 4    TLA = (2 × MMA) − High",
                description: "The same MMA/TLA calculations applied to the Future's candle so all four instruments can be compared on the same basis.",
                howToRead: "Context columns — they do not affect the Ranking.",
              },
              {
                id: "spot-ohlc",
                name: "Spot — Open / High / Low / Close",
                tint: "neutral",
                description:
                  "The four prices of the NIFTY 50 cash index for that candle. The Spot also feeds the EMA indicator.",
                howToRead:
                  "Your baseline market level. If a Spot candle is ever missing, the table borrows the Future's candle for that row — the only place any substitution is allowed.",
              },
              {
                id: "spot-mma-tla",
                name: "Spot MMA / Spot TLA",
                tint: "neutral",
                formula: "MMA = (O + H + L − C) ÷ 4    TLA = (2 × MMA) − High",
                description: "The same MMA/TLA calculations applied to the Spot index candle.",
                howToRead: "Context columns, same reading as the Future's MMA/TLA.",
              },
              {
                id: "smc",
                name: "SMC (nearest key level)",
                tint: "neutral",
                formula:
                  "Compares the Future price to four reference levels —\nsession High (SWH), session Low (SWL),\nprevious candle High (PDH), previous candle Low (PDL) —\nand shows whichever is closest.",
                description:
                  "Answers, for each candle: which important price level is the market sitting nearest to right now? Shows the level's name and value, e.g. \"SWH 24,474.30\".",
                howToRead:
                  "Price reacting near a key high or low is more meaningful than movement in open space. \"SWH …\" means the market is pressing against the day's high; \"SWL …\" means it's near the day's low.",
              },
              {
                id: "fib",
                name: "FIB (nearest Fibonacci level)",
                tint: "neutral",
                formula:
                  "Level = High − (High − Low) × ratio\nRatios: 23.6%, 38.2%, 50%, 61.8%, 78.6%\n(High/Low = the session's range so far)",
                description:
                  "Splits the day's price range into the five classic Fibonacci retracement levels and shows the one the Future price is currently closest to, e.g. \"61.8% 24,411.55\".",
                howToRead: "Fibonacci levels are widely-watched turning-point zones — price often pauses or reverses near them.",
              },
              {
                id: "rsi",
                name: "RSI (14)",
                tint: "neutral",
                formula:
                  "RSI = 100 − 100 ÷ (1 + RS)\nRS = average gain ÷ average loss over the last 14 candles\n(Wilder's smoothing — the industry-standard method)",
                description:
                  "Relative Strength Index — a momentum gauge from 0 to 100, calculated on the Future's closing prices. Needs 14 candles of history before it can show its first value.",
                howToRead: "Above 70 = overbought (the rise may be tiring); below 30 = oversold (the fall may be tiring); around 50 = neutral.",
              },
              {
                id: "ema",
                name: "EMA",
                tint: "neutral",
                formula: "Shows the result of comparing EMA20 to EMA200 of the Spot index (see section 8).",
                description:
                  "This column does not show a raw moving-average number. It shows a signal — CALL, PUT or NEUTRAL — describing whether the Spot index's short-term trend (EMA20) is currently above or below its long-term trend (EMA200). See section 8 for the full logic.",
                howToRead: "\"CALL (+1)\" = short-term trend above long-term (bullish bias). \"PUT (-1)\" = below (bearish bias). \"NEUTRAL (0)\" = equal or not yet available.",
              },
              {
                id: "vwap",
                name: "VWAP",
                tint: "neutral",
                formula: "VWAP = Σ(Typical Price × Volume) ÷ ΣVolume, since the session start.\nTypical Price = (High + Low + Close) ÷ 3",
                description:
                  "The true volume-weighted average price the Future contract has traded at since the market opened today, recalculated every candle.",
                howToRead:
                  "Future above VWAP = the market is trading above its volume-weighted average for the day (buyers in charge); below VWAP = below average (sellers in charge). Shows \"VWAP Not Available\" until the first traded volume of the session is recorded — this is expected at the very start of a session, not an error.",
              },
            ],
          },
        ],
      },
    ],
  },

  // ── 7. INDICATORS ────────────────────────────────────────────────────────
  {
    id: "m1-indicators",
    heading: "7 — Indicators",
    blocks: [
      {
        type: "para",
        content:
          "Module 1 shows five indicator columns: SMC, FIB, RSI, EMA and VWAP. Each is explained below in full — what it's for, the exact logic behind it, and how it behaves on screen today.",
      },
    ],
    subsections: [
      {
        id: "m1-ind-smc",
        heading: "7.1 SMC",
        blocks: [
          {
            type: "fields",
            fields: [
              {
                label: "Purpose",
                text: "Tells you, for every candle, which important reference price level the market is currently closest to.",
              },
              {
                label: "Business logic",
                text: "Four candidate levels are always tracked: the session's High and Low so far (SWH / SWL), and the previous candle's High and Low (PDH / PDL). Whichever of the four is numerically closest to the current price is shown.",
              },
              {
                label: "Formula",
                text: "distance = |candidate level − current price| for each of SWH, SWL, PDH, PDL; the smallest distance wins.",
              },
              {
                label: "Output",
                text: "A short label plus the level's value, e.g. \"SWH 24,474.30\" or \"PDL 24,401.10\".",
              },
              {
                label: "Example",
                text: "Session High = 24,480, Session Low = 24,390, price = 24,472 → closest level is SWH, so the cell shows \"SWH 24,480.00\".",
              },
              {
                label: "Display rules",
                text: "Plain text, no colour coding. Recalculated on every candle, live and historical.",
              },
              {
                label: "Current UI behaviour",
                text: "Available on every timeframe from the first candle of the session onward (the very first candle uses its own high/low as the previous-candle reference, since there is no earlier candle yet).",
              },
            ],
          },
          {
            type: "note",
            content:
              "SMC here refers specifically to this nearest-reference-level indicator. It does not currently include structure concepts such as Break of Structure, Change of Character, Fair Value Gaps, Order Blocks, Liquidity Sweeps, or Premium/Discount zones.",
          },
        ],
      },
      {
        id: "m1-ind-fib",
        heading: "7.2 Fibonacci (FIB)",
        blocks: [
          {
            type: "fields",
            fields: [
              {
                label: "Purpose",
                text: "Shows which classic Fibonacci retracement level the market is currently sitting closest to.",
              },
              {
                label: "Business logic",
                text: "The day's trading range (session High to session Low) is split into five widely-watched retracement levels; the one nearest to the current price is displayed.",
              },
              {
                label: "Formula",
                text: "Level = High − (High − Low) × ratio, for ratios 23.6%, 38.2%, 50%, 61.8%, 78.6%.",
              },
              {
                label: "Output",
                text: "A percentage label plus the level's value, e.g. \"61.8% 24,411.55\".",
              },
              {
                label: "Example",
                text: "High = 24,500, Low = 24,300 → the 61.8% level = 24,500 − (200 × 0.618) = 24,376.40.",
              },
              {
                label: "Display rules",
                text: "Plain text, no colour coding.",
              },
              {
                label: "Current UI behaviour",
                text: "Recalculated every candle from the Future's session range; shows \"—\" only if the session hasn't yet established a High/Low range.",
              },
            ],
          },
        ],
      },
      {
        id: "m1-ind-rsi",
        heading: "7.3 RSI",
        blocks: [
          {
            type: "fields",
            fields: [
              {
                label: "Purpose",
                text: "A momentum gauge that shows whether the market has been rising or falling too quickly to be sustained.",
              },
              {
                label: "Business logic",
                text: "Uses Wilder's smoothing method (the industry-standard version of RSI), calculated from the Future contract's closing prices — never the option premiums.",
              },
              {
                label: "Formula",
                text: "RSI = 100 − 100 ÷ (1 + RS), where RS = average gain ÷ average loss over the last 14 candles.",
              },
              {
                label: "Output",
                text: "A number from 0 to 100.",
              },
              {
                label: "Example",
                text: "Average gain 12, average loss 4 → RS = 3 → RSI = 100 − 100/4 = 75 (overbought territory).",
              },
              {
                label: "Display rules",
                text: "Shown as a whole number; plain text, no colour coding.",
              },
              {
                label: "Current UI behaviour",
                text: "Needs 14 candles of Future price history before it can show a value — earlier rows show \"—\" by design, not as an error.",
              },
            ],
          },
        ],
      },
      {
        id: "m1-ind-ema",
        heading: "7.4 EMA",
        blocks: [
          {
            type: "fields",
            fields: [
              {
                label: "Purpose",
                text: "Tells you whether the Spot index's short-term trend is currently running above or below its long-term trend.",
              },
              {
                label: "Business logic",
                text: "Two Exponential Moving Averages of the Spot index are tracked behind the scenes: a 20-candle EMA (EMA20, the short-term trend) and a 200-candle EMA (EMA200, the long-term trend). Only the comparison between them is shown in the table — the two underlying numbers are not displayed as separate columns.",
              },
              {
                label: "Formula",
                text: "EMA20 and EMA200 are each calculated as: EMA = (Close × k) + (previous EMA × (1 − k)), with k = 2 ÷ 21 for EMA20 and k = 2 ÷ 201 for EMA200, each seeded from a simple average of its first candles.",
              },
              {
                label: "Comparison logic",
                text: "IF EMA20 > EMA200 → display \"CALL (+1)\". IF EMA20 < EMA200 → display \"PUT (-1)\". ELSE (equal, or either value not yet available) → display \"NEUTRAL (0)\".",
              },
              {
                label: "Output",
                text: "One of exactly three labels: \"CALL (+1)\", \"PUT (-1)\", or \"NEUTRAL (0)\". No raw EMA price is shown in this column.",
              },
              {
                label: "Example",
                text: "EMA20 = 24,410, EMA200 = 24,380 → EMA20 is above EMA200 → the cell shows \"CALL (+1)\".",
              },
              {
                label: "Display rules",
                text: "Plain text label, no colour coding beyond the text itself.",
              },
              {
                label: "Current UI behaviour",
                text: "EMA20 needs 20 candles of Spot history and EMA200 needs 200 before each can produce a value; the column shows \"—\" until both are ready. Prior-session candles are used automatically to \"warm up\" this history where possible so a value is available as early as possible in the trading day.",
              },
            ],
          },
          {
            type: "note",
            content:
              "Only the comparison result (CALL / PUT / NEUTRAL) is displayed in the Indicator column — the EMA20 and EMA200 numbers themselves, and a set of related internal scoring/rating values, are calculated behind the scenes but are not shown as columns on screen or in the Excel export.",
          },
        ],
      },
      {
        id: "m1-ind-vwap",
        heading: "7.5 VWAP",
        blocks: [
          {
            type: "fields",
            fields: [
              {
                label: "Purpose",
                text: "Shows the true volume-weighted average price the market has traded at since today's session opened — a common reference for whether the current price is \"expensive\" or \"cheap\" relative to the day so far.",
              },
              {
                label: "Business logic",
                text: "Calculated from the NIFTY Future contract's own traded volume (the Spot index has no traded volume of its own to weight by, so it is never used for VWAP).",
              },
              {
                label: "Formula",
                text: "VWAP = Σ(Typical Price × Volume) ÷ ΣVolume, accumulated since the session start. Typical Price = (High + Low + Close) ÷ 3.",
              },
              {
                label: "Volume requirement",
                text: "VWAP is a true volume-weighted calculation — it requires real traded volume data to produce a value. It resets to zero every time the table is (re)started.",
              },
              {
                label: "Output",
                text: "A whole-number price, or the literal text \"VWAP Not Available\".",
              },
              {
                label: "\"VWAP Not Available\" behaviour",
                text: "Shown whenever no traded volume has been recorded yet for the session — typically only for the first few moments right after the table starts. As soon as the first volume is recorded, VWAP begins showing a real value and keeps accumulating from there.",
              },
              {
                label: "Display rules",
                text: "Plain text, no colour coding.",
              },
              {
                label: "Current UI behaviour",
                text: "Updates on every live tick as new volume is recorded for the forming candle, and on every completed candle thereafter.",
              },
            ],
          },
        ],
      },
    ],
  },

  // ── 8. CALCULATIONS ──────────────────────────────────────────────────────
  {
    id: "m1-calculations",
    heading: "8 — Calculations",
    blocks: [
      {
        type: "para",
        content: "A consolidated reference of every formula used in the table (full detail for each is in sections 6 and 7).",
      },
      {
        type: "table",
        headers: ["Calculation", "Formula"],
        rows: [
          ["MMA", "(Open + High + Low − Close) ÷ 4"],
          ["TLA", "(2 × MMA) − High"],
          ["Ranking", "Higher of Call MMA / Put MMA — ties favour Call"],
          ["RSI (14)", "100 − 100 ÷ (1 + average gain ÷ average loss), Wilder's smoothing"],
          ["EMA20 / EMA200", "(Close × k) + (previous EMA × (1 − k)); k = 2/21 for EMA20, 2/201 for EMA200"],
          ["EMA signal", "EMA20 > EMA200 → CALL (+1); EMA20 < EMA200 → PUT (-1); equal/unavailable → NEUTRAL (0)"],
          ["VWAP", "Σ(Typical Price × Volume) ÷ ΣVolume since session start; Typical Price = (High+Low+Close)÷3"],
          ["Fibonacci levels", "High − (High − Low) × ratio, for 23.6% / 38.2% / 50% / 61.8% / 78.6%"],
          ["SMC nearest level", "Nearest of Session High, Session Low, Previous-candle High, Previous-candle Low"],
        ],
      },
      {
        type: "note",
        content:
          "Every calculation always uses full-precision values internally — only the on-screen display is rounded (two decimals for option-side numbers, whole numbers for index-level numbers).",
      },
    ],
  },

  // ── 9. EXCEL EXPORT ──────────────────────────────────────────────────────
  {
    id: "m1-export",
    heading: "9 — Excel Export",
    blocks: [
      {
        type: "bullets",
        items: [
          "Download Excel (in the toolbar) exports the table exactly as it currently looks — same columns, same order, same values, same hidden columns excluded. It's disabled until at least one row of data exists.",
          "The file is automatically named after your symbol, timeframe and the trading date, e.g. Module1_NIFTY_5Min_2026-07-15.xlsx.",
          "An automatic export also happens once per trading day, shortly after the market closes (15:45 IST) — so you always have an end-of-day copy even if you forget to download manually. It only runs once per day, even if you reload the page after it's already happened.",
        ],
      },
    ],
  },

  // ── 10. LIVE UPDATES ─────────────────────────────────────────────────────
  {
    id: "m1-live",
    heading: "10 — Live Updates",
    blocks: [
      {
        type: "steps",
        steps: [
          { n: 1, text: "The broker sends a price update every time any of your four instruments trades — during busy periods that can be several hundred updates per minute." },
          { n: 2, text: "These updates are folded into candles for all twelve timeframes at once, so switching timeframe is instant." },
          { n: 3, text: "The bottom row of your table (the live candle) refreshes about twice per second: its High creeps up as new highs print, its Low creeps down, and its Close is always the latest price." },
          { n: 4, text: "When the candle's time window ends, that row freezes as history and a fresh live row starts. All formulas recompute for the new candle." },
        ],
      },
      {
        type: "bullets",
        items: [
          "Market hours: Monday–Friday, 09:00–15:45 IST. The table always starts from the 09:15 session open.",
          "The live feed only starts after you connect your broker — the system never connects on its own.",
          "History shown is for the current trading session only.",
        ],
      },
    ],
  },

  // ── 11. MARKET STATUS ────────────────────────────────────────────────────
  {
    id: "m1-status",
    heading: "11 — Market Status & Messages",
    blocks: [
      {
        type: "glossary",
        glossary: [
          { term: "Live (green)", def: "Everything is working — prices are updating normally." },
          { term: "Connecting…", def: "The screen is establishing the connection to the market feed. Wait a moment." },
          { term: "Market Closed", def: "It's outside trading hours (Mon–Fri 09:00–15:45 IST). Nothing to do — come back when the market opens." },
          { term: "Authentication Required", def: "The broker connection is not active. Connect with your broker credentials (section 2.2)." },
          { term: "Reconnecting…", def: "The broker feed dropped and the system is retrying automatically (up to 5 attempts). Usually resolves within a minute." },
          { term: "Broker Disconnected", def: "Automatic reconnection gave up. Press Retry; if that fails, connect to the broker again." },
          { term: "Broker Session Expired", def: "The broker ended the session (for example, logged in elsewhere). A fresh broker connection is required." },
          { term: "API Error", def: "A data request failed. Press Retry — your selection is kept, only the data is re-fetched." },
          { term: "Connection Lost", def: "Your internet connection to the server dropped. The screen reconnects automatically and re-joins all live feeds once your network returns." },
          { term: "Feed interrupted", def: "A brief banner shown above the table if the live feed hiccups mid-session while the table stays visible; it clears itself once the feed recovers." },
        ],
      },
    ],
  },

  // ── 12. TROUBLESHOOTING ──────────────────────────────────────────────────
  {
    id: "m1-troubleshooting",
    heading: "12 — Troubleshooting",
    blocks: [
      {
        type: "glossary",
        glossary: [
          {
            term: "The strike dropdown is empty",
            def: "Strike lists depend on the live price cache for that symbol. If it's temporarily empty, wait a few seconds and reselect the expiry, or check that your broker connection is Live.",
          },
          {
            term: "Call or Put cells all show \"—\"",
            def: "No trade has occurred yet for that option since you started the table. This clears itself as soon as the first trade prints — it is never filled in with another instrument's price.",
          },
          {
            term: "EMA shows \"—\" for a long time",
            def: "EMA20 needs 20 candles and EMA200 needs 200 candles of Spot history before either can produce a value. On slower timeframes (like 1h or above) this can take a while within a single session, even though prior-session history is used to help wherever possible.",
          },
          {
            term: "VWAP shows \"VWAP Not Available\"",
            def: "No traded volume has been recorded yet for the session. This normally clears within moments of the table starting.",
          },
          {
            term: "The table is empty after selecting everything",
            def: "Confirm the status light isn't showing an error (section 11) — an incomplete broker connection or a closed market will prevent the table from starting even with a full selection.",
          },
          {
            term: "My column layout reset",
            def: "Your hidden/reordered columns are saved to your account. If you're on a different account or a different browser profile, your saved layout won't carry over.",
          },
          {
            term: "The Download Excel button is greyed out",
            def: "There's no data yet to export. Wait for at least one row to appear in the table.",
          },
        ],
      },
    ],
  },

  // ── 13. FAQ ───────────────────────────────────────────────────────────────
  {
    id: "m1-faq",
    heading: "13 — FAQ",
    blocks: [
      {
        type: "faq",
        items: [
          {
            q: "Does Module 1 place trades?",
            a: "No. It is a read-only analysis screen — it never places, modifies or cancels any order.",
          },
          {
            q: "Why is TLA often a negative number?",
            a: "TLA is derived from MMA (which itself subtracts the Close), so a negative TLA is mathematically normal with the current formula — not an error.",
          },
          {
            q: "On a tie, why does Call win the Ranking?",
            a: "That's the specified rule: if Call MMA and Put MMA are exactly equal, Call is shown as the winner.",
          },
          {
            q: "Can I watch a Call-only or Put-only table?",
            a: "Not currently from the screen — Module 1 always watches both sides of your chosen strike together.",
          },
          {
            q: "Can I look at a custom date range instead of today?",
            a: "Not currently available from the screen — the table always shows the current trading session.",
          },
          {
            q: "Is the data real-time?",
            a: "Yes — prices come from a live broker feed and the visible candle refreshes roughly twice a second while the market is open.",
          },
          {
            q: "Why do option prices show two decimals but the Future/Spot show whole numbers?",
            a: "Option premiums move in small ticks where the decimals matter; index-level prices are shown rounded for readability. Full precision is always used in the underlying calculations either way.",
          },
          {
            q: "Does the EMA column show me a moving average price?",
            a: "No — it shows only the CALL / PUT / NEUTRAL result of comparing the short-term and long-term Spot trend to each other (see section 7.4). The underlying numbers are not displayed.",
          },
        ],
      },
    ],
  },
];
