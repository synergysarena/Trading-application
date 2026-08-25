import ExcelJS from "exceljs";

export const exportModule2ToExcel = async (
  session: any,
  sortedTimestamps: string[],
  selectedOHLCFields: string[] = ["open", "high", "low", "close"]
) => {
  if (!session || !session.strikes) {
    console.warn("No active session data to export.");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dezprox Trading App";
  workbook.created = new Date();

  const rawSelected: string[] = session.selectedStrikes || [];
  const rawKeys: string[] = Object.keys(session.strikes || {});
  const selectedStrikes: string[] = Array.from(new Set([...rawSelected, ...rawKeys]));

  const ceStrikes = selectedStrikes.filter((s) => s.endsWith("CE"));
  const peStrikes = selectedStrikes.filter((s) => s.endsWith("PE"));

  // Dynamic OHLC fields configuration
  const ohlcDefs = [
    {
      id: "open",
      header: "Day Open",
      getVal: (s: any) => (typeof s.dayOpen === "number" && !isNaN(s.dayOpen) && s.dayOpen > 0 ? Math.round(s.dayOpen) : 0),
    },
    {
      id: "high",
      header: "Day High",
      getVal: (s: any) => (typeof s.dayHigh === "number" && !isNaN(s.dayHigh) && s.dayHigh > 0 ? Math.round(s.dayHigh) : 0),
    },
    {
      id: "low",
      header: "Day Low",
      getVal: (s: any) => (typeof s.dayLow === "number" && !isNaN(s.dayLow) && s.dayLow > 0 ? Math.round(s.dayLow) : 0),
    },
    {
      id: "close",
      header: "LTP / Close",
      getVal: (s: any) => {
        const ltp = (s.grid && s.grid.length > 0) ? s.grid[s.grid.length - 1]?.ltp : s.dayOpen;
        return typeof ltp === "number" && !isNaN(ltp) && ltp > 0 ? Math.round(ltp) : 0;
      },
    },
  ].filter((d) => selectedOHLCFields.includes(d.id));

  const buildSheet = (sheetName: string, strikeKeys: string[], headerColor: string) => {
    const sheet = workbook.addWorksheet(sheetName);

    // Base headers: S.No., Strike, Trend Badge, % Change + selected OHLC fields + minute timestamps
    const baseHeaders = ["S.No.", "Strike", "Trend Badge", "% Change", ...ohlcDefs.map((d) => d.header)];
    const allHeaders = [...baseHeaders, ...sortedTimestamps];

    // Add Header Row
    const headerRow = sheet.addRow(allHeaders);
    headerRow.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: headerColor },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 24;

    // Set Column Widths
    sheet.getColumn(1).width = 8;  // S.No.
    sheet.getColumn(2).width = 14; // Strike
    sheet.getColumn(3).width = 14; // Trend Badge
    sheet.getColumn(4).width = 12; // % Change

    ohlcDefs.forEach((_, idx) => {
      sheet.getColumn(5 + idx).width = 12;
    });

    sortedTimestamps.forEach((_, idx) => {
      sheet.getColumn(5 + ohlcDefs.length + idx).width = 10;
    });

    // Min & Max across strikeKeys in this sheet for each active OHLC column
    const ohlcMinMax: Record<string, { max: number | null; min: number | null }> = {};
    ohlcDefs.forEach((d) => {
      const vals: number[] = [];
      strikeKeys.forEach((key) => {
        const s = session.strikes[key];
        if (s) {
          const val = d.getVal(s);
          if (val > 0) vals.push(val);
        }
      });
      ohlcMinMax[d.id] = {
        max: vals.length > 0 ? Math.max(...vals) : null,
        min: vals.length > 0 ? Math.min(...vals) : null,
      };
    });

    // Populate Rows
    strikeKeys.forEach((strikeKey, index) => {
      const strikeData = session.strikes[strikeKey];
      if (!strikeData) return;

      // Row-wise Min & Max for timestamp LTP cells in this row
      const rowLtps: number[] = [];
      sortedTimestamps.forEach((ts) => {
        const cell = (strikeData.grid || []).find((c: any) => c.timestamp === ts);
        if (cell && typeof cell.ltp === "number" && !isNaN(cell.ltp) && cell.ltp > 0) {
          rowLtps.push(cell.ltp);
        }
      });
      const rowMax = rowLtps.length > 0 ? Math.max(...rowLtps) : null;
      const rowMin = rowLtps.length > 0 ? Math.min(...rowLtps) : null;
      const hasDistinctRowMinMax = rowMax !== null && rowMin !== null && rowMax !== rowMin;

      const rowValues: (string | number)[] = [
        index + 1, // S.No. starting from 1
        strikeKey,
        strikeData.trendBadge || "FLAT",
        typeof strikeData.pctChange === "number" ? `${strikeData.pctChange > 0 ? "+" : ""}${strikeData.pctChange.toFixed(2)}%` : "0.00%",
        ...ohlcDefs.map((d) => d.getVal(strikeData)),
      ];

      // Add Minute Ticks
      sortedTimestamps.forEach((ts) => {
        const cell = (strikeData.grid || []).find((c: any) => c.timestamp === ts);
        rowValues.push(cell && typeof cell.ltp === "number" ? cell.ltp : "");
      });

      const row = sheet.addRow(rowValues);
      row.height = 22;
      row.alignment = { vertical: "middle", horizontal: "center" };
      row.font = { name: "Arial", size: 10 };

      // Apply cell styling & borders
      row.eachCell((cell, colNumber) => {
        cell.border = {
          top: { style: "thin", color: { argb: "E2E8F0" } },
          bottom: { style: "thin", color: { argb: "E2E8F0" } },
          left: { style: "thin", color: { argb: "E2E8F0" } },
          right: { style: "thin", color: { argb: "E2E8F0" } },
        };

        // Active OHLC cells (Col 5 to 4 + ohlcDefs.length)
        if (colNumber >= 5 && colNumber < 5 + ohlcDefs.length) {
          const ohlcIdx = colNumber - 5;
          const def = ohlcDefs[ohlcIdx];
          const val = def.getVal(strikeData);
          const { max, min } = ohlcMinMax[def.id] || { max: null, min: null };
          if (max !== null && min !== null && max !== min && val === max && val > 0) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1E3A8A" } }; // Dark Blue
            cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFF" } };
          } else if (max !== null && min !== null && max !== min && val === min && val > 0) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "111827" } }; // Black
            cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFF" } };
          }
        }

        // Minute Timestamp cells (Col 5 + ohlcDefs.length onwards)
        const minStartCol = 5 + ohlcDefs.length;
        if (colNumber >= minStartCol) {
          const tsIdx = colNumber - minStartCol;
          const ts = sortedTimestamps[tsIdx];
          const gridCell = (strikeData.grid || []).find((c: any) => c.timestamp === ts);
          if (gridCell && typeof gridCell.ltp === "number" && !isNaN(gridCell.ltp) && gridCell.ltp > 0) {
            const isHighest = hasDistinctRowMinMax && gridCell.ltp === rowMax;
            const isLowest  = hasDistinctRowMinMax && gridCell.ltp === rowMin;
            if (isHighest) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "BFDBFE" } }; // Light Blue
              cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "1E3A8A" } };
            } else if (isLowest) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "111827" } }; // Black
              cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFF" } };
            }
          }
        }
      });
    });
  };

  // Build CE Sheet (Green header: 047857)
  if (ceStrikes.length > 0) {
    buildSheet("CE Strikes", ceStrikes, "047857");
  }

  // Build PE Sheet (Red header: E53935)
  if (peStrikes.length > 0) {
    buildSheet("PE Strikes", peStrikes, "E53935");
  }

  // Fallback if no specific CE/PE filter matched
  if (ceStrikes.length === 0 && peStrikes.length === 0 && selectedStrikes.length > 0) {
    buildSheet("Strikes", selectedStrikes, "1E293B");
  }

  // Download XLSX
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const filename = `Module2_StrikeTracker_${session.indexSymbol || "Session"}_${session.expiryDate || ""}.xlsx`;

  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
};

