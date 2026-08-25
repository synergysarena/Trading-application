import type { Category } from "./types";
import { MODULE1_SECTIONS } from "./module1";
import { MODULE2_SECTIONS } from "./module2";
import { APP_DETAILS_SECTIONS } from "./appDetails";

export * from "./types";

export const CATEGORIES: Category[] = [
  {
    id: "module1",
    label: "Module 1",
    icon: "📘",
    audience: "For traders — how to use the screen",
    sections: MODULE1_SECTIONS,
  },
  {
    id: "module2",
    label: "Module 2",
    icon: "📘",
    audience: "Coming soon",
    sections: MODULE2_SECTIONS,
    comingSoon: true,
  },
  {
    id: "app-details",
    label: "Application Details",
    icon: "⚙",
    audience: "For developers — architecture & implementation",
    sections: APP_DETAILS_SECTIONS,
  },
];
