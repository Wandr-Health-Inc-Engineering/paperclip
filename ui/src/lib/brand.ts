// Tethr brand constants.
//
// Single source of truth for the user-visible product name. Imported wherever
// the literal "Paperclip" used to appear in user-facing UI (document titles,
// breadcrumbs, copy strings). Package names, error class names, and other
// internal identifiers are intentionally left as "paperclip" so upstream
// merges from paperclipai/paperclip stay clean.
//
// Usage convention:
//   - APP_NAME       — lowercase, used in running prose and most UI surfaces
//   - APP_NAME_FORMAL — initial cap, used in document titles, bios, formal contexts

export const APP_NAME = "tethr" as const;
export const APP_NAME_FORMAL = "Tethr" as const;
