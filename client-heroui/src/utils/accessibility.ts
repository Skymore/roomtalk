/**
 * HeroUI currently mirrors a visible Input/Select `label` into `aria-label`
 * while also referencing that label through `aria-labelledby`. Supplying one
 * whitespace character keeps the visible label as the sole computed name.
 * Remove this workaround after upgrading to a HeroUI version that no longer
 * creates the duplicate accessible name.
 */
export const HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE = ' ';
