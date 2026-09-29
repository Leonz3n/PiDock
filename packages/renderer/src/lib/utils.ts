import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui class composer ([UI 对齐] #47).
 *
 * Every vendored component under `src/components/ui` builds its class string
 * with `cn(...)`, so a caller's `className` can override any variant default
 * without fighting specificity.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
