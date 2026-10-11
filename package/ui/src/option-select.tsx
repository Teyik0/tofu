import { cn } from "cn";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export interface SelectOption<Value extends string> {
  label: string;
  value: Value;
}

/** A full-width registry Select for a flat list of string options. */
export function OptionSelect<Value extends string>({
  ariaDescribedBy,
  ariaLabel,
  className,
  contentClassName,
  disabled,
  id,
  onValueChange,
  options,
  placeholder,
  value,
}: {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  disabled: boolean;
  id?: string;
  onValueChange: (value: Value) => void;
  options: readonly SelectOption<Value>[];
  /** Shown while `value` is null. */
  placeholder?: string;
  value: Value | null;
}) {
  return (
    <Select
      disabled={disabled}
      items={options}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next);
        if (option) {
          onValueChange(option.value);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        className={cn("w-full min-w-0", className)}
        id={id}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className={contentClassName}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
