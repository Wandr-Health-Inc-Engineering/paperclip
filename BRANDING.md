# tethr branding

This fork is reskinned as **tethr** (Wandr Health's internal cloud OS). The original project is **paperclip** (paperclipai/paperclip), and we sync from it regularly.

The reskin is designed to absorb upstream changes with minimal friction. The rules below exist to keep merges clean.

## Architecture

| Layer | File | Purpose |
|---|---|---|
| Brand constants | [ui/src/lib/brand.ts](ui/src/lib/brand.ts) | `APP_NAME`, `APP_NAME_FORMAL` — used wherever the user-visible product name appears |
| Theme overrides | [ui/src/styles/tethr-theme.css](ui/src/styles/tethr-theme.css) | CSS variable overrides and font imports, imported AFTER `index.css` in `main.tsx` |
| Favicons | `ui/public/favicon.*`, `apple-touch-icon.png` | Replaced with tethr marks |
| Wordmark | `ui/src/components/TethrWordmark.tsx` | In-app wordmark component |

## Override-don't-edit rule

We do NOT edit upstream files when an override layer can do the job:

- **Colors, fonts, borders, radius** → override CSS variables in `tethr-theme.css`. Never edit `ui/src/index.css`.
- **Visible product name** → import `APP_NAME` / `APP_NAME_FORMAL` from `@/lib/brand`. Don't hardcode "tethr" in components.
- **shadcn components** → don't touch `ui/src/components/ui/*`. Carry brand via CSS variables and Tailwind classes from outside.

## What we DON'T rename

These are intentionally left as "paperclip":

- Package names (`@paperclipai/*` workspace packages)
- LocalStorage keys (e.g. `paperclip.theme`) — changing these would reset user preferences across the team
- Error class names, internal IDs, log labels, telemetry events
- The lucide `Paperclip` icon (it's an attachment icon, not branding)
- Server-side HTML comment markers (`<!-- PAPERCLIP_FAVICON_START -->`) — they're contracts the server's `ui-branding.ts` injector reads
- **Cross-system string constants** that the frontend compares against backend-produced text. Specifically: `SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY` and `SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY` in [ui/src/lib/successful-run-handoff.ts](ui/src/lib/successful-run-handoff.ts). The backend (`server/src/services/recovery/`) emits the same literal text; rebranding requires a coordinated server change. Same applies to the `/^Paperclip exhausted/i` regex check.
- [ui/src/pages/CompanyExport.tsx](ui/src/pages/CompanyExport.tsx) export-markdown footer links — those credit the origin tool (paperclip.ing) and are part of the exported artifact's audit trail.

## Post-upstream-merge checklist

After `git merge upstream/master` (or equivalent), run this sweep:

```bash
# 1. New user-visible "Paperclip" strings
grep -rn "Paperclip" ui/src --include='*.tsx' --include='*.ts' \
  | grep -v "@paperclipai" \
  | grep -v "lucide-react" \
  | grep -v "PaperclipSprite\|PAPERCLIP_SPRITES"

# 2. New favicon references in index.html (might overwrite our placeholder)
git diff HEAD~1 -- ui/index.html ui/public/favicon*

# 3. New CSS variables in index.css that might need brand mapping
git diff HEAD~1 -- ui/src/index.css | grep -E '^\+\s*--'

# 4. New chart/destructive color uses we may want to clamp
grep -rn "var(--chart-" ui/src --include='*.tsx' --include='*.css' | wc -l
```

Anything that turns up: add to `tethr-theme.css` if a token can cover it, or to a brand sweep commit if it's a copy string.
