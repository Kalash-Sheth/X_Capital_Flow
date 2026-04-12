import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        outline:
          "border-border bg-transparent text-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        positive:
          "border-emerald-200 bg-emerald-50 text-emerald-700",
        negative:
          "border-red-200 bg-red-50 text-red-700",
        caution:
          "border-amber-200 bg-amber-50 text-amber-700",
        regime:
          "border-[#C8DCF0] bg-[#C8DCF0]/60 text-[#1B3A5C] font-bold tracking-wide uppercase text-[10px]",
        brand:
          "border-[#C8DCF0] bg-[#1B3A5C] text-white",
        muted:
          "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
