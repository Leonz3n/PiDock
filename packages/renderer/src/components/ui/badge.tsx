import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui `Badge` ([UI 对齐] #47): the prototype's meta chips (task id, SDK
 * session, 只读 · 无工具, connection state) are all badges, so the vendored
 * component carries the chip geometry instead of a pill.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[10px] whitespace-nowrap [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-foreground",
        soft: "border-border bg-secondary text-[#5b6670]",
        outline: "border-border bg-transparent text-muted-foreground",
        accent: "border-primary bg-secondary text-foreground",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
