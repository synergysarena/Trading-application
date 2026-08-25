import { Tag, Rocket, Building2, Package, CheckCircle2, FileText, Globe } from "lucide-react";

// ── Product Information card ──────────────────────────────────────────────────
// Sits at the very top of the Documentation page, below the Dezprox banner and
// above the "Platform Guide" header. Pure metadata display — no state, no
// interaction beyond the Website link — styled with the same local tokens as
// the rest of the docs page for visual consistency.

const BORDER = "#d8e0ea";
const TEXT   = "#102033";
const MUTED  = "#5b6b82";
const GREEN  = "#16a34a";
const FONT   = "'Inter', 'Segoe UI', system-ui, sans-serif";

interface FieldDef {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
}

function SuccessBadge({ label }: { label: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20,
      background: "#f0fdf4", border: `1px solid ${GREEN}30`,
      fontSize: 11.5, fontWeight: 700, color: GREEN,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN, display: "inline-block" }} />
      {label}
    </span>
  );
}

function FieldRow({ field }: { field: FieldDef }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 4px" }}>
      <span style={{
        flexShrink: 0, marginTop: 1, color: MUTED, opacity: 0.7,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {field.icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10.5, fontWeight: 600, color: MUTED,
          textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3,
        }}>
          {field.label}
        </div>
        <div style={{
          fontSize: field.emphasize ? 17 : 13.5,
          fontWeight: field.emphasize ? 800 : 700,
          color: field.emphasize ? GREEN : TEXT,
          lineHeight: 1.4, wordBreak: "break-word",
        }}>
          {field.value}
        </div>
      </div>
    </div>
  );
}

export function ProductInfoCard() {
  const iconProps = { size: 15, strokeWidth: 2 };

  const fields: FieldDef[] = [
    { icon: <Tag {...iconProps} />, label: "Product Name", value: "TradePro Analytics Suite" },
    { icon: <Rocket {...iconProps} />, label: "Version", value: "1.0" },
    { icon: <Building2 {...iconProps} />, label: "Developed By", value: "Dezprox LLP" },
    { icon: <Package {...iconProps} />, label: "Category", value: "Enterprise Trading Analytics Platform" },
    // {
    //   icon: <IndianRupee {...iconProps} />,
    //   label: "Current Market Value",
    //   value: "₹2,50,000 INR",
    //   emphasize: true,
    // },
    { icon: <CheckCircle2 {...iconProps} />, label: "Development Status", value: <SuccessBadge label="Production Ready" /> },
    { icon: <FileText {...iconProps} />, label: "License", value: "Commercial" },
    {
      icon: <Globe {...iconProps} />,
      label: "Website",
      value: (
        <a
          href="https://www.dezprox.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: GREEN, fontWeight: 700, textDecoration: "none" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = "underline"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = "none"; }}
        >
          https://www.dezprox.com
        </a>
      ),
    },
  ];

  return (
    <div style={{
      background: "#fff",
      border: `1.5px solid ${BORDER}`,
      borderRadius: 12,
      marginBottom: 20,
      overflow: "hidden",
      fontFamily: FONT,
    }}>
      <div style={{ height: 3, background: `linear-gradient(90deg, ${GREEN}, #10b981)` }} />
      <div style={{ padding: "18px 24px 8px" }}>
        <h2 style={{
          margin: "0 0 4px",
          fontSize: 15.5, fontWeight: 900, color: TEXT,
          letterSpacing: "-0.01em",
        }}>
          Product Information
        </h2>
        <div style={{
          fontSize: 12, color: MUTED, fontWeight: 500,
          paddingBottom: 12, marginBottom: 4,
          borderBottom: `1.5px solid ${BORDER}`,
        }}>
          Overview of this platform and its release.(July/26)
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          columnGap: 20,
        }}>
          {fields.map((f) => <FieldRow key={f.label} field={f} />)}
        </div>
      </div>
    </div>
  );
}

export default ProductInfoCard;
