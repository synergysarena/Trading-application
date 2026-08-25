// ── Shared documentation content types ────────────────────────────────────────
// Used by both the Module 1 (client-facing) and Application Details
// (developer-facing) content sets, plus the DocsPage renderer.

export type Tint = "call" | "put" | "neutral";

export interface ColRef {
  id: string;
  name: string;
  tint: Tint;
  formula?: string;
  description: string;
  howToRead: string;
}

export interface GlossaryEntry {
  term: string;
  def: string;
}

export interface Step {
  n: number;
  text: string;
}

export interface FieldEntry {
  label: string;
  text: string;
}

export interface FaqEntry {
  q: string;
  a: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  auth?: string;
  params?: string;
  response?: string;
  purpose: string;
}

export type DocBlock =
  | { type: "para"; content: string }
  | { type: "note"; content: string }
  | { type: "warn"; content: string }
  | { type: "bullets"; items: string[] }
  | { type: "steps"; steps: Step[] }
  | { type: "columns"; columns: ColRef[] }
  | { type: "glossary"; glossary: GlossaryEntry[] }
  | { type: "fields"; fields: FieldEntry[] }
  | { type: "faq"; items: FaqEntry[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "endpoints"; endpoints: ApiEndpoint[] }
  | { type: "code"; content: string; label?: string };

export interface Subsection {
  id: string;
  heading: string;
  blocks: DocBlock[];
}

export interface Section {
  id: string;
  heading: string;
  blocks?: DocBlock[];
  subsections?: Subsection[];
}

export interface Category {
  id: string;
  label: string;
  icon: string;
  audience: string;
  sections: Section[];
  comingSoon?: boolean;
}

// ── TOC ───────────────────────────────────────────────────────────────────────

export interface TocEntry {
  id: string;
  label: string;
  depth: number; // 0 = section, 1 = subsection
  categoryId: string;
}

export function buildTocForCategory(cat: Category): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const sec of cat.sections) {
    entries.push({ id: sec.id, label: sec.heading, depth: 0, categoryId: cat.id });
    for (const sub of sec.subsections ?? []) {
      entries.push({ id: sub.id, label: sub.heading, depth: 1, categoryId: cat.id });
    }
  }
  return entries;
}

// ── Search helpers ────────────────────────────────────────────────────────────

function colMatches(col: ColRef, q: string): boolean {
  return (
    col.name.toLowerCase().includes(q) ||
    col.description.toLowerCase().includes(q) ||
    (col.formula?.toLowerCase().includes(q) ?? false) ||
    col.howToRead.toLowerCase().includes(q)
  );
}

function blockMatches(block: DocBlock, q: string): boolean {
  switch (block.type) {
    case "para":
    case "note":
    case "warn":
    case "code":
      return block.content.toLowerCase().includes(q);
    case "bullets":
      return block.items.some((i) => i.toLowerCase().includes(q));
    case "steps":
      return block.steps.some((s) => s.text.toLowerCase().includes(q));
    case "columns":
      return block.columns.some((c) => colMatches(c, q));
    case "glossary":
      return block.glossary.some(
        (g) => g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q)
      );
    case "fields":
      return block.fields.some(
        (f) => f.label.toLowerCase().includes(q) || f.text.toLowerCase().includes(q)
      );
    case "faq":
      return block.items.some(
        (f) => f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q)
      );
    case "table":
      return block.rows.some((row) => row.some((cell) => cell.toLowerCase().includes(q)));
    case "endpoints":
      return block.endpoints.some(
        (e) =>
          e.path.toLowerCase().includes(q) ||
          e.purpose.toLowerCase().includes(q) ||
          e.method.toLowerCase().includes(q)
      );
  }
}

function subsectionMatches(sub: Subsection, q: string): boolean {
  if (sub.heading.toLowerCase().includes(q)) return true;
  return sub.blocks.some((b) => blockMatches(b, q));
}

export function sectionMatches(section: Section, q: string): boolean {
  if (!q) return true;
  if (section.heading.toLowerCase().includes(q)) return true;
  if (section.blocks?.some((b) => blockMatches(b, q))) return true;
  if (section.subsections?.some((s) => subsectionMatches(s, q))) return true;
  return false;
}

export function categoryMatches(cat: Category, q: string): boolean {
  if (!q) return true;
  if (cat.label.toLowerCase().includes(q)) return true;
  return cat.sections.some((s) => sectionMatches(s, q));
}

export function matchingColIds(categories: Category[], q: string): Set<string> {
  const ids = new Set<string>();
  if (!q) return ids;
  const scan = (blocks: DocBlock[] | undefined) => {
    for (const block of blocks ?? []) {
      if (block.type === "columns") {
        for (const col of block.columns) {
          if (colMatches(col, q)) ids.add(col.id);
        }
      }
    }
  };
  for (const cat of categories) {
    for (const sec of cat.sections) {
      scan(sec.blocks);
      for (const sub of sec.subsections ?? []) scan(sub.blocks);
    }
  }
  return ids;
}
