import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui `Button` ([UI 对齐] #47), vendored per shadcn's copy-in model.
 *
 * Two deliberate deviations from the upstream file, both recorded in
 * `components.json`'s token layer:
 * - hover surfaces use `secondary` (`bg-soft`) instead of shadcn's `accent`,
 *   because in PiDock `accent` is the brand navy, not a hover grey;
 * - radii use `rounded-sm` (6px), the prototype's control radius.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-xs transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:bg-[#1b2f5e]",
        outline: "border-border bg-card text-foreground hover:bg-secondary",
        secondary: "border-border bg-secondary text-secondary-foreground hover:bg-[#dfe4ec]",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-secondary",
        destructive: "border-destructive bg-transparent text-destructive hover:bg-[#fdf3f3]",
        link: "border-transparent bg-transparent text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-2.5 py-1",
        sm: "h-7 px-2 text-[11px]",
        lg: "h-9 px-3",
        icon: "h-8 w-8 p-0",
        "icon-sm": "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
