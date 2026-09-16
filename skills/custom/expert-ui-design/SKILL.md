---
name: expert-ui-design
description: Apply DeerFlow's Expert page UI system to every UI-facing frontend change in this repository, including new pages, routes, dashboards, galleries, forms, workspace views, and React/Vue components. Use it automatically unless the user explicitly requests a different visual system. Do not apply to backend-only work, data/API-only changes, or frontend logic changes with no visual impact.
---

# DeerFlow Expert Page UI

Treat the current Expert page implementation as the visual source of truth. Before changing UI, read `frontend/AGENTS.md` and inspect the current Expert page components (especially `frontend/src/components/workspace/agent-harness/local-agent-gallery.tsx`, `local-agent-card.tsx`, and related dialogs). Reuse the repository's existing semantic theme tokens and component primitives. Preserve route, data flow, and component architecture unless the task explicitly asks for a structural change.

This system is the default for all future UI pages in the repository. Adapt domain copy and data, but keep the same visual grammar, density, dimensions, and interaction patterns. If the existing Expert implementation has changed, follow the current implementation while retaining the constraints below.

## Fixed design tokens

Apply these values consistently. Prefer semantic theme variables that resolve to these values rather than introducing one-off literals.

| Token | Required value | Usage |
| --- | --- | --- |
| Base spacing | `8px` | Default padding, gaps, and margins |
| Maximum component spacing | `12px` | Only when `8px` is insufficient; do not exceed it for component internals |
| Description text | `12px` | Helper text, metadata, captions, status text |
| Body text | `14px` | Inputs, controls, paragraphs, labels, table cells |
| Heading text | `16px` | Page and section headings; no oversized display type |
| Emphasis weight | `700` | Only key values, primary headings, and critical status text |
| Regular weight | `400` | All ordinary text unless emphasis is required |

### Spacing and dimensions

- Use `8px` as the default `padding`, `margin`, `gap`, and section separation. Use `12px` only for the few places that need extra breathing room; never use arbitrary component spacing above `12px`.
- Keep controls compact. Prefer the existing Expert page heights and radii; do not increase default control size or add decorative whitespace.
- Use one stable width for repeated components. Repeated labels, inputs, selects, buttons, cards, and table columns must align to the same width rules within a view.
- Give labels a consistent width based on the longest label in the group. Labels and compact control text must use `white-space: nowrap`; widen the label or let the layout reflow rather than wrapping text.
- Keep component-internal text at the same `12px`/`14px` scale as the rest of the page. Do not use a component library's oversized defaults.
- Use responsive layout changes only to prevent clipping or overlap. At narrow widths, stack controls and allow the grid to reflow while preserving the same token values.

### Typography

- Use one font family for the entire page and all components. Reuse the repository's configured font; never mix font families, fallback stacks, or per-component fonts.
- Use only `12px`, `14px`, and `16px` unless an existing system primitive requires another size for a technical reason. In that case, keep the exception local and visually subordinate.
- Use `700` sparingly for key content. Do not compensate for weak hierarchy with larger type, all caps, or mixed fonts.

### Color and surfaces

- Use one coherent Expert palette throughout the page: dark navy heading/text (`#173a5b`), muted blue-gray secondary text (`#71869a`), sky-blue primary action (`#2587ea`), pale blue selected/accent surface (`#eff6fb` or `#edf6ff`), and light blue-gray border (`#d8e5ef`). Prefer the existing semantic tokens when available.
- Use a single base background/surface for the page. Do not alternate unrelated white and gray blocks. Cards, panels, dialogs, and forms should inherit the same surface unless a pale-blue selected/accent state is needed.
- Keep heading, body, description, and border colors within the same semantic theme. Do not introduce unrelated colors or ad hoc gray values.
- Primary buttons, links that represent primary actions, and focus accents must use the Expert theme blue. Secondary and destructive actions may use existing semantic variants, but must remain consistent across the whole page.
- Use one shared status palette everywhere: success `#16a34a`, warning `#d97706`, error `#dc2626`, and neutral `#71869a`, with matching low-contrast tinted backgrounds. Do not invent per-page status colors.
- Category colors are small semantic accents only; never use them as full-page backgrounds or as competing themes.
- Provide dark-mode equivalents through existing theme tokens rather than duplicating literal colors.

## Signature layout

- **Shell:** full-height `bg-background` column with a compact header and light border. Keep information dense, calm, and easy to scan.
- **Header:** concise `16px` dark-blue title, one-line `12px` description, then a responsive action row with search, secondary action, and one blue primary action.
- **Filters:** a bordered row with horizontally scrollable compact tabs and counts. Active tabs use pale blue tint, blue text, and a light blue border; inactive tabs stay quiet until hover.
- **Collection:** a responsive grid of compact cards with stable dimensions. Cards may contain an avatar/image, title, category, short description, capability tags, and one clear primary action. Avoid cards inside cards.
- **Detail:** use a focused dialog or side panel. Follow the Expert pattern: tinted header with avatar and title, description, capabilities, optional prompt rows, and one obvious primary action.
- **Shape:** use the existing `rounded-md`/`rounded-lg` controls and dialogs. Use `rounded-2xl` only where the current Expert dialog already does.

## Behavior and accessibility

- Match existing button, input, card, dialog, dropdown, toast, and icon-library components. Use Lucide icons when already available.
- Implement hover, focus-visible, disabled, loading, empty, error, and success states in the same palette. Every implied action must be functional.
- Keep keyboard focus visible, use semantic headings and buttons/links, label inputs, and provide accessible names for icon-only controls. Respect `prefers-reduced-motion`.
- At mobile widths, stack header actions, keep filters horizontally scrollable, and reflow cards/details without clipping or overlap. Check wide layouts for intentional density and aligned widths.

## Delivery check

Before handoff, compare the result with the current Expert page in source or the running app. Verify:

1. All component padding, gaps, and margins are `8px` by default and never exceed `12px` internally.
2. One font family and only the `12px`/`14px`/`16px` scale are used; key content uses weight `700`.
3. Background, text, border, button, and status colors come from the shared Expert palette.
4. Repeated components and labels have aligned, stable widths and no unintended wrapping.
5. Desktop and mobile states have no clipping, overlap, or inconsistent density.

Run the relevant lint/type/build checks for the changed frontend code. Start a dev server and provide its URL when the change requires a running app.

Do not copy the Expert page's domain content into unrelated screens. Copy its UI system and adapt labels, data, and actions to the requested feature.
